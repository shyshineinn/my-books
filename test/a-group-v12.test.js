/* ============================================================
 * A 组剩余数据模型(v12):系列 A3 / 标识符 A5 / uuid A7 / 排序键 A8
 *
 * 隔离纪律:全部用 openDb(临时目录) 的**传入句柄**。
 *
 * 重要教训(2026-10-15 实测踩过):src/db/books.js 内部用的是模块级单例 db,
 * 所以**不能**用 books.addBook / updateBook 来造测试数据 —— 那会写进真实
 * data/books.db(我曾因此把 6 本书写进生产库并手工清理)。
 * 本文件一律自己写 SQL + 调用接收 db 句柄的 db 层模块(identifiers.repo 等)。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb, inTransaction, migrations } = require('../src/db/index.js');
const idsRepo = require('../src/db/identifiers.js');
const search = require('../src/db/search.js');
const sk = require('../src/core/sort_keys.js');
const seriesCore = require('../src/core/series.js');
const idCore = require('../src/core/identifiers.js');
const { parseBook, mergeUpdate } = require('../src/core/book.js');

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-v12-test-'));
  tmpDirs.push(dir);
  return dir;
}

function freshDb() {
  const db = openDb(tempDir());
  db.exec('DELETE FROM book_identifiers; DELETE FROM book_custom_values; DELETE FROM custom_columns; DELETE FROM books;');
  search.reindexAll(db);
  return db;
}

// 自己写 SQL 造书(句柄是传入的临时库,不碰真实库);
// 表结构上模拟 books.js 的写入结果(title_sort / uuid / series / isbn)
function insertBook(db, {
  title, author = '', authorSort = '', series = '', seriesIndex = 0,
  isbn = '', doubanId = '', rating = 0,
} = {}) {
  const ts = new Date().toISOString();
  const r = db.prepare(`
    INSERT INTO books (title, title_sort, author, author_sort, status, tags, read_logs,
                       series, series_index, isbn, douban_id, rating, uuid, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'wish', '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title, sk.titleSort(title), author, authorSort || sk.authorsToSortString([author]),
    series, seriesIndex, isbn, doubanId, rating,
    require('node:crypto').randomUUID(), ts, ts
  );
  const id = r.lastInsertRowid;
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  search.indexBook(db, row);
  // 双写标识符(与 books.js 的行为一致)
  if (isbn || doubanId) {
    idsRepo.setIdentifiers(db, id, { isbn, douban: doubanId });
  }
  return id;
}

const titles = (rows) => rows.map((b) => b.title);

/* ================= A8 排序键(纯函数) ================= */

test('A8 titleSort:英语冠词移位到末尾', () => {
  assert.equal(sk.titleSort('The Hobbit'), 'Hobbit, The');
  assert.equal(sk.titleSort('A Brief History of Time'), 'Brief History of Time, A');
  assert.equal(sk.titleSort('An Artist of the Floating World'), 'Artist of the Floating World, An');
});

test('A8 titleSort:中文书名原样(不影响既有排序)', () => {
  for (const t of ['三体', '活着', '百年孤独', '人类简史', '明朝那些事儿']) {
    assert.equal(sk.titleSort(t), t);
  }
});

test('A8 titleSort:剥掉书名外层引号(含中文书名号)', () => {
  assert.equal(sk.titleSort('《三体》'), '三体');
  assert.equal(sk.titleSort('「ノルウェイの森」'), 'ノルウェイの森');
  assert.equal(sk.titleSort('"The Hobbit"'), 'Hobbit, The', '先剥引号再移冠词');
});

test('A8 titleSort:只有冠词本身时保留原文(不移位)', () => {
  assert.equal(sk.titleSort('The'), 'The');
  assert.equal(sk.titleSort('A'), 'A');
});

test('A8 titleSort:冠词必须后接空格,「Theory」不误伤', () => {
  assert.equal(sk.titleSort('Theory of Everything'), 'Theory of Everything');
  assert.equal(sk.titleSort('Anarchy'), 'Anarchy');
  assert.equal(sk.titleSort('Then We Came to the End'), 'Then We Came to the End');
});

test('A8 authorToAuthorSort:姓名倒装为「姓, 名」', () => {
  assert.equal(sk.authorToAuthorSort('John Smith'), 'Smith, John');
  assert.equal(sk.authorToAuthorSort('Ursula K. Le Guin'), 'Guin, Ursula K. Le');
});

