/* ============================================================
 * 合并书籍(数据层):字段/标签/记录/自定义值/标识符/文件/来源删除
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const { openDb } = require('../src/db/index.js');
const books = require('../src/db/books.js');
const search = require('../src/db/search.js');
const categories = require('../src/db/categories.js');
const identifiers = require('../src/db/identifiers.js');
const bookFiles = require('../src/db/book_files.js');
const customFields = require('../src/db/custom_fields.js');
const notes = require('../src/db/notes.js');
const { validateReadingData } = require('../src/core/mobile-reading.js');
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
    INSERT INTO books (title, author, status, tags, cover, summary,
      read_count, read_logs, publisher, pub_year, rating, series, series_index,
      isbn, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.title || '书', opts.author || '', opts.status || 'wish',
    JSON.stringify(opts.tags || []), opts.cover || '', opts.summary || '',
    opts.readCount || 0, JSON.stringify(opts.readLogs || []),
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

function setUuid(db, id) {
  const uuid = randomUUID();
  db.prepare('UPDATE books SET uuid = ? WHERE id = ?').run(uuid, id);
  return uuid;
}

const readingData = (extra = {}) => ({
  positions: [], bookmarks: [], notes: [], reading_records: [], tombstones: [], ...extra,
});
const position = (time, progress = 0.1) => ({
  format: 'EPUB', fileSha256: '', lastReadTime: time, readingProgress: progress,
  locatorJson: null, sourceDeviceId: 'device-a',
});
const bookmark = (id, updatedAt) => ({
  syncId: id, chapterIndex: 0, createdAt: 1, updatedAt, isStale: false, tagsJson: '',
  position: 0, locatorJson: null, title: '标题', remark: '',
});
const noteItem = (id, updatedAt) => ({
  syncId: id, chapterIndex: 0, createdAt: 1, updatedAt, isStale: false, tagsJson: '',
  startPosition: 0, endPosition: 0, startLocatorJson: null, endLocatorJson: null,
  selectedText: '', note: '批注', color: '', type: '', isNote: true,
  origin: '', sourceRuleId: '', sourceMatchKey: '', styleSnapshotJson: '',
});
const readingRecord = (updatedAt, duration = 10) => ({
  date: '2026-01-01', sourceDeviceId: 'device-a', duration, startTime: 1, endTime: 2, updatedAt,
});
function putReadingState(db, bookId, bookUuid, revision, data) {
  db.prepare(`INSERT INTO mobile_reading_state (book_id, book_uuid, revision, data, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(bookId, bookUuid, revision, JSON.stringify(data), new Date().toISOString());
}

test('mergeBooks:合并字段/标签/记录/自定义值/标识符/文件,永久删除来源', () => {
  const db = freshDb();
  customFields.addColumn(db, {
    label: 'mood', name: '心情', datatype: 'text', is_multiple: false, options: [],
  });

  const target = makeBook(db, {
    title: '目标书', author: '作者', status: 'reading', tags: ['科幻'],
    cover: '', summary: '', publisher: '', pubYear: '', rating: 0,
    series: '', seriesIndex: 0, readLogs: [], formats: ['EPUB'],
  });
  const source = makeBook(db, {
    title: '来源书', author: '作者', status: 'done', tags: ['小说', '科幻'],
    cover: '/uploads/s.png', summary: '来源简介',
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

test('mergeContents:目标空且单来源原样搬入;多来源加小节;空来源忽略', () => {
  assert.equal(notes.mergeContents('', [{ title: '甲', content: '正文' }]), '正文');
  assert.equal(notes.mergeContents('目标', [{ title: '甲', content: '来源' }]),
    '目标\n\n---\n\n### 合并自《甲》\n\n来源\n');
  assert.equal(notes.mergeContents('', [{ title: '甲', content: '   ' }]), '');
  const multi = notes.mergeContents('', [
    { title: '甲', content: 'a' },
    { title: '乙', content: 'b' },
  ]);
  assert.match(multi, /### 合并自《甲》\n\na/);
  assert.match(multi, /### 合并自《乙》\n\nb/);
  assert.ok(notes.MAX_NOTE_BYTES > 0);
});

test('mergeBooks:合并安卓阅读状态,冲突保留较新记录并应用墓碑', () => {
  const db = freshDb();
  const target = makeBook(db, { title: '目标' });
  const source = makeBook(db, { title: '来源' });
  const targetUuid = setUuid(db, target);
  const sourceUuid = setUuid(db, source);

  putReadingState(db, target, targetUuid, 2, readingData({
    positions: [position(100, 0.2)],
    bookmarks: [bookmark('b1', 100), bookmark('b2', 150)],
    notes: [noteItem('n1', 100)],
    reading_records: [readingRecord(100, 10)],
  }));
  putReadingState(db, source, sourceUuid, 5, readingData({
    positions: [position(200, 0.8)],
    bookmarks: [bookmark('b1', 50)],
    notes: [noteItem('n2', 200)],
    reading_records: [readingRecord(300, 20)],
    tombstones: [{ namespace: 'bookmark', itemId: 'b2', deviceId: 'device-b', deletedAt: 400 }],
  }));

  const result = mergeBooks(db, target, [source]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const row = db.prepare('SELECT * FROM mobile_reading_state WHERE book_id = ?').get(target);
  assert.ok(row);
  assert.equal(row.book_uuid, targetUuid);
  assert.equal(row.revision, 6, 'max(2,5)+1');
  const data = JSON.parse(row.data);
  assert.equal(validateReadingData(data), true);
  assert.equal(data.positions.length, 1);
  assert.equal(data.positions[0].lastReadTime, 200, '较新的位置覆盖旧的');
  assert.equal(data.positions[0].readingProgress, 0.8);
  assert.deepEqual(data.bookmarks.map((b) => b.syncId), ['b1'], 'b2 被来源墓碑删除');
  assert.equal(data.bookmarks[0].updatedAt, 100, '冲突保留目标较新记录');
  assert.deepEqual(data.notes.map((n) => n.syncId).sort(), ['n1', 'n2']);
  assert.equal(data.reading_records.length, 1);
  assert.equal(data.reading_records[0].updatedAt, 300);
  assert.equal(data.tombstones.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mobile_reading_state WHERE book_id = ?').get(source).n, 0);
  db.close();
});

test('mergeBooks:目标没有阅读状态时搬入来源状态并提升版本', () => {
  const db = freshDb();
  const target = makeBook(db, { title: '目标' });
  const source = makeBook(db, { title: '来源' });
  const targetUuid = setUuid(db, target);
  const sourceUuid = setUuid(db, source);
  putReadingState(db, source, sourceUuid, 4, readingData({ bookmarks: [bookmark('b1', 100)] }));

  const result = mergeBooks(db, target, [source]);
  assert.equal(result.ok, true);
  const row = db.prepare('SELECT * FROM mobile_reading_state WHERE book_id = ?').get(target);
  assert.equal(row.book_uuid, targetUuid);
  assert.equal(row.revision, 5);
  assert.deepEqual(JSON.parse(row.data).bookmarks.map((b) => b.syncId), ['b1']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mobile_reading_state WHERE book_id = ?').get(source).n, 0);
  db.close();
});

test('mergeBooks:来源阅读数据损坏时整体回滚,不删除来源', () => {
  const db = freshDb();
  const target = makeBook(db, { title: '目标' });
  const source = makeBook(db, { title: '来源' });
  const targetUuid = setUuid(db, target);
  const sourceUuid = setUuid(db, source);
  putReadingState(db, target, targetUuid, 1, readingData({ bookmarks: [bookmark('b1', 100)] }));
  // 两条同 key 的 position 违反 validateReadingData,无法合并
  putReadingState(db, source, sourceUuid, 2, readingData({
    positions: [position(1), position(2)],
  }));

  const result = mergeBooks(db, target, [source]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VALIDATION');
  assert.ok(rawBook(db, source), '来源书不能被删除');
  const targetState = db.prepare('SELECT * FROM mobile_reading_state WHERE book_id = ?').get(target);
  assert.equal(targetState.revision, 1, '目标状态不能被改动');
  assert.deepEqual(JSON.parse(targetState.data).bookmarks.map((b) => b.syncId), ['b1']);
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
