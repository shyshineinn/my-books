/* ============================================================
 * 高级搜索语法解析(对标 calibre db/search.py 的字段/布尔/范围查询)
 *
 * 纯函数,无 I/O:把用户输入的一串查询解析成结构化对象,交给
 * src/db/search.js 翻译成 SQL。示例:
 *   (tag:科幻 or tag:奇幻) and not status:done
 *   rating>=8 三体 not tag:"=草稿"
 *   cover:true
 *   date:>10daysago
 *
 * 语法:
 *   · 字段谓词  field:value / field>=n / field!=x   字段名大小写不敏感
 *   · 值可加引号含空格:tag:"外国文学"
 *   · 裸词      → 自由文本(书名/作者/简介/标签全文)
 *   · 检索类型前缀(写在字段谓词的**值**里,与 calibre 的 search kinds 对齐):
 *       =  相等      tag:=科幻        精确等于,不是子串
 *       ~  正则      title:~^三体.*    Python 风格正则
 *       ^  字符变体  title:^er       忽略大小写与变音符号,标点空格有意义
 *   · not       → 取反其后的一条;可用 not ( ... ) 否定一组
 *   · -         → 同 not(前导,作用于紧随的那一条)
 *   · and       → 默认连接,可省略
 *   · or        → 并联;**括号可改变优先级**(缺省 and 优先于 or)
 *
 * 与 2026-10-20 之前的版本(无括号版)的关键差异:
 *   旧:`or` 一出现就把**全部**正向条款 OR 起来 → a or b and c ≡ (a or b or c)
 *   新:标准优先级 → a or b and c ≡ a or (b and c);要旧语义请写 (a or b) and c
 *   这是与 calibre 对齐的必要改动,会让依赖旧行为的查询结果变化。
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
  // 虚拟书库:`vl:科幻` / `虚拟书库:"我的 书库"`(对标 calibre 的 vl: 字段)
  vl: 'vl', virtual: 'vl', virtual_library: 'vl', 虚拟书库: 'vl',
  // 封面/日期等新增字段(与 calibre 的可搜索字段名对齐)
  cover: 'cover', 封面: 'cover',
  date: 'date', added: 'date', 加入日期: 'date', 添加日期: 'date',
  comments: 'comments', 简介: 'comments', summary: 'comments',
  size: 'size', 大小: 'size',
  marked: 'marked', 标记: 'marked',
};
// 状态中文/别名 → 库内 code(wish/reading/done)。
const STATUS_VALUE = {
  wish: 'wish', 想读: 'wish',
  reading: 'reading', 在读: 'reading',
  done: 'done', 已读: 'done',
};

// 运算符 → 规范 op。':' 与 '=' 都算相等。
const OP_MAP = { ':': 'eq', '=': 'eq', '!=': 'ne', '>=': 'ge', '<=': 'le', '>': 'gt', '<': 'lt' };

// 检索类型前缀(写在值里,calibre 的 search kinds):
//   '=' 相等 / '~' 正则 / '^' 字符变体;无前缀 = contains(子串)
// 归一成 search.js 认识的 kind,缺省 'contains'。
const KIND_MAP = { '=': 'eq', '~': 'regexp', '^': 'charvariant' };
const DEFAULT_KIND = 'contains';

// 自定义字段前缀(对标 calibre library/field_metadata.py:547 的 custom_field_prefix)
const CUSTOM_PREFIX = '#';

// 一次扫描,产出 token 流。五种形态,match 组别固定:
//   1 = 字段谓词(字段名 + 运算符 + 带引号或裸值)
//   2 = 加引号的短语
//   3 = 左括号 / 4 = 右括号   ← 只有未加引号的裸 ( ) 才是分组符
//   5 = 裸词
// 字段名用 \p{L}\p{N}(带 u 模式)而非 \w —— 否则中文别名(标签:/作者:/状态:)
// 匹配不上,FIELD_ALIAS 里的中文键形同虚设。
// 字段名首字符允许 '#' —— 自定义字段的 `#label:值` 语法(与 calibre 一致)。
//
// 两条关键约束,都是实测踩出来的:
//   · **裸词必须排除 ( )**(`[^\s()]+` 而非 `\S+`):否则 `(rating>=9)` 的
//     右括号被吃进 token 变成 `rating>=9)`,值成了 `9)`,Number() 得 NaN,
//     整条被静默丢弃(A4 的嵌套括号里 rating 条件凭空消失)。
//   · **但字段谓词的值必须允许 ( )**:正则本来就是 `title:~^(三体|活着)` 这种写法,
//     若值也在 `(` 处截断,谓词会变成 `title:~^` + 值只剩 `^`,
//     正则退化成"匹配空串",查询恒不命中。所以谓词分支用 `\S+` 吃到空白为止。
const TOKEN_RE = /([\p{L}\p{N}_#]+:(?:"[^"]*"|'[^']*'|\S+))|("[^"]*"|'[^']*')|(\()|(\))|([^\s()]+)/gu;
const PRED_RE = /^([\p{L}\p{N}_#]+)(!=|>=|<=|=|>|<|:)(?:"([^"]*)"|'([^']*)'|(.+))$/u;

function stripQuotes(s) {
  const str = String(s);
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  return str;
}

// 把值开头的检索类型前缀剥出来,与 SQL WHERE 的运算符分开:
//   '=科幻'   → { kind:'eq',        op:'eq',  value:'科幻' }
//   '~^三体'  → { kind:'regexp',    op:'eq',  value:'^三体' }
//   '^er'     → { kind:'charvariant', op:'eq', value:'er' }
//   '科幻'    → { kind:'contains',  op:'eq',  value:'科幻' }
// 注意:只剥**一个**前缀字符。calibre 同样只认一个(search_kinds 段),
// '==' 的第二个 '=' 会留在值里 —— 那是用户的内容,不是语法。
function splitKind(value) {
  const s = String(value);
  const kind = KIND_MAP[s[0]];
  if (!kind) return { kind: DEFAULT_KIND, value: s };
  return { kind, value: s.slice(1) };
}

// 解析一条字段谓词文本 → 子句;未知字段返回 null(调用方降级为自由词)。
function parsePredicate(token) {
  const m = PRED_RE.exec(token);
  if (!m) return null;
  const raw01 = m[1];
  const op = OP_MAP[m[2]];
  const raw = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
  const unquoted = stripQuotes(raw);

  // 自定义字段:`#label:值`。label 由注册表校验(不在这里查库 —— core 层不碰 I/O),
  // 因此这里只做「形如 label 就认」的语法收口,真正的存在性由 search.js 查注册表判定
  // (不存在的 label 会让该条永不命中,而不是静默变成自由词 —— 见 search.js 的说明)。
  if (raw01.startsWith(CUSTOM_PREFIX)) {
    const label = raw01.slice(CUSTOM_PREFIX.length).toLowerCase();
    if (!label) return null;                       // 单个 '#' 不是字段谓词
    const { kind, value } = splitKind(unquoted);
    return { type: 'filter', field: CUSTOM_PREFIX + label, op, value, kind };
  }

  const field = FIELD_ALIAS[raw01.toLowerCase()];
  if (!field) return null;
  let value = stripQuotes(raw);
  const { kind, value: kv } = splitKind(value);
  value = kv;
  if (field === 'status') value = STATUS_VALUE[value.toLowerCase()] || value.toLowerCase();
  return { type: 'filter', field, op, value, kind };
}

// 主入口:返回 { free[], filters[], notFree[], notFilters[], or, groups[] }。
//   free/filters      正向自由词与字段谓词(顶层,平铺)
//   notFree/notFilters 顶层否定条款
//   or                顶层是否出现 or(向后兼容字段:有括号时以 groups 为准)
//   groups            带布尔结构的子树:{ op:'and'|'or', children:[...] }
// 顶层仍是「正向 AND + 否定恒 AND NOT」的语义,与旧版一致;
// 只有显式括号才产生 groups,从而不改变无括号查询的行为。
// 空输入 → 全空对象(searchBooks 据此走全库分支)。
function parseQuery(input) {
  const out = { free: [], filters: [], notFree: [], notFilters: [], or: false, groups: [] };
  const str = String(input || '').trim();
  if (!str) return out;

  const tokens = tokenize(str);
  if (!tokens.length) return out;

  const p = new Parser(tokens);
  const ast = p.parseExpr();          // 语法错误时 parseExpr 自行降级,不会抛给调用方
  if (!ast) return out;

  // or 标记:保留给无括号查询(search.js 见到 or 且无 groups 时仍走旧的整体 OR)。
  // 有括号时 or 的位置已在 AST 里表达,不需要这个粗粒度标志。
  out.or = hasTopLevelOr(ast);

  flatten(ast, out, false);
  return out;
}

// AST 顶层是否含 or(用于兼容旧的"or 一出现就整体并联"行为)
function hasTopLevelOr(node) {
  if (!node) return false;
  if (node.op === 'or') return true;
  if (node.op === 'and') return (node.children || []).some(hasTopLevelOr);
  return false;
}

/* ---------- 词法 ---------- */