test('A8 authorToAuthorSort:中文名 / 单 token 原样返回', () => {
  for (const n of ['刘慈欣', '余华', '加西亚·马尔克斯', '当年明月', '圣埃克苏佩里']) {
    assert.equal(sk.authorToAuthorSort(n), n);
  }
});

test('A8 authorToAuthorSort:含逗号视为已规范化,不二次处理', () => {
  assert.equal(sk.authorToAuthorSort('Smith, John'), 'Smith, John');
});

test('A8 authorToAuthorSort:带前缀称谓的不倒装(Dr. Seuss)', () => {
  assert.equal(sk.authorToAuthorSort('Dr. Seuss'), 'Dr. Seuss');
});

test('A8 authorsToSortString:多作者用 " & " 连接(calibre 同款)', () => {
  assert.equal(sk.authorsToSortString(['John Smith', 'Jane Doe']), 'Smith, John & Doe, Jane');
  assert.equal(sk.authorsToSortString(['刘慈欣']), '刘慈欣');
  assert.equal(sk.authorsToSortString([]), '');
});

test('A8 title 排序真的按 title_sort 走(The Hobbit 归到 H 组)', () => {
  const db = freshDb();
  insertBook(db, { title: 'The Hobbit' });
  insertBook(db, { title: 'Zebra' });
  insertBook(db, { title: 'Apple' });
  search.reindexAll(db);
  // Zebra 的 title_sort 是 Zebra;Hobbit 是 "Hobbit, The";Apple 是 Apple
  // 若按 title 排会得到 Apple/Hobbit/Zebra(巧合相同),故用 The Zebra 区分:
  insertBook(db, { title: 'The Zebra' });   // title_sort = "Zebra, The"
  search.reindexAll(db);
  const got = titles(search.searchBooks(db, { sort: 'title' }));
  // Apple < Hobbit, The < Zebra < Zebra, The
  assert.deepEqual(got, ['Apple', 'The Hobbit', 'Zebra', 'The Zebra'],
    '按 title_sort 排序:冠词被移到末尾,所以 The Zebra 排在 Zebra 之后');
  db.close();
});

/* ================= A3 系列 ================= */

test('A3 parseSeriesInput:支持 `系列名 [序号]` 语法,序号可小数', () => {
  assert.deepEqual(seriesCore.parseSeriesInput('基地 [3]'), { series: '基地', series_index: 3 });
  assert.deepEqual(seriesCore.parseSeriesInput('基地[2.5]'), { series: '基地', series_index: 2.5 });
  assert.deepEqual(seriesCore.parseSeriesInput('  银河帝国 [ 10 ]  '), { series: '银河帝国', series_index: 10 });
  assert.deepEqual(seriesCore.parseSeriesInput('基地'), { series: '基地', series_index: null });
  assert.deepEqual(seriesCore.parseSeriesInput(''), { series: '', series_index: null });
});

test('A3 parseSeriesInput:只有方括号数字视为无效(防手滑)', () => {
  assert.deepEqual(seriesCore.parseSeriesInput('[3]'), { series: '', series_index: null });
});

test('A3 clampSeriesIndex:非数字归 null,负数归 null,保留一位小数', () => {
  assert.equal(seriesCore.clampSeriesIndex('3'), 3);
  assert.equal(seriesCore.clampSeriesIndex('2.56'), 2.6);
  assert.equal(seriesCore.clampSeriesIndex('abc'), null);
  assert.equal(seriesCore.clampSeriesIndex(-1), null);
  assert.equal(seriesCore.clampSeriesIndex(''), null);
});

test('A3 nextSeriesIndex:取第一个空位(first_free 策略)', () => {
  assert.equal(seriesCore.nextSeriesIndex([]), 1);
  assert.equal(seriesCore.nextSeriesIndex([1, 2, 3]), 4);
  assert.equal(seriesCore.nextSeriesIndex([1, 2, 4]), 3, '中间空位优先');
  assert.equal(seriesCore.nextSeriesIndex([2]), 1);
});

test('A3 seriesLabel:有号显示 #n,无号只显示系列名;整数不带小数点', () => {
  assert.equal(seriesCore.seriesLabel('基地', 3), '基地 #3');
  assert.equal(seriesCore.seriesLabel('基地', 2.5), '基地 #2.5');
  assert.equal(seriesCore.seriesLabel('基地', 0), '基地');
  assert.equal(seriesCore.seriesLabel('', 3), '');
});

