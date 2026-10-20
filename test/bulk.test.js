/* ============================================================
 * 批量编辑测试:ids/patch 校验、状态→阅读记录联动、事务与过滤
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
const {
  parseIds, parseBulkPatch, parseBulkRequest, applyStatusTransition, deriveLogFields, todayStr,
} = require('../src/core/bulk');

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-bulk-'));
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
  search.reindexAll(db);
  return db;
}

function makeBook(db, opts = {}) {
  const ts = '2026-01-02T03:04:05.000Z';
  const r = db.prepare(`
    INSERT INTO books (title, author, status, tags, start_date, finish_date, read_count, read_logs,
      series, series_index, publisher, pub_year, rating, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.title || '书', opts.author || '', opts.status || 'wish',
    JSON.stringify(opts.tags || []), opts.startDate || '', opts.finishDate || '',
    opts.readCount || 0, JSON.stringify(opts.readLogs || []),
    opts.series || '', opts.seriesIndex || 0, opts.publisher || '',
    opts.pubYear || '', opts.rating || 0, ts, ts,
  );
  const id = Number(r.lastInsertRowid);
  categories.syncBookTags(db, id, opts.tags || []);
  categories.syncBookAuthors(db, id, opts.author ? [opts.author] : []);
  categories.recomputeBookCaches(db, id);
  search.indexBook(db, db.prepare('SELECT * FROM books WHERE id = ?').get(id));
  return id;
}

function rawBook(db, id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

/* ---------- 纯规则 ---------- */

test('parseIds:去重、拒绝非法 id、限制批量上限', () => {
  assert.deepEqual(parseIds([1, 2, 2, '3']).ids, [1, 2, 3]);
  assert.ok(parseIds([]).error);
  assert.ok(parseIds('1,2').error);
  assert.ok(parseIds([0]).error);
  assert.ok(parseIds([1.5]).error);
  assert.ok(parseIds(Array.from({ length: 501 }, (_, i) => i + 1)).error);
});

test('parseBulkPatch:填了才改;标签增删冲突与评分/序号边界', () => {
  assert.deepEqual(parseBulkPatch({ status: 'done' }).patch, { status: 'done' });
  assert.deepEqual(
    parseBulkPatch({ tags_add: '科幻、小说', tags_remove: '旧标签' }).patch,
    { tags_add: ['科幻', '小说'], tags_remove: ['旧标签'] },
  );
  assert.ok(parseBulkPatch({ tags_add: '科幻', tags_remove: '科幻' }).errors.length);
  assert.deepEqual(parseBulkPatch({ rating: '0' }).patch, { rating: 0 });
  assert.ok(parseBulkPatch({ rating: '11' }).errors.length);
  assert.deepEqual(parseBulkPatch({ series: '基地', series_index: '2.5' }).patch, {
    series: '基地', series_index: 2.5,
  });
  assert.ok(parseBulkPatch({ series_index: '-1' }).errors.length);
  assert.ok(parseBulkPatch({}).errors.length, '空 patch 应报错');
  assert.deepEqual(parseBulkPatch({ status: '', tags_add: '', publisher: '' }).errors.length, 1);
});

