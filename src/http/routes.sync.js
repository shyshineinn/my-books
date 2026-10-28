const express = require('express');
const { db } = require('../db/index');
const { getSyncChanges, getReadingState, putReadingState } = require('../db/sync-v3');
const { requireSession } = require('./middleware.auth');
const router = express.Router();
// 公开书目浏览不等于公开个人阅读记录；协议 3 始终要求设备会话。
router.use('/api/sync', requireSession, (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.get('/api/sync/changes', (req, res, next) => {
  if (Object.keys(req.query).some((key) => key !== 'cursor')) return res.status(400).json({ code: 'VALIDATION', error: '增量同步不接受筛选参数' });
  try { res.json(getSyncChanges(db, req.query.cursor)); }
  catch (error) {
    if (error.code === 'CURSOR_RESET') return res.status(410).json({ code: error.code, error: error.message });
    next(error);
  }
});
router.get('/api/sync/reading/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id)) || Number(req.params.id) < 1) {
    return res.status(400).json({ code: 'VALIDATION', error: '书籍 id 无效' });
  }
  const book = db.prepare('SELECT * FROM books WHERE id=? AND deleted_at IS NULL').get(Number(req.params.id));
  if (!book) return res.status(404).json({ code: 'NOT_FOUND', error: '书籍不存在' });
  res.json(getReadingState(db, book));
});
router.put('/api/sync/reading/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id)) || Number(req.params.id) < 1) {
    return res.status(400).json({ code: 'VALIDATION', error: '书籍 id 无效' });
  }
  const result = putReadingState(db, Number(req.params.id), req.body);
  const { status, ...body } = result;
  res.status(status).json(body);
});
module.exports = router;
