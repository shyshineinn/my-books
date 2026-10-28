const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, inTransaction, migrations } = require('../src/db/index');
const { DatabaseSync } = require('node:sqlite');
const books = require('../src/db/books');
const { parseBook } = require('../src/core/book');
const { getBookSnapshot } = require('../src/db/sync');
const { checkBookPrecondition } = require('../src/core/revision');
const temporary = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-sync-'));
  temporary.push(dir);
  return openDb(dir);
}
after(() => temporary.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function add(db, title = '同步测试') { return books.addBook(parseBook({ title }).values, null, db); }

test('同一毫秒的更新也推进版本，并拒绝旧版本而不是依赖时间戳', () => {
  const db = fixture();
  try {
    const original = add(db);
    assert.ok(original.revision >= 1);
    assert.equal(original.revision, books.getBook(original.id, db).revision);
    const { values } = parseBook({ ...original, title: '新书名' });
    const next = books.updateBook(original.id, values, null, db);
    assert.ok(next.revision > original.revision);
    assert.equal(checkBookPrecondition(next, { expected_revision: original.revision }).code, 'CONFLICT');
    assert.equal(checkBookPrecondition(next, { expected_revision: next.revision, expected_uuid: next.uuid }).ok, true);
    assert.equal(checkBookPrecondition(next, { expected_uuid: 'different-book' }).code, 'CONFLICT');
    assert.equal(checkBookPrecondition(next, { expected_revision: '1' }).code, 'VALIDATION');
  } finally { db.close(); }
});
test('删除事件经历回收、彻底删除仍保留；恢复取消删除标记并推进版本', () => {
  const db = fixture();
  try {
    const a = add(db);
    const library = getBookSnapshot(db).library_id;
    books.softDeleteBook(db, a.id);
    let snapshot = getBookSnapshot(db);
    assert.equal(snapshot.books.length, 0);
    assert.equal(snapshot.deleted[0].uuid, a.uuid);
    assert.ok(snapshot.deleted[0].revision > a.revision);
    const deletedRevision = snapshot.deleted[0].revision;
    const restored = books.restoreBook(db, a.id);
    assert.equal(restored.ok, true);
    assert.ok(restored.book.revision > deletedRevision);
    assert.equal(getBookSnapshot(db).deleted.length, 0);
    books.softDeleteBook(db, a.id);
    books.purgeBook(db, a.id);
    snapshot = getBookSnapshot(db);
    assert.equal(snapshot.library_id, library);
    assert.equal(snapshot.deleted[0].uuid, a.uuid);
    assert.equal(snapshot.books.length, 0);
  } finally { db.close(); }
});
test('合并等硬删除与事务回滚均保持删除事件一致', () => {
  const db = fixture();
  try {
    const a = add(db);
    assert.throws(() => inTransaction(db, () => {
      books.hardDeleteBook(db, a.id);
      throw new Error('rollback');
    }));
    assert.equal(getBookSnapshot(db).deleted.length, 0);
    assert.ok(books.getBook(a.id, db));
    books.hardDeleteBook(db, a.id);
    assert.equal(getBookSnapshot(db).deleted[0].uuid, a.uuid);
  } finally { db.close(); }
});
test('附属文件和标识符的变更也推进书目版本', () => {
  const db = fixture();
  try {
    const a = add(db);
    db.prepare("INSERT INTO book_identifiers(book,type,value) VALUES(?, 'test', 'value')").run(a.id);
    const next = books.getBook(a.id, db);
    assert.ok(next.revision > a.revision);
    db.prepare("DELETE FROM book_identifiers WHERE book=? AND type='test'").run(a.id);
    assert.ok(books.getBook(a.id, db).revision > next.revision);
    books.touchBook(a.id, db);
    assert.ok(books.getBook(a.id, db).revision > next.revision + 1);
  } finally { db.close(); }
});
test('迁移后的旧软删除记录可同步，书库身份重启后稳定，演示书有独立 UUID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-sync-reopen-'));
  temporary.push(dir);
  const db = openDb(dir, { seedDemo: true });
  const snapshot = getBookSnapshot(db);
  assert.equal(snapshot.books.length, 17);
  assert.equal(new Set(snapshot.books.map((b) => b.uuid)).size, 17);
  db.close();
  const reopened = openDb(dir);
  try { assert.equal(getBookSnapshot(reopened).library_id, snapshot.library_id); } finally { reopened.close(); }
});
test('v15 升级后回收站内的旧书有明确删除记录，原书 UUID 保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-sync-old-'));
  temporary.push(dir);
  const old = new DatabaseSync(path.join(dir, 'books.db'));
  for (let index = 0; index < 15; index++) migrations[index](old, dir);
  old.exec('PRAGMA user_version=15');
  old.prepare("INSERT INTO books(title,uuid,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run('旧回收书', 'existing-uuid', '2026-10-27T00:00:00Z', '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z');
  old.close();
  const db = openDb(dir);
  try {
    assert.equal(getBookSnapshot(db).deleted[0].uuid, 'existing-uuid');
    assert.equal(getBookSnapshot(db).books.length, 0);
  } finally { db.close(); }
});