test('A3 parseBook:接受 `系列 [n]` 写法并拆成两列', () => {
  const { values, errors } = parseBook({ title: 'x', series: '基地 [3]' });
  assert.deepEqual(errors, []);
  assert.equal(values.series, '基地');
  assert.equal(values.series_index, 3);
});

test('A3 parseBook:series_index 可独立指定(覆盖方括号里的值)', () => {
  const { values } = parseBook({ title: 'x', series: '基地 [3]', series_index: 5 });
  assert.equal(values.series, '基地');
  assert.equal(values.series_index, 5);
});

test('A3 parseBook:无系列时序号归 0(不留下孤儿序号)', () => {
  const { values } = parseBook({ title: 'x', series: '', series_index: 3 });
  assert.equal(values.series, '');
  assert.equal(values.series_index, 0, '没有系列就不该有序号');
});

test('A3 mergeUpdate:未提供 series 时保留旧系列与序号', () => {
  const existing = { series: '基地', series_index: 3, title: '旧' };
  const { values } = parseBook({ title: '新' });
  const merged = mergeUpdate(existing, values, { title: '新' });
  assert.equal(merged.series, '基地');
  assert.equal(merged.series_index, 3);
});

test('A3 mergeUpdate:只改序号时系列名保留', () => {
  const existing = { series: '基地', series_index: 3, title: 'x' };
  const { values } = parseBook({ title: 'x', series_index: 7 });
  const merged = mergeUpdate(existing, values, { title: 'x', series_index: 7 });
  assert.equal(merged.series, '基地');
  assert.equal(merged.series_index, 7);
});

test('A3 排序:sort=series 按系列名 + 序号;未入系列排最后', () => {
  const db = freshDb();
  insertBook(db, { title: '第二册', series: '基地', seriesIndex: 2 });
  insertBook(db, { title: '第一册', series: '基地', seriesIndex: 1 });
  insertBook(db, { title: '散书', series: '', seriesIndex: 0 });
  insertBook(db, { title: '别系列', series: '银河帝国', seriesIndex: 1 });
  search.reindexAll(db);
  assert.deepEqual(titles(search.searchBooks(db, { sort: 'series' })),
    ['第一册', '第二册', '别系列', '散书']);
  db.close();
});

test('A3 检索:series: 精确查内置系列列', () => {
  const db = freshDb();
  insertBook(db, { title: '基地1', series: '基地', seriesIndex: 1 });
  insertBook(db, { title: '基地续篇', series: '基地续篇', seriesIndex: 1 });
  insertBook(db, { title: '别的', series: '银河帝国', seriesIndex: 1 });
  search.reindexAll(db);
  assert.deepEqual(titles(search.searchBooks(db, { q: 'series:基地' })), ['基地1']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '系列:银河帝国' })), ['别的']);
  assert.deepEqual(titles(search.searchBooks(db, { q: 'not series:基地' })).sort(), ['别的', '基地续篇']);
  db.close();
});

test('A3 检索:series_index 数值比较;非数字报 VALIDATION', () => {
  const db = freshDb();
  insertBook(db, { title: '一', series: 'S', seriesIndex: 1 });
  insertBook(db, { title: '三', series: 'S', seriesIndex: 3 });
  search.reindexAll(db);
  assert.deepEqual(titles(search.searchBooks(db, { q: 'series_index:>=2' })), ['三']);
  assert.throws(() => search.searchBooks(db, { q: 'series_index:abc' }), (e) => e.code === 'VALIDATION');
  db.close();
});

test('A3 内置 series 与自定义 #series 是不同命名空间,可共存', () => {
  const db = freshDb();
  // 建一个名为 series 的自定义字段(v11 时代就允许)
  const core = require('../src/core/custom_fields.js');
  const repo = require('../src/db/custom_fields.js');
  const def = core.parseColumnDef({ label: 'series', name: '自定义系列', datatype: 'text' });
  assert.ok(def.ok, 'series 不应被列为保留字(v12 起与内置列并存)');
  const col = inTransaction(db, () => repo.addColumn(db, def.values));

  const id = insertBook(db, { title: '双命名空间', series: '内置系列', seriesIndex: 1 });
  repo.setValues(db, id, { series: '自定义系列值' });
  search.reindexAll(db);

  assert.deepEqual(titles(search.searchBooks(db, { q: 'series:内置系列' })), ['双命名空间'], '裸 series: 查内置列');
  assert.deepEqual(titles(search.searchBooks(db, { q: '#series:自定义系列值' })), ['双命名空间'], '#series: 查自定义字段');
  db.close();
});

