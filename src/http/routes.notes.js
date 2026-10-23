/* ============================================================
 * 读书心得路由:GET / PUT / DELETE /api/books/:id/notes
 *
 * 正文存 notes-files/{id}.md;读公开,写由 /api 的 requireAdmin 保护。
 * expected_updated_at 用于 App/网页并发覆盖保护。
 * ============================================================ */

const express = require('express');

const { db } = require('../db/index');
const books = require('../db/books');
const notes = require('../db/notes');

const router = express.Router();

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const badId = (res) => res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
const notFound = (res) => res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });

function currentPayload(id) {
  const stat = notes.statNote(id);
  return stat
    ? { has_notes: true, size: stat.size, updated_at: stat.updated_at }
    : { has_notes: false, size: 0, updated_at: null };
}

router.get('/api/books/:id/notes', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  if (!books.getBook(id, db)) return notFound(res);

  const note = notes.readNote(id);
  if (!note) {
    return res.json({ has_notes: false, content: '', size: 0, updated_at: null });
  }
  res.json({
    has_notes: true,
    content: note.content,
    size: note.size,
    updated_at: note.updated_at,
  });
});

router.put('/api/books/:id/notes', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  if (!books.getBook(id, db)) return notFound(res);

  const body = req.body || {};
  if (typeof body.content !== 'string') {
    return res.status(400).json({ error: 'content 必须是 Markdown 文本', code: 'VALIDATION' });
  }

  const current = notes.statNote(id);
  const expected = String(
    body.expected_updated_at || req.get('If-Match')?.replace(/^"|"$/g, '') || ''
  ).trim();
  if (expected && expected !== (current ? current.updated_at : '')) {
    return res.status(409).json({
      error: '服务器心得已更新,请重新加载后再保存',
      code: 'CONFLICT',
      current: currentPayload(id),
    });
  }

  try {
    const saved = notes.writeNote(id, body.content);
    books.touchBook(id, db);
    res.json({
      has_notes: true,
      size: saved.size,
      updated_at: saved.updated_at,
    });
  } catch (err) {
    if (err && err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message, code: 'VALIDATION' });
    }
    throw err;
  }
});

router.delete('/api/books/:id/notes', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  if (!books.getBook(id, db)) return notFound(res);

  const removed = notes.removeNote(id);
  if (removed) books.touchBook(id, db);
  res.json({ ok: true, removed, ...currentPayload(id) });
});

module.exports = router;
