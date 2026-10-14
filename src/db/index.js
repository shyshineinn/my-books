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

// v4:豆瓣元数据字段(来源:calibre 插件 NewDouban 的字段设计)
//     publisher / pub_year / isbn / rating(5分制,一位小数)/ douban_id
function migrateV4(db, dataDir) {
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  if (!cols.includes('publisher')) db.exec("ALTER TABLE books ADD COLUMN publisher TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('pub_year')) db.exec("ALTER TABLE books ADD COLUMN pub_year TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('isbn')) db.exec("ALTER TABLE books ADD COLUMN isbn TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('rating')) db.exec('ALTER TABLE books ADD COLUMN rating REAL NOT NULL DEFAULT 0');
  if (!cols.includes('douban_id')) db.exec("ALTER TABLE books ADD COLUMN douban_id TEXT NOT NULL DEFAULT ''");
}

// v5:阅读位置(路 B 第三层:进度记忆)
//     支撑「阅读进度跨会话恢复」——后续的书签/高亮/批注也复用同一套定位坐标。
//     locator 按 locator_kind 解释:EPUB 存 epub.js 给的 CFI 串,PDF 存 {page,offsetY} JSON。
//     device 分区:同一本书在不同设备各存各的位置,互不覆盖(换设备时由前端提示,不强行同步)。
//     外键 ON DELETE CASCADE:删书自动清掉其进度行(已启用 PRAGMA foreign_keys=ON)。
function migrateV5(db, dataDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS read_positions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      book         INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      format       TEXT    NOT NULL COLLATE NOCASE,
      device       TEXT    NOT NULL DEFAULT '',
      locator      TEXT    NOT NULL,
      locator_kind TEXT    NOT NULL DEFAULT 'epubcfi'
                           CHECK (locator_kind IN ('epubcfi','pdfpage')),
      pos_frac     REAL    NOT NULL DEFAULT 0,
      epoch        INTEGER NOT NULL,
      UNIQUE (book, format, device)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS read_positions_book_idx ON read_positions (book)');
}

// v6:注释(书签 / 高亮,「批注」= note 非空的 highlight)
//     两类而非三类:calibre 的实际模型只有 bookmark / highlight,批注是挂在
//     highlight 上的 notes 字段(见 core/annotation.js 头部说明)。
//     · 无 device 维度 —— 与 read_positions 有意不同:位置按设备分区,
//       注释是内容资产,应跨设备共享(calibre 同此取舍)。
//     · locator_kind + CHECK:与 read_positions 同款收口,防止「坐标与解释方式
//       错配」在注释表重演(该坑见 core/position.js:54-61 的注释)。
//     · 唯一键 (book,format,annot_type,annot_id) 支撑幂等 UPSERT。
//     · 本版不建 FTS 虚表:注释量级小,LIKE 足够;且 trigram 有 ≥3 字的硬限制
//       (实测 2 字命中 0 行),留到书内搜索那一期一起设计更省。
function migrateV6(db, dataDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS annotations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      book          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      format        TEXT    NOT NULL COLLATE NOCASE,
      annot_type    TEXT    NOT NULL CHECK (annot_type IN ('bookmark','highlight')),
      annot_id      TEXT    NOT NULL,
      locator_kind  TEXT    NOT NULL DEFAULT 'epubcfi'
                            CHECK (locator_kind IN ('epubcfi','pdfpage')),
      start_locator TEXT    NOT NULL,
      end_locator   TEXT    NOT NULL DEFAULT '',
      text          TEXT    NOT NULL DEFAULT '',
      note          TEXT    NOT NULL DEFAULT '',
      color         TEXT    NOT NULL DEFAULT 'yellow',
      chapter       TEXT    NOT NULL DEFAULT '',
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL,
      UNIQUE (book, format, annot_type, annot_id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS annotations_book_idx ON annotations (book)');
}

// v7:多文件支持 + 移除在线阅读
//     · 新表 book_files:一本书可挂多个电子书文件(如同时有 epub 与 pdf),
//       UNIQUE(book, format) —— 同一格式只保留一份,重新上传即覆盖替换
//       (与此前 books.file_* 三列的"重新上传 = 替换"语义一致)。
//       外键 ON DELETE CASCADE:删书自动清登记;磁盘文件由路由层负责删。
//     · 存量数据迁移:books.file_path/file_format/file_size → book_files 行。
//     · DROP read_positions / annotations:在线阅读功能下线,位置与批注
//       (书签/高亮/批注)数据随之删除(2026-10-14 经用户确认;删除前数据库
//       已由 deploy/backup-db.js 留档)。
function migrateV7(db, dataDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      book       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      format     TEXT    NOT NULL,
      path       TEXT    NOT NULL,
      size       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL,
      updated_at TEXT    NOT NULL,
      UNIQUE (book, format)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS book_files_book_idx ON book_files (book)');

  // 存量单文件数据迁入(幂等:有 file_path 的列才迁)
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  if (cols.includes('file_path')) {
    const rows = db.prepare(
      "SELECT id, file_path, file_format, file_size FROM books WHERE file_path != '' AND file_format != ''"
    ).all();
    const ins = db.prepare(`
      INSERT INTO book_files (book, format, path, size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(book, format) DO NOTHING
    `);
    const ts = new Date().toISOString();
    for (const r of rows) {
      ins.run(r.id, r.file_format.toUpperCase(), r.file_path, r.file_size || 0, ts, ts);
    }
  }

  // 在线阅读相关的表与列全部移除
  db.exec('DROP TABLE IF EXISTS annotations');
  db.exec('DROP TABLE IF EXISTS read_positions');
  db.exec('ALTER TABLE books DROP COLUMN file_path');
  db.exec('ALTER TABLE books DROP COLUMN file_format');
  db.exec('ALTER TABLE books DROP COLUMN file_size');
}

// 迁移注册表:顺序即版本。v1 = 基线;以后新 schema 变更追加 v2、v3……
const migrations = [migrateV1, migrateV2, migrateV3, migrateV4, migrateV5, migrateV6, migrateV7];

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