/* ================= A5 标识符 ================= */

test('A5 cleanType / cleanVal:按 calibre clean_identifier 归一', () => {
  assert.equal(idCore.cleanType(' ISBN '), 'isbn');
  assert.equal(idCore.cleanType('Douban:ID'), 'doubanid');
  assert.equal(idCore.cleanVal(' 978,0261 '), '978|0261');
});

test('A5 parseIdentifier:空 type 报错;type 非法报错;值过长报错', () => {
  assert.equal(idCore.parseIdentifier('', '').ok, true, '全空 = 未填,合法');
  assert.equal(idCore.parseIdentifier('', 'x').ok, false);
  // 注意:cleanType 会**去掉空格/冒号/逗号**(对齐 calibre clean_identifier 的
  // 宽容风格,便于粘贴 "isbn: 123" 这类输入),所以 'is bn' → 'isbn' 是合法的。
  // 真正非法的是含其它符号的类型。
  assert.equal(idCore.parseIdentifier('is bn', 'v').ok, true, '空格被归一掉 → 合法');
  assert.equal(idCore.parseIdentifier('isbn', 'v').ok, true);
  assert.equal(idCore.parseIdentifier('is/bn', 'v').ok, false, '斜杠不在白名单');
  assert.equal(idCore.parseIdentifier('isbn@x', 'v').ok, false, '@ 不在白名单');
  assert.equal(idCore.parseIdentifier('isbn', 'x'.repeat(201)).ok, false);
});

test('A5 parseIdentifiers:字符串 / 数组 / 对象三种入参都能收', () => {
  const a = idCore.parseIdentifiers({ isbn: '123', goodreads: 'g1' });
  assert.deepEqual(a.values, { isbn: '123', goodreads: 'g1' });

  const b = idCore.parseIdentifiers(['isbn:123', 'goodreads:g1']);
  assert.deepEqual(b.values, { isbn: '123', goodreads: 'g1' });

  const c = idCore.parseIdentifiers('isbn:123,goodreads:g1');
  assert.deepEqual(c.values, { isbn: '123', goodreads: 'g1' });
});

test('A5 parseIdentifiers:空值保留为 ""(删除信号,不能丢键)', () => {
  const r = idCore.parseIdentifiers({ isbn: '' });
  assert.deepEqual(r.values, { isbn: '' }, '必须保留空串,否则"清空 isbn"会变成什么都不做');
});

test('A5 identifierUrl:已知类型给出外链,未知类型给 null', () => {
  assert.ok(idCore.identifierUrl('douban', '1234567').includes('book.douban.com/subject/1234567'));
  assert.ok(idCore.identifierUrl('goodreads', '5907').includes('goodreads.com'));
  assert.equal(idCore.identifierUrl('unknown_type', 'x'), null);
  assert.equal(idCore.identifierUrl('douban', 'not-a-number'), null, '非数字 douban id 不给链接');
});

test('A5 setIdentifiers:写入任意类型并读回', () => {
  const db = freshDb();
  const id = insertBook(db, { title: '甲' });
  inTransaction(db, () => idsRepo.setIdentifiers(db, id, { goodreads: '5907', doi: '10.1/x' }));
  assert.deepEqual(idsRepo.getIdentifiers(db, id), { goodreads: '5907', doi: '10.1/x' });
  db.close();
});

test('A5 双写:isbn / douban 同时落表与 books 专用列', () => {
  const db = freshDb();
  const id = insertBook(db, { title: '甲' });
  inTransaction(db, () => idsRepo.setIdentifiers(db, id, { isbn: '9780261103252', douban: '1084336' }));

  const row = db.prepare('SELECT isbn, douban_id FROM books WHERE id = ?').get(id);
  assert.equal(row.isbn, '9780261103252', 'books.isbn 应被双写');
  assert.equal(row.douban_id, '1084336', 'books.douban_id 应被双写');
  assert.deepEqual(idsRepo.getIdentifiers(db, id), { isbn: '9780261103252', douban: '1084336' });
  db.close();
});

