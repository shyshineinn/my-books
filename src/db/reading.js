/* ============================================================
 * 阅读记录库(第二数据库):独立 SQLite 文件 data/reading.db
 *
 * 为什么独立成库(而不是塞进 calibre 的 metadata.db):
 *   1) calibre 的 schema 依赖它用 apsw 注册的 Python 函数(title_sort / uuid4 /
 *      books_list_filter,见 calibre db/backend.py:426-431)。往那边写会触发
 *      books_insert_trg → 调 title_sort(),我们这边没有该函数 → 报错/坏数据。
 *   2) calibre 不用 WAL,它的连接靠 busy_timeout 串行化;我们要自己控制
 *      日志模式与并发策略,独立库更干净。
 *   3) calibre 升级会改 schema;i 记录属于"我的阅读生活",不该被外部升级裹挟。
 *
 * 关联键:calibre_uuid → calibre books.uuid(稳定,见 core/reading.js 顶部说明)
 *
 * 迁移机制(沿用本项目既有纪律,见 db/index.js):
 *   · PRAGMA user_version 记录 schema 版本
 *   · migrations 数组按版本递增,vN 表示"从 N-1 升到 N"
 *   · 整个升级包在事务里,任一步失败 ROLLBACK
 * ============================================================ */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// READING_DATA_DIR 供测试注入临时目录,避免碰到真实 data/
const DATA_DIR = process.env.READING_DATA_DIR || path.join(__dirname, '..', '..', 'data');

/* ---------- PRAGMA 加固 ---------- */
function applyPragmas(db) {
  // busy_timeout:写锁被占时忙等 10s(与 calibre 同值)
  db.exec('PRAGMA busy_timeout = 10000');
  // WAL:读写不互斥,崩溃自动恢复。这是**我们自己的**库,可以放心用 WAL
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
}

/* ---------- 版本化迁移 ---------- */

// v1:阅读记录基线
//     calibre_uuid 作主键 —— 一本书一行。
//     书在 calibre 里被删除时,这一行**保留**(删掉书不该抹掉"我读过它"的历史);
//     孤儿行由 listOrphans/清理接口处理。
function migrateV1(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reading (
      calibre_uuid TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'wish'
                   CHECK (status IN ('wish','reading','done')),
      read_count   INTEGER NOT NULL DEFAULT 0,
      read_logs    TEXT NOT NULL DEFAULT '[]',
      start_date   TEXT NOT NULL DEFAULT '',
      finish_date  TEXT NOT NULL DEFAULT '',
      notes_url    TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);
  // 列表页最常用的三种排序 + 状态筛选
  db.exec('CREATE INDEX IF NOT EXISTS reading_status_idx ON reading (status)');
  db.exec('CREATE INDEX IF NOT EXISTS reading_finish_idx ON reading (finish_date)');
  db.exec('CREATE INDEX IF NOT EXISTS reading_updated_idx ON reading (updated_at)');
}

const migrations = [migrateV1];

function runMigrations(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current >= migrations.length) return { from: current, to: current, ran: 0 };

  const from = current;
  db.exec('BEGIN');
  try {
    for (let v = current; v < migrations.length; v++) {
      migrations[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    err.message = `阅读库迁移失败(版本 ${current} → ${migrations.length}):${err.message}`;
    throw err;
  }
  return { from, to: migrations.length, ran: migrations.length - from };
}

/* ---------- 打开(工厂):默认 data/reading.db,测试可传临时目录 ---------- */
function openReadingDb(dataDir = DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'reading.db'));
  applyPragmas(db);
  const result = runMigrations(db);
  if (result.ran > 0) {
    console.log(`[reading] schema 迁移完成: v${result.from} → v${result.to}`);
  }
  return db;
}

const db = openReadingDb(DATA_DIR);

/* ---------- 读写 ---------- */

function nowIso() {
  return new Date().toISOString();
}

// 取一行;不存在返回 null
function getReading(uuid) {
  const row = db.prepare('SELECT * FROM reading WHERE calibre_uuid = ?').get(uuid);
  return row || null;
}

// 批量取(uuid 数组)→ Map,供列表页一次补齐所有状态,避免 N+1
function getReadings(uuids) {
  const list = (uuids || []).filter(Boolean);
  if (!list.length) return new Map();
  // SQLite 变量数上限约 999;分批查询
  const BATCH = 500;
  const out = new Map();
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const ph = batch.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM reading WHERE calibre_uuid IN (${ph})`)
      .all(...batch);
    for (const r of rows) out.set(r.calibre_uuid, r);
  }
  return out;
}

// 幂等写入(values 来自 core/parseReading 的规范化输出)。
// 已存在则保留 created_at,更新其余字段 + updated_at。
function upsertReading(uuid, values) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO reading (calibre_uuid, status, read_count, read_logs, start_date, finish_date, notes_url, created_at, updated_at)
    VALUES (@uuid, @status, @read_count, @read_logs, @start_date, @finish_date, @notes_url, @ts, @ts)
    ON CONFLICT(calibre_uuid) DO UPDATE SET
      status      = excluded.status,
      read_count  = excluded.read_count,
      read_logs   = excluded.read_logs,
      start_date  = excluded.start_date,
      finish_date = excluded.finish_date,
      notes_url   = excluded.notes_url,
      updated_at  = excluded.updated_at
  `).run({ ...values, uuid, ts });
  return getReading(uuid);
}

// 只改状态(前端"切换已读"这类高频轻操作,不必传整个对象)
function setStatus(uuid, status) {
  db.prepare('UPDATE reading SET status = ?, updated_at = ? WHERE calibre_uuid = ?')
    .run(status, nowIso(), uuid);
  return getReading(uuid);
}

function deleteReading(uuid) {
  return db.prepare('DELETE FROM reading WHERE calibre_uuid = ?').run(uuid).changes > 0;
}

// 全量行(统计用;个人库量级小,全表扫描即可)
function allReadings() {
  return db.prepare('SELECT status, read_count, read_logs, finish_date FROM reading').all();
}

// 找出"在 calibre 里已不存在"的孤儿行(传现存 uuid 集合),供清理
function listOrphans(existingUuids) {
  const have = new Set(existingUuids || []);
  return db.prepare('SELECT calibre_uuid FROM reading').all()
    .map((r) => r.calibre_uuid)
    .filter((u) => !have.has(u));
}

/* 关闭默认库连接。
   用途:① 测试收尾时释放文件句柄(Windows 上句柄未释放会 EPERM 删不掉临时目录);
        ② 进程优雅退出。关闭后 getReading 等接口不可再用。 */
function closeReadingDb() {
  try { db.close(); } catch { /* 已关闭则忽略 */ }
}

module.exports = {
  db,
  openReadingDb,
  closeReadingDb,
  runMigrations,
  migrations,
  getReading,
  getReadings,
  upsertReading,
  setStatus,
  deleteReading,
  allReadings,
  listOrphans,
};
