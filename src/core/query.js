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
const TOKEN_RE = /([\p{L}\p{N}_]+:(?:"[^"]*"|'[^']*'|[^\s]+))|("[^"]*"|'[^']*')|(\S+)/gu;
const PRED_RE = /^([\p{L}\p{N}_]+)(!=|>=|<=|=|>|<|:)(?:"([^"]*)"|'([^']*)'|(.+))$/u;

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
  const field = FIELD_ALIAS[m[1].toLowerCase()];
  if (!field) return null;
  const raw = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
  let value = stripQuotes(raw);
  if (field === 'status') value = STATUS_VALUE[value.toLowerCase()] || value.toLowerCase();
  return { type: 'filter', field, op: OP_MAP[m[2]], value };
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
