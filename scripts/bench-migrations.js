/* ============================================================
 * 迁移耗时基准:全库重算类迁移(v23 / v24)的一次性成本
 *
 * 为什么需要它:迁移在**服务启动的事务里**跑完,时长 = 部署重启的阻塞时间。
 * v23(作者空格归一化)要 rebuildAll + reindexAll 扫全库,v24(author_sort 回填)
 * 也扫一遍 books;书库到 3 万本时这两个数字必须实测,不能靠感觉。
 *
 * 用法(仓库根目录):
 *   node scripts/bench-migrations.js                # 默认 1 万 + 3 万
 *   node scripts/bench-migrations.js 5000,20000     # 自定义规模
 *
 * 只在临时目录建库,绝不碰 data/。
 * 一个规模只**播种一次**,之后按场景复制 books.db,并且一次只开一个库 ——
 * 同进程里同时挂六七个几万本的库,测出来的是磁盘抖动,不是迁移成本。
 * ============================================================ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// 必须在 require src/db/index 之前设好:该模块加载时就会打开"默认实例"
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-mig-bench-'));
process.env.MYBOOKS_STORAGE_DIR = sandbox;
process.env.MYBOOKS_SEED_DEMO = 'false';

const { db: singleton, openDb, runMigrations, migrations } = require('../src/db/index.js');

// v23 之前的历史脏数据形态:同一位作者因括号内空格不同存成两项
const AUTHOR_VARIANTS = ['[美] 弗兰克·赫伯特', '[美]弗兰克·赫伯特'];
const PLAIN_AUTHORS = ['刘慈欣', '黄仁宇', '余华', 'Jane Smith', 'Aaron Ackland'];
const TAG_POOL = ['科幻', '历史', '获奖, 特别标签', '精读'];

// author_sort 与真源不一致的行数 —— 就是"还要修多少本"
const MISMATCH_SQL = `
  SELECT COUNT(*) AS n FROM books
  WHERE author_sort <> COALESCE((
    SELECT GROUP_CONCAT(sort_key, ' & ') FROM (
      SELECT NULLIF(a.sort, '') AS sort_key
      FROM book_authors ba JOIN authors a ON a.id = ba.author
      WHERE ba.book = books.id
      ORDER BY ba.position, a.name COLLATE NOCASE
    )
  ), '')
`;
// 已发布 v23 留在现网上的现场:排序键被压成首位作者原文,authors.sort 也是原文。
// 现在代码里的 v23 已经不会这么写,所以不铺这一步就测不到 v24 真正要改多少行。
const FLATTEN_SQL = `
  UPDATE books SET author_sort = COALESCE((
    SELECT name FROM (
      SELECT a.name AS name FROM book_authors ba JOIN authors a ON a.id = ba.author
      WHERE ba.book = books.id ORDER BY ba.position, a.name COLLATE NOCASE
    ) LIMIT 1
  ), '');
  UPDATE authors SET sort = name;
`;

// 建一个"停在 v22"的库:裸 INSERT,作者链接表还是空的,排序键就是原文本身
function seedAndClose(seedDir, count) {
  const db = openDb(seedDir, { seedDemo: false });
  db.exec('DELETE FROM book_authors; DELETE FROM authors; DELETE FROM book_tags; DELETE FROM tags; DELETE FROM books;');
  const ins = db.prepare(`
    INSERT INTO books (title, author, author_sort, status, tags, read_logs, uuid, created_at, updated_at)
    VALUES (@title, @author, @author_sort, @status, @tags, '[]', @uuid, @ts, @ts)
  `);
  db.exec('BEGIN');
  for (let i = 0; i < count; i += 1) {
    // 四成是二三作者的合著 —— v24 要修的就是这种"多作者排序键被压平"的行;
    // 全用单作者样本的话它无活可干,数字会假得很漂亮。
    const single = i % 5 > 1;
    const first = i % 7 === 0 ? AUTHOR_VARIANTS[i % 2] : PLAIN_AUTHORS[i % PLAIN_AUTHORS.length];
    const author = single ? first : `${first}、${PLAIN_AUTHORS[(i + 2) % PLAIN_AUTHORS.length]}`;
    ins.run({
      title: `基准书目 ${i}`,
      author,
      author_sort: author,
      status: ['wish', 'reading', 'done'][i % 3],
      tags: JSON.stringify([TAG_POOL[i % TAG_POOL.length], TAG_POOL[(i + 1) % TAG_POOL.length]]),
      uuid: crypto.randomUUID(),
      ts: '2026-01-01T00:00:00.000Z',
    });
  }
  db.exec('COMMIT');
  db.exec('PRAGMA user_version = 22');   // v23 / v24 都还没跑
  db.close();
  return path.join(seedDir, 'books.db');
}

// 复制出场景库:关掉源句柄之后才复制,WAL 已随正常关闭被清掉
function copyTo(dbFile, name) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'books.db');
  fs.copyFileSync(dbFile, target);
  return { dir, db: new DatabaseSync(target) };
}

function ms(fn) {
  const start = process.hrtime.bigint();
  const out = fn();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, out };
}

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const scalar = (db, sql) => db.prepare(sql).get().m;
const fmt = (n) => Number(n).toFixed(0);

// 场景 A(现网):库已经跑过发布版 v23,下次重启只承担 v24
function scenarioLive(seedFile, size) {
  const { dir, db } = copyTo(seedFile, `live-${size}`);
  // 先补上作者链接(v24 是按链接表重算的,没有链接就无从对比)
  db.exec('BEGIN');
  migrations[22](db, dir);
  db.exec('COMMIT');
  db.exec('PRAGMA user_version = 23');
  db.exec(FLATTEN_SQL);                                // 铺回发布版留下的现场
  const pending = count(db, MISMATCH_SQL);
  const revisionBefore = count(db, 'SELECT COALESCE(SUM(revision), 0) AS n FROM books');
  const updatedBefore = scalar(db, 'SELECT MAX(updated_at) AS m FROM books');

  db.exec('BEGIN');
  const v24 = ms(() => migrations[23](db, dir));
  const commit = ms(() => db.exec('COMMIT'));
  const after = {
    mismatch: count(db, MISMATCH_SQL),
    revision: count(db, 'SELECT COALESCE(SUM(revision), 0) AS n FROM books'),
    updated: scalar(db, 'SELECT MAX(updated_at) AS m FROM books'),
  };
  db.close();
  return {
    label: '【现网】库已停在 v23,下次重启只跑 v24',
    detail: `${fmt(v24.ms)} ms 写 + ${fmt(commit.ms)} ms 提交 = ${fmt(v24.ms + commit.ms)} ms`
      + `  (待修 ${pending} 行 → 剩 ${after.mismatch} 行)`,
    check: after.revision === revisionBefore && after.updated === updatedBefore,
  };
}

// 场景 B(首次升级 / 回滚后再升级):v22 → v24 在同一事务里跑完
function scenarioUpgrade(seedFile, size) {
  const { dir, db } = copyTo(seedFile, `upgrade-${size}`);
  const whole = ms(() => runMigrations(db, dir));
  const mismatchAfter = count(db, MISMATCH_SQL);
  db.close();
  return {
    label: '【首次升级】v22 → v24 同事务跑完',
    detail: `${fmt(whole.ms)} ms  (跑完后与真源不一致 ${mismatchAfter} 行)`,
    check: mismatchAfter === 0,
  };
}

// 场景 B 的分步归因:同一事务里分别计时(WAL 检查点会落在语句中间)
function scenarioUpgradeSplit(seedFile, size) {
  const { dir, db } = copyTo(seedFile, `split-${size}`);
  db.exec('BEGIN');
  const v23 = ms(() => migrations[22](db, dir));
  db.exec('PRAGMA user_version = 23');
  const v24 = ms(() => migrations[23](db, dir));
  const commit = ms(() => db.exec('COMMIT'));
  db.close();
  return {
    label: '     分解',
    detail: `v23 ${fmt(v23.ms)} ms + v24 ${fmt(v24.ms)} ms + 提交 ${fmt(commit.ms)} ms`,
  };
}

// 场景 C:全新库(建表 + 24 步迁移)
function scenarioFresh(size) {
  const dir = path.join(sandbox, `fresh-${size}`);
  fs.mkdirSync(dir, { recursive: true });
  const opened = ms(() => {
    const db = openDb(dir, { seedDemo: false });
    db.close();
    return true;
  });
  return { label: '【全新库】建表 + 24 步迁移', detail: `${fmt(opened.ms)} ms` };
}

function reportSize(size) {
  const seedDir = path.join(sandbox, `seed-${size}`);
  fs.mkdirSync(seedDir, { recursive: true });
  const seedFile = seedAndClose(seedDir, size);

  console.log(`\n== ${size.toLocaleString()} 本 ==`);
  const results = [
    scenarioLive(seedFile, size),
    scenarioUpgrade(seedFile, size),
    scenarioUpgradeSplit(seedFile, size),
    scenarioFresh(size),
  ];
  for (const r of results) console.log(`  ${r.label} : ${r.detail}`);
  const live = results[0];
  console.log(`  安全性:v24 未推动 revision / 未刷新 updated_at ${live.check ? '✓' : '✗'}`);
}

const sizes = (process.argv[2] || '10000,30000')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
console.log(`迁移耗时基准  node ${process.version} / SQLite ${process.versions.sqlite || '?'}`);
console.log('口径:全部按生产方式(整批迁移包在一个事务里)计时;每个场景独立开库,用完即关。');
for (const size of sizes) reportSize(size);

// 单例库不关就删不掉临时目录(Windows 上文件被占用会 EPERM)
try { singleton.close(); } catch { /* ignore */ }
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch (err) {
  console.warn(`临时目录清理失败(${err.message}),请手工删 ${sandbox}`);
}
