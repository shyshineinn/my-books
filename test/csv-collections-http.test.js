/* ============================================================
 * CSV HTTP:导出带藏书集列,导入按名称建集并加入
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-csv-collections-'));
process.env.MYBOOKS_STORAGE_DIR = root;
process.env.MYBOOKS_SEED_DEMO = 'false';

const { db } = require('../src/db/index.js');
const dbImport = require('../src/db/import.js');
const routesExport = require('../src/http/routes.export.js');
const routesImport = require('../src/http/routes.import.js');
const { parseCsv } = require('../src/core/csv.js');

let server;
let baseUrl = '';

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(root, { recursive: true, force: true });
});

// 整个文件共用一台服务:每个用例重新 listen 会留下一堆没人关的端口
async function boot() {
  if (baseUrl) return baseUrl;
  const app = express();
  app.use(express.json());
  app.use(express.text({ type: ['text/csv', 'text/plain'] }));
  app.use(routesExport);
  app.use(routesImport);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

function collectionNames(bookId) {
  return db.prepare(`
    SELECT c.name FROM book_collections bc JOIN collections c ON c.id = bc.collection_id
    WHERE bc.book_id = ? ORDER BY c.name
  `).all(bookId).map((r) => r.name);
}

const tagNames = (bookId) => db.prepare(`
  SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag WHERE bt.book = ? ORDER BY t.name
`).all(bookId).map((r) => r.name);

const authorNames = (bookId) => db.prepare(`
  SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author
  WHERE ba.book = ? ORDER BY ba.position
`).all(bookId).map((r) => r.name);

test('CSV 导出含 collections 列;导入自动建集并加入', async () => {
  db.exec('DELETE FROM book_collections; DELETE FROM collections; DELETE FROM books;');
  dbImport.createBook({ title: '旧书', author: '旧作者' }, null, db, ['待读']);

  const base = await boot();

  const exported = await fetch(base + '/api/export.csv');
  assert.equal(exported.status, 200);
  const catalog = parseCsv(await exported.text());
  const oldRow = catalog.rows.find((row) => row[catalog.headers.indexOf('title')] === '旧书');
  assert.equal(oldRow[catalog.headers.indexOf('collections')], '待读');

  const csv = 'title,author,collections\n"新书","新作者","精读, 待读"\n';
  const imported = await fetch(base + '/api/import.csv?duplicate=add', {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: csv,
  });
  assert.equal(imported.status, 200);
  const out = await imported.json();
  assert.equal(out.summary.created, 1, JSON.stringify(out));
  const created = db.prepare('SELECT id FROM books WHERE title = ?').get('新书');
  assert.ok(created);
  assert.deepEqual(collectionNames(created.id), ['待读', '精读']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collections').get().n, 2, '同名藏书集不用重复创建');
});

// 名字里就带分隔符(标签「科幻, 悬疑」、藏书集「精读、泛读」、作者「Herbert, Frank」)时,
// 导出→导入必须原样回来,而不是被拆成两个标签 / 两个集 / 两位作者。
// 做法是真的走一圈:建样本 → 导出 → 清库 → 导回 → 比对真源表。
test('导出再导入:名字里含分隔符的标签、藏书集、作者都不被拆开', async () => {
  const wipe = () => {
    db.exec('DELETE FROM book_collections; DELETE FROM collections;');
    db.exec('DELETE FROM book_tags; DELETE FROM book_authors; DELETE FROM tags; DELETE FROM authors;');
    db.exec('DELETE FROM books;');
  };
  wipe();
  const base = await boot();

  // 用 authors 数组建样本:parseBook 只归一化数组项,不再按分隔符拆,
  // 这样才能造出"名字里带逗号"的作者(库里这种写法就是 calibre 的「姓, 名」)。
  dbImport.createBook(
    { title: '往返样本', authors: ['Herbert, Frank', 'Doe, Jane'], tags: ['科幻, 悬疑', '带、号'] },
    null, db, ['精读、泛读'],
  );
  const 样本 = db.prepare('SELECT id, author, author_sort FROM books WHERE title = ?').get('往返样本');
  const expectTags = tagNames(样本.id);
  const expectAuthors = authorNames(样本.id);
  const expectCollections = collectionNames(样本.id);
  assert.deepEqual(expectTags, ['带、号', '科幻, 悬疑'].sort(), '样本本身应按整名建标签');

  const exported = await fetch(base + '/api/export.csv');
  const csv = await exported.text();
  const catalog = parseCsv(csv);
  const row = catalog.rows.find((r) => r[catalog.headers.indexOf('title')] === '往返样本');
  const cellOf = (name) => row[catalog.headers.indexOf(name)];
  // 导出侧确实做了转义:分隔符前面挂一个反斜杠,读回时就不算拆分点
  assert.match(cellOf('author'), /Herbert\\, Frank、Doe\\, Jane/);
  assert.match(cellOf('tags'), /科幻\\, 悬疑/);

  wipe();
  const imported = await fetch(base + '/api/import.csv?duplicate=add', {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: csv,
  });
  assert.equal(imported.status, 200);
  const out = await imported.json();
  assert.equal(out.summary.created, 1, JSON.stringify(out.results));

  const 回来 = db.prepare('SELECT id, author, author_sort FROM books WHERE title = ?').get('往返样本');
  assert.ok(回来, '导入应新建同一本');
  assert.deepEqual(tagNames(回来.id), expectTags);
  assert.deepEqual(authorNames(回来.id), expectAuthors);
  assert.deepEqual(collectionNames(回来.id), expectCollections);
  assert.equal(回来.author, 样本.author, '作者缓存串不变');
  assert.equal(回来.author_sort, 样本.author_sort, '排序键按整名算(「Herbert, Frank」已带逗号 = 用户写好的「姓, 名」)');
  // 真源表里不该多出被拆开的碎片
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE name IN ('科幻','悬疑',' 悬疑')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM authors WHERE name IN ('Herbert','Frank','Doe','Jane')").get().n, 0);
});
