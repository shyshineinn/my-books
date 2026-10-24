/* ============================================================
 * 出站代理路由:外链封面图片代理
 * 逻辑与原版一致:SSRF 防护 / 内存缓存 / 超时重试。
 * ============================================================ */

const express = require('express');

const { LruCache } = require('./lru');

const router = express.Router();

// LRU 上限 100 条:图片 buffer 较大,内存上限尤其重要
const imgCache = new LruCache(100); // url -> { t, buffer, contentType }
const IMG_CACHE_TTL = 60 * 60 * 1000;

// SSRF 黑名单 / 防盗链 Referer / 取图逻辑全部收口到 core/remote-image.js ——
// 批量补全元数据也要下载封面,两处必须用同一份守卫(复制必然漂移,而
// SSRF 防护一旦漂移就是安全缺口)。
const { checkRemoteUrl, fetchRemoteImage } = require('../core/remote-image');

router.get('/api/img-proxy', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  const check = checkRemoteUrl(raw);
  if (!check.ok) {
    return res.status(check.code === 'VALIDATION' ? 400 : 502).json({ error: check.error, code: check.code });
  }

  const hit = imgCache.get(raw);
  if (hit && Date.now() - hit.t < IMG_CACHE_TTL) {
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Content-Type', hit.contentType);
    res.set('X-Cache', 'hit');
    return res.send(hit.buffer);
  }

  const got = await fetchRemoteImage(raw);
  if (!got.ok) {
    const status = got.code === 'VALIDATION' ? 400 : got.code === 'UPSTREAM_TIMEOUT' ? 504 : 502;
    return res.status(status).json({ error: got.error, code: got.code });
  }

  imgCache.set(raw, { t: Date.now(), buffer: got.buffer, contentType: got.contentType });
  res.set('Cache-Control', 'public, max-age=3600');
  res.set('Content-Type', got.contentType);
  res.set('X-Cache', 'miss');
  res.send(got.buffer);
});

module.exports = router;
