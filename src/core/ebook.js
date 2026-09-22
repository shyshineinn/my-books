/* ============================================================
 * 电子书文件规则(纯函数,不碰 I/O)
 * 路 B 第一步:存储与阅读。转换能力后续接 ebook-convert,不在本层。
 *
 * 支持格式:EPUB / PDF(站内阅读)
 *           MOBI / AZW3 / TXT(存储+下载,暂不站内阅读)
 * 上限:80MB(扫版 PDF 留余量;Nginx client_max_body_size 需同步调大)
 * ============================================================ */

const EBOOK_FORMATS = ['epub', 'pdf', 'mobi', 'azw3', 'txt'];
const EBOOK_READABLE = ['epub', 'pdf']; // 支持站内阅读的格式
const EBOOK_MAX_SIZE = 80 * 1024 * 1024; // 80MB

// 从文件名提取格式(最后一个点之后);无扩展名返回 ''
function extOf(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(filename || '').trim());
  return m ? m[1].toLowerCase() : '';
}

// 校验上传的电子书文件:{ ok, format?, size?, error?, code? }
// sizeBytes 由调用方(路由层)从实际上传内容取,不信文件名
function validateEbookFile(filename, sizeBytes) {
  const ext = extOf(filename);
  if (!ext) return { ok: false, error: '文件缺少扩展名,无法识别格式', code: 'VALIDATION' };
  if (!EBOOK_FORMATS.includes(ext)) {
    return { ok: false, error: `暂不支持 .${ext} 格式(支持:${EBOOK_FORMATS.join(' / ')})`, code: 'VALIDATION' };
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: '文件内容为空', code: 'VALIDATION' };
  }
  if (sizeBytes > EBOOK_MAX_SIZE) {
    return { ok: false, error: `文件不能超过 ${Math.round(EBOOK_MAX_SIZE / 1024 / 1024)}MB`, code: 'VALIDATION' };
  }
  return { ok: true, format: ext.toUpperCase(), size: sizeBytes };
}

// 生成存储文件名:bookId-时间戳-随机.扩展名(可读 + 防碰撞 + 不透传原文件名)
function ebookFileName(bookId, format) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${bookId}-${Date.now()}-${rand}.${format.toLowerCase()}`;
}

module.exports = { EBOOK_FORMATS, EBOOK_READABLE, EBOOK_MAX_SIZE, extOf, validateEbookFile, ebookFileName };