function tokenize(str) {
  const raw = [];
  for (const m of str.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) raw.push({ t: 'pred', text: m[1] });
    else if (m[2] !== undefined) raw.push({ t: 'phrase', text: stripQuotes(m[2]) });
    else if (m[3] !== undefined) raw.push({ t: 'lparen' });
    else if (m[4] !== undefined) raw.push({ t: 'rparen' });
    else raw.push({ t: 'word', text: m[5] });
  }
  return balanceParens(splitTrailingParens(raw));
}

// 谓词值里的括号归属判断(TOKEN_RE 让谓词吃到空白,所以 `(a or b)` 里
// 最后一个谓词会把结尾的 ')' 一起吞进来)。
//
// 规则:数谓词文本里的括号平衡。**若右括号多于左括号**,说明多出来的
// 那几个属于外层分组语法,应当从值里剥出来还原成 rparen token:
//   `title:~^(三体|活着)` → 值里 1 个 '(' 1 个 ')' → 平衡 → 全留在值里(正则)
//   `(tag:a or tag:b)`    → 最后一个谓词是 `tag:b)`,右比左多 1 → 剥出 ')'
// 这样正则的括号与分组的括号各归各位,不需要用户加引号。
function splitTrailingParens(tokens) {
  const out = [];
  for (const tk of tokens) {
    if (tk.t !== 'pred' && tk.t !== 'word') { out.push(tk); continue; }
    const text = tk.text;
    // 数整段的括号平衡:左多/相等 → 括号属于值本身(正则的分组),整段留下。
    // 只有**右多于左**时,多出来的那些才属于外层分组语法,从尾部剥出。
    let depth = 0;
    for (const ch of text) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (depth >= 0 || !/\)+$/.test(text)) { out.push({ t: tk.t, text }); continue; }

    let body = text;
    let extra = 0;
    while (extra < -depth && body.endsWith(')')) {
      body = body.slice(0, -1);
      extra += 1;
    }
    if (body) out.push({ t: tk.t, text: body });
    for (let i = 0; i < extra; i += 1) out.push({ t: 'rparen' });
  }
  return out;
}

