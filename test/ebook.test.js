/* ============================================================
 * 电子书文件模块测试:
 *   · core/ebook.js 校验规则(格式白名单/大小/文件名生成)
 *   · v7 迁移(book_files 表存在;books 的 file_* 列已删)
 *   · db 登记层(listFiles/getFile/upsertFile/removeFile)
 *   · 存量数据迁移(file_* → book_files 行)
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateEbookFile, extOf, ebookFileName, EBOOK_FORMATS, EBOOK_MAX_SIZE } = require('../src/core/ebook.js');
const { openDb } = require('../src/db/index.js');
const bookFiles = require('../src/db/book_files.js');

/* ---------- core/ebook.js ---------- */

test('extOf:提取小写扩展名;无扩展名返回空', () => {
  assert.equal(extOf('三体.EPUB'), 'epub');
  assert.equal(extOf('a.b.c.pdf'), 'pdf');
  assert.equal(extOf('无扩展名'), '');
  assert.equal(extOf(''), '');
});

test('validateEbookFile:支持的格式全部通过', () => {
  for (const f of EBOOK_FORMATS) {
    const r = validateEbookFile(`书.${f}`, 1024);
    assert.equal(r.ok, true, `${f} 应通过`);
    assert.equal(r.format, f.toUpperCase());
  }
});

test('validateEbookFile:不支持格式与缺扩展名被拒', () => {
  assert.equal(validateEbookFile('a.exe', 10).ok, false);
  assert.equal(validateEbookFile('a.docx', 10).ok, false);
  assert.equal(validateEbookFile('noext', 10).ok, false);
});

test('validateEbookFile:空文件与超限文件被拒', () => {
  assert.equal(validateEbookFile('a.epub', 0).ok, false);
  assert.equal(validateEbookFile('a.epub', -1).ok, false);
  const r = validateEbookFile('a.epub', EBOOK_MAX_SIZE + 1);
  assert.equal(r.ok, false);
  assert.ok(/不能超过/.test(r.error));
});

test('ebookFileName:包含 bookId 与正确扩展名,随机防碰撞', () => {
  const a = ebookFileName(12, 'EPUB');
  const b = ebookFileName(12, 'EPUB');
  assert.ok(a.startsWith('12-'));
  assert.ok(a.endsWith('.epub'));
  assert.notEqual(a, b);
});

/* ---------- v7 迁移 + db 登记层 ---------- */

function openTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-ebook-test-'));
  const db = openDb(dir);
  return { dir, db };
}

function insertBook(db, title = '带文件的书') {
  const now = new Date().toISOString();
  const r = db.prepare(`
    INSERT INTO books (title, status, tags, read_logs, created_at, updated_at)
    VALUES (?, 'done', '[]', '[]', ?, ?)
  `).run(title, now, now);
  return r.lastInsertRowid;
}

test('v7 迁移:book_files 表存在;books 的 file_* 三列已删除', () => {
  const { dir, db } = openTestDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  assert.ok(tables.includes('book_files'), 'book_files 表应存在');
  assert.ok(!tables.includes('read_positions'), 'read_positions 应已删除');
  assert.ok(!tables.includes('annotations'), 'annotations 应已删除');

  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  for (const col of ['file_path', 'file_format', 'file_size']) {
    assert.ok(!cols.includes(col), `列 ${col} 应已删除`);
  }

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('book_files:登记 / 列表 / 查询 / 删除', () => {
  const { dir, db } = openTestDb();
  const id = insertBook(db);

  assert.deepEqual(bookFiles.listFiles(db, id), []);

  bookFiles.upsertFile(db, id, { format: 'EPUB', path: '12-a.epub', size: 1024 });
  bookFiles.upsertFile(db, id, { format: 'PDF', path: '12-b.pdf', size: 2048 });

  const files = bookFiles.listFiles(db, id);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.format), ['EPUB', 'PDF']); // 按格式名排序
  assert.equal(files[0].path, '12-a.epub');
  assert.equal(files[0].size, 1024);

  const one = bookFiles.getFile(db, id, 'PDF');
  assert.equal(one.path, '12-b.pdf');
  assert.equal(bookFiles.getFile(db, id, 'MOBI'), null);

  const byId = bookFiles.getFileById(db, files[0].id);
  assert.equal(byId.format, 'EPUB');

  // 删除单个格式
  assert.equal(bookFiles.removeFile(db, id, 'EPUB'), 1);
  assert.equal(bookFiles.listFiles(db, id).length, 1);
  // 删除全部
  assert.equal(bookFiles.removeFile(db, id), 1);
  assert.deepEqual(bookFiles.listFiles(db, id), []);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('book_files:同格式重复上传覆盖替换(UPSERT)', () => {
  const { dir, db } = openTestDb();
  const id = insertBook(db);

  const first = bookFiles.upsertFile(db, id, { format: 'EPUB', path: '12-old.epub', size: 111 });
  const second = bookFiles.upsertFile(db, id, { format: 'EPUB', path: '12-new.epub', size: 222 });

  assert.equal(second.id, first.id, 'UPSERT 后应仍是同一行');
  const files = bookFiles.listFiles(db, id);
  assert.equal(files.length, 1, '同格式只保留一份');
  assert.equal(files[0].path, '12-new.epub');
  assert.equal(files[0].size, 222);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('book_files:删书级联清理登记(ON DELETE CASCADE)', () => {
  const { dir, db } = openTestDb();
  const id = insertBook(db);
  bookFiles.upsertFile(db, id, { format: 'EPUB', path: '12-a.epub', size: 1024 });

  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  assert.deepEqual(bookFiles.listFiles(db, id), []);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v7 存量迁移:books.file_* 旧数据迁入 book_files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-mig-legacy-'));
  // 手工构造 v3 时代的库:有 file_* 三列、user_version=3、带一行文件数据
  const dbPath = path.join(dir, 'books.db');
  const legacy = new (require('node:sqlite').DatabaseSync)(dbPath);
  legacy.exec(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'wish',
      summary TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      start_date TEXT NOT NULL DEFAULT '',
      finish_date TEXT NOT NULL DEFAULT '',
      cover TEXT NOT NULL DEFAULT '',
      notes_url TEXT NOT NULL DEFAULT '',
      read_count INTEGER NOT NULL DEFAULT 0,
      read_logs TEXT NOT NULL DEFAULT '[]',
      file_path TEXT NOT NULL DEFAULT '',
      file_format TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO books (title, status, tags, file_path, file_format, file_size, created_at, updated_at)
    VALUES ('有文件的书', 'done', '[]', '5-old.epub', 'EPUB', 4096, '2024-01-01', '2024-01-02');
    INSERT INTO books (title, status, tags, created_at, updated_at)
    VALUES ('无文件的书', 'wish', '[]', '2024-02-01', '2024-02-02');
  `);
  legacy.close();

  const db = openDb(dir); // 触发 v4~v7 迁移
  const rows = db.prepare('SELECT id FROM books ORDER BY id').all();
  const files = bookFiles.listFiles(db, rows[0].id);
  assert.equal(files.length, 1);
  assert.equal(files[0].format, 'EPUB');
  assert.equal(files[0].path, '5-old.epub');
  assert.equal(files[0].size, 4096);
  // 无文件的书不产生登记行
  assert.deepEqual(bookFiles.listFiles(db, rows[1].id), []);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
