/* ============================================================
 * 元数据源网络层(HTTP 适配,含豆瓣反爬与 Open Library)
 *
 * 为什么独立成模块:此前网络层内嵌在 routes.metadata.js 里,
 * 「按 ISBN 添加」链路(批量导入 / 扫码回填)也要用同一套
 * Cookie / UA / 延迟 / 反爬检测 —— 复制一份必然漂移,提取共享。
 * 分层不变:core/douban.js、core/openlibrary.js 是纯解析,
 * 本文件只负责"把 URL 变成解析结果",不碰数据库与 express。
 *
 * 豆瓣反爬要点(移植自 calibre 插件 NewDouban):
 *   · Cookie:环境变量 DOUBAN_COOKIE > data/douban-cookie 文件
 *   · 请求前随机延迟 0~100ms;UA 池轮换
 *   · 检测 '<title>禁止访问</title>' 明确报错(报 BLOCKED 而不是空结果)
 *
 * 错误约定(供路由与批量导入分支处理):
 *   · throw { code:'BLOCKED' }  —— 豆瓣拒绝访问(提示配 Cookie)
 *   · throw { code:'UPSTREAM' } —— 上游非 200
 *   · fetch 自身超时抛 TimeoutError/AbortError(调用方判 err.name)
 *   · lookupIsbn* 返回 { status } 而不是抛错 —— 批量导入要逐条记账:
 *       { status:'found', book, source } | { status:'not_found' }
 *       | { status:'blocked' } | { status:'error' }
 * ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const { parseSearchPage, parseBookPage, mapToBook } = require('../core/douban');
const { authorKeysFromEdition, mapOpenLibraryBook } = require('../core/openlibrary');
const { isbnKey } = require('../core/isbn');

const { DATA_DIR } = require('../core/paths');
const COOKIE_FILE = path.join(DATA_DIR, 'douban-cookie');
const DOUBAN_SEARCH_URL = 'https://www.douban.com/search?cat=1001&q=';
const DOUBAN_BOOK_URL = 'https://book.douban.com/subject/';
const DOUBAN_ISBN_URL = 'https://book.douban.com/isbn/';
const OPENLIBRARY_URL = 'https://openlibrary.org';
const DOUBAN_SUBJECT_RE = /book\.douban\.com\/subject\/(\d+)/;
const FETCH_TIMEOUT_MS = 15000;

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
  return fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
}

// 检测豆瓣反爬页(与插件同款)
function isProhibited(html) {
  return typeof html === 'string' && html.includes('<title>禁止访问</title>');
}

const blockedError = () => Object.assign(new Error('豆瓣拒绝访问'), { code: 'BLOCKED' });
const upstreamError = (status) => Object.assign(new Error(`豆瓣搜索失败(HTTP ${status})`), { code: 'UPSTREAM' });

/* ---------- 豆瓣:书名 / 任意词搜索(两步:候选页 + 并发详情) ---------- */
// 返回 mapToBook 形状的数组;上游异常抛错(见文件头约定)
async function searchDouban(q) {
  const sResp = await doubanFetch(DOUBAN_SEARCH_URL + encodeURIComponent(q));
  if (!sResp.ok) throw upstreamError(sResp.status);
  const sHtml = await sResp.text();
  if (isProhibited(sHtml)) throw blockedError();

  const candidates = parseSearchPage(sHtml);
  if (!candidates.length) return [];

  // 并发拉详情(上限 5,与插件并发数一致);单个详情失败不拖垮整次搜索
  const details = await Promise.all(
    candidates.slice(0, 5).map(async (c) => {
      try {
        const bResp = await doubanFetch(DOUBAN_BOOK_URL + c.doubanId + '/');
        if (!bResp.ok) return null;
        const html = await bResp.text();
        if (isProhibited(html)) return null;
        const meta = parseBookPage(html, c.doubanId);
        return meta ? mapToBook(meta) : null;
      } catch { return null; }
    })
  );
  return details.filter(Boolean);
}

