/* ============================================================
 * 合并书籍(数据层):字段/标签/记录/自定义值/标识符/文件/来源删除
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
const { mergeBooks } = require('../src/db/merge');

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-merge-'));
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
  search.reindexAll(db);
  return db;
}

function makeBook(db, opts = {}) {
  const ts = '2026-01-02T03:04:05.000Z';
  const r = db.prepare(`
    INSERT INTO books (title, author, status, tags, cover, summary, notes_url,
      read_count, read_logs, publisher, pub_year, rating, series, series_index,
      isbn, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.title || '书', opts.author || '', opts.status || 'wish',
    JSON.stringify(opts.tags || []), opts.cover || '', opts.summary || '',
    opts.notesUrl || '', opts.readCount || 0, JSON.stringify(opts.readLogs || []),
    opts.publisher || '', opts.pubYear || '', opts.rating || 0,
    opts.series || '', opts.seriesIndex || 0, opts.isbn || '', ts, ts,
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

function rawBook(db, id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

test('mergeBooks:合并字段/标签/记录/自定义值/标识符/文件,永久删除来源', () => {
  const db = freshDb();
  customFields.addColumn(db, {
    label: 'mood', name: '心情', datatype: 'text', is_multiple: false, options: [],
  });

  const target = makeBook(db, {
    title: '目标书', author: '作者', status: 'reading', tags: ['科幻'],
    cover: '', summary: '', notesUrl: '', publisher: '', pubYear: '', rating: 0,
    series: '', seriesIndex: 0, readLogs: [], formats: ['EPUB'],
  });
  const source = makeBook(db, {
    title: '来源书', author: '作者', status: 'done', tags: ['小说', '科幻'],
    cover: '/uploads/s.png', summary: '来源简介', notesUrl: '/notes/s',
    publisher: '来源社', pubYear: '2002', rating: 9,
    series: '基地', seriesIndex: 2,
    readLogs: [{ start: '2025-01-01', finish: '2025-01-05' }],
    readCount: 1, isbn: '9787536692930',
    identifiers: { goodreads: 'g1' }, formats: ['EPUB', 'PDF'],
  });
  customFields.setValues(db, source, { mood: '震撼' });

  const result = mergeBooks(db, target, [source]);
  assert.equal(result.ok, true);
  assert.equal(result.merged, 1);
  assert.equal(rawBook(db, source), undefined, '来源书应被永久删除');
  assert.equal(rawBook(db, source)?.deleted_at, undefined, '来源不应进回收站');

  const row = rawBook(db, target);
  assert.equal(row.title, '目标书');
  assert.equal(row.status, 'done');
  assert.deepEqual(JSON.parse(row.tags), ['科幻', '小说']);
  assert.equal(row.read_count, 1);
  assert.equal(row.finish_date, '2025-01-05');
  assert.equal(row.publisher, '来源社');
  assert.equal(row.pub_year, '2002');
  assert.equal(row.rating, 9);
  assert.equal(row.series, '基地');
  assert.equal(row.series_index, 2);
  assert.equal(row.cover, '/uploads/s.png');
  assert.equal(row.summary, '来源简介');
  assert.equal(row.notes_url, '/notes/s');
  assert.equal(row.isbn, '9787536692930', '目标无 ISBN 时用来源');

  assert.equal(customFields.getValues(db, target).mood, '震撼');
  const ids = identifiers.getIdentifiers(db, target);
  assert.equal(ids.goodreads, 'g1');
  assert.equal(ids.isbn, '9787536692930');

  const formats = bookFiles.listFiles(db, target).map((f) => f.format);
  assert.deepEqual(formats, ['EPUB', 'PDF'], '来源独有 PDF 应迁到目标');
  assert.equal(bookFiles.getFile(db, target, 'PDF').path, `${source}-pdf`);
  assert.equal(bookFiles.getFile(db, source, 'PDF'), null);

  assert.equal(search.searchBooks(db, { q: '小说' }).length >= 1, true, '合并后的标签应进入 FTS');
  assert.equal(categories.listTags(db).find((t) => t.name === '小说').count, 1);

  assert.equal(result.assets.length, 1);
  assert.deepEqual(result.assets[0].assets.ebookFiles, [`${source}-epub`], '来源重复格式随来源清理');
  assert.deepEqual(result.assets[0].assets.coverFiles, [], '封面已转给目标,不能删');
  db.close();
});

test('mergeBooks:目标已有值优先;缺失/回收站来源整体拒绝', () => {
  const db = freshDb();
  const target = makeBook(db, {
    title: '目标', author: '甲', rating: 8, publisher: '目标社',
    identifiers: { goodreads: 'target' }, formats: ['EPUB'],
  });
  const source = makeBook(db, {
    title: '来源', author: '甲', rating: 9, publisher: '来源社',
    identifiers: { goodreads: 'source' }, formats: ['EPUB', 'PDF'],
  });

  const ok = mergeBooks(db, target, [source]);
  assert.equal(ok.ok, true);
  const row = rawBook(db, target);
  assert.equal(row.rating, 8);
  assert.equal(row.publisher, '目标社');
  assert.equal(identifiers.getIdentifiers(db, target).goodreads, 'target', '目标标识符优先');
  assert.deepEqual(bookFiles.listFiles(db, target).map((f) => f.format), ['EPUB', 'PDF']);
  assert.deepEqual(ok.assets[0].assets.ebookFiles, [`${source}-epub`], '来源重复 EPUB 随来源清理');

  const before = rawBook(db, target);
  const missing = mergeBooks(db, target, [999999]);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_FOUND');
  assert.equal(rawBook(db, target).rating, before.rating);

  const trashed = makeBook(db, { title: '回收站里的' });
  books.softDeleteBook(db, trashed);
  const bad = mergeBooks(db, target, [trashed]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'NOT_FOUND');
  assert.equal(rawBook(db, target).title, '目标');
  db.close();
});