// 括号配平(宽松策略:搜索框的输入不该因为手滑多打/漏打一个括号就丢结果)。
//   多打的右括号 → 在 depth 0 处直接丢弃(它本来也无处可配)
//   漏打的右括号 → 末尾补齐(解析器遇到流尾的 '(' 已能正确收尾)
// 只在 token 流上数深度,不碰引号内的括号 —— 带引号的短语已经是 phrase token,
// 其中的 ( ) 是内容不是语法,这正是 TOKEN_RE 先匹配引号短语的原因。
function balanceParens(tokens) {
  let depth = 0;
  const out = [];
  for (const tk of tokens) {
    if (tk.t === 'lparen') { depth += 1; out.push(tk); continue; }
    if (tk.t === 'rparen') {
      if (depth === 0) continue;                 // 孤儿右括号:丢弃
      depth -= 1;
      out.push(tk);
      continue;
    }
    out.push(tk);
  }
  for (let i = 0; i < depth; i += 1) out.push({ t: 'rparen' });   // 补齐
  return out;
}

/* ---------- 语法(递归下降,标准优先级) ---------- */

// 文法(自底向上):
//   expr    := term ( or term )*
//   term    := unary ( and? unary )*        // and 可省略
//   unary   := not unary | primary
//   primary := '(' expr ')' | token
// 括号不配对(多了右括号 / 缺右括号)时**不报错**:把已解析的部分当结果,
// 其余当平铺条款。理由:搜索框是给人随手输的,报错不如宽松地找回部分结果
// —— calibre 的 ParseException 在 GUI 里也只是弹个提示,不影响继续用。

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  parseExpr() {
    const children = [];
    let first = this.parseTerm();
    if (first) children.push(first);
    while (this.peek() && this.peek().t === 'word' && /^or$/i.test(this.peek().text)) {
      this.next();                                  // 吃掉 or
      const rhs = this.parseTerm();
      if (rhs) children.push(rhs);
    }
    if (!children.length) return null;
    return children.length === 1 ? children[0] : { op: 'or', children };
  }

  parseTerm() {
    const children = [];
    let n = this.parseUnary();
    if (n) children.push(n);
    // 循环吃 and(可省略)与普通 unary;遇到 or / ) / 流尾即停
    for (;;) {
      const tk = this.peek();
      if (!tk) break;
      if (tk.t === 'word' && /^or$/i.test(tk.text)) break;
      if (tk.t === 'rparen') break;
      if (tk.t === 'word' && /^and$/i.test(tk.text)) {
        this.next();
        const rhs = this.parseUnary();
        if (rhs) children.push(rhs);
        continue;
      }
      n = this.parseUnary();
      if (n) children.push(n);
      else break;                                   // 无法前进,防死循环
    }
    if (!children.length) return null;
    return children.length === 1 ? children[0] : { op: 'and', children };
  }

  parseUnary() {
    const tk = this.peek();
    if (!tk) return null;
    if (tk.t === 'word' && /^not$/i.test(tk.text)) {
      this.next();
      const inner = this.parseUnary();
      return inner ? { op: 'not', child: inner } : null;
    }
    if (tk.t === 'word' && tk.text.startsWith('-') && tk.text.length > 1) {
      this.next();
      // 前导 '-' 等价 not。去掉 '-' 后的文本要重新走完整 token 判定:
      // 可能是字段谓词(`-tag:草稿` → tag:草稿)、也可能是裸词(`-三体` → 三体)。
      const inner = this.parseToken({ t: 'word', text: tk.text.slice(1) });
      return inner ? { op: 'not', child: inner } : null;
    }
    if (tk.t === 'lparen') {
      this.next();
      const inner = this.parseExpr();
      // 括号不配对:吃掉右括号(若有),按已解析内容继续
      if (this.peek() && this.peek().t === 'rparen') this.next();
      return inner;
    }
    this.next();
    return this.parseToken(tk);
  }

  // token → 叶子(free / filter)或 null(空短语、无法识别)
  parseToken(tk) {
    // 先按字段谓词试:`tag:x`、`rating>=8`、`title!=y` 都走这里。
    // 注意**不带冒号**的运算符写法(rating>=8)也在此收口 —— 那是本站既有语法,
    // core/query 从有括号版之前就一直支持,不能为了对齐 calibre 的冒号风格而改掉。
    const pred = parsePredicate(tk.text);
    if (pred) return pred;
    // 解析失败(未知字段/纯裸词):降级成自由词
    const text = stripQuotes(tk.text).trim();
    return text ? { type: 'free', value: text } : null;
  }
}

