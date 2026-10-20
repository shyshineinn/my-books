/* ============================================================
 * 回收站(v13,对标 calibre “最近删除”)行为测试
 *
 * 覆盖:迁移、软删除后的过滤矩阵、恢复(含 ISBN 冲突)、彻底删除、
 *       共享封面保护、过期清理、磁盘资产清理。
 * 全部使用 openDb(临时目录) 隔离,不碰生产 data/ 与真实 uploads/。
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb, migrations } = require('../src/db/index.js');
const books = require('../src/db/books.js');
const search = require('../src/db/search.js');
const categories = require('../src/db/categories.js');
const identifiers = require('../src/db/identifiers.js');
const bookFiles = require('../src/db/book_files.js');
const customFields = require('../src/db/custom_fields.js');
const stats = require('../src/db/stats.js');
const { isbnKey } = require('../src/core/isbn');
const { removeBookAssets } = require('../src/core/fs-utils.js');

const tmpDirs = [];
function tempDir(prefix = 'mybooks-trash-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

// 造一本书:主表 + 归一化标签/作者 + FTS + 可选 ISBN
function makeBook(db, {
  title = '书', author = '', tags = [], isbn = '',
  series = '', seriesIndex = 0, cover = '', status = 'done',
} = {}) {
  const ts = new Date().toISOString();
  const r = db.prepare(`
    INSERT INTO books (title, author, status, tags, cover, isbn, series, series_index, read_count, read_logs, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, ?)
  `).run(title, author, status, JSON.stringify(tags), cover, isbn, series, seriesIndex, ts, ts);
  const id = Number(r.lastInsertRowid);
  categories.syncBookTags(db, id, tags);
  categories.syncBookAuthors(db, id, author ? [author] : []);
  categories.recomputeBookCaches(db, id);
  if (isbn) identifiers.setIdentifiers(db, id, { isbn });
  search.indexBook(db, db.prepare('SELECT * FROM books WHERE id = ?').get(id));
  return id;
}

function rawBook(db, id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

/* ---------- 迁移 ---------- */

test('v13 迁移:deleted_at 列与索引存在,存量行为 NULL', () => {
  const db = openDb(tempDir());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);

  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  assert.ok(cols.includes('deleted_at'), 'books 应有 deleted_at');

  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='books_deleted_idx'").get();
  assert.ok(idx, '应建立 books_deleted_idx');

  const notNull = db.prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NOT NULL').get().n;
  assert.equal(notNull, 0, '存量书不应带删除标记');
  db.close();
});

/* ---------- 软删除后的过滤矩阵 ---------- */

test('软删除:列表/搜索/统计/分类/系列/ISBN 全部排除,关联与文件保留', () => {
  const db = freshDb();
  const col = customFields.addColumn(db, {
    label: 'mood', name: '心情', datatype: 'text', is_multiple: false, options: [],
  });
  assert.ok(col.ok);

  const id = makeBook(db, {
    title: '被删的书', author: '作者甲', tags: ['标签甲'],
    isbn: '9787111111111', series: '系列甲', seriesIndex: 1,
    cover: '/uploads/cover-a.png',
  });
  const keepId = makeBook(db, {
    title: '在架的书', author: '作者乙', tags: ['标签乙'],
    isbn: '9787222222222', series: '系列乙', seriesIndex: 1,
  });
  customFields.setValues(db, id, { mood: '开心' });
  bookFiles.upsertFile(db, id, { format: 'EPUB', path: '1-a.epub', size: 10 });

  const deleted = books.softDeleteBook(db, id);
  assert.ok(deleted && deleted.deleted_at);

  assert.equal(books.getBook(id, db), undefined, '默认查询不应看到回收站里的书');
  assert.ok(books.getBook(id, db, { includeDeleted: true }), '显式 includeDeleted 应能读到');
  assert.deepEqual(books.listBooks({}, db).map((b) => b.id), [keepId]);
  assert.equal(search.searchBooks(db, { q: '被删的书' }).length, 0, '全文搜索不应命中');

  const st = stats.getStats(db);
  assert.equal(st.total, 1, '统计总数只算在架书');
  assert.equal(st.byStatus.done, 1);

  const tagA = categories.listTags(db).find((t) => t.name === '标签甲');
  assert.ok(tagA, '软删除不清理标签定义');
  assert.equal(tagA.count, 0, '标签计数不应算回收站里的书');
  const authorA = categories.listAuthors(db).find((a) => a.name === '作者甲');
  assert.equal(authorA.count, 0);

  assert.equal(books.listSeries(db).some((s) => s.name === '系列甲'), false);
  assert.equal(identifiers.listIsbnIndex(db).has(isbnKey('9787111111111')), false, '回收站的 ISBN 不占用查重索引');
  assert.equal(identifiers.findDuplicates(db).length, 0);

  assert.equal(bookFiles.listFiles(db, id).length, 1, '软删除必须保留电子书登记');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_tags WHERE book = ?').get(id).n, 1, '软删除必须保留标签链接');
  assert.equal(customFields.getValues(db, id).mood, '开心', '软删除必须保留自定义字段值');
  assert.equal(rawBook(db, id).deleted_at, deleted.deleted_at);
  db.close();
});