test('A5 清空某个标识符:表与专用列一起清', () => {
  const db = freshDb();
  const id = insertBook(db, { title: '甲', isbn: '9780261103252' });
  assert.equal(idsRepo.getIdentifiers(db, id).isbn, '9780261103252');

  inTransaction(db, () => idsRepo.setIdentifiers(db, id, { isbn: '' }));
  assert.equal(idsRepo.getIdentifiers(db, id).isbn, undefined, '表里应删掉');
  assert.equal(db.prepare('SELECT isbn FROM books WHERE id = ?').get(id).isbn, '', '专用列也应清空');
  db.close();
});

test('A5 setIdentifiers:未提及的类型保持不动(局部更新语义)', () => {
  const db = freshDb();
  const id = insertBook(db, { title: '甲' });
  inTransaction(db, () => idsRepo.setIdentifiers(db, id, { isbn: 'A', goodreads: 'B' }));
  inTransaction(db, () => idsRepo.setIdentifiers(db, id, { goodreads: 'B2' }));
  assert.deepEqual(idsRepo.getIdentifiers(db, id), { isbn: 'A', goodreads: 'B2' });
  db.close();
});

test('A5 getIdentifiers:表里没有时用旧列兜底(兼容迁移前写入的行)', () => {
  const db = freshDb();
  // 直接写列、不写表,模拟"迁移前"或手工改库
  const ts = new Date().toISOString();
  const r = db.prepare(`INSERT INTO books (title, title_sort, author, author_sort, status, tags, read_logs, isbn, douban_id, uuid, created_at, updated_at)
    VALUES ('裸行', '裸行', '', '', 'wish', '[]', '[]', '9780000000000', '999', ?, ?, ?)`).run(require('node:crypto').randomUUID(), ts, ts);
  const got = idsRepo.getIdentifiers(db, r.lastInsertRowid);
  assert.equal(got.isbn, '9780000000000', '表里没有应从列兜底');
  assert.equal(got.douban, '999');
  db.close();
});

test('A5 getIdentifiersForBooks:批量取多本', () => {
  const db = freshDb();
  const a = insertBook(db, { title: 'A', isbn: '111' });
  const b = insertBook(db, { title: 'B' });
  const map = idsRepo.getIdentifiersForBooks(db, [a, b]);
  assert.equal(map[a].isbn, '111');
  assert.equal(map[b], undefined);
  db.close();
});

test('A5 findDuplicates:同类型同值被多本占用时能查出', () => {
  const db = freshDb();
  insertBook(db, { title: '甲', isbn: 'SAME' });
  insertBook(db, { title: '乙', isbn: 'SAME' });
  insertBook(db, { title: '丙', isbn: 'OTHER' });
  const dup = idsRepo.findDuplicates(db);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].value, 'SAME');
  assert.equal(dup[0].n, 2);
  db.close();
});

