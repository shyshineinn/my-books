/* ============================================================
 * 删书磁盘清理(修复问题 2)的回归测试:
 *   · core/book.coverUploadFile —— 封面字段 → uploads 相对文件名(纯函数)
 *   · core/fs-utils.removeUnderBase —— 删除的目录边界收口
 *   · db/books.collectAssets —— 删前收集资产(含共享封面引用检查)
 *   · 组合演练:collectAssets + removeUnderBase 走完路由层删书的磁盘部分
 * 用 openDb(临时目录) 隔离,不碰生产 data/ 与真实 uploads/。
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { coverUploadFile } = require('../src/core/book');
const { removeUnderBase } = require('../src/core/fs-utils');
const { openDb } = require('../src/db/index.js');
const { collectAssets } = require('../src/db/books.js');
const bookFiles = require('../src/db/book_files.js');

const tmpDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- coverUploadFile(纯函数) ---------- */

test('coverUploadFile:本站上传封面提取文件名', () => {
  assert.equal(coverUploadFile('/uploads/1788615697338-18e2fbf6.png'), '1788615697338-18e2fbf6.png');
});

test('coverUploadFile:外链/空值/相对路径返回空串(无本地文件可删)', () => {
  assert.equal(coverUploadFile('https://img3.doubanio.com/view/cover/x.jpg'), '');
  assert.equal(coverUploadFile(''), '');
  assert.equal(coverUploadFile(null), '');
  assert.equal(coverUploadFile('/uploads/'), '');                 // 只有目录前缀
  assert.equal(coverUploadFile('/uploads/a/b.png'), '');          // 含子目录:拒绝
});

test('coverUploadFile:反斜杠路径拒绝', () => {
  assert.equal(coverUploadFile('/uploads\\x.png'), '');
  assert.equal(coverUploadFile('/uploads/a\\b.png'), '');
});

/* ---------- removeUnderBase(删除边界) ---------- */

test('removeUnderBase:删除 base 内的文件,返回 true 且文件消失', () => {
  const dir = tempDir('mybooks-rub-');
  const f = path.join(dir, 'a.epub');
  fs.writeFileSync(f, 'x');
  assert.equal(removeUnderBase(dir, 'a.epub'), true);
  assert.equal(fs.existsSync(f), false);
});

test('removeUnderBase:文件不存在视为成功(force 语义)', () => {
  const dir = tempDir('mybooks-rub-');
  assert.equal(removeUnderBase(dir, 'ghost.epub'), true);
});

test('removeUnderBase:越界路径拒删,目标文件毫发无损', () => {
  const dir = tempDir('mybooks-rub-');
  const other = tempDir('mybooks-rub-other-');
  const outside = path.join(other, 'secret.txt');   // 真·base 外的文件
  fs.writeFileSync(outside, 'do not delete');
  assert.equal(removeUnderBase(dir, '../' + path.basename(other) + '/secret.txt'), false);
  assert.equal(removeUnderBase(dir, path.resolve(outside)), false); // 绝对路径指向 base 外
  assert.equal(removeUnderBase(dir, '.'), false);                    // base 目录本身
  assert.equal(fs.existsSync(outside), true, '拒删必须真的没碰磁盘');
});

test('removeUnderBase:空路径视为成功(无事可做)', () => {
  assert.equal(removeUnderBase(tempDir('mybooks-rub-'), ''), true);
  assert.equal(removeUnderBase(tempDir('mybooks-rub-'), null), true);
});

/* ---------- collectAssets(删前收集) ---------- */

function freshDb() {
  const dir = tempDir('mybooks-del-test-');
  const db = openDb(dir);
  db.prepare('DELETE FROM books').run();
  const { reindexAll } = require('../src/db/search.js');
  reindexAll(db);
  return db;
}

function insertBook(db, { title = '书', cover = '' }) {
  const ts = new Date().toISOString();
  const r = db.prepare(
    "INSERT INTO books (title, status, tags, read_logs, cover, created_at, updated_at) VALUES (?, 'done', '[]', '[]', ?, ?, ?)"
  ).run(title, cover, ts, ts);
  return Number(r.lastInsertRowid);
}

test('collectAssets:返回电子书文件与本站封面;不存在的 id 返回 null', () => {
  const db = freshDb();
  const id = insertBook(db, { cover: '/uploads/cover-a.png' });
  bookFiles.upsertFile(db, id, { format: 'EPUB', path: '1-a.epub', size: 10 });
  bookFiles.upsertFile(db, id, { format: 'PDF', path: '1-b.pdf', size: 20 });

  const assets = collectAssets(db, id);
  assert.deepEqual(assets.ebookFiles.sort(), ['1-a.epub', '1-b.pdf']);
  assert.deepEqual(assets.coverFiles, ['cover-a.png']);

  assert.equal(collectAssets(db, 999999), null);
  db.close();
});

test('collectAssets:外链封面没有本地文件,coverFiles 为空', () => {
  const db = freshDb();
  const id = insertBook(db, { cover: 'https://img3.doubanio.com/view/cover/x.jpg' });
  const assets = collectAssets(db, id);
  assert.deepEqual(assets.ebookFiles, []);
  assert.deepEqual(assets.coverFiles, []);
  db.close();
});

test('collectAssets:封面被另一本书引用时不交出文件(防误删共享图)', () => {
  const db = freshDb();
  const id1 = insertBook(db, { title: '甲', cover: '/uploads/shared.png' });
  insertBook(db, { title: '乙', cover: '/uploads/shared.png' });
  const assets = collectAssets(db, id1);
  assert.deepEqual(assets.coverFiles, [], '仍被引用的封面不能删');
  db.close();
});

test('组合演练:收集 → 删除,磁盘资产随记录一起清理', () => {
  const db = freshDb();
  const filesDir = tempDir('mybooks-files-');
  const uploadsDir = tempDir('mybooks-uploads-');

  const id = insertBook(db, { cover: '/uploads/cover-x.png' });
  bookFiles.upsertFile(db, id, { format: 'EPUB', path: '9-x.epub', size: 10 });
  fs.writeFileSync(path.join(filesDir, '9-x.epub'), 'ebook');
  fs.writeFileSync(path.join(uploadsDir, 'cover-x.png'), 'png');

  // 模拟路由层顺序:先收集(此时行还在),再删记录,最后删磁盘
  const assets = collectAssets(db, id);
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  for (const p of assets.ebookFiles) assert.equal(removeUnderBase(filesDir, p), true);
  for (const p of assets.coverFiles) assert.equal(removeUnderBase(uploadsDir, p), true);

  assert.deepEqual(fs.readdirSync(filesDir), [], '电子书目录应清空');
  assert.deepEqual(fs.readdirSync(uploadsDir), [], '封面目录应清空');
  db.close();
});
