const express = require('express');
const { db } = require('../db/index');
const { getSyncChanges, getReadingState, putReadingState } = require('../db/sync-v3');
const { requireSession } = require('./middleware.auth');
const { getPortableState, putPortableState } = require('../db/mobile-portable');
const { MAX_ASSET_BYTES, assetNamePattern } = require('../core/mobile-portable');
const { DATA_DIR } = require('../core/paths');
const { fileDigest } = require('../core/file-digest');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const router = express.Router();
// 公开书目浏览不等于公开个人阅读记录；协议 3 始终要求设备会话。
router.use('/api/sync', requireSession, (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.get('/api/sync/state', (req, res) => res.json(getPortableState(db)));
router.put('/api/sync/state', (req, res) => {
  const { status, ...body } = putPortableState(db, req.body);
  res.status(status).json(body);
});
const assetDirectory = path.join(DATA_DIR, 'mobile-state-assets');
router.put('/api/sync/state/assets/:name', async (req, res, next) => {
  if (!assetNamePattern.test(req.params.name)) return res.status(400).json({ code: 'VALIDATION', error: '资源名无效' });
  if (!req.is('application/octet-stream')) return res.status(415).json({ code: 'VALIDATION', error: '资源需要二进制请求体' });
  if (Number(req.headers['content-length']) > MAX_ASSET_BYTES) return res.status(413).json({ code: 'VALIDATION', error: '资源超过 64 MiB' });
  const temporary = path.join(assetDirectory, crypto.randomUUID() + '.upload');
  try {
    await fs.promises.mkdir(assetDirectory, { recursive: true });
    const hash = crypto.createHash('sha256'); let size = 0;
    await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > MAX_ASSET_BYTES) return callback(Object.assign(new Error('资源超过 64 MiB'), { status: 413 }));
      hash.update(chunk); callback(null, chunk);
    } }), fs.createWriteStream(temporary, { flags: 'wx' }));
    const sha256 = hash.digest('hex');
    if (size < 1 || sha256 !== req.params.name.split('.')[0]) return res.status(400).json({ code: 'VALIDATION', error: '资源校验失败' });
    const target = path.join(assetDirectory, req.params.name);
    const existing = await fileDigest(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && existing.sha256 !== sha256) await fs.promises.rename(temporary, target);
    else if (!existing) {
      try { await fs.promises.link(temporary, target); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if ((await fileDigest(target)).sha256 !== sha256) throw Object.assign(new Error('资源已变化'), { status: 409 });
      }
    }
    db.prepare(`INSERT INTO mobile_portable_assets(file_name,sha256,size_bytes,created_at) VALUES(?,?,?,?)
      ON CONFLICT(file_name) DO UPDATE SET sha256=excluded.sha256,size_bytes=excluded.size_bytes`)
      .run(req.params.name, sha256, size, new Date().toISOString());
    res.json({ sha256, size });
  } catch (error) { next(error); }
  finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}); }
});
router.get('/api/sync/state/assets/:name', async (req, res, next) => {
  if (!assetNamePattern.test(req.params.name)) return res.status(400).json({ code: 'VALIDATION', error: '资源名无效' });
  const row = db.prepare('SELECT * FROM mobile_portable_assets WHERE file_name=?').get(req.params.name);
  if (!row) return res.status(404).json({ code: 'NOT_FOUND', error: '资源不存在' });
  try {
    const target = path.join(assetDirectory, req.params.name);
    const digest = await fileDigest(target);
    if (digest.sha256 !== row.sha256 || digest.size !== row.size_bytes) return res.status(409).json({ code: 'FILE_CHANGED', error: '资源已损坏，请重新上传' });
    res.set({ ETag: `"sha256-${row.sha256}"`, 'X-Content-SHA256': row.sha256,
      'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' });
    res.sendFile(target, { etag: false, cacheControl: false, acceptRanges: true }, (error) => { if (error) next(error); });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ code: 'NOT_FOUND', error: '资源不存在' });
    next(error);
  }
});

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
