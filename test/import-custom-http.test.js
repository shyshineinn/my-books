/* ============================================================
 * CSV HTTP:自定义字段(#label 列)的导入
 *
 * 盯的是"表头层校验"这条路:CSV 里带一个**存在**的 #label 列必须能导入,
 * 带**不存在**的才回 400。这两件事早期实现里都是反的 ——
 * 校验时把 mapHeaders 返回的 { index, label } 整个对象当 label 去查表,
 * 于是任何 #列 都被判"不存在",错误消息里还是 [object Object]。
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-import-custom-'));
process.env.MYBOOKS_STORAGE_DIR = root;
process.env.MYBOOKS_SEED_DEMO = 'false';

const { db } = require('../src/db/index.js');
const customFields = require('../src/db/custom_fields.js');
const routesImport = require('../src/http/routes.import.js');

let server;
let baseUrl = '';

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(root, { recursive: true, force: true });
});

// 整个文件共用一台服务:每个用例都重新 listen 会留下一堆没人关的端口
async function boot() {
  if (baseUrl) return baseUrl;
  const app = express();
  app.use(express.json());
  app.use(express.text({ type: ['text/csv', 'text/plain'] }));
  app.use(routesImport);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function post(base, csv, query = 'duplicate=add') {
  const res = await fetch(`${base}/api/import.csv?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: csv,
  });
  return { status: res.status, body: await res.json() };
}

test('导入带已存在的 #label 列:值真的写进这本书', async () => {
  db.exec('DELETE FROM book_custom_values; DELETE FROM custom_columns; DELETE FROM books;');
  customFields.addColumn(db, { label: 'pages', name: '页数', datatype: 'int', is_multiple: false, options: [] });
  const base = await boot();

  const out = await post(base, 'title,#pages\n带字段,300\n');
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.summary.created, 1, JSON.stringify(out.body));

  const book = db.prepare('SELECT id FROM books WHERE title = ?').get('带字段');
  assert.ok(book);
  assert.deepEqual(customFields.getRawValues(db, book.id), { pages: '300' });
});

test('#Label 大小写不同也算同一个字段,值仍写到库内 label 上', async () => {
  const base = await boot();
  const out = await post(base, 'title,#PAGES\n大写列,120\n');
  assert.equal(out.status, 200, JSON.stringify(out.body));

  const book = db.prepare('SELECT id FROM books WHERE title = ?').get('大写列');
  assert.deepEqual(customFields.getRawValues(db, book.id), { pages: '120' });
});

test('不存在的 #label 整份拒绝,消息点名是哪个列', async () => {
  const base = await boot();
  const out = await post(base, 'title,#不存在列\n书,1\n');
  assert.equal(out.status, 400);
  assert.equal(out.body.code, 'VALIDATION');
  assert.match(out.body.error, /不存在列/);
  assert.doesNotMatch(out.body.error, /object Object/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books WHERE title = '书'").get().n, 0, '整份拒绝不该写进任何一行');
});

test('非法的自定义字段值按行失败,同批合法行照旧', async () => {
  const base = await boot();
  const res = await post(base, 'title,#pages\n坏值行,abc\n好值行,88\n');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const bad = res.body.results.find((r) => r.title === '坏值行');
  const good = res.body.results.find((r) => r.title === '好值行');
  assert.equal(bad.status, 'error', JSON.stringify(bad));
  assert.equal(good.status, 'created', JSON.stringify(good));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books WHERE title = '坏值行'").get().n, 0);
});

test('dry_run 也会拦下不存在的 #label', async () => {
  const base = await boot();
  const out = await post(base, 'title,#没有这个字段\n书,1\n', 'dry_run=1&duplicate=add');
  assert.equal(out.status, 400);
  assert.match(out.body.error, /没有这个字段/);
});
