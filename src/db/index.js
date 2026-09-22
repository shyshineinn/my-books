/* ============================================================
 * 数据库入口:打开 node:sqlite、PRAGMA 加固、建表、**版本化迁移**、种子数据
 *
 * 迁移机制(借鉴 calibre db/schema_upgrades.py):
 *   · SQLite 的 PRAGMA user_version 记录 schema 版本(0 = 全新库)
 *   · migrations 数组按版本号递增排列,vN 表示"把库从 N-1 升到 N"
 *   · 整个升级包在一个事务里执行:任一步失败 ROLLBACK,不留半成品 schema
 *   · 幂等:已到最新版本的库直接跳过;重跑无副作用
 *
 * 新增 schema 变更的规矩:在 migrations 数组**末尾**追加一个函数,
 * 不要修改历史迁移(老库靠顺序重放); history 是永久的。
 *
 * 依赖方向纪律:本目录只 import node: 内置模块与 src/core,
 * 不 import express,不感知 HTTP 的存在。
 * ============================================================ */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const { samples } = require('./seed-data');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- PRAGMA 加固(借鉴 calibre db/backend.py Connection)---------- */
function applyPragmas(db) {
  // busy_timeout:写锁被占时忙等 10s 再报错,替代立即抛 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 10000');
  // WAL:读写不互斥,进程崩溃后下次打开自动恢复;伴随文件 -shm/-wal 已 gitignore
  db.exec('PRAGMA journal_mode = WAL');
  // foreign_keys:为将来跨表引用建立约束习惯
  db.exec('PRAGMA foreign_keys = ON');
}

/* ---------- 版本化迁移 ---------- */

// v1:基线 schema(等价于历史上"建表 + 补列 + 删列"的总和效果)
//     对全新库:直接建出完整表;对曾用旧逻辑升过级的老库:补列检查仍幂等兜底
function migrateV1(db, dataDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'wish' CHECK (status IN ('wish','reading','done')),
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      start_date TEXT NOT NULL DEFAULT '',
      finish_date TEXT NOT NULL DEFAULT '',
      cover TEXT NOT NULL DEFAULT '',
      notes_url TEXT NOT NULL DEFAULT '',
      read_count INTEGER NOT NULL DEFAULT 0,
      read_logs TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // 老库兜底:历史遗留的库可能缺列(旧逻辑时代建立的),逐一补齐;幂等
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  if (!cols.includes('notes_url')) db.exec("ALTER TABLE books ADD COLUMN notes_url TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('read_count')) db.exec('ALTER TABLE books ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('read_logs')) db.exec("ALTER TABLE books ADD COLUMN read_logs TEXT NOT NULL DEFAULT '[]'");
  if (!cols.includes('summary')) db.exec("ALTER TABLE books ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
  // 下线字段删除(review 被简介取代;rating 删前自动备份)
  if (cols.includes('review')) db.exec('ALTER TABLE books DROP COLUMN review');
  if (cols.includes('rating')) {
    const backup = path.join(dataDir, 'books.backup-before-drop-rating');
    if (!fs.existsSync(backup)) fs.copyFileSync(path.join(dataDir, 'books.db'), backup);
    db.exec('ALTER TABLE books DROP COLUMN rating');
  }

  // 全局设置表(心得仓库等)
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

// v2:建立独立全文检索层(对标 calibre db/fts + db/search.py)
//     外部内容 FTS5 虚表 books_fts(trigram 分词,中文子串友好),
//     建好后按主表全量灌索引。老库升级时直接吃现有数据,无需种子。
//     幂等:虚表 CREATE IF NOT EXISTS + reindexAll 清空前重写。
function migrateV2(db, dataDir) {
  const { createFts, reindexAll } = require('./search');
  createFts(db);
  reindexAll(db);
}

// v3:电子书文件字段(路 B 第一步:存储与阅读)
//     file_path  = 文件相对 books-files/ 目录的路径(如 `12-abc.epub`)
//     file_format = 大写格式名(EPUB/PDF/MOBI/AZW3/TXT…),空 = 未上传
//     file_size  = 字节数(列表/详情展示用,便于提示"文件过大"前自查)
function migrateV3(db, dataDir) {
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  if (!cols.includes('file_path')) db.exec("ALTER TABLE books ADD COLUMN file_path TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('file_format')) db.exec("ALTER TABLE books ADD COLUMN file_format TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('file_size')) db.exec('ALTER TABLE books ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0');
}

// 迁移注册表:顺序即版本。v1 = 基线;以后新 schema 变更追加 v2、v3……
const migrations = [migrateV1, migrateV2, migrateV3];

function runMigrations(db, dataDir) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current >= migrations.length) return { from: current, to: current, ran: 0 };

  const from = current;
  // 事务包裹:任一迁移失败整体回滚,不留半成品 schema(calibre 同款纪律)
  db.exec('BEGIN');
  try {
    for (let v = current; v < migrations.length; v++) {
      migrations[v](db, dataDir);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    err.message = `数据库迁移失败(版本 ${current} → ${migrations.length}):${err.message}`;
    throw err;
  }
  return { from, to: migrations.length, ran: migrations.length - from };
}

/* ---------- 打开数据库(工厂):默认项目 data/,测试可传临时目录 ---------- */
function openDb(dataDir = DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'books.db'));
  applyPragmas(db);

  const result = runMigrations(db, dataDir);
  if (result.ran > 0) {
    console.log(`[db] schema 迁移完成: v${result.from} → v${result.to}`);
  }

  // 种子数据:仅当书架为空(全新库)
  const count = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
  if (count === 0) {
    const insert = db.prepare(`
      INSERT INTO books (title, author, status, summary, tags, start_date, finish_date, cover, notes_url, read_count, read_logs, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const b of samples) {
      insert.run(b.title, b.author, b.status, b.summary || '', JSON.stringify(b.tags), b.start_date, b.finish_date, b.read_count, JSON.stringify(b.read_logs || []), now, now);
    }
  }
  return db;
}

/* ---------- 工具函数(与重构前导出一致)---------- */
function now() {
  return new Date().toISOString();
}

// 默认实例:应用主库。测试通过 openDb(tempDir) 建隔离实例,不经此路径
const db = openDb(DATA_DIR);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

module.exports = { db, now, getSetting, setSetting, openDb, runMigrations, migrations };