/* ---------- 恢复 ---------- */

test('恢复:清墓碑后列表/搜索/统计/计数回来,无需重建 FTS', () => {
  const db = freshDb();
  const id = makeBook(db, { title: '失而复得', author: '作者甲', tags: ['标签甲'], isbn: '9787111111111' });
  const keepId = makeBook(db, { title: '一直存在', author: '作者乙', tags: ['标签乙'] });

  books.softDeleteBook(db, id);
  assert.equal(search.searchBooks(db, { q: '失而复得' }).length, 0);

  const r = books.restoreBook(db, id);
  assert.equal(r.ok, true);
  assert.ok(books.getBook(id, db));
  assert.equal(books.listBooks({}, db).length, 2);
  assert.equal(search.searchBooks(db, { q: '失而复得' }).length, 1, '恢复不应依赖重建索引');
  assert.equal(stats.getStats(db).total, 2);
  assert.equal(categories.listTags(db).find((t) => t.name === '标签甲').count, 1);
  assert.ok(identifiers.listIsbnIndex(db).has(isbnKey('9787111111111')));
  assert.deepEqual(books.listBooks({}, db).map((b) => b.id).sort(), [id, keepId].sort());
  db.close();
});

test('恢复时 ISBN 冲突:返回 CONFLICT 且墓碑不清', () => {
  const db = freshDb();
  const id = makeBook(db, { title: '旧的', isbn: '9787111111111' });
  books.softDeleteBook(db, id);
  makeBook(db, { title: '新的', isbn: '9787111111111' });

  const r = books.restoreBook(db, id);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFLICT');
  assert.match(r.error, /新的/);
  assert.ok(rawBook(db, id).deleted_at, '冲突时不得恢复');
  db.close();
});

/* ---------- 彻底删除 ---------- */

