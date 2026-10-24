/* ============================================================
 * CSV 导入(纯规则 + deps 注入编排)
 *
 * 这是 CSV 导出的另一半。导出格式见 src/db/catalog.js 的 FIXED_HEADERS,
 * 本模块按表头名**宽松识别**:
 *   · 表头大小写不敏感、可带中文别名
 *   · 只认识其中一部分也行(最小可用集是 title)
 *   · `#label` 列自动当自定义字段
 *   · 未知列忽略(不报错)—— 别人的 CSV 也可能有额外列
 *
 * ## 查重:照抄 calibre 的 find_identical_books(db/utils.py:72-104)
 *
 * calibre 的判定不是"相似度",而是**两个硬条件同时满足**:
 *   1. 所有作者都能对上(author_map 查 id,然后取交集)
 *   2. fuzzy_title(书名) 完全相等
 * fuzzy_title 的归一化(db/utils.py:60)依次做:
 *   去掉 [\[\](){}<>'";,:#] → 去掉书名排序冠词 → [-] [.] [_] 换成空格 → 折叠空格
 * 这比"bigram 相似度"严格,但**导入场景正是要严格**:
 * 宁可多建一条,也不要把《导论》和《导论(第二版)》合并成一条。
 *
 * 另有一条**更硬的证据**calibre 没有(本项目独有):
 *   ISBN 归一化后相同 → 直接判为同一本。
 * 因为 ISBN 是书的身份证,比书名+作者可靠得多。
 *
 * ## duplicate_action:照抄 calibre cmd_add.do_adding(db/cli/cmd_add.py:46-103)
 *
 * calibre 三个取值:
 *   add                      总是新建(不查重)
 *   ignore                   查到重复就跳过
 *   add_formats_to_existing  合并到已有记录
 *
 * 本项目没有"格式文件"这一维(CSV 里没有电子书正文),所以第三个取值
 * 的语义收窄成"把字段并进已有记录"(等于 enrich 的合并语义)。
 * 第三个取值仍沿用 calibre 的名字 `add_formats_to_existing`,
 * 是为了 API 兼容与可读性 —— 名字说明它"本意",这里只是同一意图下的退化实现。
 *
 * ## automerge_action:照抄 calibre
 *   overwrite   下载/导入值覆盖已有
 *   ignore      保留已有(只补空)—— 默认
 *   new record  不用已有记录,另建一条
 *
 * ## 逐条结果(与 core/isbn_import.js / core/enrich.js 同构)
 *   created   新建一条(bookId 有效)
 *   merged    合并进已有记录(bookId = 目标书)
 *   duplicate 查到重复且策略是 ignore,跳过
 *   invalid   行校验不过(缺书名 / 书名超长)
 *   error     写入异常
 * ============================================================ */

const { parseCsv } = require('./csv');

const MAX_ROWS = 500;
const MAX_REPORT = 500;          // 逐条结果上限,防止响应体过大

// 表头 → 内部字段。键是小写后的表头,值是我认识的字段名。
// 中文别名一起收:本站导出的就是中文列名(状态/标签/评分…)。
const HEADER_MAP = {
  title: 'title', 书名: 'title',
  author: 'author', authors: 'author', 作者: 'author',
  status: 'status', 状态: 'status',
  rating: 'rating', 评分: 'rating',
  publisher: 'publisher', 出版社: 'publisher',
  pub_year: 'pub_year', pubyear: 'pub_year', 出版年: 'pub_year',
  isbn: 'isbn',
  douban_id: 'douban_id', 豆瓣id: 'douban_id',
  series: 'series', 系列: 'series',
  series_index: 'series_index', 系列序号: 'series_index',
  tags: 'tags', 标签: 'tags',
  summary: 'summary', 简介: 'summary',
  cover: 'cover', 封面: 'cover',
  start_date: 'start_date', 开始日期: 'start_date',
  finish_date: 'finish_date', 读完日期: 'finish_date',
  read_count: 'read_count', 读过次数: 'read_count',
  read_logs: 'read_logs', 阅读记录: 'read_logs',
  identifiers: 'identifiers', 标识符: 'identifiers',
};

// 服务端生成、导入时**忽略**的列(带了也不报错,直接不用)
//   id / uuid        —— 本库自增与内部标识,跨库无意义
//   title_sort / author_sort / status_label —— 派生值,由服务端重算
//   created_at / updated_at —— 时间戳由服务端定
//   file_formats     —— 文件登记不能靠 CSV 搬(盘上没有对应文件)
const IGNORED_HEADERS = new Set([
  'id', 'uuid', 'title_sort', 'author_sort', 'status_label',
  'created_at', 'updated_at', 'file_formats', 'ondevice', 'size',
]);

