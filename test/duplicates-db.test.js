/* ============================================================
 * 重复书籍扫描(数据层):在架过滤 / 格式补充
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb } = require('../src/db/index.js');
const books = require('../src/db/books.js');
const search = require('../src/db/search.js');
const categories = require('../src/db/categories.js');
const bookFiles = require('../src/db/book_files.js');
const { listDuplicateGroups } = require('../src/db/duplicates');

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-dups-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function freshDb() {
  const db = openDb(tempDir());
  db.exec('DELETE FROM books');
  db.exec('DELETE FROM tags');
  db.exec('DELETE FROM authors');
  db.exec('DELETE FROM book_files');
  search.reindexAll(db);
  return db;
}

function makeBook(db, opts = {}) {
  const ts = '2026-01-02T03:04:05.000Z';
  const r = db.prepare(`
    INSERT INTO books (title, author, status, tags, isbn, publisher, pub_year, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.title || '书', opts.author || '', opts.status || 'wish',
    JSON.stringify(opts.tags || []), opts.isbn || '', opts.publisher || '',
    opts.pubYear || '', ts, ts,
  );
  const id = Number(r.lastInsertRowid);
  categories.syncBookTags(db, id, opts.tags || []);
  categories.syncBookAuthors(db, id, opts.author ? [opts.author] : []);
  categories.recomputeBookCaches(db, id);
  search.indexBook(db, db.prepare('SELECT * FROM books WHERE id = ?').get(id));
  return id;
}

test('listDuplicateGroups:返回在架重复组并补文件格式;回收站不参与', () => {
  const db = freshDb();
  const a = makeBook(db, { title: 'Dune', author: 'Frank Herbert', isbn: '' });
  const b = makeBook(db, { title: 'Dune', author: 'Frank Herbert', isbn: '' });
  makeBook(db, { title: 'Children of Dune', author: 'Frank Herbert', isbn: '' });
  const trashed = makeBook(db, { title: 'Dune', author: 'Frank Herbert', isbn: '' });
  books.softDeleteBook(db, trashed);
  bookFiles.upsertFile(db, a, { format: 'EPUB', path: 'a.epub', size: 10 });
  bookFiles.upsertFile(db, a, { format: 'PDF', path: 'a.pdf', size: 20 });

  const groups = listDuplicateGroups(db);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].books.map((x) => x.id), [a, b]);
  const first = groups[0].books.find((x) => x.id === a);
  assert.equal(first.file_formats, 'EPUB, PDF');
  assert.ok(!groups[0].books.some((x) => x.id === trashed));
  db.close();
});

test('listDuplicateGroups:无重复返回空数组', () => {
  const db = freshDb();
  makeBook(db, { title: '三体', author: '刘慈欣' });
  makeBook(db, { title: '活着', author: '余华' });
  assert.deepEqual(listDuplicateGroups(db), []);
  db.close();
});
