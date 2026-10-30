/* ============================================================
 * 列表分页契约测试
 *
 * 覆盖:searchBooksPage 的行/总数、跨页无重复、稳定排序、
 *       FTS 与 LIKE 两条检索路径、HTTP start/size/X-Total-Count、
 *       虚拟书库作用域、非法参数 400、以及"不传 size 保持全量"的兼容性。
 * 隔离:数据库用测试套件的临时存储;HTTP 只挂业务路由,不经过鉴权层。
 * ============================================================ */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { db } = require('../src/db/index.js');
const routesBooks = require('../src/http/routes.books.js');
const { attachVlScope } = require('../src/http/middleware.vl.js');
const saved = require('../src/db/saved_searches.js');
const categories = require('../src/db/categories.js');
const search = require('../src/db/search.js');

const N = 25;

function seed(count = N, { sameTimestamp = false } = {}) {
  db.exec(`
    DELETE FROM book_custom_values;
    DELETE FROM book_files;
    DELETE FROM book_identifiers;
    DELETE FROM book_tags;
    DELETE FROM book_authors;
    DELETE FROM saved_searches;
    DELETE FROM books;
    DELETE FROM tags;
    DELETE FROM authors;
  `);
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  const ins = db.prepare(`
    INSERT INTO books (title, author, status, tags, read_logs, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', ?, ?)
  `);
  for (let i = 1; i <= count; i += 1) {
    const ts = sameTimestamp
      ? '2026-01-01T00:00:00.000Z'
      : `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`;
    const tags = i % 3 === 0 ? ['科幻'] : ['小说'];
    const author = i % 2 === 0 ? '刘慈欣' : '余华';
    const status = i % 4 === 0 ? 'done' : 'reading';
    const title = i % 3 === 0 ? `三体 ${i}` : `书 ${i}`;
    const r = ins.run(title, author, status, JSON.stringify(tags), ts, ts);
    const id = Number(r.lastInsertRowid);
    categories.syncBookTags(db, id, tags);
    categories.syncBookAuthors(db, id, [author]);
    categories.recomputeBookCaches(db, id);
    search.indexBook(db, db.prepare('SELECT * FROM books WHERE id = ?').get(id));
  }
}

function pageThrough(query, size = 7) {
  const seen = [];
  let start = 0;
  for (;;) {
    const { rows, total } = search.searchBooksPage(db, query, { start, size });
    if (!rows.length) return { ids: seen, total };
    seen.push(...rows.map((r) => r.id));
    start += size;
    if (seen.length >= total) return { ids: seen, total };
  }
}

/* ---------- 数据库层 ---------- */

test('searchBooksPage:返回当前页与总数,不传 page 的 searchBooks 仍返回全量', () => {
  seed();
  assert.equal(search.searchBooks(db, {}).length, N);
  const first = search.searchBooksPage(db, {}, { start: 0, size: 10 });
  assert.equal(first.rows.length, 10);
  assert.equal(first.total, N);
  assert.ok(!('__total' in first.rows[0]), '内部字段不能泄漏给调用方');
});

test('searchBooksPage:跨页无重复、无遗漏(相同 updated_at 也要稳定)', () => {
  seed(N, { sameTimestamp: true });
  const { ids, total } = pageThrough({ sort: 'updated' }, 7);
  assert.equal(total, N);
  assert.equal(ids.length, N);
  assert.equal(new Set(ids).size, N);
});

test('searchBooksPage:无 q + 标签过滤 + sort=title 分页仍然稳定', () => {
  seed();
  const expected = search.searchBooks(db, { tag: '科幻', sort: 'title' }).map((r) => r.id);
  const seen = [];
  for (let start = 0; start < expected.length; start += 4) {
    const { rows, total } = search.searchBooksPage(db, { tag: '科幻', sort: 'title' }, { start, size: 4 });
    assert.equal(total, expected.length);
    seen.push(...rows.map((r) => r.id));
  }
  assert.deepEqual(seen, expected);
});

test('searchBooksPage:短词 LIKE 与长词 FTS 都能分页并给出正确总数', () => {
  seed();
  const short = search.searchBooksPage(db, { q: '三体' }, { start: 0, size: 3 });
  const shortAll = search.searchBooks(db, { q: '三体' });
  assert.equal(short.total, shortAll.length);
  assert.equal(short.rows.length, Math.min(3, shortAll.length));

  const long = search.searchBooksPage(db, { q: '刘慈欣' }, { start: 0, size: 2 });
  const longAll = search.searchBooks(db, { q: '刘慈欣' });
  assert.equal(long.total, longAll.length);
  assert.equal(long.rows.length, Math.min(2, longAll.length));
});

