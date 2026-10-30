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
const { fileDigest } = require('../core/file-digest');

const router = express.Router();

// 强 ETag 与 SHA-256 绑定同一份正文；If-Range 不匹配时 sendFile 返回完整 200。
router.get('/api/books/:id/files/:fileId/content', async (req, res, next) => {
  try {
    const id = Number(req.params.id), fileId = Number(req.params.fileId);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(fileId) || fileId < 1) {
      return res.status(400).json({ code: 'VALIDATION', error: '书籍或文件 id 无效' });
    }
    const book = books.getBook(id);
    const file = bookFiles.getFileById(db, fileId);
    if (!book || !file || file.book !== id) return res.status(404).json({ code: 'NOT_FOUND', error: '正文不存在' });
    if (req.query.uuid !== undefined && req.query.uuid !== book.uuid) {
      return res.status(409).json({ code: 'IDENTITY_CHANGED', error: '书籍身份已变化' });
    }
    const base = await fs.promises.realpath(FILES_DIR);
    const target = await fs.promises.realpath(path.resolve(base, file.path));
    if (!target.startsWith(base + path.sep)) return res.status(400).json({ code: 'VALIDATION', error: '正文路径无效' });
    const digest = await fileDigest(target);
    if (bookFiles.getFileById(db, fileId)?.path !== file.path) {
      return res.status(409).json({ code: 'FILE_CHANGED', error: '正文已更新，请重试下载' });
    }
    // 旧登记没有 SHA:下载时按实际文件补齐;已有值但不一致说明磁盘被改过,先记日志
    if (!file.sha256) {
      try { bookFiles.setDigest(db, fileId, digest.sha256); } catch (err) {
        console.error(`[files] 回填文件摘要失败 id=${fileId}:`, err.message);
      }
    } else if (file.sha256 !== digest.sha256) {
      console.warn(`[files] 文件摘要与登记不一致 id=${fileId}:登记=${file.sha256} 实际=${digest.sha256}`);
    }
    res.set({ ETag: `"sha256-${digest.sha256}"`, 'X-Content-SHA256': digest.sha256,
      'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes' });
    res.sendFile(target, { etag: false, acceptRanges: true, cacheControl: false }, (error) => {
      if (error) next(error);
    });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ code: 'NOT_FOUND', error: '正文不存在' });
    next(error);
  }
});

if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

function cleanupUpload(file) {
  const target = file && file.path;
  if (!target) return;
  try {
    fs.unlinkSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[files] 临时上传文件清理失败 ${target}:`, err.message);
  }
}

// 进程崩溃/请求中断可能留下 uploading-* 临时文件;启动时清掉一小时前的残留
function cleanupStaleUploads() {
  let removed = 0;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(FILES_DIR)) {
      if (!name.startsWith('uploading-')) continue;
      const full = path.join(FILES_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && now - stat.mtimeMs > 3600 * 1000) {
          fs.unlinkSync(full);
          removed += 1;
        }
      } catch { /* 文件刚被其它请求改名/删除,忽略 */ }
    }
  } catch (err) {
    console.error('[files] 清理残留上传文件失败:', err.message);
  }
  if (removed) console.log(`[files] 清理了 ${removed} 个残留临时上传文件`);
}
cleanupStaleUploads();

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
  if (err) cleanupUpload(req.file);
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '文件不能超过 80MB', code: 'VALIDATION' });
  }
  next(err);
}, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      cleanupUpload(req.file);
      return res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
    }
    const book = books.getBook(id);
    if (!book) {
      cleanupUpload(req.file);
      return res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });
    }
    if (!req.file) return res.status(400).json({ error: '未收到文件', code: 'VALIDATION' });

    const v = validateEbookFile(req.file.originalname, req.file.size);
    if (!v.ok) {
      cleanupUpload(req.file);
      return res.status(400).json({ error: v.error, code: v.code });
    }

    let digest;
    try {
      digest = await fileDigest(req.file.path);
    } catch (err) {
      cleanupUpload(req.file);
      if (err && err.status) {
        return res.status(err.status).json({ error: err.message || '读取上传文件失败', code: 'CONFLICT' });
      }
      throw err;
    }

    // multer 已流式写到磁盘(临时名),rename 到正式名 —— 同目录 rename 是原子操作
    const filename = ebookFileName(id, v.format);
    const finalPath = path.join(FILES_DIR, filename);
    try {
      fs.renameSync(req.file.path, finalPath);
    } catch (err) {
      cleanupUpload(req.file);
      throw err;
    }

    // 覆盖替换场景:登记成功后,才删被替换的旧文件
    let replaced;
    let saved;
    try {
      replaced = bookFiles.getFile(db, id, v.format);
      saved = bookFiles.upsertFile(db, id, {
        format: v.format, path: filename, size: digest.size, sha256: digest.sha256,
      });
    } catch (err) {
      // 登记失败:把刚改名的文件删掉;旧登记/旧文件保持原样
      try { fs.unlinkSync(finalPath); } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') console.error(`[files] 登记失败后清理新文件失败 ${finalPath}:`, unlinkErr.message);
      }
      throw err;
    }
    if (replaced && replaced.path !== filename) removeFileQuiet(replaced.path);
    try { books.touchBook(id, db); } catch (err) {
      console.error(`[files] 文件登记成功但更新书籍时间失败 id=${id}:`, err.message);
    }

    res.status(201).json({
      file: { id: saved.id, format: saved.format, path: saved.path, size: saved.size, sha256: saved.sha256 },
    });
  } catch (err) {
    next(err);
  }
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
  res.json({ files: rows.map((f) => ({ id: f.id, format: f.format, path: f.path, size: f.size, sha256: f.sha256 })) });
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

  // 磁盘删除失败(权限/越界)时保留登记,让用户能重试并看到真实原因
  if (!removeUnderBase(FILES_DIR, existing.path)) {
    return res.status(500).json({ error: '磁盘文件删除失败,登记已保留', code: 'INTERNAL' });
  }
  bookFiles.removeFile(db, id, format);
  books.touchBook(id, db);
  res.json({ ok: true });
});

module.exports = router;
