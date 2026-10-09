/* ============================================================
 * calibre 转发路由(Node 作为唯一出口)
 *
 * 为什么由 Node 转发而不是前端直连 calibre:
 *   1) calibre 没有任何 CORS 头(在 calibre src/calibre/srv/ 全目录搜
 *      Access-Control-Allow-Origin 与 cors 均零命中),前端跨端口 fetch 会被浏览器拦。
 *      必须同源,而 calibre 自己占着 /,所以只能反代。
 *   2) 前端只认 /api/* 一套契约,不必了解 calibre 的 /ajax/* 细节。
 *   3) 双数据库的 join 在这里做:元数据来自 calibre,阅读状态来自 reading 表。
 *
 *   GET /api/calibre/library            库信息
 *   GET /api/calibre/books              书单(元数据 + 阅读状态,已 join)
 *   GET /api/calibre/books/:uuid        单本(按 uuid 取,含阅读状态)
 *   GET /api/calibre/cover/:id          封面(流式转发)
 *   GET /api/calibre/thumb/:id          缩略图(流式转发)
 *   GET /api/calibre/file/:id/:fmt      电子书正文(流式转发)
 *   GET /api/calibre/tags               标签树
 *   GET /api/calibre/search             全文检索(calibre FTS + 阅读状态)
 *   GET /api/calibre/stats              合并统计(阅读状态 + calibre 标签分布)
 * ============================================================ */

const express = require('express');
const { Readable } = require('node:stream');

const calibre = require('../db/calibre');
const readingDb = require('../db/reading');
const { readingToJson, STATUSES } = require('../core/reading');
const { computeReadingStats, topTags } = require('../core/stats');

const router = express.Router();

/* calibre 挂了 / 超时:回 502 而不是 500 —— 让前端能区分"后端不可用" */
function calibreFailure(res, err) {
  if (err instanceof calibre.CalibreError) {
    const status = err.status === 0 ? 502 : err.status;
    return res.status(status).json({
      error: `calibre 后端不可用:${err.message}`,
      code: 'CALIBRE_UNAVAILABLE',
    });
  }
  throw err;
}

/* 把 calibre 的响应流式转发给浏览器(封面/正文可能几 MB,不整份读进内存)。
   原样透传 Content-Type 与缓存头。 */
async function pipeResponse(res, upstream) {
  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'etag', 'last-modified', 'cache-control', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (upstream.status !== 200) {
    return res.end(upstream.body);
  }
  Readable.from(upstream.body).pipe(res);
}

/* 阅读状态 map:uuid → 记录,缺失的补默认「想读」 */
function readingMapFor(uuids) {
  const rows = readingDb.getReadings(uuids);
  const out = new Map();
  for (const uuid of uuids) {
    const row = rows.get(uuid);
    out.set(uuid, row
      ? { ...readingToJson(row), is_default: false }
      : {
          calibre_uuid: uuid, status: 'wish', read_count: 0, read_logs: [],
          start_date: '', finish_date: '', notes_url: '',
          created_at: null, updated_at: null, is_default: true,
        });
  }
  return out;
}

/* ---------- 库信息 ---------- */
router.get('/api/calibre/library', async (req, res) => {
  try {
    res.json(await calibre.libraryInfo());
  } catch (err) { calibreFailure(res, err); }
});

/* ---------- 书单(双库 join 的核心) ----------
   流程:calibre search 拿 id → calibre books 拿元数据 → reading 表补状态。
   这就是 calibre 两次往返的代价(它的 /ajax/search 只返回 book_ids)。 */
router.get('/api/calibre/books', async (req, res) => {
  const {
    q = '', status = '', sort = 'title', sort_order = 'asc',
    num = '50', offset = '0', library_id = '',
  } = req.query;

  try {
    const n = Math.min(Math.max(parseInt(num, 10) || 50, 1), 500);
    const off = Math.max(parseInt(offset, 10) || 0, 0);

    const sr = await calibre.search({
      query: String(q), num: n, offset: off,
      sort: String(sort), sortOrder: String(sort_order), libraryId: String(library_id),
    });

    const ids = sr.book_ids || [];
    if (!ids.length) {
      return res.json({ total: sr.total_num ?? 0, offset: off, num: 0, books: [], search: sr });
    }

    const dict = await calibre.booksByIds(ids, { libraryId: String(library_id) });
    let books = calibre.normalizeBooks(dict, ids);

    // join 阅读状态
    const rmap = readingMapFor(books.map((b) => b.uuid).filter(Boolean));
    books = books.map((b) => ({ ...b, reading: rmap.get(b.uuid) || null }));

    // status 过滤在 Node 侧做 —— calibre 不认识 status 这个概念
    if (status && STATUSES.includes(String(status))) {
      books = books.filter((b) => b.reading && b.reading.status === status);
    }

    res.json({
      total: sr.total_num ?? books.length,
      offset: off,
      num: books.length,
      books,
      search: { sort: sr.sort, sort_order: sr.sort_order, query: sr.query, library_id: sr.library_id },
    });
  } catch (err) { calibreFailure(res, err); }
});

