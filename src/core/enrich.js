/* ============================================================
 * 批量补全元数据与封面(纯规则 + deps 注入编排)
 * 对标 calibre:
 *   · gui2/metadata/bulk_download.py   —— 下载编排(分批 / 失败集合 / 结果清单)
 *   · gui2/actions/edit_metadata.py    —— apply_mi / apply_metadata_changes
 *     (null = 不改、set_title/set_authors 独立开关、identifiers 合并、tags 并集)
 *
 * 与「按 ISBN 批量添加」的区别(两者容易混,先分清):
 *   · from-isbn  —— 库里**没有**这本书,靠 ISBN 建**新**记录
 *   · enrich     —— 库里**已有**这本书,靠 ISBN/书名给它**补**字段
 * 所以 enrich 不建档、不删除,只对已存在的行做字段级更新。
 *
 * 三个从 calibre 抄来的关键设计(不是我想当然定的):
 *
 * 1. **null = 不改**。calibre apply_metadata_changes 的文档串原话:
 *    "Set any fields you do not want updated in the Metadata object to null."
 *    本项目的等价物是"patch 里没出现的键就不改" —— 语义同构。
 *
 * 2. **title / authors 走独立开关,不在通用字段里**。calibre 用
 *    `set_title = not mi.is_null('title')` / `set_authors = ...` 单独控制
 *    (edit_metadata.py:897-898),因为它们是书的身份。
 *    本项目的 enrich **永不**改这两项:批量补全里改书名/作者等于换了一本书。
 *
 * 3. **tags 并集、identifiers 合并**。calibre: 先 `tags = old + mi.tags;
 *    list(set(tags))`(:906-909),再 `idents.update(mi.identifiers)`(:899-902)。
 *    本项目照抄并集语义,但 identifiers 反过来"已有值优先" ——
 *    手工填的 ISBN 不该被批量操作改掉(与"只补空"同一原则)。
 *
 * 取数顺序(每本独立判断):
 *   1. 该书有 ISBN          → lookupIsbn(isbn)    最准
 *   2. 没有 ISBN 但有书名   → searchByName(title) 次之(必须做标题精确比对)
 *   3. 都没有               → 跳过,记 skipped
 *
 * 状态约定(与 core/isbn_import.js 同构,便于前端复用同一套结果清单):
 *   updated   成功写入至少一个字段(updatedFields 列出改了哪些)
 *   unchanged 查到了但目标字段都已有值,无可补
 *   skipped   既无 ISBN 也无书名,无从查起
 *   not_found 数据源没查到
 *   blocked   豆瓣拒绝访问
 *   error     网络/上游异常
 * ============================================================ */

const { checkIsbn } = require('./isbn');

// 一次请求上限:批量补全是"手动勾选一批书",不是全库重建。
// calibre 的 split_jobs 默认 batch_size=100(bulk_download.py:121),
// 这里取同一个数 —— 超过就让前端分批,而不是默默截断。
const MAX_BATCH = 100;

// 抓取并发:豆瓣反爬严格,压到 3(与 core/isbn_import.js 一致)。
// 注意 calibre 是**分批串行**(batch_size=10 一批、每批一次 fork_job,
// bulk_download.py:224-269),因为它的瓶颈是进程开销;
// 本项目在同一进程内做 HTTP 抓取,用并发池,但把并发压到 3 对齐豆瓣承受度。
const LOOKUP_CONCURRENCY = 3;

// 可补字段白名单。**只放数据源真的会返回的字段** ——
// 列一个永远为空的字段(如 series)只会让 updatedFields 出现它、
// 让用户以为补到了。豆瓣与 Open Library 的映射都不产出 series,
// 故不列(2026-10-20 核实 core/douban.js:168 / core/openlibrary.js:84)。
// **title / author 不在其中**,见文件头第 2 条。
const ENRICH_FIELDS = ['summary', 'cover', 'publisher', 'pub_year', 'rating'];

// 可补的标识符类型(与 core/identifiers.js 的常用类型对齐)
const ENRICH_IDENTIFIERS = ['isbn', 'douban', 'openlibrary'];

const ERROR_TEXT = {
  not_found: '数据源没有找到这本书',
  blocked: '豆瓣拒绝访问(配置登录 Cookie 可提高成功率,见 README)',
  error: '查询元数据失败(网络或上游异常),可稍后重试',
  skipped: '这本书既没有 ISBN 也没有书名,无从查询',
};

// 判空:undefined / null / 空串 / 纯空白 都算空。
// rating 的 0 是"未评分",也算空 —— 否则永远补不上评分。
function isEmpty(field, value) {
  if (value === undefined || value === null) return true;
  if (field === 'rating') {
    const n = Number(value);
    return !Number.isFinite(n) || n <= 0;
  }
  return String(value).trim() === '';
}

