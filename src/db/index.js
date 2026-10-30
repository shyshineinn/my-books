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

const { DATA_DIR } = require('../core/paths');
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

// v8:评分改为 10 分制(与豆瓣原始分一致,不再折半)
//     存量数据曾按「豆瓣 10 分折半」存 5 分制(clampRating 旧版封顶 5),
//     ×2 还原为 10 分制;曾因折算进位丢过精度的值(8.9→4.5)只能近似还原(→9.0)。
//     rating = 0 表示未评分,不迁移。
function migrateV8(db, dataDir) {
  db.exec('UPDATE books SET rating = min(10, round(rating * 2, 1)) WHERE rating > 0');
}

// v9:标签 / 作者归一化(对标 calibre categories)
//     · 新表 tags / book_tags / authors / book_authors 成为真源;
//       books.tags、books.author 降级为「派生缓存」(展示 / FTS / 统计 / 前端零改动),
//       新增 books.author_sort 缓存(首位作者,供按作者排序)。
//     · 回填:按现有 tags JSON 与 author 串建链接,再回写规范化缓存;
//       author 若含多作者分隔符会被拆开并「、」重组 → 缓存变化,故随后 reindexAll。
//     · 纯增量:回退只需 DROP 四表 + 删 author_sort 列,books 原列与数据不动。
function migrateV9(db, dataDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE IF NOT EXISTS book_tags (
      book INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      tag  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
      PRIMARY KEY (book, tag)
    );
    CREATE INDEX IF NOT EXISTS book_tags_tag_idx ON book_tags (tag);
    CREATE TABLE IF NOT EXISTS authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      sort TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS book_authors (
      book   INTEGER NOT NULL REFERENCES books(id)   ON DELETE CASCADE,
      author INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (book, author)
    );
    CREATE INDEX IF NOT EXISTS book_authors_author_idx ON book_authors (author);
  `);
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  if (!cols.includes('author_sort')) db.exec("ALTER TABLE books ADD COLUMN author_sort TEXT NOT NULL DEFAULT ''");

  require('./categories').rebuildAll(db);
  require('./search').reindexAll(db);
}

// v10:保存的搜索 / 虚拟图书馆(对标 calibre db/library_item.py)
//     一行 = 一条命名查询:query 存原始语法串(交给 core/query 现解析),
//     sort 存排序白名单键(空则用默认 updated)。name 大小写不敏感唯一。
//     纯增量:回退只需 DROP 本表,不碰任何既有数据。
function migrateV10(db, dataDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      query      TEXT NOT NULL DEFAULT '',
      sort       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

// v11:自定义字段(对标 calibre custom_columns + FieldMetadata 注册表)
//     用户可运行时增删字段,不必再改代码加列 —— 这是 A 组「数据模型」的地基。
//
//     两张表,语义分别是"定义"与"取值":
//       custom_columns      字段注册表(label 机器名 / name 显示名 / datatype /
//                           is_multiple / options / 排序 / 软删除标记)
//       book_custom_values  取值表,PK(book, column) —— 一本书一个字段一行
//
//     与 calibre 的差异(有意为之,理由见 core/custom_fields.js 头部):
//     calibre 给每个字段建独立物理表 custom_column_N;本项目用单张值表,
//     因为"schema 只由 migrations 定义"是既有不变量,运行时 DDL 会破坏它。
//
//     健壮性要点(均取自 calibre 的写法):
//       · datatype 列带 CHECK 白名单 —— 非法类型进不了库(calibre 靠 Python 侧校验,
//         这里再加一道 schema 级防线;两份清单由测试钉死一致)
//       · label 唯一且 COLLATE NOCASE —— 大小写不同视为同一个字段
//       · 值表对 book / column 双外键 + ON DELETE CASCADE —— 删书/删字段自动清值,
//         不留孤儿行(本项目已开 PRAGMA foreign_keys=ON)
//       · 删字段是"软删除"(mark_for_delete=1),值先保留,由调用方决定何时物理清
function migrateV11(db, dataDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_columns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      label           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      name            TEXT    NOT NULL,
      datatype        TEXT    NOT NULL
                              CHECK (datatype IN ('text','comments','int','float','bool','date','rating','enumeration','series')),
      is_multiple     INTEGER NOT NULL DEFAULT 0 CHECK (is_multiple IN (0,1)),
      options         TEXT    NOT NULL DEFAULT '[]',
      display_order   INTEGER NOT NULL DEFAULT 0,
      mark_for_delete INTEGER NOT NULL DEFAULT 0 CHECK (mark_for_delete IN (0,1)),
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_custom_values (
      book       INTEGER NOT NULL REFERENCES books(id)          ON DELETE CASCADE,
      column_id  INTEGER NOT NULL REFERENCES custom_columns(id) ON DELETE CASCADE,
      value      TEXT    NOT NULL DEFAULT '',
      updated_at TEXT    NOT NULL,
      PRIMARY KEY (book, column_id)
    )
  `);
  // 按字段检索(如 #series:"基地")时按 column_id 过滤,建索引
  db.exec('CREATE INDEX IF NOT EXISTS book_custom_values_col_idx ON book_custom_values (column_id)');
}

