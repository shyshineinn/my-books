/* ============================================================
 * 手动藏书集:数据层、HTTP 接口、书架筛选
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-collections-app-'));
process.env.MYBOOKS_STORAGE_DIR = root;
process.env.MYBOOKS_SEED_DEMO = 'false';

const { openDb, db: appDb } = require('../src/db/index.js');
const collections = require('../src/db/collections.js');
const books = require('../src/db/books.js');
const search = require('../src/db/search.js');
const routesCollections = require('../src/http/routes.collections.js');

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-collections-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  try { appDb.close(); } catch { /* ignore */ }
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

function freshDb() {
  const db = openDb(tempDir());
  db.exec('DELETE FROM book_collections; DELETE FROM collections; DELETE FROM books;');
  return db;
}

function makeBook(db, { title = '书', series = '', status = 'wish' } = {}) {
  const ts = '2026-01-02T03:04:05.000Z';
  const r = db.prepare(`
    INSERT INTO books (title, author, author_sort, status, tags, read_logs, uuid, series, created_at, updated_at)
    VALUES (?, '', '', ?, '[]', '[]', ?, ?, ?, ?)
  `).run(title, status, randomUUID(), series, ts, ts);
  return Number(r.lastInsertRowid);
}

test('藏书集:创建、重名、计数、幂等加入与移除', () => {
  const db = freshDb();
  const a = makeBook(db, { title: '甲' });
  const b = makeBook(db, { title: '乙' });
  const c = collections.createCollection(db, '  待读  ');
  assert.equal(c.name, '待读');
  assert.equal(c.count, 0);
  assert.throws(() => collections.createCollection(db, '待读'), (err) => err.code === 'CONFLICT');

  const tech = collections.createCollection(db, '技术');
  assert.equal(collections.addBooks(db, c.id, [a, b, a]), 2, '重复 id 只加一次');
  assert.equal(collections.addBooks(db, c.id, [a]), 0, '重复加入是幂等的');
  assert.equal(collections.listCollections(db).find((x) => x.id === c.id).count, 2);
  assert.deepEqual(collections.listForBook(db, a).map((x) => x.name), ['待读']);

  const renamed = collections.renameCollection(db, c.id, '待读 2026');
  assert.equal(renamed.name, '待读 2026');
  assert.equal(renamed.count, 2);
  assert.throws(() => collections.renameCollection(db, c.id, '技术'), (err) => err.code === 'CONFLICT');

  assert.equal(collections.removeBooks(db, c.id, [a]), 1);
  assert.equal(collections.removeBooks(db, c.id, [a]), 0);
  assert.equal(collections.listCollections(db).find((x) => x.id === c.id).count, 1);
  assert.equal(collections.removeCollection(db, c.id), true);
  assert.equal(collections.removeCollection(db, c.id), false);
  assert.deepEqual(collections.listForBook(db, b), []);
  assert.deepEqual(collections.listCollections(db).map((x) => x.name), ['技术'], '删分组不删书');
  assert.ok(books.getBook(a, db), '书仍然存在');
  assert.ok(books.getBook(b, db));
  assert.equal(tech.count, 0);
  db.close();
});

test('藏书集:软删除隐藏计数,恢复保留关系,彻底删除级联清理', () => {
  const db = freshDb();
  const a = makeBook(db, { title: '甲' });
  const b = makeBook(db, { title: '乙' });
  const c = collections.createCollection(db, '待读');
  collections.addBooks(db, c.id, [a, b]);
  assert.equal(collections.listCollections(db)[0].count, 2);

  books.softDeleteBook(db, a);
  assert.equal(collections.listCollections(db)[0].count, 1, '回收站里的书不计入');
  assert.equal(collections.addBooks(db, c.id, [a]), 0, '回收站里的书不能新加入');
  books.restoreBook(db, a);
  assert.equal(collections.listCollections(db)[0].count, 2, '恢复后关系仍在');

  books.softDeleteBook(db, a);
  books.purgeBook(db, a);
  assert.equal(collections.listCollections(db)[0].count, 1);
  assert.deepEqual(collections.listForBook(db, a), [], '彻底删除后关系级联清理');
  assert.ok(books.getBook(b, db));
  db.close();
});

