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

const router = express.Router();

const FILES_DIR = path.join(__dirname, '..', '..', 'books-files');
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

// 删除磁盘上的旧文件(忽略不存在/已删除的异常)
function removeFileQuiet(relPath) {
  if (!relPath) return;
  try { fs.unlinkSync(path.join(FILES_DIR, relPath)); } catch { /* 文件可能已不存在 */ }
}

// 上传/替换电子书。multer 的错误(超 80MB 触发 LIMIT_FILE_SIZE)有专属 code,
// 包一层捕获,把 multer 错误转成规范 JSON,而不是掉进兜底 500。
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
