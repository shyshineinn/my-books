/* ============================================================
 * 保存的搜索 / 虚拟图书馆路由:列表 + 增 / 改 / 删
 * 只做 HTTP 协议适配,数据读写全在 src/db/saved_searches。
 * 写操作由 app.use('/api', requireAdmin) 统一鉴权(GET 放行)。
 * 单表单行操作,无需事务;冲突 / 校验错误按 code 映射状态码。
 * ============================================================ */

const express = require('express');

const { db } = require('../db/index');
const saved = require('../db/saved_searches');
const search = require('../db/search');

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

router.get('/api/saved-searches', (req, res) => res.json(saved.listSaved(db)));

// 虚拟书库(is_virtual = 1 的保存搜索)+ 命中数,给书架的作用域下拉用。
// 某个书库坏了(循环引用/语法错)不影响其它条目:count 给 null,前端显示"—"。
router.get('/api/virtual-libraries', (req, res) => {
  const rows = saved.listVirtual(db);
  res.json(rows.map((r) => {
    let count = null;
    try {
      count = search.resolveVirtualIds(db, r.name).length;
    } catch { /* 坏定义留给用户在搜索面板里修,不让整个下拉挂掉 */ }
    return { id: r.id, name: r.name, query: r.query, sort: r.sort, count };
  }));
});

router.get('/api/saved-searches/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  const row = saved.getSaved(db, id);
  if (!row) return res.status(404).json({ error: '保存的搜索不存在', code: 'NOT_FOUND' });
  res.json(row);
});

router.post('/api/saved-searches', (req, res) => {
  try {
    const created = saved.addSaved(db, {
      name: req.body.name, query: req.body.query, sort: req.body.sort, isVirtual: req.body.isVirtual,
    });
    res.status(201).json({ ok: true, item: created, items: saved.listSaved(db) });
  } catch (err) { return respond(err, res); }
});

router.put('/api/saved-searches/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    const updated = saved.updateSaved(db, id, {
      name: req.body.name, query: req.body.query, sort: req.body.sort, isVirtual: req.body.isVirtual,
    });
    if (!updated) return res.status(404).json({ error: '保存的搜索不存在', code: 'NOT_FOUND' });
    res.json({ ok: true, item: updated, items: saved.listSaved(db) });
  } catch (err) { return respond(err, res); }
});

router.delete('/api/saved-searches/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  const ok = saved.removeSaved(db, id);
  if (!ok) return res.status(404).json({ error: '保存的搜索不存在', code: 'NOT_FOUND' });
  res.json({ ok: true, items: saved.listSaved(db) });
});

module.exports = router;
