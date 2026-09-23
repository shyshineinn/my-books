/* ============================================================
 * 阅读位置(数据访问层)
 *
 * 表结构见 src/db/index.js 的 migrateV5。
 * 写入用 UPSERT:同一 (book, format, device) 只保留一行最新位置。
 * 外键 ON DELETE CASCADE 保证删书自动清理,无需在此手工联动。
 *
 * 依赖方向纪律:与 search.js 同策略 —— db 句柄由调用方传入,
 * 不在模块顶层 require 单例。这样测试可用 openDb(临时目录) 完全隔离,
 * 绝不会碰到真实 data/books.db。
 * ============================================================ */

// 读取某本书在指定格式/设备上的位置;不存在返回 null
function getPosition(db, bookId, format, device) {
  const row = db.prepare(
    'SELECT locator, locator_kind, pos_frac, epoch FROM read_positions WHERE book = ? AND format = ? AND device = ?'
  ).get(bookId, format, device);
  return row || null;
}

// 读取某本书的所有位置(按最近更新排序),供「上次在另一设备读到 x%」提示
function listPositions(db, bookId, format) {
  return db.prepare(
    `SELECT device, locator, locator_kind, pos_frac, epoch
     FROM read_positions WHERE book = ? AND format = ?
     ORDER BY epoch DESC`
  ).all(bookId, format);
}

// 写入/更新位置(幂等):values 来自 core/parsePosition 的规范化输出
function savePosition(db, bookId, values) {
  db.prepare(`
    INSERT INTO read_positions (book, format, device, locator, locator_kind, pos_frac, epoch)
    VALUES (@book, @format, @device, @locator, @locator_kind, @pos_frac, @epoch)
    ON CONFLICT(book, format, device) DO UPDATE SET
      locator = excluded.locator,
      locator_kind = excluded.locator_kind,
      pos_frac = excluded.pos_frac,
      epoch = excluded.epoch
  `).run({ ...values, book: bookId, epoch: Date.now() });
  return getPosition(db, bookId, values.format, values.device);
}

// 删除某本书的位置(单设备 / 单格式 / 全部),供「清除阅读进度」使用
function clearPosition(db, bookId, { format, device } = {}) {
  if (format && device) {
    return db.prepare('DELETE FROM read_positions WHERE book = ? AND format = ? AND device = ?')
      .run(bookId, format, device).changes;
  }
  if (format) {
    return db.prepare('DELETE FROM read_positions WHERE book = ? AND format = ?').run(bookId, format).changes;
  }
  return db.prepare('DELETE FROM read_positions WHERE book = ?').run(bookId).changes;
}

module.exports = { getPosition, listPositions, savePosition, clearPosition };
