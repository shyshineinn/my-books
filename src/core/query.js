/* ============================================================
 * 高级搜索语法解析(对标 calibre db/search.py 的字段/布尔/范围查询)
 *
 * 纯函数,无 I/O:把用户输入的一串查询解析成结构化对象,交给
 * src/db/search.js 翻译成 SQL。示例:
 *   tag:科幻 author:刘慈欣 status:done rating>=8 三体
 *   publisher:上海译文 or 王小波
 *   not tag:草稿
 *
 * 语法(刻意保持克制,不支持括号嵌套):
 *   · 字段谓词  field:value / field>=n / field!=x   字段名大小写不敏感
 *   · 值可加引号含空格:tag:"外国文学"
 *   · 裸词      → 自由文本(书名/作者/简介/标签全文)
 *   · not / -   → 否定紧随其后的那一条
 *   · or        → 出现即把「正向条款」整体改为 OR(否定条款恒为 AND NOT)
 *
 * 未知字段(如 foo:bar)整条按自由文本处理,避免误吞输入。
 * ============================================================ */

// 字段别名 → 规范名。规范名与 search.js 的谓词构造器一一对应。
// 自定义字段用 `#label` 前缀(与 calibre 的 custom_field_prefix 一致,
// 见 library/field_metadata.py:547),不进这张别名表 —— 它们由注册表动态解析。
const FIELD_ALIAS = {
  tag: 'tag', tags: 'tag', 标签: 'tag',
  author: 'author', authors: 'author', 作者: 'author',
  title: 'title', 书名: 'title',
  status: 'status', 状态: 'status',
  rating: 'rating', score: 'rating', 评分: 'rating',
  pubyear: 'pubyear', year: 'pubyear', pub_year: 'pubyear', 年份: 'pubyear', 出版年: 'pubyear',
  publisher: 'publisher', press: 'publisher', 出版社: 'publisher',
  isbn: 'isbn',
  format: 'format', formats: 'format', 格式: 'format',
  // A3 系列(内置列;注意与 v11 自定义字段的 `#series` 是两回事)
  series: 'series', 系列: 'series', 丛书: 'series',
  series_index: 'series_index', 序号: 'series_index',
  // A5 标识符:`identifier:isbn:978...` / `identifier:goodreads:123`
  identifier: 'identifier', identifiers: 'identifier', 标识符: 'identifier',
};

// 状态中文/别名 → 库内 code(wish/reading/done)。
const STATUS_VALUE = {
  wish: 'wish', 想读: 'wish',
  reading: 'reading', 在读: 'reading',
  done: 'done', 已读: 'done',
};

// 运算符 → 规范 op。':' 与 '=' 都算相等。
const OP_MAP = { ':': 'eq', '=': 'eq', '!=': 'ne', '>=': 'ge', '<=': 'le', '>': 'gt', '<': 'lt' };

// 一次扫描:优先匹配「字段:值(值可带引号)」,再独立短语,再裸词。
// 字段名用 \p{L}\p{N}(带 u 模式)而非 \w —— 否则中文别名(标签:/作者:/状态:)
// 匹配不上,FIELD_ALIAS 里的中文键形同虚设。
// 字段名首字符允许 '#' —— 自定义字段的 `#label:值` 语法(与 calibre 一致)。
// '#' 只放在「冒号前的字段名」位置,值里的 '#' 不受影响。
const TOKEN_RE = /([\p{L}\p{N}_#]+:(?:"[^"]*"|'[^']*'|[^\s]+))|("[^"]*"|'[^']*')|(\S+)/gu;
const PRED_RE = /^([\p{L}\p{N}_#]+)(!=|>=|<=|=|>|<|:)(?:"([^"]*)"|'([^']*)'|(.+))$/u;

// 自定义字段前缀(对标 calibre library/field_metadata.py:547 的 custom_field_prefix)
const CUSTOM_PREFIX = '#';

function stripQuotes(s) {
  const str = String(s);
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  return str;
}

// 解析一条字段谓词文本 → 子句;未知字段返回 null(调用方降级为自由词)。
function parsePredicate(token) {
  const m = PRED_RE.exec(token);
  if (!m) return null;
  const raw01 = m[1];
  const op = OP_MAP[m[2]];
  const raw = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];

  // 自定义字段:`#label:值`。label 由注册表校验(不在这里查库 —— core 层不碰 I/O),
  // 因此这里只做「形如 label 就认」的语法收口,真正的存在性由 search.js 查注册表判定
  // (不存在的 label 会让该条永不命中,而不是静默变成自由词 —— 见 search.js 的说明)。
  if (raw01.startsWith(CUSTOM_PREFIX)) {
    const label = raw01.slice(CUSTOM_PREFIX.length).toLowerCase();
    if (!label) return null;                       // 单个 '#' 不是字段谓词
    return { type: 'filter', field: CUSTOM_PREFIX + label, op, value: stripQuotes(raw), custom: true };
  }

  const field = FIELD_ALIAS[raw01.toLowerCase()];
  if (!field) return null;
  let value = stripQuotes(raw);
  if (field === 'status') value = STATUS_VALUE[value.toLowerCase()] || value.toLowerCase();
  return { type: 'filter', field, op, value };
}

// 主入口:返回 { free[], filters[], notFree[], notFilters[], or }。
// filters 元素:{ field, op, value }。空输入 → 全空对象(searchBooks 据此走全库分支)。
function parseQuery(input) {
  const out = { free: [], filters: [], notFree: [], notFilters: [], or: false };
  const str = String(input || '').trim();
  if (!str) return out;

  let neg = false;   // not/- 作用于下一条
  for (const m of str.matchAll(TOKEN_RE)) {
    const token = m[0];
    const isQuoted = m[2] !== undefined;

    // 布尔连接词:仅在未加引号、且不是字段谓词时生效
    if (!isQuoted && /^(and|or|not)$/i.test(token)) {
      const w = token.toLowerCase();
      if (w === 'or') out.or = true;
      else if (w === 'not') neg = true;
      // 'and' 是默认连接,吞掉即可
      continue;
    }
    // 前导 '-' 否定(如 -tag:草稿);去掉后继续解析该条
    let body = token;
    if (!isQuoted && body.startsWith('-') && body.length > 1) {
      neg = true;
      body = body.slice(1);
    }

    const pred = !isQuoted ? parsePredicate(body) : null;
    if (pred) {
      (neg ? out.notFilters : out.filters).push({ field: pred.field, op: pred.op, value: pred.value });
    } else {
      const text = stripQuotes(body).trim();
      if (text) (neg ? out.notFree : out.free).push(text);
    }
    neg = false;
  }
  return out;
}

module.exports = { parseQuery, FIELD_ALIAS, STATUS_VALUE };