test('彻底删除:行与关联数据清空,返回磁盘资产,孤儿标签/作者被清', () => {
  const db = freshDb();
  customFields.addColumn(db, {
    label: 'mood', name: '心情', datatype: 'text', is_multiple: false, options: [],
  });
  const id = makeBook(db, {
    title: '待彻底删除', author: '作者甲', tags: ['标签甲'],
    isbn: '9787111111111', cover: '/uploads/cover-a.png',
  });
  customFields.setValues(db, id, { mood: '开心' });
  bookFiles.upsertFile(db, id, { format: 'EPUB', path: '9-a.epub', size: 10 });

  books.softDeleteBook(db, id);
  const r = books.purgeBook(db, id);
  assert.equal(r.ok, true);
  assert.deepEqual(r.assets.ebookFiles, ['9-a.epub']);
  assert.deepEqual(r.assets.coverFiles, ['cover-a.png']);

  assert.equal(rawBook(db, id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_files WHERE book = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_tags WHERE book = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_identifiers WHERE book = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_custom_values WHERE book = ?').get(id).n, 0);
  assert.equal(categories.listTags(db).some((t) => t.name === '标签甲'), false, '作者/标签孤儿应被清理');
  assert.equal(categories.listAuthors(db).some((a) => a.name === '作者甲'), false);
  assert.equal(search.searchBooks(db, { q: '待彻底删除' }).length, 0);
  db.close();
});

test('彻底删除:共享封面仍被在架书引用时不删文件', () => {
  const db = freshDb();
  const idA = makeBook(db, { title: '甲', cover: '/uploads/shared.png' });
  const idB = makeBook(db, { title: '乙', cover: '/uploads/shared.png' });
  books.softDeleteBook(db, idA);

  const r = books.purgeBook(db, idA);
  assert.equal(r.ok, true);
  assert.deepEqual(r.assets.coverFiles, [], '封面仍被乙引用,不能删');

  books.softDeleteBook(db, idB);
  const r2 = books.purgeBook(db, idB);
  assert.deepEqual(r2.assets.coverFiles, ['shared.png'], '最后一个引用者删除时才清封面');
  db.close();
});

test('彻底删除的边界:在架书拒绝、不存在 404、重复软删除返回 null', () => {
  const db = freshDb();
  const id = makeBook(db, { title: '在架书' });

  const activePurge = books.purgeBook(db, id);
  assert.equal(activePurge.ok, false);
  assert.equal(activePurge.code, 'CONFLICT');

  assert.equal(books.softDeleteBook(db, id).id, id);
  assert.equal(books.softDeleteBook(db, id), null, '重复软删除不应刷新删除时间');
  assert.equal(books.purgeBook(db, 999999).code, 'NOT_FOUND');
  assert.equal(books.restoreBook(db, 999999).code, 'NOT_FOUND');
  db.close();
});

/* ---------- 过期清理 ---------- */

test('过期清理:只清超过保留期的条目,并给出剩余天数', () => {
  const db = freshDb();
  const oldId = makeBook(db, { title: '过期书' });
  const newId = makeBook(db, { title: '新删书' });
  books.softDeleteBook(db, oldId);
  books.softDeleteBook(db, newId);

  const oldTs = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE books SET deleted_at = ? WHERE id = ?').run(oldTs, oldId);

  const trash = books.listTrash(db);
  assert.equal(trash.find((b) => b.id === oldId).days_left, 0);
  assert.ok(trash.find((b) => b.id === newId).days_left >= 13, '新删书应还剩约 14 天');

  const purged = books.purgeExpired(db, 14);
  assert.deepEqual(purged.map((p) => p.id), [oldId]);
  assert.equal(rawBook(db, oldId), undefined);
  assert.ok(rawBook(db, newId));
  assert.equal(rawBook(db, newId).deleted_at, books.listTrash(db)[0].deleted_at);
  db.close();
});

/* ---------- 磁盘资产清理 ---------- */

test('removeBookAssets:按注入目录删除,越界路径拒删', () => {
  const filesDir = tempDir('mybooks-files-');
  const uploadsDir = tempDir('mybooks-uploads-');
  fs.writeFileSync(path.join(filesDir, 'a.epub'), 'x');
  fs.writeFileSync(path.join(uploadsDir, 'c.png'), 'x');

  const failed = removeBookAssets(
    { ebookFiles: ['a.epub'], coverFiles: ['c.png'] },
    { filesDir, uploadsDir },
  );
  assert.equal(failed, 0);
  assert.equal(fs.existsSync(path.join(filesDir, 'a.epub')), false);
  assert.equal(fs.existsSync(path.join(uploadsDir, 'c.png')), false);

  assert.equal(
    removeBookAssets({ ebookFiles: ['../escape.epub'], coverFiles: [] }, { filesDir, uploadsDir }),
    1,
    '越界路径必须拒删并计入失败',
  );
});
