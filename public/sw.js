/* ============================================================
 * My books · Service Worker(PWA 离线与缓存层)
 *
 * 缓存策略(与 API 缓存头正交,只管"端上"的体验):
 *   · App Shell(HTML/CSS/JS/图标/字体):cache-first,版本号失效
 *     —— 页面版本升级靠 CACHE_VERSION 变更 + 旧缓存清理
 *   · API(GET /api/*):network-first,失败回退缓存
 *     —— 书架数据优先新鲜,断网时展示上次内容(PWA 的核心价值)
 *   · 封面图片(/uploads/*、外链封面):cache-first,上限 60 张
 *   · POST/PUT/DELETE 永不缓存
 *
 * 版本管理:CACHE_VERSION 改动(index.html 的 ?v= 递增)后,
 * 激活阶段删除旧版本缓存。skipWaiting + clients.claim 让新 SW 立即接管。
 * ============================================================ */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `mybooks-shell-${CACHE_VERSION}`;
const API_CACHE = `mybooks-api-${CACHE_VERSION}`;
const IMG_CACHE = `mybooks-img-${CACHE_VERSION}`;
const IMG_LIMIT = 60;

// App Shell 资源清单:与 index.html 引用的资源保持同步
// (改了 css/js 记得同步这里 —— 与 index.html 的 ?v= 同理)
const SHELL_ASSETS = [
  '/',
  '/css/style.css?v=23',
  '/js/app.js?v=28',
  '/js/endless-gallery.js?v=6',
  '/vendor/marked.umd.js',
  '/vendor/purify.min.js',
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 只处理同源 GET(外链/POST/PUT/DELETE 直接放行)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // API:network-first —— 在线时拿最新,离线回退缓存
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(API_CACHE).then((cache) => cache.put(req, clone));
          }
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
          if (res.ok) {
            await cache.put(req, res.clone());
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

  // App Shell 与其他静态资源:cache-first,后台可被 install 时更新
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, clone));
        }
        return res;
      });
    })
  );
});
