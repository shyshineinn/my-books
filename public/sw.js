/* ============================================================
 * My books · Service Worker(PWA 离线与缓存层)
 *
 * 缓存策略(与 API 缓存头正交:只管"端上"的体验):
 *   · App Shell(HTML/CSS/JS/图标/字体):cache-first,版本号失效
 *     —— 页面版本升级靠 CACHE_VERSION 变更 + 旧缓存清理
 *   · API(GET /api/*):network-first,失败回退缓存
 *     —— 书架数据优先新鲜,断网时展示上次内容(PWA 的核心价值)
 *   · 封面图片(/uploads/*、外链封面):cache-first,上限 60 张
 *   · POST/PUT/DELETE 永不缓存
 *
 * 版本管理:CACHE_VERSION 改动(css/js 的 ?v= 递增)后,
 * 激活阶段删除旧版本缓存。skipWaiting + clients.claim 让新 SW 立即接管。
 * ============================================================ */

const CACHE_VERSION = 'v76';
const SHELL_CACHE = `mybooks-shell-${CACHE_VERSION}`;
const API_CACHE = `mybooks-api-${CACHE_VERSION}`;
const IMG_CACHE = `mybooks-img-${CACHE_VERSION}`;
const IMG_LIMIT = 60;

// App Shell 资源清单:与各页面 HTML 引用的资源保持同步
// (改了 css/js 记得同步这里 —— 与 HTML 的 ?v= 同理)
// 注意:**不缓存 / *.html 与 /notes/*** —— HTML 必须每次向服务器验证,
// 否则新内容(备案号/新功能)发布后用户要强刷才能看到。
const SHELL_ASSETS = [
  '/css/style.css?v=83',
  '/js/chrome.js?v=21',
  '/js/common.js?v=15',
  '/js/scanner.js?v=2',
  '/js/page-home.js?v=2',
  '/js/page-shelf.js?v=7',
  '/js/page-rank.js?v=1',
  '/js/page-stats.js?v=4',
  '/js/page-tags.js?v=3',
  '/js/page-notes.js?v=1',
  '/js/endless-gallery.js?v=19',
  '/vendor/marked.umd.js',
  '/vendor/purify.min.js',
  // 扫码解码库(/vendor/html5-qrcode.min.js,375KB)不进清单:
  // 首次点「扫码」才由 scanner.js 懒加载,之后走本文件的 cache-first
  // 分支自动进缓存(PWA 离线可用);预缓存会把首屏安装拖大
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.png',
  '/logo-mark.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('mybooks-') && ![SHELL_CACHE, API_CACHE, IMG_CACHE].includes(k))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// 图片缓存淘汰:超过 IMG_LIMIT 时删最旧的(cache keys 按插入序)
async function trimImageCache() {
  const cache = await caches.open(IMG_CACHE);
  const keys = await cache.keys();
  if (keys.length > IMG_LIMIT) {
    for (const key of keys.slice(0, keys.length - IMG_LIMIT)) await cache.delete(key);
  }
}

/* 哪些响应可以放进 Cache。
 *
 * 关键:**206 Partial Content 不能缓存** —— Cache API 会抛
 *   TypeError: Failed to execute 'put' on 'Cache': Partial response (status code 206) is unsupported
 * 而 `res.ok` 对 206 是 true(ok = 200~299),所以只判断 res.ok 拦不住。
 * 这在 pdf.js 上必现:它用 Range 请求分块读 PDF,服务器回 206 →
 * cache.put 抛异常 → respondWith 的 Promise 被 reject → 浏览器判
 * SW 处理失败 → 阅读器拿到空响应 → PDF 永远空白(且 console 无报错)。
 */
function isCacheable(res) {
  // 只缓存完整的 200;206/部分响应一律不缓存
  if (!res || res.status !== 200) return false;
  // 明确带 Content-Range 的响应也排除(防御性)
  if (res.headers.get('Content-Range')) return false;
  return true;
}

/* 安全的缓存写入:任何失败都吞掉,绝不影响响应本身。
 * 缓存是「锦上添花」,不能因为写缓存失败而让用户拿不到内容。*/
function putCacheQuietly(cacheName, req, res) {
  if (!isCacheable(res)) return;
  try {
    const clone = res.clone();
    caches.open(cacheName)
      .then((cache) => cache.put(req, clone))
      .catch(() => { /* 空间不足/206/不支持等:忽略,不影响响应 */ });
  } catch { /* clone 失败等:忽略 */ }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 只处理同源 GET(外链/POST/PUT/DELETE 直接放行)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Range 请求(断点/分块读取,如 pdf.js 读 PDF、视频拖动)一律不拦截:
  // 交给浏览器直连,避免 206 引发的缓存异常
  if (req.headers.has('range')) return;

  // 电子书文件不拦截:单本可达 80MB,不适合放 Cache API;
  // 且 pdf.js 会按 Range 分块取,交给网络层最稳妥
  if (url.pathname.startsWith('/books-files/')) return;

  // API:network-first —— 在线时拿最新,离线回退缓存
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          putCacheQuietly(API_CACHE, req, res);
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) =>
            cached ||
            new Response(JSON.stringify({ error: '当前离线,显示的是缓存数据', code: 'OFFLINE' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            })
          )
        )
    );
    return;
  }

  // 封面图片:cache-first
  if (url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/icon-')) {
    event.respondWith(
      caches.open(IMG_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (isCacheable(res)) {
            await cache.put(req, res.clone()).catch(() => { /* 写缓存失败不影响响应 */ });
            trimImageCache();
          }
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  // HTML 文档:network-first(与 API 同策略)—— 内容更新立即可见,
  // 离线时回退缓存版本。绝不 cache-first,否则发布新内容用户看不到。
  // 多页后各页面(/、/shelf、/rank、/stats、/notes/:id)都是独立文档:
  // 离线兜底先按"去掉查询串的自身路径"找缓存(浏览过就有),再退回首页。
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')
      || url.pathname.startsWith('/notes/')) {
    const pathOnly = url.origin + url.pathname;
    event.respondWith(
      fetch(req)
        .then((res) => {
          putCacheQuietly(API_CACHE, req, res);
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) =>
            cached || caches.match(pathOnly).then((same) =>
              same || caches.match('/').then((root) => root ||
                new Response('当前离线', { status: 503, headers: { 'Content-Type': 'text/plain; charset=UTF-8' } }))
            )
          )
        )
    );
    return;
  }

  // App Shell 与其他静态资源(?v= 版本号管理):cache-first。
  // 注意:此分支兜住所有剩余同源 GET —— 必须保证任何异常都不会让
  // respondWith 的 Promise reject,否则请求会整个失败。
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        putCacheQuietly(SHELL_CACHE, req, res);
        return res;
      });
    })
  );
});
