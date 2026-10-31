/* ============================================================
 * 分类管理路由(标签 / 作者):列表 + 重命名 / 合并 / 删除
 * 只做 HTTP 协议适配,归一化逻辑全在 src/db/categories。
 * 写操作裹事务:一次改名要改链接、重算多本书缓存、重建 FTS,
 * 任一步失败整体回滚,不留"标签改了但缓存没跟上"的半态。
 * ============================================================ */

const express = require('express');

const { db } = require('../db/index');
const categories = require('../db/categories');
const { facetOptions } = require('./facet-params');

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

// 侧栏大列表:默认不传参数仍是全量(兼容页面/工具与旧客户端);
// 一旦出现 q/limit/offset,就按分页契约返回数组 + X-Total-Count。
// 管理端写操作默认仍附带最新全量列表(兼容旧调用);
// 大库页面传 with_list=0,只拿操作结果,再自行按搜索/分页拉取。
function includeFacetList(req) {
  const value = req.query.with_list;
  return value !== '0' && value !== 'false';
}

function facetList(req, res, search) {
  let options;
  try { options = facetOptions(req.query); } catch (err) { return respond(err, res); }
  if (!options.filtered) return res.json(search.full(req.vlScope));
  const result = search.paged(req.vlScope, options);
  res.set('X-Total-Count', String(result.total));
  return res.json(result.items);
}

/* ---------- 标签 ---------- */
// 列表读取支持虚拟书库作用域(?vl=);写操作后的回包仍给全量(管理视图)
router.get('/api/tags', (req, res) => facetList(req, res, {
  full: (scopeIds) => categories.listTags(db, { scopeIds }),
  paged: (scopeIds, options) => categories.searchTags(db, {
    scopeIds, q: options.q, limit: options.limit, offset: options.offset,
  }),
}));

router.post('/api/tags/rename', (req, res) => {
  const id = parseId(req.body.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    const tagId = inTx(() => categories.renameTag(db, id, req.body.name));
    const body = { ok: true, id: tagId };
    if (includeFacetList(req)) body.tags = categories.listTags(db);
    res.json(body);
  } catch (err) { return respond(err, res); }
});

router.post('/api/tags/merge', (req, res) => {
  const from = parseId(req.body.from);
  const to = parseId(req.body.to);
  if (from === null || to === null) return res.status(400).json({ error: 'from/to 应为正整数', code: 'VALIDATION' });
  try {
    inTx(() => categories.mergeTags(db, from, to));
    const body = { ok: true };
    if (includeFacetList(req)) body.tags = categories.listTags(db);
    res.json(body);
  } catch (err) { return respond(err, res); }
});

router.delete('/api/tags/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    inTx(() => { categories.removeTag(db, id); categories.pruneOrphans(db); });
    const body = { ok: true };
    if (includeFacetList(req)) body.tags = categories.listTags(db);
    res.json(body);
  } catch (err) { return respond(err, res); }
});

/* ---------- 作者 ---------- */
router.get('/api/authors', (req, res) => facetList(req, res, {
  full: (scopeIds) => categories.listAuthors(db, { scopeIds }),
  paged: (scopeIds, options) => categories.searchAuthors(db, {
    scopeIds, q: options.q, limit: options.limit, offset: options.offset,
  }),
}));

router.post('/api/authors/rename', (req, res) => {
  const id = parseId(req.body.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    const authorId = inTx(() => categories.renameAuthor(db, id, req.body.name));
    const body = { ok: true, id: authorId };
    if (includeFacetList(req)) body.authors = categories.listAuthors(db);
    res.json(body);
  } catch (err) { return respond(err, res); }
});

router.post('/api/authors/merge', (req, res) => {
  const from = parseId(req.body.from);
  const to = parseId(req.body.to);
  if (from === null || to === null) return res.status(400).json({ error: 'from/to 应为正整数', code: 'VALIDATION' });
  try {
    inTx(() => categories.mergeAuthors(db, from, to));
    const body = { ok: true };
    if (includeFacetList(req)) body.authors = categories.listAuthors(db);
    res.json(body);
  } catch (err) { return respond(err, res); }
});

router.delete('/api/authors/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id 应为正整数', code: 'VALIDATION' });
  try {
    inTx(() => { categories.removeAuthor(db, id); categories.pruneOrphans(db); });
    const body = { ok: true };
    if (includeFacetList(req)) body.authors = categories.listAuthors(db);
    res.json(body);
  } catch (err) { return respond(err, res); }
});

module.exports = router;
