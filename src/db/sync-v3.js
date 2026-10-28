const { EMPTY_READING_DATA, validateReadingData } = require('../core/mobile-reading');

function cursorError() {
  return Object.assign(new Error('同步游标已失效，需要重新获取完整视图'), { code: 'CURSOR_RESET', status: 410 });
}
function pruneSyncChanges(db, keep = 100000) {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('Invalid log retention');
  db.prepare('DELETE FROM sync_changes WHERE seq < (SELECT COALESCE(MAX(seq),0)-?+1 FROM sync_changes)').run(keep);
}
function getSyncChanges(db, cursor) {
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec('BEGIN');
  try {
    pruneSyncChanges(db);
    const library = db.prepare("SELECT value FROM sync_metadata WHERE key='library_id'").get().value;
    const last = db.prepare('SELECT seq, checkpoint FROM sync_changes ORDER BY seq DESC LIMIT 1').get();
    const high = last?.seq || 0;
    let since = 0;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw cursorError();
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (decoded.library_id !== library || !Number.isSafeInteger(decoded.seq) || decoded.seq < 0 || decoded.seq > high) throw cursorError();
        if (decoded.seq === 0 && (db.prepare('SELECT MIN(seq) AS first FROM sync_changes').get().first || 0) > 1) throw cursorError();
        const checkpoint = decoded.seq === 0 ? '' : db.prepare('SELECT checkpoint FROM sync_changes WHERE seq=?').get(decoded.seq)?.checkpoint;
        if (decoded.checkpoint !== checkpoint) throw cursorError();
        since = decoded.seq;
      } catch { throw cursorError(); }
    }
    const full = cursor === undefined;
    const changed = (alias, kind) => full ? '1=1' : `EXISTS(SELECT 1 FROM sync_changes c WHERE c.book_id=${alias}.id AND c.kind='${kind}' AND c.seq>${since} AND c.seq<=${high})`;
    const books = db.prepare(`SELECT b.* FROM books b WHERE b.deleted_at IS NULL AND ${changed('b', 'book')} ORDER BY b.id`).all();
    const deleted = db.prepare(`SELECT d.* FROM book_deletions d WHERE NOT EXISTS(SELECT 1 FROM books b WHERE b.id=d.id AND b.deleted_at IS NULL)
      AND ${changed('d', 'book')} ORDER BY d.id`).all();
    const reading = db.prepare(`SELECT b.id,b.uuid,COALESCE(r.revision,0) AS revision FROM books b
      LEFT JOIN mobile_reading_state r ON r.book_id=b.id AND r.book_uuid=b.uuid
      WHERE b.deleted_at IS NULL AND (${changed('b', 'reading')} OR ${changed('b', 'book')}) ORDER BY b.id`).all();
    const result = { sync_version: 3, complete: full, library_id: library, books, deleted, reading,
      reading_sync: true, portable_sync: true,
      portable_revision: db.prepare('SELECT revision FROM mobile_portable_state WHERE id=1').get()?.revision || 0,
      cursor: Buffer.from(JSON.stringify({ library_id: library, seq: high, checkpoint: last?.checkpoint || '' })).toString('base64url') };
    if (ownTransaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function getReadingState(db, book) {
  const row = db.prepare('SELECT * FROM mobile_reading_state WHERE book_id=? AND book_uuid=?').get(book.id, book.uuid);
  return { book_id: book.id, book_uuid: book.uuid, revision: row?.revision || 0,
    data: row ? JSON.parse(row.data) : EMPTY_READING_DATA() };
}
function putReadingState(db, bookId, input) {
  if (!input || typeof input !== 'object' || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 ||
      typeof input.expected_uuid !== 'string' || !validateReadingData(input.data)) {
    return { status: 400, error: '阅读数据或版本条件无效', code: 'VALIDATION' };
  }
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec('BEGIN');
  try {
    const book = db.prepare('SELECT * FROM books WHERE id=? AND deleted_at IS NULL').get(bookId);
    const library = db.prepare("SELECT value FROM sync_metadata WHERE key='library_id'").get().value;
    let result;
    if (!book) result = { status: 404, error: '书籍不存在', code: 'NOT_FOUND' };
    else if (input.library_id !== library || input.expected_uuid !== book.uuid) {
      result = { status: 409, error: '书库或书籍身份已变化', code: 'IDENTITY_CHANGED' };
    } else {
      const current = getReadingState(db, book);
      if (current.revision !== input.expected_revision) result = { status: 409, code: 'CONFLICT', error: '阅读数据已在其他设备更新', current };
      else {
        db.prepare(`INSERT INTO mobile_reading_state(book_id,book_uuid,revision,data,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(book_id) DO UPDATE SET book_uuid=excluded.book_uuid,revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at`)
          .run(book.id, book.uuid, current.revision + 1, JSON.stringify(input.data), new Date().toISOString());
        result = { status: 200, ...getReadingState(db, book) };
      }
    }
    if (ownTransaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { getSyncChanges, getReadingState, putReadingState, pruneSyncChanges };
