/* ============================================================
 * 自定义字段路由(对标 calibre 的 calibredb add_custom_column /
 * custom_columns / remove_custom_column 三个命令的能力)
 *
 *   GET    /api/custom-fields            字段列表(含每字段已填值的书数,便于管理页展示)
 *   POST   /api/custom-fields            新建字段(体:label/name/datatype/is_multiple/options)
 *   PUT    /api/custom-fields/:id        改字段(只允许 name/options/display_order)
 *   DELETE /api/custom-fields/:id        软删除(可 restore;?purge=1 才物理删除)
 *   POST   /api/custom-fields/:id/restore 取消软删除
 *
 * 只做 HTTP 协议适配:规则在 core/custom_fields,数据在 db/custom_fields。
 * 写操作由 app.use('/api', requireAdmin) 统一鉴权(GET 放行)。
 * 所有写路径裹事务(inTransaction):一次字段变更要么整体生效,要么整体回滚。
 * ============================================================ */

const express = require('express');

const { db, inTransaction } = require('../db/index');
const customFields = require('../db/custom_fields');
const core = require('../core/custom_fields');

const router = express.Router();

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// 统一错误映射:core/db 层用 code 表达语义,这里翻成状态码
function respond(err, res) {
  const code = err && err.code;
  if (code === 'VALIDATION') return res.status(400).json({ error: err.message, code });
  if (code === 'NOT_FOUND') return res.status(404).json({ error: err.message, code });
  if (code === 'CONFLICT') return res.status(409).json({ error: err.message, code });
  throw err;
}

// 每个字段当前有多少本书填了值(管理页展示"被使用了 N 次",
// 让用户在删除前知道影响面 —— calibre 的字段删除确认也是这个思路)
function usageCounts() {
  const rows = db.prepare(`
    SELECT column_id, COUNT(*) AS n
    FROM book_custom_values
    WHERE value <> ''
    GROUP BY column_id
  `).all();
  const map = new Map(rows.map((r) => [r.column_id, r.n]));
  return map;
}

function withUsage(cols) {
  const usage = usageCounts();
  return cols.map((c) => ({ ...c, usage: usage.get(c.id) || 0 }));
}

router.get('/api/custom-fields', (req, res) => {
  const includeDeleted = req.query.includeDeleted === '1';
  res.json(withUsage(customFields.listColumns(db, { includeDeleted })));
});

router.post('/api/custom-fields', (req, res) => {
  const parsed = core.parseColumnDef(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.errors.join(';'), code: 'VALIDATION' });
  }
  const result = inTransaction(db, () => customFields.addColumn(db, parsed.values));
  if (!result.ok) {
    return res.status(result.code === 'CONFLICT' ? 409 : 400)
      .json({ error: result.error, code: result.code || 'VALIDATION' });
  }
  res.status(201).json({ ok: true, column: result.column, columns: withUsage(customFields.listColumns(db)) });
});

router.put('/api/custom-fields/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    const result = inTransaction(db, () => customFields.updateColumn(db, id, req.body));
    if (!result.ok) return respond(Object.assign(new Error(result.error), { code: result.code }), res);
    res.json({ ok: true, column: result.column, columns: withUsage(customFields.listColumns(db)) });
  } catch (err) { return respond(err, res); }
});

// 删除:默认软删除(定义与取值都留着,可 restore)。
// ?purge=1 才是物理删除 —— 值随外键 CASCADE 一起消失,不可恢复。
// 物理删除后必须重建 FTS? 不必:自定义值不进 books_fts(它只索引
// title/author/summary/tags),所以删字段不影响全文索引。
router.delete('/api/custom-fields/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  const purge = req.query.purge === '1';
  try {
    const result = inTransaction(db, () => (
      purge ? customFields.purgeColumn(db, id) : customFields.removeColumn(db, id)
    ));
    if (!result.ok) return respond(Object.assign(new Error(result.error), { code: result.code }), res);
    res.json({
      ok: true,
      purged: purge,
      // 物理删除后值行已随 CASCADE 消失;软删除时值仍在(restore 可救回)
      columns: withUsage(customFields.listColumns(db, { includeDeleted: true })),
    });
  } catch (err) { return respond(err, res); }
});

router.post('/api/custom-fields/:id/restore', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    const result = inTransaction(db, () => customFields.restoreColumn(db, id));
    if (!result.ok) return respond(Object.assign(new Error(result.error), { code: result.code }), res);
    res.json({ ok: true, columns: withUsage(customFields.listColumns(db)) });
  } catch (err) { return respond(err, res); }
});

// 供测试:暴露内部件以便单独驱动(与 middleware.auth 的 resetTokenCache 同思路)
module.exports = router;
module.exports.withUsage = withUsage;
