/* ============================================================
 * 阅读位置路由:读取 / 上报 / 清除阅读进度
 *
 *   GET    /api/books/:id/position?format=EPUB&device=desktop
 *            → { position: {locator,locator_kind,pos_frac,epoch}, others: [...] } | 404
 *   PUT    /api/books/:id/position        幂等 upsert
 *            body: { format, device, locator, locator_kind, pos_frac }
 *   DELETE /api/books/:id/position?format=&device=   清除(可选 format/device)
 *
 * 鉴权:写操作(PUT/DELETE)走 server.js 挂载的统一 requireAdmin(非 GET 需要 token)。
 * 读取公开 —— 与其它 GET 接口一致。
 *
 * 读取接口附带 others:该书在同一格式下的其它设备位置,供前端提示
 * 「上次在另一设备读到 42%」而不强行覆盖当前设备的位置。
 * ============================================================ */

const express = require('express');

const { db } = require('../db/index');
const books = require('../db/books');
const positions = require('../db/positions');
const { parsePosition, normalizeFormat, normalizeDevice } = require('../core/position');

const router = express.Router();

const badId = (res) => res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
const notFound = (res) => res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });

// 与 routes.books.js 同一收口规则(必须为正整数字符串)
function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

router.get('/api/books/:id/position', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  if (!books.getBook(id)) return notFound(res);

  const format = normalizeFormat(req.query.format);
  if (!format) return res.status(400).json({ error: '缺少格式(format)', code: 'VALIDATION' });
  const device = normalizeDevice(req.query.device);
  if (!device) return res.status(400).json({ error: '缺少设备标识(device)', code: 'VALIDATION' });

  const position = positions.getPosition(db, id, format, device);
  if (!position) return res.status(404).json({ error: '没有该设备上的阅读记录', code: 'NOT_FOUND' });

  // 其它设备的位置:换设备时提示用,不覆盖当前设备
  const others = positions.listPositions(db, id, format).filter((p) => p.device !== device);

  res.json({ position, others });
});

router.put('/api/books/:id/position', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  if (!books.getBook(id)) return notFound(res);

  const { ok, values, error, code } = parsePosition(req.body);
  if (!ok) return res.status(400).json({ error, code });

  const saved = positions.savePosition(db, id, values);
  res.json({ position: saved });
});

router.delete('/api/books/:id/position', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  if (!books.getBook(id)) return notFound(res);

  const format = normalizeFormat(req.query.format);
  const device = normalizeDevice(req.query.device);
  const removed = positions.clearPosition(db, id, { format, device });
  res.json({ ok: true, removed });
});

module.exports = router;
