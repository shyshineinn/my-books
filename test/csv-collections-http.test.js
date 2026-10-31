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

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(root, { recursive: true, force: true });
});

function collectionNames(bookId) {
  return db.prepare(`
    SELECT c.name FROM book_collections bc JOIN collections c ON c.id = bc.collection_id
    WHERE bc.book_id = ? ORDER BY c.name
  `).all(bookId).map((r) => r.name);
}

test('CSV 导出含 collections 列;导入自动建集并加入', async () => {
  db.exec('DELETE FROM book_collections; DELETE FROM collections; DELETE FROM books;');
  dbImport.createBook({ title: '旧书', author: '旧作者' }, null, db, ['待读']);

  const app = express();
  app.use(express.json());
  app.use(express.text({ type: ['text/csv', 'text/plain'] }));
  app.use(routesExport);
  app.use(routesImport);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

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
