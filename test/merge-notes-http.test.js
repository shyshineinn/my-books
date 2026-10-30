/* ============================================================
 * 合并书籍的心得文件编排测试
 *
 * 覆盖:HTTP 路由在 DB 合并前写目标心得、成功后删来源心得;
 *       DB 合并失败(安卓阅读数据损坏)时恢复目标心得、来源心得不动。
 * 用独立 STORAGE_DIR,避免与其它测试的 notes-files/books.db 相互污染。
 * ============================================================ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-merge-notes-http-'));
process.env.MYBOOKS_STORAGE_DIR = root;
process.env.MYBOOKS_SEED_DEMO = 'false';

const { db } = require('../src/db/index.js');
const books = require('../src/db/books.js');
const notes = require('../src/db/notes.js');
const search = require('../src/db/search.js');
const routesBooks = require('../src/http/routes.books.js');

const app = express();
app.use(express.json());
app.use(routesBooks);
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
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 可能稍后才释放句柄 */ }
});

function reset() {
  db.exec('DELETE FROM mobile_reading_state; DELETE FROM books;');
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  db.exec('DELETE FROM book_tags; DELETE FROM book_authors;');
  for (const id of notes.listNoteIds()) notes.removeNote(id);
}

function makeBook(title) {
  const uuid = randomUUID();
  const ts = '2026-01-02T03:04:05.000Z';
  const r = db.prepare(`
    INSERT INTO books (title, author, author_sort, status, tags, read_logs, uuid, created_at, updated_at)
    VALUES (?, '', '', 'wish', '[]', '[]', ?, ?, ?)
  `).run(title, uuid, ts, ts);
  const id = Number(r.lastInsertRowid);
  search.indexBook(db, db.prepare('SELECT * FROM books WHERE id = ?').get(id));
  return { id, uuid };
}

test('合并成功后:目标心得包含来源小节,来源心得文件删除', async () => {
  reset();
  const target = makeBook('目标');
  const source = makeBook('来源');
  notes.writeNote(target.id, '目标心得');
  notes.writeNote(source.id, '来源心得');

  const res = await fetch(base + '/api/books/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId: target.id, sourceIds: [source.id] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  const merged = notes.readNote(target.id).content;
  assert.match(merged, /目标心得/);
  assert.match(merged, /### 合并自《来源》/);
  assert.match(merged, /来源心得/);
  assert.equal(notes.statNote(source.id), null, '来源心得应删除');
  assert.equal(books.getBook(source.id), undefined, '来源书应永久删除');
});

test('目标没有心得时原样搬入单本来来源心得', async () => {
  reset();
  const target = makeBook('目标');
  const source = makeBook('来源');
  notes.writeNote(source.id, '# 原始心得\n\n正文');

  const res = await fetch(base + '/api/books/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId: target.id, sourceIds: [source.id] }),
  });
  assert.equal(res.status, 200);
  assert.equal(notes.readNote(target.id).content, '# 原始心得\n\n正文');
  assert.equal(notes.statNote(source.id), null);
});

test('DB 合并失败时恢复目标心得,来源心得与来源书不动', async () => {
  reset();
  const target = makeBook('目标');
  const source = makeBook('来源');
  notes.writeNote(target.id, '原目标心得');
  notes.writeNote(source.id, '来源新心得');
  // 损坏的安卓阅读数据会让 mergeReadingStates 抛 VALIDATION,DB 事务回滚
  db.prepare(`INSERT INTO mobile_reading_state (book_id, book_uuid, revision, data, updated_at)
    VALUES (?, ?, 1, ?, ?)`).run(source.id, source.uuid, JSON.stringify({
    positions: [
      { format: 'EPUB', fileSha256: '', lastReadTime: 1, readingProgress: 0.1, locatorJson: null, sourceDeviceId: 'd' },
      { format: 'EPUB', fileSha256: '', lastReadTime: 2, readingProgress: 0.2, locatorJson: null, sourceDeviceId: 'd' },
    ],
    bookmarks: [], notes: [], reading_records: [], tombstones: [],
  }), new Date().toISOString());

  const res = await fetch(base + '/api/books/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId: target.id, sourceIds: [source.id] }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'VALIDATION');
  assert.equal(notes.readNote(target.id).content, '原目标心得', '目标心得必须恢复');
  assert.equal(notes.readNote(source.id).content, '来源新心得', '来源心得不能被删除');
  assert.ok(books.getBook(source.id), '来源书必须保留');
});