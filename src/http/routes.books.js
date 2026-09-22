/* ============================================================
 * 书籍路由:解析请求参数 → 调 src/db → 组 HTTP 响应
 * 业务校验在 src/core/parseBook,数据操作在 src/db/books,
 * 本文件只做 HTTP 协议适配,不写业务规则与 SQL。
 *
 * 错误响应统一带 code 字段:中文消息给人类看,
 * code(AUTH_REQUIRED/NOT_FOUND/VALIDATION/CONFLICT)给多端程序判断
 * —— PWA / 小程序 / CLI 按 code 分支,不解析中文文案。
 * ============================================================ */

const express = require('express');

const { parseBook, mergeUpdate } = require('../core/book');
const books = require('../db/books');

const router = express.Router();

// :id 参数类型收口(借鉴 calibre srv/ajax.py 对 ids 的显式校验):
// 必须是正整数字符串,否则 400 —— 保证进入数据层的 id 语义正确,
// 让"格式错"返回 400、"格式对但不存在"返回 404,二者不混淆
function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const badId = (res) => res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
const notFound = (res) => res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });
const badBody = (res, msg) => res.status(400).json({ error: msg, code: 'VALIDATION' });

router.get('/api/books', (req, res) => {
  res.json(books.listBooks(req.query));
});

router.get('/api/books/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const row = books.getBook(id);
  if (!row) return notFound(res);
  res.json(row);
});

router.post('/api/books', (req, res) => {
  const { errors, values } = parseBook(req.body);
  if (errors.length) return badBody(res, errors.join(';'));
  res.status(201).json(books.addBook(values));
});

router.put('/api/books/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const existing = books.getBook(id);
  if (!existing) return notFound(res);

  const { errors, values } = parseBook(req.body);
  if (errors.length) return badBody(res, errors.join(';'));

  // 表单未提供的字段:保留数据库旧值(简介/读后感/心得链接/封面/读过次数/阅读记录)
  const merged = mergeUpdate(existing, values, req.body);
  res.json(books.updateBook(existing.id, merged));
});

router.delete('/api/books/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const ok = books.deleteBook(id);
  if (!ok) return notFound(res);
  res.json({ ok: true });
});

module.exports = router;