// v12:A 组剩余数据模型(系列 / 标识符 / uuid / 排序键)
//
//     · books.series / books.series_index —— 系列与系列序号,对标 calibre
//       (metadata_sqlite.sql:12 的 series_index REAL DEFAULT 1.0)。
//       序号用 REAL:中篇插队很常见(第 2.5 册)。
//       不建 series 值表:一本书只属于一个系列(calibre 也是 UNIQUE(book)),
//       改名/合并用一条 UPDATE 即可,"带计数的系列列表"用 GROUP BY 即可。
//     · books.title_sort —— 书名排序键(剥引号 + 英语冠词移位),
//       对标 calibre title_sort()(ebooks/metadata/__init__.py:203-228)。
//       改造前直接 ORDER BY title,导致 "The Hobbit" 排在 T 组。
//     · books.uuid —— 单本稳定标识,对标 calibre books.uuid
//       (schema_upgrades.py:204 的 ALTER TABLE books ADD COLUMN uuid TEXT)。
//       用途:跨库/导入导出时识别"同一本书",不受自增 id 变化影响。
//     · book_identifiers —— 任意类型的标识符(isbn/goodreads/doi…),
//       对标 calibre identifiers 表 UNIQUE(book,type)
//       (metadata_sqlite.sql:105-110)。isbn/douban_id 两列**保留**
//       (豆瓣抓取/FTS/前端都在用),新表承接**其余**类型,避免牵动既有链路。
//
//     回填:title_sort 按现有 title 算;uuid 逐行生成;series 相关列默认空。
function migrateV12(db, dataDir) {
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);

  if (!cols.includes('series')) {
    db.exec("ALTER TABLE books ADD COLUMN series TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('series_index')) {
    // REAL NOT NULL DEFAULT 0:0 表示"未指定序号"(calibre 默认 1.0,
    // 但那是"第一个"的语义;本项目用 0 区分"没填",展示时不显示 #)
    db.exec('ALTER TABLE books ADD COLUMN series_index REAL NOT NULL DEFAULT 0');
  }
  if (!cols.includes('title_sort')) {
    db.exec("ALTER TABLE books ADD COLUMN title_sort TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('uuid')) {
    db.exec("ALTER TABLE books ADD COLUMN uuid TEXT NOT NULL DEFAULT ''");
  }

  db.exec('CREATE INDEX IF NOT EXISTS books_series_idx ON books (series COLLATE NOCASE)');
  db.exec('CREATE INDEX IF NOT EXISTS books_title_sort_idx ON books (title_sort COLLATE NOCASE)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS book_identifiers (
      book  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      type  TEXT    NOT NULL COLLATE NOCASE,
      value TEXT    NOT NULL DEFAULT '',
      PRIMARY KEY (book, type)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS book_identifiers_type_idx ON book_identifiers (type, value COLLATE NOCASE)');

  // 回填 title_sort / uuid。注意:迁移里**不能** require core/sort_keys 吗?
  // 可以 —— src/db/ 依赖 src/core/ 是本项目的既定方向(见 db/categories.js
  // 依赖 core/book.js)。但为让"迁移重放"结果与"当时代码"解耦,这里用同一份
  // 纯函数:它是确定性的,重放历史库得到同样结果(与 migrateV8 的评分折算同理)。
  const { titleSort } = require('../core/sort_keys');
  const rows = db.prepare("SELECT id, title, uuid FROM books").all();
  const updSort = db.prepare('UPDATE books SET title_sort = ? WHERE id = ?');
  const updUuid = db.prepare('UPDATE books SET uuid = ? WHERE id = ?');
  const crypto = require('node:crypto');
  for (const r of rows) {
    updSort.run(titleSort(r.title), r.id);
    if (!r.uuid) updUuid.run(crypto.randomUUID(), r.id);
  }

  // 把 isbn / douban_id 两列同步进 identifiers 表(双写的第一半:
  // 让新表成为"全部标识符"的完整视图,读的时候只需查新表 + 兜底旧列)
  const withIds = db.prepare("SELECT id, isbn, douban_id FROM books WHERE isbn <> '' OR douban_id <> ''").all();
  const insId = db.prepare(`
    INSERT INTO book_identifiers (book, type, value) VALUES (?, ?, ?)
    ON CONFLICT(book, type) DO NOTHING
  `);
  for (const r of withIds) {
    if (r.isbn) insId.run(r.id, 'isbn', String(r.isbn).trim());
    if (r.douban_id) insId.run(r.id, 'douban', String(r.douban_id).trim());
  }
}

// v13:回收站(对标 calibre 的“最近删除”,保留 14 天)。
//
// calibre 的删除是“把书目录移到 .trash 再删数据库行”,恢复时从 OPF 重建
// (db/backend.py:move_book_to_trash / move_book_from_trash)。本项目不能照搬:
// 元数据真源是规范化后的 SQLite(标签/作者链接、自定义字段、标识符、阅读
// 记录),书目录里没有自包含的 OPF;硬删行后这些关系无处可取。因此改用
// 墓碑列保留整行与全部关联数据,恢复只需一条 UPDATE,查询层统一过滤。
// 生命周期与 calibre 对齐:14 天保留、可恢复、可彻底删除。
function migrateV13(db, dataDir) {
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  if (!cols.includes('deleted_at')) db.exec('ALTER TABLE books ADD COLUMN deleted_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS books_deleted_idx ON books (deleted_at)');
}

// v14:虚拟书库(对标 calibre library_item.is_virtual)。
//     「保存的搜索」只是命名查询;打上 is_virtual 后它才成为虚拟书库 ——
//     可以用 ?vl=名称 或 `vl:名称` 把整套视图(列表/分类计数/统计/导出)收进去。
//     纯增量:回退只需忽略本列。
function migrateV14(db, dataDir) {
  const cols = db.prepare('PRAGMA table_info(saved_searches)').all().map((c) => c.name);
  if (!cols.includes('is_virtual')) {
    db.exec('ALTER TABLE saved_searches ADD COLUMN is_virtual INTEGER NOT NULL DEFAULT 0 CHECK (is_virtual IN (0,1))');
  }
}

// v15:读书心得改为**服务器存储**(notes-files/{id}.md),下线 GitHub 链接机制。
//     · books.notes_url 列删除 —— 它存的是"GitHub 上的 md 文件链接",
//       心得正文如今由 notes-files/{id}.md 承载(见 src/db/notes.js),
//       这个链接字段再无读写方,留着只会让人误以为心得还在 GitHub 上。
//     · settings 表删除 —— 它只为心得仓库(notes_repo / notes_branch)存在,
//       仓库配置随 /api/settings 端点一起下线。
//     回退只需把这两样加回来(数据本身在 notes-files/ 里,不依赖 schema)。
function migrateV15(db, dataDir) {
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  if (cols.includes('notes_url')) db.exec('ALTER TABLE books DROP COLUMN notes_url');
  db.exec('DROP TABLE IF EXISTS settings');
}

// v16:书目版本与持久删除记录。触发器覆盖批量操作、分类、文件、自定义字段等写入路径。
function migrateV16(db) {
  if (!db.prepare('PRAGMA table_info(books)').all().some((column) => column.name === 'revision')) {
    db.exec('ALTER TABLE books ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)');
  }
  const crypto = require('node:crypto');
  for (const row of db.prepare("SELECT id FROM books WHERE uuid = ''").all()) {
    db.prepare('UPDATE books SET uuid = ? WHERE id = ?').run(crypto.randomUUID(), row.id);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS book_deletions (
      id INTEGER PRIMARY KEY, uuid TEXT NOT NULL,
      revision INTEGER NOT NULL, deleted_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO book_deletions SELECT id, uuid, revision, deleted_at FROM books WHERE deleted_at IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS books_revision AFTER UPDATE ON books WHEN NEW.revision = OLD.revision BEGIN
      UPDATE books SET revision = OLD.revision + 1,
        updated_at = CASE WHEN NEW.updated_at = OLD.updated_at THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NEW.updated_at END
        WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS books_soft_delete_event AFTER UPDATE OF deleted_at ON books WHEN NEW.deleted_at IS NOT NULL BEGIN
      INSERT INTO book_deletions(id, uuid, revision, deleted_at)
        VALUES(NEW.id, NEW.uuid, MAX(NEW.revision, OLD.revision + 1), NEW.deleted_at)
        ON CONFLICT(id) DO UPDATE SET uuid=excluded.uuid, revision=excluded.revision, deleted_at=excluded.deleted_at;
    END;
    CREATE TRIGGER IF NOT EXISTS books_restore_event AFTER UPDATE OF deleted_at ON books WHEN NEW.deleted_at IS NULL BEGIN
      DELETE FROM book_deletions WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS books_hard_delete_event AFTER DELETE ON books BEGIN
      INSERT INTO book_deletions(id, uuid, revision, deleted_at)
        VALUES(OLD.id, OLD.uuid, OLD.revision + 1, COALESCE(OLD.deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
        ON CONFLICT(id) DO UPDATE SET uuid=excluded.uuid, revision=excluded.revision, deleted_at=excluded.deleted_at;
    END;
  `);
  db.prepare("INSERT OR IGNORE INTO sync_metadata(key, value) VALUES('library_id', ?)").run(crypto.randomUUID());
  for (const table of ['book_files', 'book_identifiers', 'book_custom_values']) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const ids = operation === 'UPDATE' ? 'OLD.book, NEW.book' : operation === 'DELETE' ? 'OLD.book' : 'NEW.book';
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_revision_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
        UPDATE books SET revision=revision+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (${ids});
      END;`);
    }
  }
}

// v17:单调变更日志与安卓阅读数据。检查点随机值可识别备份恢复后的序号复用。
function migrateV17(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL, uuid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('book','reading')),
      checkpoint TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    );
    CREATE INDEX IF NOT EXISTS sync_changes_book_idx ON sync_changes(book_id, seq);
    CREATE TABLE IF NOT EXISTS mobile_reading_state (
      book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      book_uuid TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
      data TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO sync_changes(book_id, uuid, kind) SELECT id, uuid, 'book' FROM books b
      WHERE NOT EXISTS(SELECT 1 FROM sync_changes c WHERE c.book_id=b.id AND c.kind='book');
    INSERT INTO sync_changes(book_id, uuid, kind) SELECT id, uuid, 'book' FROM book_deletions
      WHERE id NOT IN (SELECT id FROM books) AND NOT EXISTS(SELECT 1 FROM sync_changes c WHERE c.book_id=book_deletions.id AND c.kind='book');
    CREATE TRIGGER IF NOT EXISTS books_sync_insert AFTER INSERT ON books BEGIN
      INSERT INTO sync_changes(book_id,uuid,kind) VALUES(NEW.id,NEW.uuid,'book');
    END;
    CREATE TRIGGER IF NOT EXISTS books_sync_update AFTER UPDATE ON books
      WHEN NEW.revision != OLD.revision OR NEW.deleted_at IS NOT OLD.deleted_at BEGIN
      INSERT INTO sync_changes(book_id,uuid,kind) VALUES(NEW.id,NEW.uuid,'book');
    END;
    CREATE TRIGGER IF NOT EXISTS books_sync_delete AFTER DELETE ON books BEGIN
      INSERT INTO sync_changes(book_id,uuid,kind) VALUES(OLD.id,OLD.uuid,'book');
    END;
    CREATE TRIGGER IF NOT EXISTS mobile_reading_sync_insert AFTER INSERT ON mobile_reading_state BEGIN
      INSERT INTO sync_changes(book_id,uuid,kind) VALUES(NEW.book_id,NEW.book_uuid,'reading');
    END;
    CREATE TRIGGER IF NOT EXISTS mobile_reading_sync_update AFTER UPDATE ON mobile_reading_state BEGIN
      INSERT INTO sync_changes(book_id,uuid,kind) VALUES(NEW.book_id,NEW.book_uuid,'reading');
    END;
  `);
}

// v18:与安卓可移植快照相同的个人资料、设置和书架状态；资源始终由会话保护。
function migrateV18(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_portable_state (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>0),
      data TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mobile_portable_assets (
      file_name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

// v19:自定义字段数值影子列。
// VIRTUAL 生成列由 value 自动派生,不需要改写入路径、也不重写旧表;
// 索引让 #页数:>=300 这类范围筛选走 (column_id, value_num),
// 不再对每个值做 CAST 全扫。空值保持 NULL,不参与数值比较。
function migrateV19(db) {
  // 迁移测试会把 user_version 回拨重放,这里必须幂等(ALTER 不支持 IF NOT EXISTS)
  // table_info 不列生成列,必须用 table_xinfo 才看得见 value_num
  const cols = db.prepare('PRAGMA table_xinfo(book_custom_values)').all().map((c) => c.name);
  if (!cols.includes('value_num')) {
    db.exec(`
      ALTER TABLE book_custom_values
        ADD COLUMN value_num REAL GENERATED ALWAYS AS (
          CASE WHEN value <> '' THEN CAST(value AS REAL) END
        ) VIRTUAL;
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS book_custom_values_num_idx
      ON book_custom_values (column_id, value_num);
  `);
}

// v20:电子书文件持久化 SHA-256。
// 新上传直接写入;旧行留空,下载时按实际文件回填;供后续完整性/孤儿扫描使用。
function migrateV20(db) {
  const cols = db.prepare('PRAGMA table_info(book_files)').all().map((c) => c.name);
  if (!cols.includes('sha256')) {
    db.exec("ALTER TABLE book_files ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''");
  }
}

// v21:文件摘要回填属于完整性元数据,不应推动书目 revision。
// 收窄 v16 的 book_files 更新触发器:只有书、格式、路径或大小变化才记书目变更。
function migrateV21(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS book_files_revision_update;
    CREATE TRIGGER book_files_revision_update AFTER UPDATE ON book_files
      WHEN OLD.book IS NOT NEW.book OR OLD.format IS NOT NEW.format
        OR OLD.path IS NOT NEW.path OR OLD.size IS NOT NEW.size
    BEGIN
      UPDATE books SET revision=revision+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (OLD.book, NEW.book);
    END;
  `);
}

// v22:手动藏书集。成员关系独立于 tags,不触发书目 revision。
function migrateV22(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_collections (
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      added_at      TEXT NOT NULL,
      PRIMARY KEY (collection_id, book_id)
    );
    CREATE INDEX IF NOT EXISTS book_collections_book_idx ON book_collections(book_id);
  `);
}

// 迁移注册表:顺序即版本，历史迁移保持不变。
const migrations = [migrateV1, migrateV2, migrateV3, migrateV4, migrateV5, migrateV6, migrateV7, migrateV8, migrateV9, migrateV10, migrateV11, migrateV12, migrateV13, migrateV14, migrateV15, migrateV16, migrateV17, migrateV18, migrateV19, migrateV20, migrateV21, migrateV22];

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
function openDb(dataDir = DATA_DIR, { seedDemo = process.env.MYBOOKS_SEED_DEMO === 'true' } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'books.db');

  // 判"新库"要看**打开之前**库文件是否存在,而不是打开之后书架是否为空:
  //   · 用"表为空"当条件 → 用户把书删光后,下次 pm2 restart / 部署重启
  //     会把 17 本示例书整批塞回来(实测过的坑:删干净 = 复活)
  //   · 用"文件不存在"当条件 → 全新库才播种;老库哪怕被清空也保持空着
  // 只判存在性即可:空文件同样由迁移建表,种子只在真正的第一次启动写入。
  const isNewLibrary = !fs.existsSync(dbPath);

  const db = new DatabaseSync(dbPath);
  applyPragmas(db);

  const result = runMigrations(db, dataDir);
  if (result.ran > 0) {
    console.log(`[db] schema 迁移完成: v${result.from} → v${result.to}`);
  }

  // 检索用的自定义 SQL 函数:真正的正则 + 列侧字符折叠。
  // node:sqlite 的 function() 在旧版本不存在;不支持时 search.js 退回 LIKE 近似。
  if (typeof db.function === 'function') {
    const { foldVariants } = require('./search');
    db.function('regexp', { deterministic: true }, (pattern, value) => {
      const p = String(pattern == null ? '' : pattern);
      if (p.length > 200) return 0; // 防 ReDoS:超长正则直接不命中
      try {
        return new RegExp(p).test(String(value == null ? '' : value)) ? 1 : 0;
      } catch {
        return 0; // 非法正则按不命中处理,不让整条查询报错
      }
    });
    db.function('fold_variants', { deterministic: true }, (value) => foldVariants(value));
    db.__mybooksFns = true;
  }

  // 种子数据:仅当这是一个全新的库文件(与书架当前是否为空无关)
  if (isNewLibrary && seedDemo) {
    const insert = db.prepare(`
      INSERT INTO books (title, author, status, summary, tags, start_date, finish_date, cover, read_count, read_logs, created_at, updated_at, uuid)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
    `);
    const nowTs = now();
    for (const b of samples) {
      insert.run(b.title, b.author, b.status, b.summary || '', JSON.stringify(b.tags), b.start_date, b.finish_date, b.read_count, JSON.stringify(b.read_logs || []), nowTs, nowTs, require('node:crypto').randomUUID());
    }
    // 种子走裸 INSERT,绕过了 books.js 的 addBook 同步路径,故此处显式补两步:
    //   · rebuildAll:按种子的 tags/author 建归一化链接与缓存(含 author_sort)
    //   · reindexAll:把种子灌进 FTS(历史上新库种子从未进全文索引,一并修正)
    require('./categories').rebuildAll(db);
    require('./search').reindexAll(db);
  }
  return db;
}

/* ---------- 工具函数(与重构前导出一致)---------- */
function now() {
  return new Date().toISOString();
}

// 事务包裹助手(嵌套安全)。
// 为什么需要:本项目的写入路径有三层 —— routes(可能已开事务,如 categories)、
// db/books(自己要保证"主表 + 关联表"原子)、db 内部的同步函数。
// 若各层都无脑 BEGIN,SQLite 会报 "cannot start a transaction within a transaction"。
// 所以:已在事务中就直接执行(并入外层事务,由外层决定提交/回滚),
// 否则自己开一个。用 db.isTransaction 判断,不靠自己维护计数器 ——
// 计数器在异常路径上极易与实际状态失同步。
function inTransaction(handleDb, fn) {
  if (handleDb.isTransaction) return fn();
  handleDb.exec('BEGIN');
  try {
    const out = fn();
    handleDb.exec('COMMIT');
    return out;
  } catch (err) {
    try { handleDb.exec('ROLLBACK'); } catch { /* 回滚失败则保留原始错误 */ }
    throw err;
  }
}

// 默认实例:应用主库。测试通过 openDb(tempDir) 建隔离实例,不经此路径
const db = openDb(DATA_DIR);

module.exports = { db, now, openDb, runMigrations, migrations, inTransaction };