test('parseBulkRequest:API 请求体是 { ids, patch },不能把整个 body 当 patch', () => {
  const ok = parseBulkRequest({ ids: [1, 2], patch: { status: 'done' } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.ids, [1, 2]);
  assert.deepEqual(ok.patch, { status: 'done' });

  const empty = parseBulkRequest({ ids: [1], patch: {} });
  assert.ok(empty.errors.length, '空 patch 应报错');

  const badIds = parseBulkRequest({ ids: [0], patch: { status: 'done' } });
  assert.ok(badIds.errors.length);
});

test('状态联动:已读补读完日、在读补开读日,日期/次数由记录推导', () => {
  const doneLogs = applyStatusTransition('done', [], '2026-10-20');
  assert.deepEqual(doneLogs, [{ start: '', finish: '2026-10-20' }]);
  assert.deepEqual(deriveLogFields(doneLogs), {
    start_date: '', finish_date: '2026-10-20', read_count: 1,
  });

  const readingLogs = applyStatusTransition('reading', [], '2026-10-20');
  assert.deepEqual(readingLogs, [{ start: '2026-10-20', finish: '' }]);
  assert.deepEqual(deriveLogFields(readingLogs), {
    start_date: '2026-10-20', finish_date: '', read_count: 0,
  });

  const existing = [{ start: '2026-01-01', finish: '2026-01-05' }];
  assert.equal(applyStatusTransition('done', existing, '2026-10-20').length, 1, '已有读完记录不重复补');
  assert.equal(deriveLogFields(existing).read_count, 1);
  assert.equal(todayStr(new Date(2026, 9, 20)), '2026-10-20');
});

/* ---------- 数据库批量更新 ---------- */

test('bulkUpdateBooks:状态/标签/系列/出版/评分一起更新,未选中的书不动', () => {
  const db = freshDb();
  const a = makeBook(db, {
    title: '甲', tags: ['旧标签', '保留'], series: '旧系列', seriesIndex: 1,
    publisher: '旧社', pubYear: '1999', rating: 3,
  });
  const b = makeBook(db, { title: '乙', tags: ['旧标签'] });
  const c = makeBook(db, { title: '丙', tags: ['旧标签'] });

  const result = books.bulkUpdateBooks(db, [a, b], {
    status: 'done',
    tags_add: ['科幻'],
    tags_remove: ['旧标签'],
    series: '基地',
    publisher: '新社',
    pub_year: '2026',
    rating: 9.5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 2);

  for (const id of [a, b]) {
    const row = rawBook(db, id);
    assert.equal(row.status, 'done');
    assert.equal(row.series, '基地');
    assert.equal(row.publisher, '新社');
    assert.equal(row.pub_year, '2026');
    assert.equal(row.rating, 9.5);
    assert.equal(row.read_count, 1);
    assert.equal(row.finish_date, todayStr());
    assert.match(row.read_logs, new RegExp(todayStr()));
    const tags = JSON.parse(row.tags);
    assert.ok(tags.includes('科幻'));
    assert.ok(!tags.includes('旧标签'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_tags bt JOIN tags t ON t.id=bt.tag WHERE bt.book=? AND t.name=?').get(id, '科幻').n, 1);
  }
  assert.deepEqual(JSON.parse(rawBook(db, a).tags), ['保留', '科幻'], '未指定的旧标签保留');

  const untouched = rawBook(db, c);
  assert.equal(untouched.status, 'wish');
  assert.equal(untouched.publisher, '');
  assert.deepEqual(JSON.parse(untouched.tags), ['旧标签']);

  assert.equal(search.searchBooks(db, { q: '科幻' }).length, 2, '新增标签应同步 FTS');
  db.close();
});

test('bulkUpdateBooks:切到在读补开读记录;在架书与回收站混合时整体拒绝', () => {
  const db = freshDb();
  const a = makeBook(db, { title: '甲', status: 'wish' });
  const b = makeBook(db, { title: '乙', status: 'wish' });
  const trashed = makeBook(db, { title: '丙' });
  books.softDeleteBook(db, trashed);

  const ok = books.bulkUpdateBooks(db, [a, b], { status: 'reading' });
  assert.equal(ok.ok, true);
  for (const id of [a, b]) {
    const row = rawBook(db, id);
    assert.equal(row.status, 'reading');
    const logs = JSON.parse(row.read_logs);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].start, todayStr());
    assert.equal(logs[0].finish, '');
    assert.equal(row.start_date, todayStr());
  }

  const before = rawBook(db, a);
  const failed = books.bulkUpdateBooks(db, [a, trashed], { rating: 1 });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'NOT_FOUND');
  assert.equal(rawBook(db, a).rating, before.rating, '整体拒绝时不得部分更新');
  db.close();
});
