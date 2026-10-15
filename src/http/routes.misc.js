/* ============================================================
 * 设置 / 统计 / 上传路由(HTTP 适配层)
 * ============================================================ */

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const settings = require('../db/settings');
const stats = require('../db/stats');
const { atomicWrite } = require('../core/fs-utils');
const { UPLOAD_DIR } = require('../core/paths');

const router = express.Router();

// 封面上传目录(与电子书目录同为磁盘资产,位置定义见 core/paths.js)
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 全局设置:心得仓库
router.get('/api/settings', (req, res) => {
  res.json(settings.getSettings());
});

router.put('/api/settings', (req, res) => {
  const result = settings.saveSettings(req.body.notesRepo, req.body.notesBranch);
  if (!result.ok) return res.status(400).json({ error: result.error, code: 'VALIDATION' });
  res.json({ notesRepo: result.notesRepo, notesBranch: result.notesBranch });
});

// 封面上传(base64);MIME 白名单 + 5MB 上限 + 随机文件名
router.post('/api/upload', (req, res) => {
  const data = String(req.body.data || '');
  const match = data.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/);
  if (!match) return res.status(400).json({ error: '仅支持 png/jpg/gif/webp 图片', code: 'VALIDATION' });

  const ext = match[1].split('/')[1].replace('jpeg', 'jpg');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: '图片不能超过 5MB', code: 'VALIDATION' });

  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  // 原子写:先临时文件再 rename,断电/崩溃不会留半张图(借鉴 calibre atomic_write)
  atomicWrite(path.join(UPLOAD_DIR, filename), buffer);
  res.status(201).json({ url: `/uploads/${filename}` });
});

// 统计数据
router.get('/api/stats', (req, res) => {
  res.json(stats.getStats());
});

module.exports = router;