function parseTags(raw) {
  let arr;
  try { arr = JSON.parse(raw || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return arr.map((t) => String(t).trim()).filter(Boolean);
}

/**
 * 计算"要把哪些字段写进目标书"。
 * 与 calibre apply_mi 同构:已有值不动、tags 并集、identifiers 合并。
 * @param current 库里现有行
 * @param incoming 数据源返回的字段
 * @param opts { overwrite, fields, currentIdentifiers }
 * @returns { patch, filled[], skippedExisting[] }
 */
function buildPatch(current, incoming, { overwrite = false, fields = null, currentIdentifiers = null } = {}) {
  const want = Array.isArray(fields) && fields.length
    ? fields.filter((f) => ENRICH_FIELDS.includes(f))
    : ENRICH_FIELDS;
  const patch = {};
  const filled = [];
  const skippedExisting = [];

  for (const f of want) {
    const next = incoming[f];
    if (next === undefined || next === null) continue;
    if (f === 'rating') {
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) continue;
    } else if (String(next).trim() === '') {
      continue;                                   // 数据源没给这个字段
    }

    const has = !isEmpty(f, current[f]);
    if (has && !overwrite) { skippedExisting.push(f); continue; }

    patch[f] = f === 'rating' ? Number(next) : String(next).trim();
    filled.push(f);
  }

  // tags:并集,永不清空/覆盖(calibre edit_metadata.py:906-909 同款)
  const incTags = Array.isArray(incoming.tags) ? incoming.tags : [];
  if (incTags.length) {
    const cur = new Set(parseTags(current.tags).map((t) => t.toLowerCase()));
    const add = [];
    for (const t of incTags) {
      const name = String(t == null ? '' : t).trim();
      if (!name || cur.has(name.toLowerCase())) continue;
      cur.add(name.toLowerCase());
      add.push(name);
    }
    if (add.length) {
      patch.tags_add = add;
      filled.push('tags');
    }
  }

  // identifiers:只补当前缺的类型(calibre 是 update 让新值优先,这里反过来)
  const incIds = incoming.identifiers && typeof incoming.identifiers === 'object' ? incoming.identifiers : {};
  const haveIds = currentIdentifiers && typeof currentIdentifiers === 'object' ? currentIdentifiers : null;
  const idsPatch = {};
  for (const type of ENRICH_IDENTIFIERS) {
    const val = String(incIds[type] == null ? '' : incIds[type]).trim();
    if (!val) continue;
    const existing = haveIds
      ? String(haveIds[type] == null ? '' : haveIds[type]).trim()
      // 没有标识符表时退回行上的专用列(isbn / douban_id)
      : String((type === 'douban' ? current.douban_id : current[type]) || '').trim();
    if (existing && !overwrite) continue;          // 已有 → 不覆盖
    idsPatch[type] = val;
  }
  if (Object.keys(idsPatch).length) {
    patch.identifiers = idsPatch;
    if (!filled.includes('identifiers')) filled.push('identifiers');
  }

  return { patch, filled, skippedExisting };
}

// 数据源结果(mapToBook 形状)→ buildPatch 的 incoming 形状。
// 与 core/isbn_import.js 的 toBookBody 是**两种用途**:那边造新书(要 status/tags),
// 这边补旧书(只挑能补的字段),故不共用 —— 共用会逼出很多 if 分支。
function toIncoming(book) {
  if (!book) return {};
  const identifiers = {};
  if (book.isbn) identifiers.isbn = String(book.isbn).trim();
  if (book.doubanId) identifiers.douban = String(book.doubanId).trim();
  if (book.openlibraryId) identifiers.openlibrary = String(book.openlibraryId).trim();
  return {
    summary: book.summary || '',
    cover: book.cover || '',
    publisher: book.publisher || '',
    pub_year: book.pubYear || '',
    rating: book.rating || 0,
    tags: Array.isArray(book.tags) ? book.tags : [],
    identifiers,
  };
}

// 并发受限的 map(与 core/isbn_import.js 同款;两处各自保留是因为
// 抽成共享工具只为 8 行服务,反而多一层间接)
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
 * 批量补全编排。
 * @param deps {
 *   getBook(id)                → 行 | null(不存在/回收站返回 null)
 *   getIsbn?(id)               → 标识符表里的 isbn(行上没有时兜底)
 *   getIdentifiers?(id)        → { type: value }(标识符并集用)
 *   lookupIsbn(isbn)           → { status:'found', book, source } | { status:'not_found'|'blocked'|'error' }
 *   searchByName(title, author)→ 同上
 *   updateBook(id, patch)      → 更新后的行 | null
 *   saveCover?(id, url)        → 可选:把外链封面落盘,返回 /uploads/xxx | null
 * }
 * @param opts { ids, overwrite, fields }
 * @returns { results, summary }
 */
async function enrichBooks(deps, { ids, overwrite = false, fields = null } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) throw Object.assign(new Error('请至少选择一本书'), { code: 'VALIDATION' });
  if (list.length > MAX_BATCH) {
    throw Object.assign(new Error(`一次最多补全 ${MAX_BATCH} 本,请分批操作`), { code: 'VALIDATION' });
  }

  const results = list.map((id) => ({
    id, title: '', status: '', source: '', updatedFields: [], error: '',
    // 封面单独记成败:calibre 维护 failed_ids 与 failed_covers 两个集合
    // (bulk_download.py:229-230),因为"元数据拿到了但封面下载失败"是常见情形,
    // 混成一个失败集合会让用户以为整个补全失败了。
    coverStatus: '', coverError: '',
  }));

  await mapLimit(results, LOOKUP_CONCURRENCY, async (row) => {
    try {
      const current = deps.getBook(row.id);
      if (!current) {
        row.status = 'error';
        row.error = '书籍不存在或已在回收站';
        return;
      }
      row.title = current.title || '';

      // ISBN 有两个来源:行上的列 + 标识符表。标识符表更新,优先用它
      // (db/identifiers.js 的"表为准、旧列兜底"在这里同样适用)。
      const isbnRaw = (deps.getIsbn && deps.getIsbn(row.id)) || current.isbn || '';
      const isbn = checkIsbn(isbnRaw);

      let found = null;
      if (isbn) {
        const r = await deps.lookupIsbn(isbn);
        if (r && r.status === 'found') found = r;
        else {
          row.status = (r && r.status) || 'error';
          row.error = ERROR_TEXT[row.status] || ERROR_TEXT.error;
          return;
        }
      } else if (String(current.title || '').trim()) {
        const r = await deps.searchByName(current.title, current.author);
        if (r && r.status === 'found') found = r;
        else {
          row.status = (r && r.status) || 'error';
          row.error = ERROR_TEXT[row.status] || ERROR_TEXT.error;
          return;
        }
      } else {
        row.status = 'skipped';
        row.error = ERROR_TEXT.skipped;
        return;
      }

      row.source = found.source || '';

      // 封面落盘:外链封面会失效/被防盗链拦,补全时顺手存到本地。
      // 失败不影响其它字段(封面只是锦上添花),但要单独记账 ——
      // 与 calibre 的 failed_covers 集合同思路。
      const incoming = toIncoming(found.book);
      if (incoming.cover && deps.saveCover && wantCover(fields)) {
        const emptyCover = isEmpty('cover', current.cover);
        if (emptyCover || overwrite) {
          try {
            const saved = await deps.saveCover(row.id, incoming.cover);
            if (saved) { incoming.cover = saved; row.coverStatus = 'saved'; }
            else { row.coverStatus = 'failed'; row.coverError = '封面未能下载,已保留外链地址'; }
          } catch (err) {
            // 落盘失败:退回外链 URL,不让整条失败
            row.coverStatus = 'failed';
            row.coverError = (err && err.message) || '封面下载失败';
          }
        } else {
          row.coverStatus = 'skipped';           // 已有封面,不下载
        }
      } else if (wantCover(fields) && !incoming.cover) {
        row.coverStatus = 'none';                // 数据源没给封面
      } else {
        row.coverStatus = 'skipped';             // 调用方只要元数据
      }

      const currentIdentifiers = deps.getIdentifiers ? deps.getIdentifiers(row.id) : null;
      const { patch, filled } = buildPatch(current, incoming, { overwrite, fields, currentIdentifiers });
      if (!filled.length) {
        row.status = 'unchanged';
        return;
      }

      const updated = deps.updateBook(row.id, patch);
      if (!updated) {
        row.status = 'error';
        row.error = '写入失败(书籍可能已被删除)';
        return;
      }
      row.status = 'updated';
      row.updatedFields = filled;
    } catch (err) {
      row.status = 'error';
      row.error = (err && err.message) || ERROR_TEXT.error;
    }
  });

  const summary = {
    total: results.length,
    updated: 0, unchanged: 0, skipped: 0, not_found: 0, blocked: 0, error: 0,
    // 封面维度的汇总(与 calibre 的 failed_covers 对齐):
    // cover_saved 覆盖了几个、cover_failed 下载失败几个
    cover_saved: 0, cover_failed: 0,
  };
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
    if (r.coverStatus === 'saved' || (r.updatedFields.includes('cover'))) summary.cover_saved += 1;
    if (r.coverStatus === 'failed') summary.cover_failed += 1;
  }
  return { results, summary };
}

// fields 限定里如果只要元数据(不含 cover),就不必去下载图片。
// 对应 calibre ConfirmDialog 的 covers=False 分支(只下元数据不下封面)。
function wantCover(fields) {
  if (!Array.isArray(fields) || !fields.length) return true;
  return fields.includes('cover');
}

module.exports = {
  MAX_BATCH,
  LOOKUP_CONCURRENCY,
  ENRICH_FIELDS,
  ENRICH_IDENTIFIERS,
  ERROR_TEXT,
  isEmpty,
  parseTags,
  buildPatch,
  toIncoming,
  enrichBooks,
  wantCover,
};
