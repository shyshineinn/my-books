/* ============================================================
 * 阅读位置规则(纯函数,不碰 I/O)
 *
 * 依赖方向纪律:本目录不 import 任何项目模块,规则可脱离数据库独立测试。
 *
 * 位置模型说明:
 *   · locator      —— 坐标本体。EPUB 存 epub.js 的 CFI 串(标准 EPUBCFI),
 *                     PDF 存 JSON 字符串 {"page":n,"offsetY":y}
 *   · locator_kind —— 解释方式,决定 locator 的形状
 *   · pos_frac     —— 0~1 的全文进度,仅用于列表展示与「上次读到 x%」提示
 *   · device       —— 设备标识,同一本书不同设备各存各的
 *
 * 为什么不让前端直接写库:locator 与 kind 必须一致(epubcfi 配 CFI 串、
 * pdfpage 配 JSON),错配会让恢复时定位到错误位置。这里统一收口校验。
 * ============================================================ */

const LOCATOR_KINDS = ['epubcfi', 'pdfpage'];
const MAX_LOCATOR_LEN = 2000;   // CFI 串可能很长;2000 足够且防滥用
const MAX_DEVICE_LEN = 64;

// 规范化设备标识:前端传什么用什么,但收窄长度与字符集,避免脏数据
function normalizeDevice(raw) {
  const d = String(raw ?? '').trim().slice(0, MAX_DEVICE_LEN);
  // 只留字母数字、连字符、下划线、点(前端用 desktop / phone / 自定义短标识)
  return d.replace(/[^\w.-]/g, '');
}

// 规范化格式名:大写(与 books.file_format 的存法一致)
function normalizeFormat(raw) {
  return String(raw ?? '').trim().toUpperCase().slice(0, 16);
}

/* 校验并规范化上报的位置:{ ok, values } 或 { ok:false, error, code } */
function parsePosition(body) {
  const b = body && typeof body === 'object' ? body : {};

  const format = normalizeFormat(b.format);
  if (!format) return { ok: false, error: '缺少格式(format)', code: 'VALIDATION' };

  const device = normalizeDevice(b.device);
  if (!device) return { ok: false, error: '缺少设备标识(device)', code: 'VALIDATION' };

  const kind = String(b.locator_kind ?? 'epubcfi').trim().toLowerCase();
  if (!LOCATOR_KINDS.includes(kind)) {
    return { ok: false, error: `定位方式不合法(支持:${LOCATOR_KINDS.join(' / ')})`, code: 'VALIDATION' };
  }

  const locator = String(b.locator ?? '').trim();
  if (!locator) return { ok: false, error: '缺少位置(locator)', code: 'VALIDATION' };
  if (locator.length > MAX_LOCATOR_LEN) {
    return { ok: false, error: `位置过长(上限 ${MAX_LOCATOR_LEN} 字符)`, code: 'VALIDATION' };
  }

  // 坐标与解释方式必须匹配 —— 错配会导致下次恢复时定位错误
  if (kind === 'epubcfi' && !/^epubcfi\(/.test(locator)) {
    return { ok: false, error: 'locator_kind=epubcfi 时,locator 应为 epubcfi(...) 形式的串', code: 'VALIDATION' };
  }
  if (kind === 'pdfpage') {
    const parsed = parsePdfLocator(locator);
    if (!parsed) return { ok: false, error: 'locator_kind=pdfpage 时,locator 应为 {"page":n,...} 的 JSON', code: 'VALIDATION' };
  }

  // pos_frac:0~1;非法输入归 0(不报错,进度提示是次要信息,不该因它拒掉整次上报)
  let frac = Number(b.pos_frac);
  if (!Number.isFinite(frac) || frac < 0) frac = 0;
  if (frac > 1) frac = 1;

  return { ok: true, values: { format, device, locator, locator_kind: kind, pos_frac: frac } };
}

/* 解析 PDF 位置 JSON;返回 { page, offsetY } 或 null */
function parsePdfLocator(locator) {
  try {
    const o = JSON.parse(locator);
    if (!o || typeof o !== 'object') return null;
    const page = Number(o.page);
    if (!Number.isInteger(page) || page < 1) return null;
    let offsetY = Number(o.offsetY);
    if (!Number.isFinite(offsetY) || offsetY < 0) offsetY = 0;
    return { page, offsetY };
  } catch {
    return null;
  }
}

/* 构造 PDF 位置串(供调用方与测试复用,避免各处手拼 JSON 格式不一致) */
function pdfLocator(page, offsetY = 0) {
  return JSON.stringify({ page: Math.max(1, Math.floor(Number(page) || 1)), offsetY: Math.max(0, Number(offsetY) || 0) });
}

/* 进度展示文案:0.4231 → "42%" */
function formatPercent(frac) {
  const n = Number(frac);
  if (!Number.isFinite(n) || n <= 0) return '0%';
  if (n >= 1) return '100%';
  return Math.round(n * 100) + '%';
}

module.exports = {
  LOCATOR_KINDS,
  MAX_LOCATOR_LEN,
  MAX_DEVICE_LEN,
  normalizeDevice,
  normalizeFormat,
  parsePosition,
  parsePdfLocator,
  pdfLocator,
  formatPercent,
};
