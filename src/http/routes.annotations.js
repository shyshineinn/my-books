/* ============================================================
 * 注释路由:书签 / 高亮 / 批注
 *
 *   GET    /api/books/:id/annotations?format=EPUB
 *            → { annotations: [...] }   format 可选;不给则返回该书全部格式
 *   POST   /api/books/:id/annotations          幂等 upsert,成功 201
 *   PUT    /api/books/:id/annotations/:annotId 只改 note / color / chapter
 *   DELETE /api/books/:id/annotations/:annotId
 *
 * 鉴权:与 positions 一致 —— 写操作(POST/PUT/DELETE)由 server.js 挂载的
 * 统一 requireAdmin 覆盖(非 GET 需要 token);GET 公开。
 *
 * 定位:用客户端生成的 annot_id(uuid)而非数字主键作为对外标识 ——
 * 前端本来就持有它,且天然幂等(重复提交同一条不会产生第二行)。
 * ============================================================ */

const express = require('express');

const { db } = require('../db/index');
const books = require('../db/books');
const annotations = require('../db/annotations');
const { parseAnnotation, mergeAnnotationUpdate, normalizeFormat, MAX_ANNOT_ID_LEN } = require('../core/annotation');

const router = express.Router();

const badId = (res) => res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
const notFound = (res) => res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });
const annotNotFound = (res) => res.status(404).json({ error: '注释不存在', code: 'NOT_FOUND' });

// 与 routes.books.js / routes.positions.js 同一收口规则(必须为正整数字符串)
function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// annot_id 来自客户端 uuid;这里只做形状校验,与 core/annotation.js 同一字符集
function parseAnnotId(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > MAX_ANNOT_ID_LEN || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return s;
}

router.get('/api/books/:id/annotations', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  if (!books.getBook(id)) return notFound(res);

  const rawFormat = req.query.format;
  let format;
  if (rawFormat !== undefined && String(rawFormat).trim() !== '') {
    format = normalizeFormat(rawFormat);
    if (!format) return res.status(400).json({ error: '格式不合法(format)', code: 'VALIDATION' });
  }

  res.json({ annotations: annotations.listAnnotations(db, id, { format }) });
});

router.post('/api/books/:id/annotations', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  if (!books.getBook(id)) return notFound(res);

  const { ok, values, error, code } = parseAnnotation(req.body);
  if (!ok) return res.status(400).json({ error, code });

  res.status(201).json({ annotation: annotations.upsertAnnotation(db, id, values) });
});

router.put('/api/books/:id/annotations/:annotId', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const annotId = parseAnnotId(req.params.annotId);
  if (annotId === null) return res.status(400).json({ error: '注释标识不合法', code: 'VALIDATION' });
  if (!books.getBook(id)) return notFound(res);

  const existing = annotations.getByAnnotIdInBook(db, id, annotId);
  if (!existing) return annotNotFound(res);

  // mergeAnnotationUpdate 返回 { ok, values } 或 { ok:false, error, code }
  const { ok, values: merged, error, code } = mergeAnnotationUpdate(existing, req.body);
  if (!ok) return res.status(400).json({ error, code });

  res.json({ annotation: annotations.updateAnnotation(db, existing.id, merged) });
});

router.delete('/api/books/:id/annotations/:annotId', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const annotId = parseAnnotId(req.params.annotId);
  if (annotId === null) return res.status(400).json({ error: '注释标识不合法', code: 'VALIDATION' });
  if (!books.getBook(id)) return notFound(res);

  const existing = annotations.getByAnnotIdInBook(db, id, annotId);
  if (!existing) return annotNotFound(res);

  annotations.deleteAnnotation(db, existing.id);
  res.json({ ok: true });
});

module.exports = router;
