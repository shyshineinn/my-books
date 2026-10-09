#!/usr/bin/env node
/* ============================================================
 * 把旧 books.db 导入 calibre 库(生成 calibredb 命令并执行)
 *
 * 背景:实测你的库里有 31 条记录,但 books-files/ 是**空的** ——
 * 也就是说只有"书目记录",没有"电子书文件"。所以用 calibredb 的
 * --empty 建空书目记录(calibre 原生支持,库里显示为"无格式"的书)。
 * 以后有 epub 文件时,用 calibredb add 把格式补到对应记录上。
 *
 * 关于重名:你的数据里《三体》有 4 条、《活着》有 2 条。calibre 的
 * add_books 默认 add_duplicates=True(cache.py:2683),所以**不会**去重,
 * 4 条会如实建 4 个记录 —— 正是我们想要的。
 *
 * 封面:旧库存的是外链 URL,而 calibredb -c 只接受本地文件路径。
 * 本脚本会先把封面下载到 data/calibre-covers/,再随书记录一起导入。
 * 下载失败的跳过(不阻断导入)。
 *
 * 用法:
 *   node deploy/import-to-calibre.js --dry-run        # 只生成命令,不执行
 *   node deploy/import-to-calibre.js --exec           # 真的导入
 *   node deploy/import-to-calibre.js --exec --no-covers   # 导入但跳过封面下载
 *
 * 幂等性:默认会跳过 calibre 里已存在(同名+同作者)的书,所以可安全重跑。
 *   若确实要建重复记录,加 --allow-duplicates。
 *   ⚠️ 查重需要读库,而 calibredb 与 calibre-server 抢同一把全局 db 锁
 *      (calibre srv/standalone.py:177-186),所以导入前请先:
 *        systemctl stop calibre-server
 *
 * 环境变量:
 *   CALIBRE_LIBRARY  库目录(默认 /root/calibre-library;本机测试可改)
 *   CALIBREDB        可执行文件(默认 calibredb)
 * ============================================================ */

const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DRY_RUN = !process.argv.includes('--exec');
const NO_COVERS = process.argv.includes('--no-covers');
const ALLOW_DUPLICATES = process.argv.includes('--allow-duplicates');
const LIBRARY = process.env.CALIBRE_LIBRARY || '/root/calibre-library';
const CALIBREDB = process.env.CALIBREDB || 'calibredb';
const ROOT = path.join(__dirname, '..');
const COVER_DIR = path.join(ROOT, 'data', 'calibre-covers');

/* 旧库里 status/阅读记录不属于 calibre,但**标签**属于。
   这里把 status 也转成一个标签,方便你在 calibre 里按状态筛选 ——
   真正的阅读记录稍后由 migrate-reading.js 迁到 reading.db。 */
const STATUS_TAG = { wish: '想读', reading: '在读', done: '已读' };

function openLegacy() {
  const p = path.join(ROOT, 'data', 'books.db');
  if (!fs.existsSync(p)) {
    console.error(`找不到旧库:${p}`);
    process.exit(1);
  }
  const db = new DatabaseSync(p, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/* 下载封面到本地。calibredb -c 只认真实文件路径。
   返回本地路径或 null。 */
async function fetchCover(url, id) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const ext = (url.split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i) || [, 'jpg'])[1].toLowerCase();
  const dest = path.join(COVER_DIR, `${id}.${ext}`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        // 豆瓣/必应等图床会检查 Referer,不带就 403
        'User-Agent': 'Mozilla/5.0 (compatible; my-books-import/1.0)',
        Referer: new URL(url).origin,
      },
    });
    if (!res.ok) {
      console.log(`      封面 HTTP ${res.status},跳过`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) {
      console.log('      封面内容过小,跳过');
      return null;
    }
    fs.mkdirSync(COVER_DIR, { recursive: true });
    fs.writeFileSync(dest, buf);
    return dest;
  } catch (err) {
    console.log(`      封面下载失败(${err.message}),跳过`);
    return null;
  }
}

function parseTags(raw) {
  try {
    const t = JSON.parse(raw || '[]');
    return Array.isArray(t) ? t.filter(Boolean) : [];
  } catch { return []; }
}

