/* ============================================================
 * CSV 目录组装测试:固定列 / 自定义字段 / 标识符 / 文件格式 / 筛选
 * 用 openDb(临时目录) 隔离,不碰真实库。
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
const identifiers = require('../src/db/identifiers.js');
const bookFiles = require('../src/db/book_files.js');
const customFields = require('../src/db/custom_fields.js');
const collections = require('../src/db/collections.js');
const { buildCatalog } = require('../src/db/catalog');

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-catalog-'));
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
  db.exec('DELETE FROM book_identifiers');
  db.exec('DELETE FROM book_files');
  db.exec('DELETE FROM book_collections; DELETE FROM collections');
  search.reindexAll(db);
  return db;
}

function makeBook(db, opts = {}) {
  const ts = '2026-01-02T03:04:05.000Z';
  const r = db.prepare(`
    INSERT INTO books (
      title, author, status, tags, cover, isbn, series, series_index,
      rating, publisher, pub_year, read_count, read_logs, summary, uuid,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.title || '书', opts.author || '', opts.status || 'done',
    JSON.stringify(opts.tags || []), opts.cover || '', opts.isbn || '',
    opts.series || '', opts.seriesIndex || 0, opts.rating || 0,
    opts.publisher || '', opts.pubYear || '', opts.readCount || 0,
    JSON.stringify(opts.readLogs || []), opts.summary || '',
    opts.uuid || '', ts, ts,
  );
  const id = Number(r.lastInsertRowid);
  categories.syncBookTags(db, id, opts.tags || []);
  categories.syncBookAuthors(db, id, opts.author ? [opts.author] : []);
  categories.recomputeBookCaches(db, id);
  if (opts.isbn || opts.identifiers) {
    identifiers.setIdentifiers(db, id, { isbn: opts.isbn, ...(opts.identifiers || {}) });
  }
  if (opts.formats) {
    for (const fmt of opts.formats) {
      bookFiles.upsertFile(db, id, { format: fmt, path: `${id}-${fmt.toLowerCase()}`, size: 10 });
    }
  }
  search.indexBook(db, db.prepare('SELECT * FROM books WHERE id = ?').get(id));
  return id;
}

function rowObject(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

test('buildCatalog:固定列 + 自定义字段 + 标识符 + 文件格式', () => {
  const db = freshDb();
  customFields.addColumn(db, {
    label: 'mood', name: '心情', datatype: 'text', is_multiple: false, options: [],
  });
  const id = makeBook(db, {
    title: '三体', author: '刘慈欣', tags: ['科幻', '小说'], status: 'done',
    series: '地球往事', seriesIndex: 2.5, rating: 9.5,
    publisher: '重庆出版社', pubYear: '2008', isbn: '9787536692930',
    identifiers: { goodreads: 'g1' },
    formats: ['EPUB', 'PDF'],
    readLogs: [{ start: '2025-01-01', finish: '2025-01-05' }],
    readCount: 1, summary: '给岁月以文明', cover: '/uploads/c.png',
    uuid: '11111111-1111-4111-8111-111111111111',
  });
  customFields.setValues(db, id, { mood: '震撼' });
  const read = collections.createCollection(db, '待读');
  const deep = collections.createCollection(db, '精读');
  collections.addBooks(db, read.id, [id]);
  collections.addBooks(db, deep.id, [id]);

  const { headers, rows } = buildCatalog(db, {});
  assert.equal(rows.length, 1);
  assert.ok(headers.includes('#mood'), '自定义字段应成为动态列');

  const row = rowObject(headers, rows[0]);
  assert.equal(row.title, '三体');
  assert.equal(row.author, '刘慈欣');
  assert.equal(row.status, 'done');
  assert.equal(row.status_label, '已读');
  assert.equal(row.tags, '小说, 科幻');
  assert.equal(row.collections, '待读, 精读');
  assert.equal(row.series, '地球往事');
  assert.equal(row.series_index, 2.5);
  assert.equal(row.rating, 9.5);
  assert.equal(row.publisher, '重庆出版社');
  assert.equal(row.pub_year, '2008');
  assert.equal(row.isbn, '9787536692930');
  assert.equal(row.file_formats, 'EPUB, PDF');
  assert.equal(row.identifiers, 'goodreads:g1; isbn:9787536692930');
  assert.equal(row.uuid, '11111111-1111-4111-8111-111111111111');
  assert.equal(row['#mood'], '震撼');
  assert.match(row.read_logs, /2025-01-05/);
  assert.equal(row.created_at, '2026-01-02T03:04:05.000Z');
  db.close();
});

test('buildCatalog:沿用列表筛选;回收站中的书不导出', () => {
  const db = freshDb();
  const doneId = makeBook(db, { title: '读完的', status: 'done' });
  makeBook(db, { title: '在读的', status: 'reading' });
  const trashedId = makeBook(db, { title: '已删除的', status: 'done' });
  books.softDeleteBook(db, trashedId);

  const done = buildCatalog(db, { status: 'done' });
  assert.deepEqual(done.rows.map((r) => r[done.headers.indexOf('id')]), [doneId]);

  const all = buildCatalog(db, {});
  assert.equal(all.rows.length, 2);
  assert.ok(!all.rows.some((r) => r[all.headers.indexOf('title')] === '已删除的'));
  db.close();
});

test('buildCatalog:空结果也返回完整表头(含自定义字段)', () => {
  const db = freshDb();
  customFields.addColumn(db, {
    label: 'pages', name: '页数', datatype: 'int', is_multiple: false, options: [],
  });
  const { headers, rows } = buildCatalog(db, { q: '根本不存在的书' });
  assert.deepEqual(rows, []);
  assert.ok(headers.includes('title'));
  assert.ok(headers.includes('#pages'));
  db.close();
});
