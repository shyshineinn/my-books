/* ============================================================
 * CSV 导入的数据访问层
 *
 * 提供 core/import.js 需要的三个入口(全部走已有的事务/同步路径):
 *   listExisting()         查重索引的原料
 *   createBook(body, custom) 建新书 —— 走 books.addBook,自动同步
 *                            tags/authors/identifiers/FTS
 *   mergeBook(id, ...)     合并进已有记录 —— 走 books.enrichBook 的字段并集语义
 *
 * 为什么 mergeBook 复用 enrichBook 而不是另写一份:
 *   "把导入的字段并进已有记录"与"把数据源的字段补进已有记录"是**同一个操作**,
 *   区别只在字段来源(CSV vs 豆瓣)。收敛到一条路径,才不会出现
 *   "导入合并会清标签、补全合并不会"这种两条实现漂移出来的怪行为。
 *   代价是导入合并不能覆盖"标签"(enrichBook 是并集语义)——
 *   但那正是我们想要的:导入不该删掉你已有的标签。
 *
 * 依赖方向纪律:与 db/search.js 同构 —— db 句柄由调用方传入
 * (默认用单例),测试可完全隔离。
 * ============================================================ */

const { db, now, inTransaction } = require('./index');
const books = require('./books');
const identifiersRepo = require('./identifiers');
const categories = require('./categories');
const search = require('./search');
const customFields = require('./custom_fields');
const { parseBook, mergeUpdate } = require('../core/book');
const { isbnKey } = require('../core/isbn');
const { parseCsv } = require('../core/csv');
const { mapHeaders } = require('../core/import');

// 查重索引的原料:在架书的精简行。
// 不排序、不筛选 —— 导入要看到全库,虚拟书库不该影响查重
// (否则"在某个书库里导入"会重复建书)。
function listExisting(handleDb = db) {
  return handleDb.prepare(`
    SELECT id, title, author, isbn, series
    FROM books
    WHERE deleted_at IS NULL
  `).all();
}

// 为了让 ISBN 查重跨越"专用列 + 标识符表"两个来源,
// isbnOf 用与「按 ISBN 添加」完全同一套归一化(listIsbnIndex 的键)。
// 这里返回的是**归一化后的 key**,与 core/import.js 的 byIsbn 键一致。
function makeIsbnOf(handleDb = db) {
  const idx = identifiersRepo.listIsbnIndex(handleDb);
  // 反查:book id → isbnKey
  const byId = new Map();
  for (const [key, val] of idx) {
    if (!byId.has(val.id)) byId.set(val.id, key);
  }
  return (row) => byId.get(row.id) || isbnKey(row.isbn || '');
}

// 建新书:body 来自 CSV 行,先过 core/parseBook 统一校验与推导
// (阅读记录是唯一日期来源等规则也一并生效)。
function createBook(body, customValues = null, handleDb = db) {
  const { errors, values } = parseBook(body);
  if (errors.length) {
    throw Object.assign(new Error(errors.join(';')), { code: 'VALIDATION' });
  }
  // parseBook 已经把 tags 序列化成 JSON 存在 values.tags 里,
  // 所以不需要单独传 tags;identifiers 则被 parseBook 放在 values.identifiers,
  // 由 books.addBook 内部处理 —— 这里不用再剔出来手动写一次
  // (早期版本剔了又写,会因为 idMap 为空而漏写,已修)。
  return books.addBook(values, customValues, handleDb);
}

/**
 * 合并进已有记录。
 * 语义 = enrich 的字段并集(只补空 / overwrite 时覆盖),**不动 title/author**
 * (导入时目标书的身份应当保留,这与 calibre 合并记录"目标优先"同思路)。
 *
 * @returns 更新后的行 | null(目标不存在)
 */
