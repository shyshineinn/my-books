/* ============================================================
 * 手动藏书集 HTTP 接口
 *
 * 只做协议适配与权限外的输入校验;数据读写见 src/db/collections。
 * GET 列表支持 ?vl= 作用域;写操作由 /api 的统一鉴权中间件保护。
 * ============================================================ */

const express = require('express');

const { db } = require('../db/index');
const collections = require('../db/collections');

const router = express.Router();

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function respond(err, res) {
  if (err && err.code === 'VALIDATION') return res.status(400).json({ error: err.message, code: 'VALIDATION' });
  if (err && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
  if (err && err.code === 'CONFLICT') return res.status(409).json({ error: err.message, code: 'CONFLICT' });
  throw err;
}

router.get('/api/collections', (req, res) => {
  res.json(collections.listCollections(db, { scopeIds: req.vlScope }));
});

router.post('/api/collections', (req, res) => {
  try {
    res.status(201).json({ ok: true, item: collections.createCollection(db, req.body && req.body.name) });
  } catch (err) { return respond(err, res); }
});

router.put('/api/collections/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '藏书集 id 应为正整数', code: 'VALIDATION' });
  try {
    const item = collections.renameCollection(db, id, req.body && req.body.name);
    if (!item) return res.status(404).json({ error: '藏书集不存在', code: 'NOT_FOUND' });
    res.json({ ok: true, item });
  } catch (err) { return respond(err, res); }
});

router.delete('/api/collections/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '藏书集 id 应为正整数', code: 'VALIDATION' });
  if (!collections.removeCollection(db, id)) {
    return res.status(404).json({ error: '藏书集不存在', code: 'NOT_FOUND' });
  }
  res.json({ ok: true });
});

router.post('/api/collections/:id/books', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '藏书集 id 应为正整数', code: 'VALIDATION' });
  if (!collections.getCollection(db, id)) {
    return res.status(404).json({ error: '藏书集不存在', code: 'NOT_FOUND' });
  }
  try {
    res.json({ ok: true, added: collections.addBooks(db, id, req.body && req.body.ids) });
  } catch (err) { return respond(err, res); }
});

router.delete('/api/collections/:id/books', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '藏书集 id 应为正整数', code: 'VALIDATION' });
  if (!collections.getCollection(db, id)) {
    return res.status(404).json({ error: '藏书集不存在', code: 'NOT_FOUND' });
  }
  try {
    res.json({ ok: true, removed: collections.removeBooks(db, id, req.body && req.body.ids) });
  } catch (err) { return respond(err, res); }
});

module.exports = router;
