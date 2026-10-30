/* ============================================================
 * 电子书上传/删除的生命周期测试
 *
 * 覆盖:成功上传持久化 SHA;缺失书/非法 id/非法格式时临时文件被清理;
 *       磁盘删除失败时保留 DB 登记;正常删除同时清磁盘与登记。
 * 独立 STORAGE_DIR,不碰真实 books-files/uploads。
 * ============================================================ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-files-http-'));
process.env.MYBOOKS_STORAGE_DIR = root;
process.env.MYBOOKS_SEED_DEMO = 'false';

const { db } = require('../src/db/index.js');
const { FILES_DIR } = require('../src/core/paths.js');
const bookFiles = require('../src/db/book_files.js');
const search = require('../src/db/search.js');
const routesFiles = require('../src/http/routes.files.js');

const app = express();
app.use(express.json());
app.use(routesFiles);
let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function reset() {
  db.exec('DELETE FROM book_files; DELETE FROM books;');
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  for (const name of fs.readdirSync(FILES_DIR)) fs.rmSync(path.join(FILES_DIR, name), { force: true });
}

function makeBook(title = '测试书') {
  const ts = '2026-01-02T03:04:05.000Z';
  const r = db.prepare(`
    INSERT INTO books (title, author, author_sort, status, tags, read_logs, uuid, created_at, updated_at)
    VALUES (?, '', '', 'wish', '[]', '[]', ?, ?, ?)
  `).run(title, randomUUID(), ts, ts);
  const id = Number(r.lastInsertRowid);
  search.indexBook(db, db.prepare('SELECT * FROM books WHERE id = ?').get(id));
  return id;
}

function uploadForm(body, name) {
  const form = new FormData();
  form.append('file', new Blob([body], { type: 'application/octet-stream' }), name);
  return form;
}

async function postFile(id, body, name) {
  return fetch(`${base}/api/books/${id}/file`, { method: 'POST', body: uploadForm(body, name) });
}

const temporaryFiles = () => fs.readdirSync(FILES_DIR).filter((name) => name.startsWith('uploading-'));

test('成功上传:返回并持久化 SHA-256,文件落盘', async () => {
  reset();
  const id = makeBook();
  const body = Buffer.from('hello epub');
  const res = await postFile(id, body, 'book.epub');
  assert.equal(res.status, 201);
  const json = await res.json();
  const expected = createHash('sha256').update(body).digest('hex');
  assert.equal(json.file.format, 'EPUB');
  assert.equal(json.file.sha256, expected);
  const row = bookFiles.getFile(db, id, 'EPUB');
  assert.equal(row.sha256, expected);
  assert.ok(fs.existsSync(path.join(FILES_DIR, row.path)));
});

test('缺书 / 非法 id / 非法格式:临时文件都被清理', async () => {
  reset();
  const missing = await postFile(999999, Buffer.from('x'), 'x.epub');
  assert.equal(missing.status, 404);
  assert.deepEqual(temporaryFiles(), []);

  const badId = await postFile('abc', Buffer.from('x'), 'x.epub');
  assert.equal(badId.status, 400);
  assert.deepEqual(temporaryFiles(), []);

  const id = makeBook();
  const badFormat = await postFile(id, Buffer.from('x'), 'x.exe');
  assert.equal(badFormat.status, 400);
  assert.deepEqual(temporaryFiles(), []);
  assert.equal(bookFiles.listFiles(db, id).length, 0);
});

test('磁盘删除失败时保留登记;正常删除同时清磁盘与登记', async () => {
  reset();
  const id = makeBook();
  bookFiles.upsertFile(db, id, { format: 'PDF', path: '../outside.pdf', size: 1 });

  const failed = await fetch(`${base}/api/books/${id}/file?format=PDF`, { method: 'DELETE' });
  assert.equal(failed.status, 500);
  assert.ok(bookFiles.getFile(db, id, 'PDF'), '删除失败时登记必须保留');

  const body = Buffer.from('hello delete');
  const uploaded = await postFile(id, body, 'book.epub');
  assert.equal(uploaded.status, 201);
  const saved = bookFiles.getFile(db, id, 'EPUB');
  const finalPath = path.join(FILES_DIR, saved.path);
  assert.ok(fs.existsSync(finalPath));

  const deleted = await fetch(`${base}/api/books/${id}/file?format=EPUB`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(bookFiles.getFile(db, id, 'EPUB'), null);
  assert.equal(fs.existsSync(finalPath), false);
});