const STATUS_ALIAS = {
  wish: 'wish', 想读: 'wish',
  reading: 'reading', 在读: 'reading',
  done: 'done', 已读: 'done',
};

/* ---------- calibre 的 fuzzy_title(db/utils.py:60-69) ---------- */

// calibre 只处理英文标点:`[\[\](){}<>'";,:#]`,并且是**直接删掉**。
// 直接删掉对英文成立(英文标点两侧本来就有空格),但对**中文**会出问题:
//   「三体：地球往事」删冒号 → 三体地球往事
//   「三体 地球往事」       → 三体 地球往事
// 两者不等,查重就漏了。所以本项目的做法是分两组:
//   · 包裹型标点(书名号、引号、括号)→ 删掉(它们不承担分隔作用)
//   · 分隔型标点(冒号、逗号、顿号、分号、句号)→ 换成空格(它们就是分隔符)
// 再折叠空白。这样中文与英文的行为都正确。
const FUZZY_WRAP = /[\[\](){}<>'";《》〈〉“”‘’「」『』（）【】〔〕]/g;
const FUZZY_DELIM = /[,:#、，。；：！？·]/g;
const FUZZY_SEP = /[-._]/g;
const FUZZY_SPACE = /\s+/g;
// 英语书名排序冠词(calibre get_title_sort_pat 的英文默认集)
const TITLE_ARTICLES = /^(?:the|a|an)\s+/i;

function fuzzyTitle(raw) {
  let t = String(raw == null ? '' : raw).trim().toLowerCase();
  t = t.replace(FUZZY_WRAP, '');          // 包裹型:删
  t = t.replace(FUZZY_DELIM, ' ');        // 分隔型:变空格
  t = t.replace(TITLE_ARTICLES, '');
  t = t.replace(FUZZY_SEP, ' ');
  t = t.replace(FUZZY_SPACE, ' ').trim();
  return t;
}

// 作者归一:与 calibre 一致 —— 每个作者名小写后逐个比对,**全部**匹配才算同一本
function normalizeAuthorName(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/* ---------- 表头解析 ---------- */

/**
 * 把 CSV 表头映射成字段顺序。
 * @param headers 原始表头数组
 * @returns { fields: Array<{ index, field, label }>, ignored: string[], custom: Array<{index,label}> }
 */
function mapHeaders(headers) {
  const fields = [];
  const ignored = [];
  const custom = [];
  headers.forEach((raw, index) => {
    const h = String(raw == null ? '' : raw).trim();
    if (!h) return;
    const lower = h.toLowerCase();

    // 自定义字段列:#label
    if (lower.startsWith('#')) {
      const label = lower.slice(1).trim();
      if (label) custom.push({ index, label });
      return;
    }
    if (IGNORED_HEADERS.has(lower)) { ignored.push(h); return; }
    const field = HEADER_MAP[lower];
    if (!field) { ignored.push(h); return; }   // 未知列:静默忽略
    // 同名列出现多次时只认第一个(Excel 拼接常见)
    if (fields.some((f) => f.field === field)) return;
    fields.push({ index, field, label: h });
  });
  return { fields, ignored, custom };
}

/* ---------- 行 → parseBook 请求体 ---------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function splitTags(raw) {
  return String(raw == null ? '' : raw)
    .split(/[,，、;；]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// 标识符串 `type:value; type2:value2` → 对象
function parseIdentifiersCell(raw) {
  const out = {};
  for (const part of String(raw == null ? '' : raw).split(/[;；]+/)) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i <= 0) continue;
    const type = s.slice(0, i).trim().toLowerCase();
    const value = s.slice(i + 1).trim();
    if (type && value) out[type] = value;
  }
  return out;
}

function clampRating(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(10, Math.round(n * 10) / 10);
}

/**
 * 一行 → { errors, body, custom }
 * body 是 core/parseBook 能吃的形状;不被 parseBook 认识的字段(如 identifiers)
 * 一并带上,由调用方拆分。
 */
function rowToBook(headers, row, { fields, custom }) {
  const errors = [];
  const cell = (index) => String(row[index] == null ? '' : row[index]);
  const body = {};
  const customValues = {};

  for (const f of fields) {
    const raw = cell(f.index).trim();
    if (raw === '') continue;                   // 空单元格 = 不提供该字段
    switch (f.field) {
      case 'tags': body.tags = splitTags(raw); break;
      case 'rating': body.rating = clampRating(raw); break;
      case 'status': {
        const st = STATUS_ALIAS[raw.toLowerCase()] || STATUS_ALIAS[raw];
        if (st) body.status = st;
        else errors.push(`状态「${raw}」不认识(可用:想读/在读/已读)`);
        break;
      }
      case 'read_count': body.read_count = raw; break;
      case 'read_logs': body.read_logs = raw; break;   // 交给 parseBook 解析 JSON
      case 'start_date':
      case 'finish_date':
        if (!DATE_RE.test(raw)) errors.push(`${f.label}「${raw}」不是 YYYY-MM-DD`);
        else body[f.field] = raw;
        break;
      case 'series': body.series = raw; break;
      case 'series_index': body.series_index = raw; break;
      case 'identifiers': Object.assign(body, { identifiers: parseIdentifiersCell(raw) }); break;
      case 'douban_id': body.douban_id = raw; break;
      default: body[f.field] = raw;
    }
  }

  for (const c of custom) {
    const raw = cell(c.index).trim();
    if (raw !== '') customValues[c.label] = raw;
  }

  if (!String(body.title || '').trim()) errors.push('书名不能为空');
  return { errors, body, custom: customValues };
}

/* ---------- 查重(calibre find_identical_books 的移植) ---------- */

/**
 * 建立查重索引。入参是库内全部在架书的精简行。
 * @returns { byIsbn: Map, byFuzzyTitle: Map<fuzzy, book[]> }
 */
function buildDedupeIndex(rows, isbnOf) {
  const byIsbn = new Map();
  const byFuzzyTitle = new Map();
  for (const r of rows) {
    const key = isbnOf ? String(isbnOf(r) || '').trim() : '';
    if (key && !byIsbn.has(key)) byIsbn.set(key, r);
    const ft = fuzzyTitle(r.title);
    if (!ft) continue;
    if (!byFuzzyTitle.has(ft)) byFuzzyTitle.set(ft, []);
    byFuzzyTitle.get(ft).push(r);
  }
  return { byIsbn, byFuzzyTitle };
}

/**
 * 找出与 incoming 相同的那本书(没有则 null)。
 * 判定顺序(从严到宽):
 *   1. ISBN 相同(最强,本项目新增)
 *   2. fuzzy_title 相同 **且** 所有作者都能对上(calibre 同款)
 */
function findIdentical(body, index) {
  const isbn = String(body.isbn || '').trim();
  if (isbn) {
    const hit = index.byIsbn.get(isbn);
    if (hit) return { book: hit, reason: 'isbn' };
  }

  const ft = fuzzyTitle(body.title);
  if (!ft) return null;
  const candidates = index.byFuzzyTitle.get(ft);
  if (!candidates || !candidates.length) return null;

  // 作者比对(对齐 calibre db/utils.py:75-86 的方向):
  //   拿**新书**的每个作者去过滤候选 —— 新书的作者必须**全部**出现在候选书里,
  //   但候选书可以多出别的作者。
  //   「导入甲」→ 命中已有「甲、乙」;「导入甲、丙」→ 不命中「甲、乙」。
  const authors = splitAuthorNames(body.author);
  if (!authors.length) {
    // 没有作者信息时,只有唯一候选才认为同一本(避免"同名不同作者"误判)
    return candidates.length === 1 ? { book: candidates[0], reason: 'title' } : null;
  }
  const want = new Set(authors.map(normalizeAuthorName));
  for (const c of candidates) {
    const got = new Set(splitAuthorNames(c.author).map(normalizeAuthorName));
    if (!got.size) continue;                    // 候选没作者:不算匹配(保守)
    let all = true;
    for (const a of want) if (!got.has(a)) { all = false; break; }
    if (all) return { book: c, reason: 'title' };
  }
  return null;
}

// 作者串 → 名字数组(与 core/book.js 的 splitAuthors 同分隔符)
function splitAuthorNames(raw) {
  return String(raw == null ? '' : raw)
    .split(/[&，、,/]+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/* ---------- 编排 ---------- */

// 并发不需要:导入是纯数据库写入,没有网络;串行更简单也更容易保证事务边界

/**
 * 导入 CSV。
 * @param deps {
 *   listExisting()                  → 库内全部在架书 [{id,title,author,isbn}]
 *   isbnOf(row)                     → 该书归一化后的 ISBN(查重用)
 *   createBook(body, custom)        → { id, title }(新建)
 *   mergeBook(bookId, body, custom, {overwrite}) → { id } | null(合并进已有)
 *   normalizeCustom(customValues)   → { ok, errors, values }(可选;校验自定义字段)
 * }
 * @param opts { text, duplicateAction, automergeAction, dryRun }
 * @returns { results, summary, ignoredHeaders, mappedFields }
 */
function importCsv(deps, { text, duplicateAction = 'add', automergeAction = 'ignore', dryRun = false } = {}) {
  const { headers, rows } = parseCsv(text);
  if (!headers.length) {
    throw Object.assign(new Error('CSV 是空的或没有表头'), { code: 'VALIDATION' });
  }
  if (rows.length > MAX_ROWS) {
    throw Object.assign(new Error(`一次最多导入 ${MAX_ROWS} 行,请分批`), { code: 'VALIDATION' });
  }

  const mapped = mapHeaders(headers);
  if (!mapped.fields.some((f) => f.field === 'title')) {
    throw Object.assign(
      new Error('CSV 里找不到「书名/title」列,无法导入'),
      { code: 'VALIDATION' },
    );
  }

  const dup = ['add', 'ignore', 'add_formats_to_existing'].includes(duplicateAction)
    ? duplicateAction : 'add';
  const am = ['overwrite', 'ignore', 'new record'].includes(automergeAction)
    ? automergeAction : 'ignore';

  // 查重索引:只有需要查重时才建(duplicateAction != 'add' 或 automerge 不是 new record)
  const needDedupe = dup !== 'add' || am !== 'new record';
  const index = needDedupe ? buildDedupeIndex(deps.listExisting(), deps.isbnOf) : null;

  const results = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNo = i + 2;                          // +2:表头占第 1 行,数据从第 2 行起
    const out = { row: rowNo, status: '', title: '', bookId: null, existing: null, reason: '', error: '' };

    const { errors, body, custom } = rowToBook(headers, row, mapped);
    out.title = String(body.title || '').trim();

    if (errors.length) {
      out.status = 'invalid';
      out.error = errors.join(';');
      results.push(out);
      continue;
    }

    let target = null;
    if (index) {
      const hit = findIdentical(body, index);
      if (hit) { target = hit.book; out.reason = hit.reason; }
    }

    // 策略矩阵(照 calibre cmd_add.do_adding 的形状):
    //   duplicateAction=add              → 总是新建
    //   duplicateAction=ignore + 命中    → 跳过
    //   duplicateAction=add_formats_to_existing + 命中 → 合并进已有
    //   automerge=overwrite 影响合并时是否覆盖
    //   automerge=new record 让"本该合并"退化成新建
    if (target && dup === 'ignore') {
      out.status = 'duplicate';
      out.existing = { id: target.id, title: target.title };
      out.error = '库中已有这本书,按当前策略跳过';
      results.push(out);
      continue;
    }

    const shouldMerge = target && dup === 'add_formats_to_existing' && am !== 'new record';

    if (dryRun) {
      out.status = shouldMerge ? 'merged' : 'created';
      out.bookId = target ? target.id : null;
      if (target) out.existing = { id: target.id, title: target.title };
      results.push(out);
      continue;
    }

    try {
      if (shouldMerge) {
        const merged = deps.mergeBook(target.id, body, custom, { overwrite: am === 'overwrite' });
        if (!merged) {
          out.status = 'error';
          out.error = '合并失败(目标书可能已被删除)';
        } else {
          out.status = 'merged';
          out.bookId = merged.id;
          out.existing = { id: target.id, title: target.title };
        }
      } else {
        const created = deps.createBook(body, custom);
        out.status = 'created';
        out.bookId = created.id;
      }
    } catch (err) {
      out.status = 'error';
      out.error = (err && err.message) || '写入失败';
    }
    results.push(out);
  }

  const summary = { total: results.length, created: 0, merged: 0, duplicate: 0, invalid: 0, error: 0, dry_run: !!dryRun };
  for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;

  return {
    results: results.slice(0, MAX_REPORT),
    summary,
    ignoredHeaders: mapped.ignored,
    mappedFields: mapped.fields.map((f) => f.label),
    customFields: mapped.custom.map((c) => c.label),
  };
}

module.exports = {
  MAX_ROWS,
  HEADER_MAP,
  IGNORED_HEADERS,
  STATUS_ALIAS,
  fuzzyTitle,
  normalizeAuthorName,
  splitAuthorNames,
  mapHeaders,
  rowToBook,
  buildDedupeIndex,
  findIdentical,
  splitTags,
  parseIdentifiersCell,
  importCsv,
};
