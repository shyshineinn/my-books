/* ============================================================
 * 分类管理路由(标签 / 作者):列表 + 重命名 / 合并 / 删除
 * 只做 HTTP 协议适配,归一化逻辑全在 src/db/categories。
 * 写操作裹事务:一次改名要改链接、重算多本书缓存、重建 FTS,
 * 任一步失败整体回滚,不留"标签改了但缓存没跟上"的半态。
 * ============================================================ */

const express = require('express');

const { db } = require('../db/index');
const categories = require('../db/categories');

const router = express.Router();

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function respond(err, res) {
  if (err && err.code === 'VALIDATION') return res.status(400).json({ error: err.message, code: 'VALIDATION' });
  if (err && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
  throw err;
}

// 事务包裹:成功 COMMIT 返回结果,异常 ROLLBACK 后交 respond / 全局处理
function inTx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ---------- 标签 ---------- */
router.get('/api/tags', (req, res) => res.json(categories.listTags(db)));

router.post('/api/tags/rename', (req, res) => {
  const id = parseId(req.body.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    const tagId = inTx(() => categories.renameTag(db, id, req.body.name));
    res.json({ ok: true, id: tagId, tags: categories.listTags(db) });
  } catch (err) { return respond(err, res); }
});

router.post('/api/tags/merge', (req, res) => {
  const from = parseId(req.body.from);
  const to = parseId(req.body.to);
  if (from === null || to === null) return res.status(400).json({ error: 'from/to 应为正整数', code: 'VALIDATION' });
  try {
    inTx(() => categories.mergeTags(db, from, to));
    res.json({ ok: true, tags: categories.listTags(db) });
  } catch (err) { return respond(err, res); }
});

router.delete('/api/tags/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    inTx(() => { categories.removeTag(db, id); categories.pruneOrphans(db); });
    res.json({ ok: true, tags: categories.listTags(db) });
  } catch (err) { return respond(err, res); }
});

/* ---------- 作者 ---------- */
router.get('/api/authors', (req, res) => res.json(categories.listAuthors(db)));

router.post('/api/authors/rename', (req, res) => {
  const id = parseId(req.body.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    const authorId = inTx(() => categories.renameAuthor(db, id, req.body.name));
    res.json({ ok: true, id: authorId, authors: categories.listAuthors(db) });
  } catch (err) { return respond(err, res); }
});

router.post('/api/authors/merge', (req, res) => {
  const from = parseId(req.body.from);
  const to = parseId(req.body.to);
  if (from === null || to === null) return res.status(400).json({ error: 'from/to 应为正整数', code: 'VALIDATION' });
  try {
    inTx(() => categories.mergeAuthors(db, from, to));
    res.json({ ok: true, authors: categories.listAuthors(db) });
  } catch (err) { return respond(err, res); }
});

router.delete('/api/authors/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    inTx(() => { categories.removeAuthor(db, id); categories.pruneOrphans(db); });
    res.json({ ok: true, authors: categories.listAuthors(db) });
  } catch (err) { return respond(err, res); }
});

module.exports = router;
