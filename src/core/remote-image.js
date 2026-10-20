/* ============================================================
 * 远程图片获取的共享守卫(纯规则 + 一个 fetch 包装)
 *
 * 为什么独立成模块:两处都要"把外链图片安全地取回来"——
 *   · src/http/routes.proxy.js 的 /api/img-proxy(前端 Canvas 取色用)
 *   · 批量补全元数据时把豆瓣封面下载进 uploads/(enrich)
 * 复制两份必然漂移,而 SSRF 防护一旦漂移就是安全缺口。故收口到这里。
 *
 * 本模块**不放 express 逻辑**,只回答三个问题:
 *   1. 这个 URL 能不能访问?(协议白名单 + 内网黑名单)
 *   2. 该不该给它发 Referer?发给谁?(豆瓣必须带、百度系绝不能带)
 *   3. 取回来的是不是一张合规的图片?(content-type + 体积上限)
 * ============================================================ */

// 内网/保留地址黑名单(SSRF 防护核心)。宁可多拦,不可漏拦 ——
// 误拦一个公网图床只是"封面显示不出来",漏拦一个内网地址是内网穿透。
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // 172.16.0.0/12
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true; // IPv6 回环/ULA/链路本地
  if (h.startsWith('0.')) return true; // 0.0.0.0/8
  return false;
}

/* 防盗链 Referer:只对豆瓣图床添加,不能一刀切给所有图床。
 *
 * 豆瓣图床(doubanio.com)对无 Referer 的请求直接回 418 I'm a Teapot:
 *   实测同一 URL,不带 Referer → 418;带 https://book.douban.com/ → 200 + 真实 JPEG。
 * 而另一些图床是反过来的 —— 百度系(bkimg.cdn.bcebos.com)要求 Referer 属于自家,
 * 给它发豆瓣 Referer 会被 403(实测 4 个百度封面在加 Referer 后全部失败)。
 * 故此处按域名定向添加,对非豆瓣图床不发送 Referer。
 */
function refererFor(hostname) {
  const h = String(hostname || '').toLowerCase();
  // 豆瓣图床域:img1/img3/img9.doubanio.com、*.douban.com 等
  if (h === 'doubanio.com' || h.endsWith('.doubanio.com')) return 'https://book.douban.com/';
  if (h === 'douban.com' || h.endsWith('.douban.com')) return 'https://book.douban.com/';
  return '';
}

// 允许的图片 MIME(与封面上传的白名单一致:png/jpeg/gif/webp)
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 15000;

// 校验 URL 是否可访问。返回 { ok, url } 或 { ok:false, error, code }
function checkRemoteUrl(raw) {
  let url;
  try {
    url = new URL(String(raw == null ? '' : raw).trim());
  } catch {
    return { ok: false, error: '链接格式不正确', code: 'VALIDATION' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: '仅支持 http/https 图片链接', code: 'VALIDATION' };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, error: '不允许访问内网地址', code: 'VALIDATION' };
  }
  return { ok: true, url };
}

// 取一张远程图片。返回 { ok:true, buffer, contentType } 或 { ok:false, error, code }。
// retry 默认 true:部分图床偶发超时,自动重试一次(与 /api/img-proxy 同款)。
async function fetchRemoteImage(rawUrl, { retry = true } = {}) {
  const check = checkRemoteUrl(rawUrl);
  if (!check.ok) return check;

  const ref = refererFor(check.url.hostname);
  const doFetch = () => fetch(check.url, {
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    redirect: 'follow',
    headers: {
      'User-Agent': 'MyBooks/1.0',
      ...(ref ? { Referer: ref } : {}),
    },
  });

  let resp;
  try {
    resp = await doFetch();
  } catch {
    if (!retry) return { ok: false, error: '图片拉取超时或失败', code: 'UPSTREAM_TIMEOUT' };
    try {
      resp = await doFetch();
    } catch {
      return { ok: false, error: '图片拉取超时或失败', code: 'UPSTREAM_TIMEOUT' };
    }
  }

  if (!resp.ok) {
    return { ok: false, error: `图片拉取失败(HTTP ${resp.status})`, code: 'UPSTREAM' };
  }
  const contentType = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_MIME.has(contentType)) {
    return { ok: false, error: '链接不是支持的图片格式(png/jpeg/gif/webp)', code: 'UPSTREAM' };
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > IMAGE_MAX_BYTES) {
    return { ok: false, error: '图片不能超过 5MB', code: 'UPSTREAM' };
  }
  if (!buffer.length) {
    return { ok: false, error: '图片内容为空', code: 'UPSTREAM' };
  }
  return { ok: true, buffer, contentType };
}

// MIME → 落盘扩展名(与 routes.misc.js 封面上传的命名规则保持同一套)
function extForMime(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct === 'image/png') return 'png';
  if (ct === 'image/webp') return 'webp';
  if (ct === 'image/gif') return 'gif';
  return 'jpg';                       // image/jpeg 与兜底
}

module.exports = {
  isPrivateHost,
  refererFor,
  checkRemoteUrl,
  fetchRemoteImage,
  extForMime,
  IMAGE_MIME,
  IMAGE_MAX_BYTES,
  IMAGE_TIMEOUT_MS,
};