// 把 AST 摊平回旧版的三段式结构(free/filters/notFree/notFilters),
// 显式括号产生的布尔子表达式进 groups,由 search.js 用 SQL 括号翻译。
// 摊平规则与 calibre 一致:and 嵌套直接下沉,or/not 子树保留结构。
//
// 顶层 not 的处理有两条路,取决于 not 的**直接孩子**是不是叶子:
//   · not 一个叶子(not tag:x)→ 摊进 notFilters(旧版形状,测试与调用方都不变)
//   · not 一组(not (a or b))→ 整棵树进 notGroups,保留 NOT (...) 结构
// 后者不能摊平:NOT(a OR b) ≠ NOT a AND NOT b,摊了就改了语义。
function flatten(node, out, negated) {
  if (!node) return;

  if (node.type === 'free') { (negated ? out.notFree : out.free).push(node.value); return; }
  if (node.type === 'filter') { (negated ? out.notFilters : out.filters).push(node); return; }

  if (node.op === 'not') {
    const child = node.child;
    const childIsLeaf = child && (child.type === 'free' || child.type === 'filter');
    if (childIsLeaf) { flatten(child, out, !negated); return; }
    // not 一组:保留 NOT 结构
    const sqlNode = toSql(node, negated);
    if (sqlNode) {
      if (negated) out.notGroups = out.notGroups || [];
      (negated ? out.notGroups : out.groups).push(sqlNode);
    }
    return;
  }

  if (node.op === 'and') {
    // 纯 and 链:与顶层语义相同,直接下沉(否定也一样下沉)
    for (const c of node.children) flatten(c, out, negated);
    return;
  }

  // or 子树(或含 not 的 and):保留结构交给 SQL
  const sqlNode = toSql(node, negated);
  if (sqlNode) {
    if (negated) out.notGroups = out.notGroups || [];
    (negated ? out.notGroups : out.groups).push(sqlNode);
  }
}

// AST → 可直接翻译 SQL 的轻量结构:{ op:'and'|'or'|'not', children|child }
// 叶子仍是 search.js 认识的 { type:'free', value } / { type:'filter', ... }。
function toSql(node, negated) {
  if (!node) return null;
  if (node.type === 'free' || node.type === 'filter') return node;

  if (node.op === 'not') {
    // not 子树整体交给 SQL 的 NOT (...),不再向下摊平
    return { op: 'not', child: toSql(node.child, negated) };
  }
  const children = node.children.map((c) => toSql(c, negated)).filter(Boolean);
  if (!children.length) return null;
  return children.length === 1 ? children[0] : { op: node.op, children };
}

module.exports = { parseQuery, FIELD_ALIAS, STATUS_VALUE, KIND_MAP, DEFAULT_KIND, splitKind };
