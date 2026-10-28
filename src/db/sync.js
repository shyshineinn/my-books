// 完整、无筛选的同步视图。删除记录不随回收站过期而消失。
function getBookSnapshot(db) {
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec('BEGIN');
  try {
    const result = {
      sync_version: 2,
      complete: true,
      library_id: db.prepare("SELECT value FROM sync_metadata WHERE key='library_id'").get().value,
      books: db.prepare('SELECT * FROM books WHERE deleted_at IS NULL ORDER BY id').all(),
      deleted: db.prepare(`SELECT d.* FROM book_deletions d
        WHERE NOT EXISTS(SELECT 1 FROM books b WHERE b.id=d.id AND b.deleted_at IS NULL) ORDER BY d.id`).all(),
    };
    if (ownTransaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { getBookSnapshot };