function mergeBook(bookId, body, customValues = null, { overwrite = false } = {}, handleDb = db) {
  const existing = books.getBook(bookId, handleDb);
  if (!existing) return null;

  // 只挑 enrich 认识的字段做合并;其余(status/read_logs 等)不碰 ——
  // 导入一条 CSV 不该把已有书的阅读记录改掉。
  const patch = {};
  const picks = ['summary', 'publisher', 'pub_year', 'rating', 'cover'];
  for (const f of picks) {
    const raw = body[f];
    if (raw === undefined || raw === null) continue;
    const str = typeof raw === 'number' ? String(raw) : String(raw).trim();
    if (str === '') continue;
    if (f === 'rating') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) continue;
      patch.rating = n;
    } else {
      patch[f] = str;
    }
  }

  // 标签:并集(导入永远不删你已有标签)
  const incTags = Array.isArray(body.tags) ? body.tags : [];
  if (incTags.length) patch.tags_add = incTags;

  // 标识符:只补缺的类型
  if (body.identifiers && typeof body.identifiers === 'object') {
    patch.identifiers = body.identifiers;
  } else {
    const ids = {};
    if (body.isbn) ids.isbn = String(body.isbn).trim();
    if (body.douban_id) ids.douban = String(body.douban_id).trim();
    if (Object.keys(ids).length) patch.identifiers = ids;
  }

  // series / series_index 不在 enrich 白名单里(单本补全用不到),
  // 但**导入**要能带进来 —— 追加进 patch,由 enrichBook 的列白名单决定是否生效。
  // 注意 enrichBook 的 ENRICH_COLUMNS 不含 series,所以这里需要单独更新。
  const seriesPatch = {};
  if (String(body.series || '').trim()) seriesPatch.series = String(body.series).trim().slice(0, 200);
  if (body.series_index !== undefined && body.series_index !== '') {
    const n = Number(body.series_index);
    if (Number.isFinite(n) && n >= 0) seriesPatch.series_index = Math.min(9999, Math.round(n * 10) / 10);
  }

  return inTransaction(handleDb, () => {
    // 已存在字段在 overwrite=false 时跳过(与 enrich 的"只补空"一致)
    const filtered = { ...patch };
    if (!overwrite) {
      for (const f of picks) {
        const has = f === 'rating' ? Number(existing[f]) > 0 : String(existing[f] || '').trim() !== '';
        if (has) delete filtered[f];
      }
    }
    const updated = books.enrichBook(handleDb, bookId, filtered);
    if (!updated) return null;

    // series 单独一条(不在 ENRICH_COLUMNS 里),同样遵守"只补空"
    if (Object.keys(seriesPatch).length) {
      const hasSeries = String(existing.series || '').trim() !== '';
      if (!hasSeries || overwrite) {
        handleDb.prepare('UPDATE books SET series = ?, series_index = ?, updated_at = ? WHERE id = ?')
          .run(seriesPatch.series ?? existing.series,
            seriesPatch.series_index ?? existing.series_index,
            now(), bookId);
      }
    }

    // 自定义字段:同 enrich 的"只补空"
    if (customValues && Object.keys(customValues).length) {
      const cols = customFields.listColumns(handleDb);
      const cur = customFields.getRawValues(handleDb, bookId, { columns: cols });
      const toSet = {};
      for (const [label, val] of Object.entries(customValues)) {
        if (!overwrite && String(cur[label] == null ? '' : cur[label]).trim() !== '') continue;
        toSet[label] = val;
      }
      if (Object.keys(toSet).length) customFields.setValues(handleDb, bookId, toSet);
    }

    return books.getBook(bookId, handleDb);
  });
}

// 只解析表头(不动库)。路由层要用它在**写库之前**校验 CSV 的结构:
// 列名是否认识、#自定义字段是否存在。比"先写几行再报错"安全得多。
function parseHeaders(text) {
  const { headers } = parseCsv(text);
  return mapHeaders(headers);
}

module.exports = { listExisting, makeIsbnOf, createBook, mergeBook, parseHeaders };