test('searchBooksPage:start 越过末页返回空数组且总数仍正确', () => {
  seed();
  const page = search.searchBooksPage(db, {}, { start: N + 50, size: 10 });
  assert.deepEqual(page.rows, []);
  assert.equal(page.total, N);
});

test('searchBooksPage:非法分页参数抛 VALIDATION', () => {
  seed();
  for (const page of [{ start: -1, size: 10 }, { start: 0, size: 0 }, { start: 0, size: 1.5 }]) {
    assert.throws(() => search.searchBooksPage(db, {}, page), (e) => e.code === 'VALIDATION');
  }
});

/* ---------- HTTP 层 ---------- */

const app = express();
app.use(express.json());
app.use('/api', attachVlScope);
app.use(routesBooks);
let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

test('HTTP:size/start 分页 + X-Total-Count + no-store', async () => {
  seed();
  const res = await fetch(`${base}/api/books?size=10&start=0`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-total-count'), String(N));
  assert.match(res.headers.get('cache-control'), /no-store/);
  const rows = await res.json();
  assert.equal(rows.length, 10);
  assert.ok(!('__total' in rows[0]));

  const last = await fetch(`${base}/api/books?size=10&start=20`);
  assert.equal(last.headers.get('x-total-count'), String(N));
  assert.equal((await last.json()).length, 5);
});

test('HTTP:不传 size 时保持旧行为(全量数组,无分页头)', async () => {
  seed();
  const res = await fetch(`${base}/api/books`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-total-count'), null);
  assert.equal((await res.json()).length, N);
});

test('HTTP:筛选条件参与总数计算', async () => {
  seed();
  const expected = search.searchBooks(db, { status: 'done' }).length;
  const res = await fetch(`${base}/api/books?status=done&size=5`);
  assert.equal(res.headers.get('x-total-count'), String(expected));
  assert.equal((await res.json()).length, Math.min(5, expected));
});

test('HTTP:虚拟书库作用域 + 分页', async () => {
  seed();
  saved.addSaved(db, { name: '已读', query: 'status:done', isVirtual: true });
  const expected = search.searchBooks(db, { q: 'status:done' }).length;
  const res = await fetch(`${base}/api/books?vl=${encodeURIComponent('已读')}&size=4`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-total-count'), String(expected));
  assert.equal((await res.json()).length, Math.min(4, expected));
});

test('HTTP:多个 vl 取交集(INTERSECT),作用域子查询参数顺序正确', async () => {
  seed();
  saved.addSaved(db, { name: '已读', query: 'status:done', isVirtual: true });
  saved.addSaved(db, { name: '科幻', query: 'tag:科幻', isVirtual: true });
  const expected = search.searchBooks(db, { q: 'status:done tag:科幻' }).length;
  assert.ok(expected > 0, '样本里应有交集');
  const res = await fetch(`${base}/api/books?vl=${encodeURIComponent('已读')}&vl=${encodeURIComponent('科幻')}&size=5`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-total-count'), String(expected));
  assert.equal((await res.json()).length, Math.min(5, expected));
});

test('HTTP:虚拟书库查询里的长自由词走 LIKE 子查询,仍能命中', async () => {
  seed();
  saved.addSaved(db, { name: '刘慈欣书', query: '刘慈欣', isVirtual: true });
  const expected = search.searchBooks(db, { q: '刘慈欣' }).length;
  const res = await fetch(`${base}/api/books?vl=${encodeURIComponent('刘慈欣书')}&size=3`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-total-count'), String(expected));
  assert.equal((await res.json()).length, Math.min(3, expected));
});

test('HTTP:非法分页参数返回 400 VALIDATION', async () => {
  seed();
  for (const qs of ['size=0', 'size=201', 'size=abc', 'start=-1&size=10', 'start=1.2&size=10']) {
    const res = await fetch(`${base}/api/books?${qs}`);
    assert.equal(res.status, 400, qs);
    assert.equal((await res.json()).code, 'VALIDATION', qs);
  }
});

test('HTTP:start 越过末页返回空数组与正确总数', async () => {
  seed();
  const res = await fetch(`${base}/api/books?start=999&size=10`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-total-count'), String(N));
  assert.deepEqual(await res.json(), []);
});