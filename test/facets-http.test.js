/* ============================================================
 * 作者/标签 facets 的 HTTP 分页与搜索参数
 * 默认无参数保持全量；带 q/limit/offset 时返回数组 + X-Total-Count。
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-facets-http-'));
process.env.MYBOOKS_STORAGE_DIR = root;
process.env.MYBOOKS_SEED_DEMO = 'false';

const { db } = require('../src/db/index.js');
const categories = require('../src/db/categories.js');
const search = require('../src/db/search.js');
const { splitAuthors } = require('../src/core/book.js');
const routesCategories = require('../src/http/routes.categories.js');
const routesBooks = require('../src/http/routes.books.js');

let server;

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(root, { recursive: true, force: true });
});

function addBook(title, author, tags, series = '', seriesIndex = 0) {
  const ts = '2026-02-03T04:05:06.000Z';
  const names = splitAuthors(author);
  const result = db.prepare(`
    INSERT INTO books (title, author, author_sort, status, tags, read_logs, series, series_index, created_at, updated_at)
    VALUES (?, ?, ?, 'wish', ?, '[]', ?, ?, ?, ?)
  `).run(title, names.join('、'), names[0] || '', JSON.stringify(tags), series, seriesIndex, ts, ts);
  const id = Number(result.lastInsertRowid);
  categories.syncBookTags(db, id, tags);
  categories.syncBookAuthors(db, id, names);
  return id;
}

function start() {
  addBook('甲', '王小明、李四', ['科幻', '100%'], '地球往事', 1);
  addBook('乙', '王大明', ['科幻', '_测试'], '地球往事', 2);
  addBook('丙', '张三', ['文学'], '其他系列', 1);
  search.reindexAll(db);
  const app = express();
  app.use(express.json());
  app.use(routesCategories);
  app.use(routesBooks);
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('facets 分页:数组响应 + X-Total-Count,非法参数 400', async () => {
  const base = await start();

  const page = await fetch(base + '/api/authors?limit=1');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-total-count'), '4');
  assert.deepEqual((await page.json()).map((x) => x.name), ['张三'], '作者按名称排序');

  const second = await fetch(base + '/api/authors?limit=1&offset=1');
  assert.deepEqual((await second.json()).map((x) => x.name), ['李四']);

  const search = await fetch(base + '/api/tags?q=' + encodeURIComponent('科') + '&limit=100');
  assert.equal(search.headers.get('x-total-count'), '1');
  const tags = await search.json();
  assert.deepEqual(tags.map((x) => x.name), ['科幻']);
  assert.equal(tags[0].count, 2);

  for (const query of ['limit=0', 'limit=201', 'limit=x', 'offset=-1']) {
    const bad = await fetch(base + '/api/tags?' + query);
    assert.equal(bad.status, 400, query);
    assert.equal((await bad.json()).code, 'VALIDATION', query);
  }

  const full = await fetch(base + '/api/tags');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('x-total-count'), null, '全量兼容路径不计算总数头');
  assert.deepEqual((await full.json()).map((x) => x.name).sort(), ['100%', '_测试', '文学', '科幻'].sort());

  const series = await fetch(base + '/api/series?limit=1');
  assert.equal(series.status, 200);
  assert.equal(series.headers.get('x-total-count'), '2');
  const seriesPage = await series.json();
  assert.deepEqual(seriesPage.map((x) => `${x.name}:${x.count}`), ['其他系列:1']);

  const seriesSearch = await fetch(base + '/api/series?q=' + encodeURIComponent('地球'));
  assert.equal(seriesSearch.headers.get('x-total-count'), '1');
  const seriesHit = await seriesSearch.json();
  assert.equal(seriesHit[0].name, '地球往事');
  assert.equal(seriesHit[0].max_index, 2);
  assert.ok(seriesHit[0].label);

  const badSeries = await fetch(base + '/api/series?limit=201');
  assert.equal(badSeries.status, 400);
  assert.equal((await badSeries.json()).code, 'VALIDATION');

  // 写操作默认仍带回全量列表;with_list=0 只回操作结果。
  const tag = (await (await fetch(base + '/api/tags?q=' + encodeURIComponent('科幻'))).json())[0];
  const compactRename = await fetch(base + '/api/tags/rename?with_list=0', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tag.id, name: '硬科幻' }),
  });
  const compactBody = await compactRename.json();
  assert.equal(compactBody.ok, true);
  assert.equal(compactBody.tags, undefined);

  const fullRename = await fetch(base + '/api/tags/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: compactBody.id, name: '科幻' }),
  });
  const fullBody = await fullRename.json();
  assert.ok(Array.isArray(fullBody.tags), '默认响应仍带全量列表');

  const authors = await (await fetch(base + '/api/authors?q=' + encodeURIComponent('王'))).json();
  const from = authors.find((a) => a.name === '王大明');
  const to = authors.find((a) => a.name === '王小明');
  const compactMerge = await fetch(base + '/api/authors/merge?with_list=0', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: from.id, to: to.id }),
  });
  const mergeBody = await compactMerge.json();
  assert.equal(mergeBody.ok, true);
  assert.equal(mergeBody.authors, undefined);
  const merged = await (await fetch(base + '/api/authors?q=' + encodeURIComponent('王'))).json();
  assert.deepEqual(merged.map((a) => a.name), ['王小明'], '合并已生效');
});