test('A5 删书:标识符随外键 CASCADE 消失', () => {
  const db = freshDb();
  const id = insertBook(db, { title: '甲', isbn: 'X' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_identifiers WHERE book = ?').get(id).n, 1);
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_identifiers WHERE book = ?').get(id).n, 0);
  db.close();
});

test('A5 检索:identifier:type:value 与 identifier:type 两种写法', () => {
  const db = freshDb();
  const a = insertBook(db, { title: '甲', isbn: '9780261103252' });
  insertBook(db, { title: '乙', isbn: '9780261103253' });
  inTransaction(db, () => idsRepo.setIdentifiers(db, a, { goodreads: '5907' }));
  search.reindexAll(db);

  assert.deepEqual(titles(search.searchBooks(db, { q: 'identifier:isbn:9780261103252' })), ['甲']);
  assert.deepEqual(titles(search.searchBooks(db, { q: 'identifier:goodreads' })), ['甲'], '只给类型 = 有该类型即可');
  assert.deepEqual(titles(search.searchBooks(db, { q: '标识符:goodreads:5907' })), ['甲'], '中文别名');
  db.close();
});

test('A5 parseBook:isbn / douban_id 进 identifiers;identifiers 对象也能直接传', () => {
  const a = parseBook({ title: 'x', isbn: '123', douban_id: '999' });
  assert.equal(a.values.identifiers.isbn, '123');
  assert.equal(a.values.identifiers.douban, '999');

  const b = parseBook({ title: 'x', identifiers: { goodreads: 'g1', doi: 'd1' } });
  assert.equal(b.values.identifiers.goodreads, 'g1');
  assert.equal(b.values.identifiers.doi, 'd1');
});

/* ================= A7 uuid ================= */

test('A7 迁移:为每本书回填 uuid,且格式合法、互不相同', () => {
  const db = freshDb();
  const ts = new Date().toISOString();
  // 造两行 uuid 为空的行,再手工跑一次 v12 的回填逻辑(等价于老库升级)
  db.prepare(`INSERT INTO books (title, title_sort, author, author_sort, status, tags, read_logs, uuid, created_at, updated_at)
    VALUES ('老书甲','老书甲','','','wish','[]','[]','',?,?),('老书乙','老书乙','','','wish','[]','[]','',?,?)`).run(ts, ts, ts, ts);
  const emptyBefore = db.prepare("SELECT COUNT(*) n FROM books WHERE uuid = ''").get().n;
  assert.equal(emptyBefore, 2);

  // 重放 v12:把 user_version 退一格再跑迁移
  db.exec('PRAGMA user_version = 11');
  const { runMigrations } = require('../src/db/index.js');
  runMigrations(db, tempDir());

  const rows = db.prepare('SELECT id, uuid FROM books').all();
  assert.equal(rows.filter((r) => !r.uuid).length, 0, '所有行都应有 uuid');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const r of rows) assert.ok(uuidRe.test(r.uuid), `uuid 格式应合法:${r.uuid}`);
  assert.equal(new Set(rows.map((r) => r.uuid)).size, rows.length, 'uuid 互不相同');
  db.close();
});

test('A7 v12 迁移幂等:重复重放不改变已回填的 uuid 与 title_sort', () => {
  const db = freshDb();
  const id = insertBook(db, { title: 'The Hobbit' });
  const before = db.prepare('SELECT uuid, title_sort FROM books WHERE id = ?').get(id);

  db.exec('PRAGMA user_version = 11');
  const { runMigrations } = require('../src/db/index.js');
  runMigrations(db, tempDir());

  const after = db.prepare('SELECT uuid, title_sort FROM books WHERE id = ?').get(id);
  assert.equal(after.uuid, before.uuid, '已有 uuid 不应被改写');
  assert.equal(after.title_sort, before.title_sort);
  db.close();
});

test('A7 v12 迁移:把既有 isbn/douban_id 同步进 identifiers 表', () => {
  const db = freshDb();
  const ts = new Date().toISOString();
  const r = db.prepare(`INSERT INTO books (title, title_sort, author, author_sort, status, tags, read_logs, isbn, douban_id, uuid, created_at, updated_at)
    VALUES ('有编号的书','有编号的书','','','wish','[]','[]','9780261103252','1084336',?,?,?)`)
    .run(require('node:crypto').randomUUID(), ts, ts);
  const id = r.lastInsertRowid;

  // 重放 v12:应把列值灌进 identifiers 表
  db.exec('PRAGMA user_version = 11');
  const { runMigrations } = require('../src/db/index.js');
  runMigrations(db, tempDir());

  const got = idsRepo.getIdentifiers(db, id);
  assert.equal(got.isbn, '9780261103252');
  assert.equal(got.douban, '1084336');
  db.close();
});

/* ================= 迁移与结构 ================= */

test('v12 迁移:books 有四个新列,book_identifiers 表存在', () => {
  const dir = tempDir();
  const db = openDb(dir);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  for (const c of ['series', 'series_index', 'title_sort', 'uuid']) {
    assert.ok(cols.includes(c), `缺少列 ${c}`);
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('book_identifiers'));
  // 索引也应在
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  for (const i of ['books_series_idx', 'books_title_sort_idx', 'book_identifiers_type_idx']) {
    assert.ok(idx.includes(i), `缺少索引 ${i}`);
  }
  db.close();
});

test('book_identifiers 主键:同书同类型只能一行(幂等覆盖)', () => {
  const db = freshDb();
  const id = insertBook(db, { title: '甲' });
  inTransaction(db, () => idsRepo.setIdentifiers(db, id, { isbn: 'A' }));
  inTransaction(db, () => idsRepo.setIdentifiers(db, id, { isbn: 'B' }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_identifiers WHERE book = ?').get(id).n, 1);
  assert.equal(idsRepo.getIdentifiers(db, id).isbn, 'B');
  db.close();
});

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
