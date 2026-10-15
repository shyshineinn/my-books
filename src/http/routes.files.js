/* ============================================================
 * 电子书文件路由:上传 / 列表 / 删除 / 下载登记(存储,不含在线阅读)
 *
 * 设计:
 *   · 一本书可挂多个文件(epub、pdf…),同一格式只保留一份 ——
 *     重新上传相同格式 = 覆盖替换(UNIQUE(book, format) UPSERT),
 *     被替换的旧文件从磁盘删除,避免磁盘膨胀。
 *   · multipart 上传(multer 磁盘存储 → 校验 → 原子改名),文件存
 *     books-files/;登记在 book_files 表(v7 迁移)。
 *   · 下载走 express.static,disposition 由前端 download 属性实现;
 *     原文件名不落盘、不透传,与封面上传同一安全思路。
 * ============================================================ */

const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');

const { db } = require('../db/index');
const books = require('../db/books');
const bookFiles = require('../db/book_files');
const { validateEbookFile, ebookFileName } = require('../core/ebook');
const { removeUnderBase } = require('../core/fs-utils');
const { FILES_DIR } = require('../core/paths');

const router = express.Router();

if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// 磁盘流式存储:大文件(PDF 可达 80MB)不再整份读进内存,
// 避免服务器内存尖峰;文件先写临时名,校验通过后原子改名。
// 磁盘缓冲上限 20MB:超过这个大小的剩余部分直接流写磁盘。
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, FILES_DIR),
    filename: (req, file, cb) => cb(null, `uploading-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  }),
  limits: { fileSize: 80 * 1024 * 1024 },
});

// 删除电子书目录内的文件:统一走 fs-utils 的边界收口(拒绝越出 FILES_DIR 的路径),
// 与 routes.books.js 删书时的清理共用同一套删除纪律。
function removeFileQuiet(relPath) {
  if (!removeUnderBase(FILES_DIR, relPath)) {
    console.error(`[files] 未能删除或路径越界: ${relPath}`);
  }
}

// multer 错误(超 80MB 触发 LIMIT_FILE_SIZE)转规范 JSON,不掉进兜底 500
router.post('/api/books/:id/file', upload.single('file'), (err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '文件不能超过 80MB', code: 'VALIDATION' });
  }
  next(err);
}, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
  }
  const book = books.getBook(id);
  if (!book) return res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });
  if (!req.file) return res.status(400).json({ error: '未收到文件', code: 'VALIDATION' });

  const v = validateEbookFile(req.file.originalname, req.file.size);
  if (!v.ok) {
    // 校验失败:删掉磁盘上的临时上传文件,不留垃圾
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: v.error, code: v.code });
  }

  // multer 已流式写到磁盘(临时名),rename 到正式名 —— 同目录 rename 是原子操作
  const filename = ebookFileName(id, v.format);
  const finalPath = path.join(FILES_DIR, filename);
  fs.renameSync(req.file.path, finalPath);

  // 覆盖替换场景:登记成功后再删被替换的旧文件(失败也不丢新文件)
  const replaced = bookFiles.getFile(db, id, v.format);
  const saved = bookFiles.upsertFile(db, id, { format: v.format, path: filename, size: v.size });
  if (replaced && replaced.path !== filename) removeFileQuiet(replaced.path);

  res.status(201).json({ file: { id: saved.id, format: saved.format, path: saved.path, size: saved.size } });
});

// 某本书的文件列表
router.get('/api/books/:id/file', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
  }
  const book = books.getBook(id);
  if (!book) return res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });
  const rows = bookFiles.listFiles(db, id);
  res.json({ files: rows.map((f) => ({ id: f.id, format: f.format, path: f.path, size: f.size })) });
});

// 删除某个文件(按格式;磁盘 + 登记一起删)
router.delete('/api/books/:id/file', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
  }
  const book = books.getBook(id);
  if (!book) return res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });

  const format = String(req.query.format || '').trim().toUpperCase();
  if (!format) return res.status(400).json({ error: '缺少格式(format 查询参数)', code: 'VALIDATION' });

  const existing = bookFiles.getFile(db, id, format);
  if (!existing) return res.status(404).json({ error: `这本书没有 ${format} 文件`, code: 'NOT_FOUND' });

  removeFileQuiet(existing.path);
  bookFiles.removeFile(db, id, format);
  res.json({ ok: true });
});

module.exports = router;
