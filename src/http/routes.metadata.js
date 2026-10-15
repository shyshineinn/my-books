/* ============================================================
 * 豆瓣元数据路由:GET /api/v1/metadata/search?q=书名或ISBN
 *
 * 网络层(与 core/douban.js 的解析层分离):
 *   · Cookie 配置:环境变量 DOUBAN_COOKIE > data/douban-cookie 文件
 *     (登录豆瓣浏览器 F12 → Network → 复制 Cookie 头整段)
 *   · 随机延迟 0~100ms(插件同款反爬)
 *   · 15s 超时;"禁止访问"明确报 502,提示配 Cookie
 *   · LRU 20 条缓存(候选页),10 分钟
 * ============================================================ */

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { parseSearchPage, parseBookPage, mapToBook } = require('../core/douban');
const { LruCache } = require('./lru');

const router = express.Router();

const COOKIE_FILE = path.join(__dirname, '..', '..', 'data', 'douban-cookie');
const SEARCH_CACHE_TTL = 10 * 60 * 1000; // 10 分钟:与文件头声明一致
const searchCache = new LruCache(20);
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];
const randomUA = () => UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
const randomDelay = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 100)));

function loadCookie() {
  if (process.env.DOUBAN_COOKIE) return String(process.env.DOUBAN_COOKIE).trim();
  try {
    if (fs.existsSync(COOKIE_FILE)) return fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  } catch { /* ignore */ }
  return '';
}

async function doubanFetch(url) {
  await randomDelay();
  const headers = {
    'User-Agent': randomUA(),
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  const cookie = loadCookie();
  if (cookie) headers['Cookie'] = cookie;
  return fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' });
}

// 检测豆瓣反爬页(与插件同款)
function isProhibited(html) {
  return typeof html === 'string' && html.includes('<title>禁止访问</title>');
}

// 搜索处理函数:单独抽出(不写成 router.get 的内联回调),
// 便于测试直接以假 req/res + 桩 fetch 驱动,验证缓存 TTL 行为。
async function handleMetadataSearch(req, res) {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '缺少搜索词(书名或 ISBN)', code: 'VALIDATION' });

  const isIsbn = /^\d{9,13}[xX]?$/.test(q.replace(/[- ]/g, ''));
  const searchKey = isIsbn ? `isbn:${q}` : q;

  const hit = searchCache.get(searchKey);
  if (hit) {
    // TTL 检查(此前缺这一步:注释写着 10 分钟,代码却是"命中就返回",
    // 条目只在被 20 条 LRU 淘汰前永久有效 —— 豆瓣改条目后一直拿旧数据)
    if (Date.now() - hit.t < SEARCH_CACHE_TTL) {
      res.set('X-Cache', 'hit');
      return res.json({ results: hit.results, cookieless: !loadCookie() });
    }
    searchCache.delete(searchKey); // 过期条目主动清掉,别占着容量位
  }

  try {
    // 第一步:统一搜索页拿候选(即使 ISBN 也走搜索页,豆瓣搜索对 ISBN 兼容)
    const searchUrl = 'https://www.douban.com/search?cat=1001&q=' + encodeURIComponent(q);
    const sResp = await doubanFetch(searchUrl);
    if (!sResp.ok) {
      return res.status(502).json({ error: `豆瓣搜索失败(HTTP ${sResp.status})`, code: 'UPSTREAM' });
    }
    const sHtml = await sResp.text();
    if (isProhibited(sHtml)) {
      return res.status(502).json({
        error: '豆瓣拒绝访问。请配置登录 Cookie:浏览器登录豆瓣 → F12 → Network → 复制 Cookie 头,写入服务器 data/douban-cookie 文件(或 DOUBAN_COOKIE 环境变量)后重启',
        code: 'BLOCKED',
      });
    }
    const candidates = parseSearchPage(sHtml);
    if (!candidates.length) return res.json({ results: [], cookieless: !loadCookie() });

    // 第二步:并发拉详情(上限 5,与插件并发数一致)
    const details = await Promise.all(
      candidates.slice(0, 5).map(async (c) => {
        try {
          const bResp = await doubanFetch('https://book.douban.com/subject/' + c.doubanId + '/');
          if (!bResp.ok) return null;
          const html = await bResp.text();
          if (isProhibited(html)) return null;
          const meta = parseBookPage(html, c.doubanId);
          return meta ? mapToBook(meta) : null;
        } catch { return null; }
      })
    );
    const results = details.filter(Boolean);
    searchCache.set(searchKey, { t: Date.now(), results });
    res.set('X-Cache', 'miss');
    res.json({ results, cookieless: !loadCookie() });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: '连接豆瓣超时,请稍后重试', code: 'UPSTREAM_TIMEOUT' });
    }
    console.error('[douban] search failed:', err.message);
    res.status(500).json({ error: '豆瓣查询失败', code: 'INTERNAL' });
  }
}

router.get('/api/metadata/search', handleMetadataSearch);

module.exports = router;
// 供测试:处理函数、缓存实例与 TTL 常量(与 middleware.auth.js 导出
// resetTokenCache 同一思路 —— 路由照常注册,内部件可被单独驱动)
module.exports.handleMetadataSearch = handleMetadataSearch;
module.exports.searchCache = searchCache;
module.exports.SEARCH_CACHE_TTL = SEARCH_CACHE_TTL;
