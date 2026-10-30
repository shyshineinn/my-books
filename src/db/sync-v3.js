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
/* ---------- 合并书籍时的安卓阅读状态迁移 ---------- */

// 同 key 冲突时保留 updatedAt 较新的一条;相等时保留先到的(目标优先)
function mergeByKey(targetItems, sourceItems, keyOf, newerField) {
  const map = new Map();
  for (const item of targetItems) map.set(keyOf(item), item);
  for (const item of sourceItems) {
    const key = keyOf(item);
    const prev = map.get(key);
    if (!prev) { map.set(key, item); continue; }
    if ((Number(item[newerField]) || 0) > (Number(prev[newerField]) || 0)) map.set(key, item);
  }
  return [...map.values()];
}

function parseState(book, row) {
  let data;
  try { data = JSON.parse(row.data); } catch {
    throw Object.assign(new Error(`书籍「${book.title}」的安卓阅读数据无法解析,已中止合并`), { code: 'VALIDATION' });
  }
  if (!validateReadingData(data)) {
    throw Object.assign(new Error(`书籍「${book.title}」的安卓阅读数据不合法,已中止合并`), { code: 'VALIDATION' });
  }
  return data;
}

function mergeReadingData(targetData, sourceData) {
  const positions = mergeByKey(
    targetData.positions, sourceData.positions,
    (p) => `${p.format}:${p.fileSha256 || ''}`, 'lastReadTime',
  );
  const bookmarks = mergeByKey(targetData.bookmarks, sourceData.bookmarks, (b) => b.syncId, 'updatedAt');
  const notes = mergeByKey(targetData.notes, sourceData.notes, (n) => n.syncId, 'updatedAt');
  const reading = mergeByKey(
    targetData.reading_records, sourceData.reading_records,
    (r) => `${r.date}:${r.sourceDeviceId}`, 'updatedAt',
  );
  const tombstones = mergeByKey(
    targetData.tombstones, sourceData.tombstones,
    (t) => `${t.namespace}:${t.itemId}`, 'deletedAt',
  );
  // 墓碑优先:被删除的批注/书签不能再出现在合并结果里(否则 validateReadingData 会拒绝)
  const deleted = { bookmark: new Set(), note: new Set() };
  for (const t of tombstones) deleted[t.namespace].add(t.itemId);
  return {
    positions,
    bookmarks: bookmarks.filter((b) => !deleted.bookmark.has(b.syncId)),
    notes: notes.filter((n) => !deleted.note.has(n.syncId)),
    reading_records: reading,
    tombstones,
  };
}

// 在 mergeBooks 的事务内调用:来源书的阅读状态先并入目标,来源删除时旧行再随外键消失。
// 状态按 (format:fileSha256 / syncId / date+device / 墓碑) 去重,冲突保留较新记录;
// 结构不合法或合并后超出限制时抛 VALIDATION,由 mergeBooks 回滚整次合并。
function mergeReadingStates(db, target, sources) {
  const targetRow = db.prepare('SELECT * FROM mobile_reading_state WHERE book_id = ?').get(target.id);
  const sourceStates = [];
  for (const source of sources) {
    const row = db.prepare('SELECT * FROM mobile_reading_state WHERE book_id = ?').get(source.id);
    if (row) sourceStates.push({ book: source, row, data: parseState(source, row) });
  }
  if (!sourceStates.length) return 0;

  const targetData = targetRow ? parseState(target, targetRow) : null;
  let data = targetData ? structuredClone(targetData) : structuredClone(sourceStates[0].data);
  const toMerge = targetData ? sourceStates : sourceStates.slice(1);
  for (const state of toMerge) data = mergeReadingData(data, state.data);

  if (!validateReadingData(data)) {
    throw Object.assign(new Error('合并后的安卓阅读数据超出限制或结构冲突,已中止合并'), { code: 'VALIDATION' });
  }

  const bookUuid = target.uuid || targetRow?.book_uuid;
  if (!bookUuid) {
    throw Object.assign(new Error('目标书缺少 uuid,无法迁移安卓阅读数据,已中止合并'), { code: 'VALIDATION' });
  }
  const revision = Math.max(targetRow?.revision || 0, ...sourceStates.map((s) => s.row.revision)) + 1;
  db.prepare(`
    INSERT INTO mobile_reading_state (book_id, book_uuid, revision, data, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET
      book_uuid = excluded.book_uuid, revision = excluded.revision,
      data = excluded.data, updated_at = excluded.updated_at
  `).run(target.id, bookUuid, revision, JSON.stringify(data), new Date().toISOString());
  return sourceStates.length;
}

module.exports = { getSyncChanges, getReadingState, putReadingState, pruneSyncChanges, mergeReadingStates };