/* ---------- 单本:按 uuid 取(阅读记录的关联键) ----------
   注意:这里刻意**不用** /ajax/book/{uuid}。calibre 的 book_to_json 会把
   db_id 从响应里 pop 掉(见其 srv/ajax.py:67),拿不到数字 id,而封面/正文
   URL 需要数字 id。改用 /ajax/books?ids=<uuid>&id_is_uuid=true —— 它返回
   {数字id: {...}} 这种以数字 id 为键的字典(ajax.py:205 的 lookup_by_uuid),
   一次同时拿到数字 id 与元数据。 */
router.get('/api/calibre/books/:uuid', async (req, res) => {
  const uuid = String(req.params.uuid || '').trim();
  try {
    const dict = await calibre.booksByIds(uuid, {
      idIsUuid: true,
      libraryId: String(req.query.library_id || ''),
    });
    const ids = Object.keys(dict || {});
    if (!ids.length) return res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });

    const b = calibre.normalizeBook(ids[0], dict[ids[0]]);
    if (!b) return res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });
    // 用请求里的 uuid 兜底:万一 calibre 未回传 uuid 字段
    if (!b.uuid) b.uuid = uuid;
    const rmap = readingMapFor([b.uuid]);
    res.json({ book: { ...b, reading: rmap.get(b.uuid) || null } });
  } catch (err) { calibreFailure(res, err); }
});

/* ---------- 图片与文件:流式转发 ---------- */
router.get('/api/calibre/cover/:id', async (req, res) => {
  try {
    pipeResponse(res, await calibre.cover(req.params.id, {
      what: 'cover', size: String(req.query.sz || ''), libraryId: String(req.query.library_id || ''),
    }));
  } catch (err) { calibreFailure(res, err); }
});

router.get('/api/calibre/thumb/:id', async (req, res) => {
  try {
    pipeResponse(res, await calibre.cover(req.params.id, {
      what: 'thumb', size: String(req.query.sz || '300x400'), libraryId: String(req.query.library_id || ''),
    }));
  } catch (err) { calibreFailure(res, err); }
});

router.get('/api/calibre/file/:id/:fmt', async (req, res) => {
  try {
    pipeResponse(res, await calibre.bookFile(req.params.id, req.params.fmt, {
      libraryId: String(req.query.library_id || ''),
    }));
  } catch (err) { calibreFailure(res, err); }
});

/* ---------- 标签树 ---------- */
router.get('/api/calibre/tags', async (req, res) => {
  try {
    res.json(await calibre.categories(String(req.query.library_id || '')));
  } catch (err) { calibreFailure(res, err); }
});

/* ---------- 全文检索(calibre FTS + 阅读状态) ---------- */
router.get('/api/calibre/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '缺少检索词 q', code: 'VALIDATION' });
  try {
    const sr = await calibre.ftsSearch(q, { libraryId: String(req.query.library_id || '') });
    const ids = Object.keys(sr.metadata || {});
    const rmap = readingMapFor(ids.map((id) => (sr.metadata[id] || {}).uuid).filter(Boolean));
    const results = ids.map((id) => {
      const m = sr.metadata[id] || {};
      const hit = (sr.results || []).find((x) => String(x.book_id) === String(id)) || {};
      return {
        id: Number(id),
        uuid: m.uuid || null,
        title: m.title || '',
        authors: m.authors || '',
        snippet: hit.text || '',
        reading: rmap.get(m.uuid) || null,
      };
    });
    res.json({ query: q, indexing_status: sr.indexing_status || null, results });
  } catch (err) { calibreFailure(res, err); }
});

/* ---------- 合并统计:阅读状态(本地)+ 标签分布(calibre) ----------
   标签分布需要扫全库元数据:个人库量级小,一次 ids=all 可以接受;
   库很大时这里应改为定时任务预聚合,而不是每次请求都扫。 */
router.get('/api/calibre/stats', async (req, res) => {
  try {
    const local = computeReadingStats(readingDb.allReadings());

    let tags = [];
    let formats = {};
    let totalBooks = local.total;
    if (req.query.with_tags !== 'false') {
      const dict = await calibre.booksByIds('all', { libraryId: String(req.query.library_id || '') });
      const books = calibre.normalizeBooks(dict, 'all');
      totalBooks = books.length;
      tags = topTags(books.map((b) => b.tags), 12);
      for (const b of books) {
        for (const f of b.formats) formats[f] = (formats[f] || 0) + 1;
      }
    }

    res.json({
      // total = calibre 里的总藏书;recorded = 已有阅读记录的书
      total: totalBooks,
      recorded: local.total,
      byStatus: local.byStatus,
      byYear: local.byYear,
      rereads: local.rereads,
      topTags: tags,
      byFormat: formats,
    });
  } catch (err) { calibreFailure(res, err); }
});

module.exports = router;
