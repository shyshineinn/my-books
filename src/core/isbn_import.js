/* ============================================================
 * 「按 ISBN 批量添加」编排(纯逻辑,deps 注入,对标 calibre add_isbns)
 *
 * calibre 的流程(gui2/actions/add.py:460 add_isbns):
 *   对话框收行 → 校验/去重(check_isbn)→ 可选查重(check_for_existing_isbns)
 *   → 逐条建档 → 批量下载元数据。本模块是它的 web 版编排:
 *
 *   逐条:校验 → 归一化 → 查重(库内 / 批内)→ 抓元数据 → 建档
 *
 * 为什么 deps 注入而不是直接 require db/http:
 *   ① core 层纪律 —— 不 import 项目内 I/O 模块,可脱离网络与数据库单测;
 *   ② 路由注入真实实现(真库 + 豆瓣),测试注入假实现(记账用),
 *      两条链路共用同一份编排,行为不会漂移。
 *
 * 状态约定(逐条结果):
 *   created    已建档(bookId/title 有效)
 *   duplicate  库中已有同 ISBN(existing={id,title})或本次输入重复(existing=null)
 *   invalid    校验不过(位数/校验位/全同数字)—— 明确报错,不静默丢弃
 *   not_found  两个元数据源都没查到 —— 不建档(本项目书名非空;calibre 允许
 *              空标题占位行,前端改为给「手动录入」入口,不制造垃圾数据)
 *   blocked    豆瓣拒绝访问且 OL 未命中(提示配 Cookie)
 *   error      网络/上游异常,可重试
 * ============================================================ */

const { checkIsbn, normalizeIsbn, isbnKey } = require('./isbn');

// 一次请求上限:再大就不是"个人书库补录"而是批量导入,应分批
const MAX_BATCH = 50;
// 抓取并发(与豆瓣搜索的并发数一致:压住反爬)
const LOOKUP_CONCURRENCY = 3;

const ERROR_TEXT = {
  not_found: '豆瓣与 Open Library 都没有找到这本书的元数据',
  blocked: '豆瓣拒绝访问(配置登录 Cookie 可提高成功率,见 README)',
  error: '查询元数据失败(网络或上游异常),可稍后重试',
};

// 批量输入 → 行数组:每行一个 ISBN;也容忍逗号/分号分隔(从表格/文档里粘来的常见形态)
function parseIsbnInput(input) {
  const raw = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\r\n,;]+/);
  return raw.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
}

// 元数据(源映射形状)→ parseBook 请求体。isbn 用查询值(校验过的裸串)为准 ——
// 条码/手输才是"这本实体书"的事实来源,页面上的 ISBN 字段可能有排版差异
function toBookBody(book, isbn, tags) {
  const identifiers = { isbn };
  if (book.doubanId) identifiers.douban = String(book.doubanId);
  if (book.openlibraryId) identifiers.openlibrary = String(book.openlibraryId);
  return {
    title: book.title || '',
    author: book.author || '',
    summary: book.summary || '',
    cover: book.cover || '',
    publisher: book.publisher || '',
    pub_year: book.pubYear || '',
    isbn,
    rating: book.rating || 0,
    douban_id: book.doubanId || '',
    tags: tags === undefined ? [] : tags,
    status: 'wish',
    identifiers,
  };
}

// 并发受限的 map(简单工作池;JS 单线程下 next++ 无竞态)
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * @param deps { lookupIsbn, isbnIndex, createBook }
 *   lookupIsbn(isbn)       → { status:'found', book } | { status:'not_found'|'blocked'|'error' }
 *   isbnIndex()            → Map(isbnKey → { id, title })(checkExisting 时才调用)
 *   createBook(body)       → 建档后的行(至少含 id / title)
 * @param opts { entries, tags, convertTo13, checkExisting }
 * @returns { results, summary }
 */
async function importIsbns(deps, { entries, tags = [], convertTo13 = false, checkExisting = false } = {}) {
  const inputs = Array.isArray(entries) ? entries : [];
  if (!inputs.length) throw Object.assign(new Error('没有可处理的 ISBN'), { code: 'VALIDATION' });
  if (inputs.length > MAX_BATCH) {
    throw Object.assign(new Error(`一次最多 ${MAX_BATCH} 个 ISBN,请分批添加`), { code: 'VALIDATION' });
  }

  const results = [];
  const seenKeyIndex = new Map(); // isbnKey → 首现结果下标(批内去重)
  const todo = [];

  inputs.forEach((input) => {
    const raw = String(input == null ? '' : input).trim();
    const row = { input: raw, isbn: '', status: '', title: '', bookId: null, existing: null, error: '' };

    const isbn = checkIsbn(raw);
    if (!isbn) {
      row.status = 'invalid';
      row.error = '不是合法的 ISBN(位数或校验位不对)';
      results.push(row);
      return;
    }
    row.isbn = convertTo13 ? normalizeIsbn(isbn) : isbn;

    const key = isbnKey(row.isbn);
    if (seenKeyIndex.has(key)) {
      row.status = 'duplicate';
      row.error = '本次输入中重复,已跳过';
      results.push(row);
      return;
    }
    seenKeyIndex.set(key, results.length);
    results.push(row);
    todo.push({ row, key });
  });

  // 库内查重:一次建索引(calibre 也是整字段读出来比对),不逐条查
  const index = checkExisting ? deps.isbnIndex() : null;
  const pending = [];
  for (const item of todo) {
    const hit = index && index.get(item.key);
    if (hit) {
      item.row.status = 'duplicate';
      item.row.existing = hit;
      item.row.error = '库中已有同 ISBN 的书,已跳过';
      item.row.title = hit.title;
      continue;
    }
    pending.push(item);
  }

  // 抓元数据 + 建档(并发受限;单条失败不拖垮整批)
  await mapLimit(pending, LOOKUP_CONCURRENCY, async (item) => {
    try {
      const r = await deps.lookupIsbn(item.row.isbn);
      if (!r || r.status !== 'found') {
        item.row.status = (r && r.status) || 'error';
        item.row.error = ERROR_TEXT[item.row.status] || ERROR_TEXT.error;
        return;
      }
      const created = deps.createBook(toBookBody(r.book, item.row.isbn, tags));
      item.row.status = 'created';
      item.row.title = created.title;
      item.row.bookId = created.id;
    } catch (err) {
      item.row.status = 'error';
      item.row.error = (err && err.message) || ERROR_TEXT.error;
    }
  });

  const summary = { total: results.length, created: 0, duplicate: 0, invalid: 0, not_found: 0, blocked: 0, error: 0 };
  for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;
  return { results, summary };
}

module.exports = { MAX_BATCH, LOOKUP_CONCURRENCY, ERROR_TEXT, parseIsbnInput, toBookBody, importIsbns };
