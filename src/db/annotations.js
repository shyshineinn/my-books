/* ============================================================
 * 注释(书签 / 高亮 / 批注)数据访问层
 *
 * 表结构见 src/db/index.js 的 migrateV6。
 * 幂等键 = UNIQUE(book, format, annot_type, annot_id),写入用 UPSERT;
 * 外键 ON DELETE CASCADE 保证删书自动清注释,无需在此手工联动。
 *
 * 依赖方向纪律:与 search.js / positions.js 同策略 —— db 句柄由调用方传入,
 * 不在模块顶层 require 单例。这样测试可用 openDb(临时目录) 完全隔离,
 * 绝不会碰到真实 data/books.db(positions.js 初版违反此条踩过坑)。
 * ============================================================ */

const COLUMNS = `id, book, format, annot_type, annot_id, locator_kind,
  start_locator, end_locator, text, note, color, chapter, created_at, updated_at`;

// 列出某本书的注释。format 可选:给了就只返回该格式,不给返回全部。
// 排序:先按章名,再按位置 —— CFI 串的字典序近似文档顺序,列表足够用。
function listAnnotations(db, bookId, { format } = {}) {
  if (format) {
    return db.prepare(
      `SELECT ${COLUMNS} FROM annotations WHERE book = ? AND format = ?
       ORDER BY chapter, start_locator, id`
    ).all(bookId, format);
  }
  return db.prepare(
    `SELECT ${COLUMNS} FROM annotations WHERE book = ?
     ORDER BY format, chapter, start_locator, id`
  ).all(bookId);
}

function getAnnotation(db, id) {
  return db.prepare(`SELECT ${COLUMNS} FROM annotations WHERE id = ?`).get(id) || null;
}

// 按完整唯一键查(供幂等 upsert 回读)
function getByAnnotId(db, bookId, format, annotType, annotId) {
  return db.prepare(
    `SELECT ${COLUMNS} FROM annotations
     WHERE book = ? AND format = ? AND annot_type = ? AND annot_id = ?`
  ).get(bookId, format, annotType, annotId) || null;
}

/*
 * 按 (book, annot_id) 查 —— 供 PUT/DELETE「只知道 annotId」的场景使用。
 *
 * 前提:annot_id 由前端生成 uuid,在一本书范围内实际唯一。
 * 表上的 UNIQUE 是 (book, format, annot_type, annot_id),理论上同一本书的
 * 两个格式可以用同一个 annot_id;此时本函数返回最早的一行。
 * 若将来前端不再用 uuid,应改为要求 PUT/DELETE 带 format + annot_type 查询参数。
 */
function getByAnnotIdInBook(db, bookId, annotId) {
  return db.prepare(
    `SELECT ${COLUMNS} FROM annotations WHERE book = ? AND annot_id = ? ORDER BY id LIMIT 1`
  ).get(bookId, annotId) || null;
}

// 写入/更新一条注释(幂等):values 来自 core/parseAnnotation 的规范化输出。
// created_at 不在 DO UPDATE 列表里 —— 更新时保留首次创建时间。
function upsertAnnotation(db, bookId, values) {
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO annotations
      (book, format, annot_type, annot_id, locator_kind,
       start_locator, end_locator, text, note, color, chapter, created_at, updated_at)
    VALUES
      (@book, @format, @annot_type, @annot_id, @locator_kind,
       @start_locator, @end_locator, @text, @note, @color, @chapter, @ts, @ts)
    ON CONFLICT(book, format, annot_type, annot_id) DO UPDATE SET
      locator_kind  = excluded.locator_kind,
      start_locator = excluded.start_locator,
      end_locator   = excluded.end_locator,
      text          = excluded.text,
      note          = excluded.note,
      color         = excluded.color,
      chapter       = excluded.chapter,
      updated_at    = excluded.updated_at
  `).run({
    book: bookId,
    format: values.format,
    annot_type: values.annot_type,
    annot_id: values.annot_id,
    locator_kind: values.locator_kind,
    start_locator: values.start_locator,
    end_locator: values.end_locator,
    text: values.text,
    note: values.note,
    color: values.color,
    chapter: values.chapter,
    ts,
  });
  return getByAnnotId(db, bookId, values.format, values.annot_type, values.annot_id);
}

// 局部更新:merged 为 core/mergeAnnotationUpdate 的结果(只动 note/color/chapter)
function updateAnnotation(db, id, merged) {
  const info = db.prepare(
    'UPDATE annotations SET note = @note, color = @color, chapter = @chapter, updated_at = @ts WHERE id = @id'
  ).run({
    note: merged.note,
    color: merged.color,
    chapter: merged.chapter,
    ts: new Date().toISOString(),
    id,
  });
  if (!info.changes) return null;
  return getAnnotation(db, id);
}

function deleteAnnotation(db, id) {
  return db.prepare('DELETE FROM annotations WHERE id = ?').run(id).changes;
}

module.exports = {
  listAnnotations,
  getAnnotation,
  getByAnnotId,
  getByAnnotIdInBook,
  upsertAnnotation,
  updateAnnotation,
  deleteAnnotation,
};