function run(args) {
  return execFileSync(CALIBREDB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/* 读出 calibre 库里已有的书,建 "书名|作者" 指纹集合,用于跳过重复。
 *
 * 为什么必须做这件事:calibre 的 add_books 默认 add_duplicates=True
 * (db/cache.py:2683),所以**重跑本脚本会把每本书再加一遍** ——
 * 实测踩过:跑两次后库里 26 本 = 13 本 × 2 份,随即导致阅读记录迁移
 * 每本都报"有 2 个候选"的歧义。
 *
 * 用 calibredb list --for-machine 拿 JSON(比解析表格输出可靠)。
 * 注意:调用 calibredb 时不能有 calibre-server 在跑(抢同一把 db 锁),
 * 失败时给出明确提示而不是抛栈。 */
function existingFingerprints() {
  let raw;
  try {
    raw = run(['list', '--library-path', LIBRARY, '--fields=title,authors', '--for-machine']);
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString();
    if (/Another calibre program/i.test(msg)) {
      console.error('');
      console.error('[导入] ⚠️ calibre-server 正在运行,无法读库查重。');
      console.error('       calibredb 与 calibre-server 抢同一把全局 db 锁');
      console.error('       (calibre srv/standalone.py:177-186),不能同时跑。');
      console.error('       请先执行:systemctl stop calibre-server');
      console.error('       导入完成后再:systemctl start calibre-server');
      process.exit(1);
    }
    // 库为空时 calibredb list 可能报错,视为"没有任何已存在的书"
    return new Set();
  }

  let books;
  try {
    books = JSON.parse(raw);
  } catch {
    // --for-machine 不被支持(老版本 calibre),退化为"不做查重"
    return null;
  }

  const set = new Set();
  for (const b of books || []) {
    const authors = Array.isArray(b.authors) ? b.authors.join('&') : String(b.authors || '');
    set.add(fpKey(b.title, authors));
  }
  return set;
}

/* 指纹:书名 + 作者,规范化为小写、去空白、去标点。
   与 migrate-reading.js 的 norm() 同思路 —— 重名判定要一致。 */
function fpKey(title, authors) {
  const n = (s) => String(s || '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[《》「」""''·—\-_:：,，.。!！?？\s]/g, '')
    .toLowerCase();
  return n(title) + '|' + n(authors);
}

async function main() {
  const db = openLegacy();

  // 只 SELECT 实际存在的列。旧库的 schema 随版本演进而不同
  // (实测本机的 books 表没有 series 列,但有 pub_year/publisher/douban_id),
  // 硬编码列名会在别人的库上直接报 no such column。
  const have = new Set(db.prepare('PRAGMA table_info(books)').all().map((c) => c.name));
  const want = ['id', 'title', 'author', 'status', 'tags', 'series', 'publisher', 'pub_year', 'isbn', 'cover', 'summary'];
  const cols = want.filter((c) => have.has(c));
  const missing = want.filter((c) => !have.has(c));
  if (missing.length) {
    console.log(`[导入] 旧库没有这些列,已跳过: ${missing.join(', ')}`);
  }

  const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM books ORDER BY id`).all();
  db.close();

  console.log(`[导入] 模式: ${DRY_RUN ? 'dry-run(只打印,不执行)' : '执行'}`);
  console.log(`[导入] 库目录: ${LIBRARY}`);
  console.log(`[导入] 旧库共 ${rows.length} 条记录`);

  // 查重(除非显式要求允许重复)
  let existing = null;
  if (!ALLOW_DUPLICATES) {
    existing = existingFingerprints();
    if (existing === null) {
      console.log('[导入] ⚠️ 无法读取现有库(calibredb --for-machine 不支持),本次不做查重');
    } else {
      console.log(`[导入] calibre 库里已有 ${existing.size} 本,将跳过重复项`);
    }
  } else {
    console.log('[导入] --allow-duplicates:不查重,每本书都会新建一条记录');
  }
  console.log('');

  // 先把封面对齐好(执行模式下才真下载)
  const prepared = [];
  let skipped = 0;
  for (const r of rows) {
    if (existing && existing.has(fpKey(r.title, r.author))) {
      skipped++;
      continue;
    }
    let coverPath = null;
    if (!DRY_RUN && !NO_COVERS && r.cover) {
      process.stdout.write(`  [${r.id}] ${r.title} 取封面… `);
      coverPath = await fetchCover(r.cover, r.id);
      console.log(coverPath ? '成功' : '跳过');
    }
    prepared.push({ ...r, coverPath });
  }
  if (skipped) console.log(`[导入] 跳过 ${skipped} 本(calibre 里已存在同名同作者)`);
  if (!DRY_RUN && prepared.length) console.log('');

  // 生成并执行命令
  let ok = 0, fail = 0;
  const failures = [];

  for (const r of prepared) {
    const tags = parseTags(r.tags);
    // 把阅读状态也做成标签,便于在 calibre 里筛
    const st = STATUS_TAG[r.status];
    if (st) tags.push(st);

    const args = ['add', '--empty', '--title', r.title];
    if (r.author) args.push('--authors', r.author);
    if (tags.length) args.push('--tags', tags.join(','));
    if (r.series) args.push('--series', r.series);
    if (r.isbn) args.push('--isbn', r.isbn);
    if (r.coverPath) args.push('--cover', r.coverPath);
    // 全局选项(库路径)必须放最后。注意正确的名字是 --library-path;
    // calibredb add **没有** --pubdate 选项(已核对 cmd_add.py 的 option_parser),
    // 出版年份等用 set_metadata 单独设,见脚本末尾提示。
    args.push('--library-path', LIBRARY);

    if (DRY_RUN) {
      console.log(`  # [${r.id}] ${r.title}`);
      console.log(`  ${CALIBREDB} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
      continue;
    }

    try {
      const out = run(args);
      process.stdout.write(`  [${r.id}] ${r.title} → ${out.trim().split('\n').pop()}\n`);
      ok++;
    } catch (err) {
      fail++;
      const msg = (err.stderr || err.message || '').toString().trim().split('\n').slice(-1)[0];
      failures.push({ id: r.id, title: r.title, msg });
      console.log(`  [${r.id}] ${r.title} ✗ ${msg}`);
    }
  }

  if (DRY_RUN) {
    console.log('');
    console.log('[导入] dry-run 结束。确认无误后加 --exec 执行。');
    return;
  }

  console.log('');
  console.log(`[导入] 成功 ${ok} 条,失败 ${fail} 条`);
  if (failures.length) {
    console.log('[导入] 失败清单:');
    for (const f of failures) console.log(`   [${f.id}] ${f.title}: ${f.msg}`);
  }
  console.log('');
  console.log('下一步:');
  console.log('  1) 验证库内容');
  console.log(`       calibredb list --library-path ${LIBRARY} --fields=title,authors,tags`);
  console.log('  2) 出版年份需单独设(calibredb add 没有 --pubdate 选项):');
  console.log(`       calibredb set_metadata <book_id> --field pubdate:2020-01-01 --library-path ${LIBRARY}`);
  console.log('  3) 迁移阅读记录(想读/在读/已读、读过几遍):');
  console.log('       node deploy/migrate-reading.js --dry-run');
}

main().catch((err) => {
  console.error('[导入] 失败:', err);
  process.exit(1);
});
