/* ============================================================
 * calibre 只读客户端(数据访问层)
 *
 * 为什么走 HTTP 而不是直连 metadata.db:
 *   1) calibre 的 schema 依赖它用 apsw 注册的 Python 函数(title_sort / uuid4 /
 *      books_list_filter / collation PYNOCASE、icucollate —— 见 calibre
 *      db/backend.py:424-432)。读它的**视图**(如 tag_browser_ratings,schema 里
 *      带 books_list_filter(book))会直接报 no such function。
 *   2) calibre 用的不是 WAL,且它自己靠 busy_timeout 串行化;走 HTTP 由它自己
 *      管理连接,我们完全不碰它的锁与 schema。
 *   3) 走 HTTP 免疫 calibre 升级导致的 schema 变化。
 *
 * 用的是 /ajax/* 这套**对外**接口(相对稳定);
 * 刻意不用 /interface-data/*(那是 calibre 自家前端的内部 API,随版本变)。
 *
 * 认证:calibre 侧不开 --enable-auth(开了连封面都要登录,公开站点会废)。
 * 写操作靠 --trusted-ips 让 Node 的 127.0.0.1 成为可信来源。
 *
 * 依赖方向纪律:只 import node: 内置,不 import express。
 * ============================================================ */

const BASE = (process.env.CALIBRE_URL || 'http://127.0.0.1:3003/calibre').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.CALIBRE_TIMEOUT_MS || 10000);
// 生成封面/转换大书会慢,单独给长超时
const SLOW_TIMEOUT_MS = Number(process.env.CALIBRE_SLOW_TIMEOUT_MS || 60000);

class CalibreError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'CalibreError';
    this.status = status;
    this.url = url;
  }
}

/* 底层请求:带超时、错误归一化。
   返回 { status, headers, body(Buffer) };不抛 4xx/5xx,由调用方决定语义。 */
async function request(pathname, { timeout = TIMEOUT_MS, ...init } = {}) {
  const url = BASE + pathname;
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    // 连接失败 / 超时:统一成 CalibreError,让上层能区分"calibre 挂了"
    const reason = err.name === 'TimeoutError' ? '请求超时' : '无法连接';
    throw new CalibreError(`${reason}: ${url} (${err.message})`, 0, url);
  }
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body, url };
}

/* 取 JSON。calibre 出错时返回 HTML 错误页,这里给出可诊断的报错。 */
async function getJson(pathname, opts) {
  const { status, body, url } = await request(pathname, opts);
  if (status !== 200) {
    const peek = body.toString('utf8').slice(0, 200);
    throw new CalibreError(`calibre 返回 ${status}: ${peek}`, status, url);
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new CalibreError(`calibre 返回的不是 JSON: ${body.toString('utf8').slice(0, 200)}`, status, url);
  }
}

/* ---------- 库信息 ---------- */
// → { library_map: {id: name}, default_library: id }
function libraryInfo() {
  return getJson('/ajax/library-info');
}

/* ---------- 搜索 ----------
   calibre 的 /ajax/search **只返回 book_ids**(见 calibre srv/ajax.py:555-567),
   要拿元数据必须再调 /ajax/books —— 列表页本来就是两次往返。 */
function search({ query = '', num = 50, offset = 0, sort = 'title', sortOrder = 'asc', libraryId = '' } = {}) {
  const qs = new URLSearchParams({
    query: String(query),
    num: String(num),
    offset: String(offset),
    sort: String(sort),
    sort_order: sortOrder,
  });
  if (libraryId) qs.set('library_id', libraryId);
  return getJson(`/ajax/search?${qs}`);
}

/* ---------- 批量元数据 ----------
   ids: 'all' 或逗号分隔的数字 id。calibre 对 /ajax/books 不分页(ajax.py:201),
   大库请先用 search 分页拿到 id 再传进来。 */
function booksByIds(ids, { libraryId = '', idIsUuid = false, categoryUrls = false } = {}) {
  const qs = new URLSearchParams({
    ids: Array.isArray(ids) ? ids.join(',') : String(ids),
    category_urls: categoryUrls ? 'true' : 'false',
    id_is_uuid: idIsUuid ? 'true' : 'false',
  });
  if (libraryId) qs.set('library_id', libraryId);
  return getJson(`/ajax/books?${qs}`);
}

/* ---------- 单本(支持 uuid 查询) ---------- */
function book(bookId, { libraryId = '', idIsUuid = false } = {}) {
  const qs = new URLSearchParams({ id_is_uuid: idIsUuid ? 'true' : 'false' });
  if (libraryId) qs.set('library_id', libraryId);
  return getJson(`/ajax/book/${encodeURIComponent(bookId)}?${qs}`);
}

/* ---------- 分类(标签树) ---------- */
function categories(libraryId = '') {
  const p = libraryId ? `/${encodeURIComponent(libraryId)}` : '';
  return getJson(`/ajax/categories${p}`);
}

