/* ============================================================
 * 出站代理路由:读书心得(GitHub raw)与外链封面图片代理
 * 逻辑与原版一致:域名白名单 / SSRF 防护 / 内存缓存 / 超时重试。
 * ============================================================ */

const express = require('express');

const { getSetting } = require('../db/index');
const { LruCache } = require('./lru');

const router = express.Router();

// ---------- 读书心得:服务端代理拉取 GitHub 上的 Markdown 文件(带缓存) ----------
const NOTES_HOSTS = ['raw.githubusercontent.com', 'gist.githubusercontent.com'];

function toRawUrl(u) {
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (!m) return null;
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  if (!NOTES_HOSTS.includes(url.hostname)) return null;
  return 'https://' + url.hostname + url.pathname + url.search;
}

// LRU 上限 100 条:修掉"Map 只增不减"的内存债;命中状态经 X-Cache 头可观测
const notesCache = new LruCache(100); // url -> { t, content }

router.get('/api/notes', async (req, res) => {
  const q = String(req.query.url || '').trim();
  if (!q) return res.status(400).json({ error: '缺少心得文件链接', code: 'VALIDATION' });

  let raw;
  if (/^https?:\/\//i.test(q)) {
    raw = toRawUrl(q);
    if (!raw) return res.status(400).json({ error: '仅支持 GitHub 上的 Markdown 文件链接', code: 'VALIDATION' });
  } else {
    // 短文件名:解析到设置里的心得仓库
    const repo = getSetting('notes_repo');
    const branch = getSetting('notes_branch') || 'main';
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      return res.status(400).json({ error: '尚未配置心得仓库,请点击右上角 ⚙ 进行设置', code: 'NOT_CONFIGURED' });
    }
    const file = q.replace(/^\/+/, '');
    raw = `https://raw.githubusercontent.com/${repo}/${branch}/${encodeURI(file.endsWith('.md') ? file : file + '.md')}`;
  }

  const hit = notesCache.get(raw);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) {
    res.set('X-Cache', 'hit');
    return res.json({ content: hit.content });
  }

  try {
    const resp = await fetch(raw, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'MyBooks/1.0' },
    });
    if (!resp.ok) {
      return res.status(502).json({ error: `GitHub 文件拉取失败(HTTP ${resp.status}),请检查链接和文件是否公开`, code: 'UPSTREAM' });
    }
    const content = await resp.text();
    notesCache.set(raw, { t: Date.now(), content });
    res.set('X-Cache', 'miss');
    res.json({ content });
  } catch {
    res.status(504).json({ error: '连接 GitHub 超时或失败,请稍后重试', code: 'UPSTREAM_TIMEOUT' });
  }
});

// ---------- 图片代理:外链封面转同源图片,供前端 Canvas 取色(缓存 + SSRF 防护) ----------
// LRU 上限 100 条:与 notesCache 同策略;图片 buffer 较大,内存上限尤其重要
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
