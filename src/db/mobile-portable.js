const { validatePortableState } = require('../core/mobile-portable');

function getPortableState(db) {
  const row = db.prepare('SELECT revision,data FROM mobile_portable_state WHERE id=1').get();
  return { library_id: db.prepare("SELECT value FROM sync_metadata WHERE key='library_id'").get().value,
    revision: row?.revision || 0, data: row ? JSON.parse(row.data) : null };
}
function putPortableState(db, input) {
  if (!input || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || !validatePortableState(input.data, db)) {
    return { status: 400, code: 'VALIDATION', error: '同步快照、资源或书籍身份无效' };
  }
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN');
  try {
    const current = getPortableState(db);
    let result;
    if (current.library_id !== input.library_id) result = { status: 409, code: 'IDENTITY_CHANGED', error: '书库身份已变化' };
    else if (current.revision !== input.expected_revision) result = { status: 409, code: 'CONFLICT', error: '其他设备已修改同步快照', current };
    else {
      db.prepare(`INSERT INTO mobile_portable_state(id,revision,data,updated_at) VALUES(1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at`)
        .run(current.revision + 1, JSON.stringify(input.data), new Date().toISOString());
      result = { status: 200, ...getPortableState(db) };
    }
    if (own) db.exec('COMMIT');
    return result;
  } catch (error) { if (own) db.exec('ROLLBACK'); throw error; }
}
module.exports = { getPortableState, putPortableState };
