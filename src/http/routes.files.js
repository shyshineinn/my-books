/* ============================================================
 * 电子书文件路由:上传 / 删除 / 下载(路 B 第一步:存储与阅读)
 *
 * 设计:
 *   · multipart 上传(multer 内存存储 → 校验 → 原子写盘),文件存
 *     books-files/(与 uploads/ 封面分开,便于各自管理)
 *   · 登记在 books 表 file_* 三列;一本书同时只保留一个文件
 *     (重新上传 = 替换,旧文件删除,避免磁盘膨胀)
 *   · 下载走 express.static,disposition 由前端 download 属性实现;
 *     原文件名不落盘、不透传,与封面上传同一安全思路
 * ============================================================ */

const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');

const books = require('../db/books');
const { validateEbookFile, ebookFileName } = require('../core/ebook');
const { atomicWrite } = require('../core/fs-utils');

const router = express.Router();

const FILES_DIR = path.join(__dirname, '..', '..', 'books-files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// 内存存储:先校验再落盘,拒绝的请求不产生任何磁盘文件
// (80MB 文件进内存瞬时可行;文件写盘后 buffer 即被 GC)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });

// 删除磁盘上的旧文件(忽略不存在/已删除的异常)
function removeFileQuiet(relPath) {
  if (!relPath) return;
  try { fs.unlinkSync(path.join(FILES_DIR, relPath)); } catch { /* 文件可能已不存在 */ }
}

// 上传/替换电子书
router.post('/api/books/:id/file', upload.single('file'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
  }
  const book = books.getBook(id);
  if (!book) return res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });
  if (!req.file) return res.status(400).json({ error: '未收到文件', code: 'VALIDATION' });

  const v = validateEbookFile(req.file.originalname, req.file.size);
  if (!v.ok) return res.status(400).json({ error: v.error, code: v.code });

  const filename = ebookFileName(id, v.format);
  atomicWrite(path.join(FILES_DIR, filename), req.file.buffer);

  // 替换场景:登记成功后再删旧文件(失败也不丢新文件)
  const oldPath = book.file_path;
  const updated = books.setBookFile(id, { filePath: filename, format: v.format, size: v.size });
  if (oldPath && oldPath !== filename) removeFileQuiet(oldPath);

  res.status(201).json({ file: { path: updated.file_path, format: updated.file_format, size: updated.file_size } });
});

// 删除电子书(磁盘 + 登记)
router.delete('/api/books/:id/file', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
  }
  const book = books.getBook(id);
  if (!book || !book.file_path) return res.status(404).json({ error: '这本书没有电子书文件', code: 'NOT_FOUND' });

  removeFileQuiet(book.file_path);
  books.clearBookFile(id);
  res.json({ ok: true });
});

// 电子书文件清单是否存在(供前端判断)
router.get('/api/books/:id/file', (req, res) => {
  const id = Number(req.params.id);
  const book = books.getBook(id);
  if (!book) return res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });
  if (!book.file_path) return res.status(404).json({ error: '这本书没有电子书文件', code: 'NOT_FOUND' });
  res.json({ file: { path: book.file_path, format: book.file_format, size: book.file_size } });
});

module.exports = router;