/* ---------- 某分类下的书(只返回 book_ids) ---------- */
function booksIn(encodedCategory, encodedItem, { num = 100, offset = 0, sort = 'title', sortOrder = 'asc', libraryId = '' } = {}) {
  const qs = new URLSearchParams({
    num: String(num),
    offset: String(offset),
    sort: String(sort),
    sort_order: sortOrder,
  });
  if (libraryId) qs.set('library_id', libraryId);
  return getJson(`/ajax/books_in/${encodedCategory}/${encodedItem}?${qs}`);
}

/* ---------- 全文检索(calibre 的 FTS5,中文分词一般) ---------- */
function ftsSearch(query, { libraryId = '' } = {}) {
  const qs = new URLSearchParams({ query: String(query), use_stemming: 'y' });
  if (libraryId) qs.set('library_id', libraryId);
  return getJson(`/fts/search?${qs}`);
}

/* ---------- 图片与文件(流式转发,不落盘) ---------- */
// 封面:what = 'cover' | 'thumb';thumb 可带 sz(如 '300x400' 或 'full')
async function cover(bookId, { what = 'cover', size = '', libraryId = '' } = {}) {
  const qs = new URLSearchParams();
  if (size) qs.set('sz', size);
  if (libraryId) qs.set('library_id', libraryId);
  const p = `/get/${what}/${encodeURIComponent(bookId)}${qs.toString() ? '?' + qs : ''}`;
  return request(p, { timeout: SLOW_TIMEOUT_MS });
}

// 电子书正文:fmt = EPUB / PDF / MOBI ...
async function bookFile(bookId, fmt, { libraryId = '' } = {}) {
  const qs = new URLSearchParams();
  if (libraryId) qs.set('library_id', libraryId);
  const p = `/get/${encodeURIComponent(fmt)}/${encodeURIComponent(bookId)}${qs.toString() ? '?' + qs : ''}`;
  return request(p, { timeout: SLOW_TIMEOUT_MS });
}

/* ---------- 归一化:calibre 书对象 → 前端形状 ----------
   calibre 的 /ajax/books 返回 { book_id: {...} } 这种以 id 为键的字典。
   这里转成数组,并把字段名收敛到前端习惯的形态。
   注意:只做形状适配,**不丢字段** —— 前端要什么自己取。 */
function normalizeBook(id, raw) {
  if (!raw) return null;
  const fm = raw.format_metadata || {};
  return {
    // 稳定主键:阅读记录靠它关联
    uuid: raw.uuid || null,
    // calibre 内部 id:取封面/正文要用
    id: Number(id),
    title: raw.title || '未知书名',
    // calibre 的 authors 是数组;前端多数场景要单串,同时保留原数组
    authors: Array.isArray(raw.authors) ? raw.authors : (raw.authors ? [raw.authors] : []),
    author: Array.isArray(raw.authors) ? raw.authors.join(' & ') : (raw.authors || ''),
    author_sort: raw.author_sort || '',
    title_sort: raw.title_sort || raw.sort || '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    series: raw.series || '',
    series_index: raw.series_index ?? null,
    publisher: raw.publisher || '',
    // calibre 的 comments 是 HTML
    comments: raw.comments || '',
    languages: Array.isArray(raw.languages) ? raw.languages : [],
    identifiers: raw.identifiers || {},
    isbn: (raw.identifiers && raw.identifiers.isbn) || '',
    pubdate: raw.pubdate && raw.pubdate !== 'None' ? raw.pubdate : '',
    timestamp: raw.timestamp && raw.timestamp !== 'None' ? raw.timestamp : '',
    last_modified: raw.last_modified && raw.last_modified !== 'None' ? raw.last_modified : '',
    // 注意:calibre 的 /ajax/book 默认把 rating 除以 2(ajax.py:62-65),
    // 即 HTTP 层看到的是 0~5。这里原样透出,不做二次换算。
    rating: typeof raw.rating === 'number' ? raw.rating : 0,
    formats: Array.isArray(raw.formats) ? raw.formats : [],
    format_sizes: fm,
    // 封面 URL 由 Node 代理,前端不直连 calibre(同源 + 统一入口)
    cover_url: `/api/calibre/cover/${id}`,
    thumb_url: `/api/calibre/thumb/${id}?sz=300x400`,
  };
}

// /ajax/books 的字典 → 归一化数组(按传入 ids 顺序)
function normalizeBooks(dict, ids) {
  const order = ids && ids !== 'all' ? String(ids).split(',') : Object.keys(dict || {});
  return order
    .map((id) => normalizeBook(id, dict[id]))
    .filter(Boolean);
}

module.exports = {
  BASE,
  CalibreError,
  request,
  getJson,
  libraryInfo,
  search,
  booksByIds,
  book,
  categories,
  booksIn,
  ftsSearch,
  cover,
  bookFile,
  normalizeBook,
  normalizeBooks,
};