/* ---------- 豆瓣:按 ISBN 直查 ---------- */
// book.douban.com/isbn/<isbn>/ 会 302 到对应详情页,一步拿到 subject id。
// 找不到时豆瓣跳到搜索/错误页 —— 此时回退到搜索流程,取 ISBN 精确匹配的候选
// (不匹配的候选宁可判 not_found,也不自动建档 —— 元数据张冠李戴比缺数据更糟)
async function lookupIsbnDouban(isbn) {
  const resp = await doubanFetch(DOUBAN_ISBN_URL + encodeURIComponent(isbn) + '/');
  if (!resp.ok) return { status: 'not_found' };
  const html = await resp.text();
  if (isProhibited(html)) return { status: 'blocked' };

  const m = DOUBAN_SUBJECT_RE.exec(String(resp.url || ''));
  if (m) {
    const meta = parseBookPage(html, m[1]);
    if (meta) return { status: 'found', book: mapToBook(meta), source: 'douban' };
  }

  const results = await searchDouban(isbn);
  const exact = results.find((r) => isbnKey(r.isbn) === isbnKey(isbn));
  if (exact) return { status: 'found', book: exact, source: 'douban' };
  // 详情页没给出 ISBN 的候选(老条目偶见):仅当唯一候选时接受
  if (results.length === 1 && !results[0].isbn) {
    return { status: 'found', book: results[0], source: 'douban' };
  }
  return { status: 'not_found' };
}

/* ---------- Open Library(免费,无需 key;豆瓣未命中时的兜底) ---------- */

async function openlibraryJson(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': randomUA(), Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw Object.assign(new Error(`Open Library 请求失败(HTTP ${resp.status})`), { code: 'UPSTREAM' });
  return resp.json();
}

async function lookupIsbnOpenLibrary(isbn) {
  const edition = await openlibraryJson(`${OPENLIBRARY_URL}/isbn/${encodeURIComponent(isbn)}.json`);
  if (!edition) return { status: 'not_found' };

  // 作者名要逐个再取(author 的 name 不在 edition 里);
  // 单个作者取不到不影响整本(名字缺失好过整条失败)
  const authorNames = [];
  for (const key of authorKeysFromEdition(edition)) {
    try {
      const a = await openlibraryJson(OPENLIBRARY_URL + key + '.json');
      if (a && a.name) authorNames.push(String(a.name));
    } catch { /* 忽略单个作者失败 */ }
  }

  // 简介在 work 上;取不到就没有简介(尽力而为)
  let work = null;
  const wkey = edition.works && edition.works[0] && edition.works[0].key;
  if (wkey) {
    try { work = await openlibraryJson(OPENLIBRARY_URL + wkey + '.json'); } catch { work = null; }
  }

  const book = mapOpenLibraryBook({ isbn, edition, authorNames, work });
  if (!book.title) return { status: 'not_found' };
  return { status: 'found', book, source: 'openlibrary' };
}

/* ---------- 组合入口:豆瓣优先,Open Library 兜底 ---------- */
// 批量导入与单本回填都走这里,保证两条链路的取数行为一致
async function lookupIsbn(isbn) {
  let doubanFailure = 'not_found';
  try {
    const r = await lookupIsbnDouban(isbn);
    if (r.status === 'found') return r;
    doubanFailure = r.status; // 'not_found' | 'blocked'
  } catch (err) {
    // 超时/网络异常:不直接放弃,继续问 Open Library
    doubanFailure = err && err.code === 'BLOCKED' ? 'blocked' : 'error';
  }

  try {
    const r = await lookupIsbnOpenLibrary(isbn);
    if (r.status === 'found') return r;
  } catch { /* OL 不可用不改变结论,保留豆瓣侧的原因 */ }

  return { status: doubanFailure };
}

module.exports = {
  DOUBAN_ISBN_URL,
  loadCookie,
  isProhibited,
  doubanFetch,
  searchDouban,
  lookupIsbnDouban,
  lookupIsbnOpenLibrary,
  lookupIsbn,
};