test('藏书集:批量加入/移除失败时整体回滚', () => {
  const db = freshDb();
  const a = makeBook(db, { title: '甲' });
  const b = makeBook(db, { title: '乙' });
  const c = collections.createCollection(db, '待读');
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM book_collections').get().n;

  db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON book_collections
    WHEN NEW.book_id = ${b} BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
  assert.throws(() => collections.addBooks(db, c.id, [a, b]), /boom/);
  assert.equal(count(), 0, '第二条失败时第一条也必须回滚');

  db.exec('DROP TRIGGER fail_insert');
  collections.addBooks(db, c.id, [a, b]);
  assert.equal(count(), 2);
  db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON book_collections
    WHEN OLD.book_id = ${b} BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
  assert.throws(() => collections.removeBooks(db, c.id, [a, b]), /boom/);
  assert.equal(count(), 2, '第二条删除失败时第一条也必须回滚');
  db.close();
});

test('书架筛选:collection 精确成员、series 精确匹配、非法 id', () => {
  const db = freshDb();
  const a = makeBook(db, { title: '基地', series: '基地', status: 'done' });
  const b = makeBook(db, { title: '基地续篇', series: '基地续篇', status: 'wish' });
  const c = makeBook(db, { title: '无关', series: '基地', status: 'reading' });
  const col = collections.createCollection(db, '待读');
  collections.addBooks(db, col.id, [a, b]);

  const byCollection = search.searchBooksPage(db, { collection: String(col.id) }, { start: 0, size: 20 });
  assert.equal(byCollection.total, 2);
  assert.deepEqual(byCollection.rows.map((r) => r.id).sort((x, y) => x - y), [a, b].sort((x, y) => x - y));

  const bySeries = search.searchBooksPage(db, { series: '基地' }, { start: 0, size: 20 });
  assert.equal(bySeries.total, 2, '系列精确匹配,不命中「基地续篇」');
  assert.deepEqual(bySeries.rows.map((r) => r.id).sort((x, y) => x - y), [a, c].sort((x, y) => x - y));

  const combined = search.searchBooksPage(db, { collection: String(col.id), status: 'done' }, { start: 0, size: 20 });
  assert.deepEqual(combined.rows.map((r) => r.id), [a]);

  assert.throws(() => search.searchBooksPage(db, { collection: 'abc' }, { start: 0, size: 20 }),
    (err) => err.code === 'VALIDATION');
  assert.equal(search.searchBooksPage(db, { collection: '999999' }, { start: 0, size: 20 }).total, 0);
  db.close();
});

test('藏书集 HTTP:CRUD 与批量关系接口', async () => {
  const db = appDb;
  db.exec('DELETE FROM book_collections; DELETE FROM collections; DELETE FROM books;');
  const a = makeBook(db, { title: '甲' });
  const b = makeBook(db, { title: '乙' });
  const app = express();
  app.use(express.json());
  app.use(routesCollections);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(base + '/api/collections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '待读' }),
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    const id = created.item.id;

    assert.equal((await fetch(base + '/api/collections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '待读' }),
    })).status, 409);
    assert.equal((await fetch(base + '/api/collections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ' ' }),
    })).status, 400);

    res = await fetch(`${base}/api/collections/${id}/books`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [a, b] }),
    });
    assert.deepEqual(await res.json(), { ok: true, added: 2 });

    const listed = await (await fetch(base + '/api/collections')).json();
    assert.deepEqual(listed, [{ id, name: '待读', count: 2 }]);

    res = await fetch(`${base}/api/collections/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '2026 待读' }),
    });
    assert.equal((await res.json()).item.name, '2026 待读');

    res = await fetch(`${base}/api/collections/${id}/books`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [a] }),
    });
    assert.deepEqual(await res.json(), { ok: true, removed: 1 });
    assert.equal((await fetch(`${base}/api/collections/${id}/books`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [] }),
    })).status, 400);
    assert.equal((await fetch(base + '/api/collections/999999/books', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [a] }),
    })).status, 404);

    assert.equal((await fetch(`${base}/api/collections/${id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(await (await fetch(base + '/api/collections')).json(), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
