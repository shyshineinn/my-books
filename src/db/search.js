/* ============================================================
 * 独立全文检索层(对标 calibre db/search.py + db/fts)
 *
 * 设计要点:
 *  · 独立的 FTS5 虚表 books_fts,与 books 主表通过 content='books'
 *    外部内容连接,不冗余存书,增删改时同步一行(见 books.js)。
 *  · 分词用 trigram:对中文子串友好(中文字本身无空格,unicode61
 *    会把整串当一个 token 而失效)。trigram 索引长度 >=3 的字符片段,
 *    因此 1~2 字短词走 LIKE 兜底(见 searchBooks 的短词分支)。
 *  · 检索走 BM25 相关度排序;与 status/tag 过滤器、排序白名单正交。
 *
 * 依赖方向纪律:本模块不 import express、不做 I/O,操作由调用方传入的
 * db 句柄完成 —— 便于 books.js 复用,也利于测试用 openDb(临时目录) 隔离。
 * 唯一的 import 是纯函数 core/query(查询语法解析),与 categories 依赖
 * core/book 同构:db 层依赖 core 层的纯逻辑是本项目的既定分层方向。
 * ============================================================ */

const { parseQuery } = require('../core/query');
const { inClause } = require('../core/sql');
const customFieldsRepo = require('./custom_fields');
const savedSearches = require('./saved_searches');

const TRIGRAM_MIN = 3; // trigram 只索引/匹配 >=3 字符的片段
const MAX_VL_DEPTH = 10; // 虚拟书库最多嵌套 10 层(循环引用另有显式检测)

// 建 FTS 虚表(幂等)。外部内容表:books_fts 不含真实数据,
// 查询时回源 books 表,books 变动经 indexBook/removeBook 同步。
function createFts(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
      title, author, summary, tags,
      content='books',
      content_rowid='id',
      tokenize='trigram'
    )
  `);
}

// 全量重建索引:清空虚表后按主表逐行灌入。用于迁移 / 索引损坏修复。
// 注意:调用方负责事务边界。迁移路径(migrateV2)已在 BEGIN/COMMIT 内,
// 故此处不再自行开事务,避免"事务中开事务"。
function reindexAll(db) {
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  const rows = db.prepare('SELECT id, title, author, summary, tags FROM books').all();
  const ins = db.prepare(
    'INSERT INTO books_fts(rowid, title, author, summary, tags) VALUES (?, ?, ?, ?, ?)'
  );
  for (const r of rows) ins.run(r.id, r.title, r.author, r.summary, r.tags);
  return rows.length;
}

// 单本同步:新增 / 更新时调用。外部内容表用 rowid 对应 books.id。
function indexBook(db, book) {
  db.prepare(
    'INSERT INTO books_fts(rowid, title, author, summary, tags) VALUES (?, ?, ?, ?, ?)'
  ).run(book.id, book.title, book.author, book.summary, book.tags);
}

// 单本删除:从索引移除。外部内容表的删除必须显式执行,主表 DELETE 不会级联。
function removeBook(db, id) {
  db.prepare('DELETE FROM books_fts WHERE rowid = ?').run(id);
}

// 单本更新同步(UPDATE 场景专用):
// 外部内容 FTS 表的 DELETE 语义是"按 content 表**当前**内容清词条"——
// 若主表已 UPDATE,再调 removeBook 删掉的其实是新词条,旧词条会残留。
// 正确姿势:把**旧行内容**通过特殊 'delete' 命令显式传入,再插入新行。
function updateBookIndex(db, id, oldRow, newRow) {
  db.prepare(
    "INSERT INTO books_fts(books_fts, rowid, title, author, summary, tags) VALUES('delete', ?, ?, ?, ?, ?)"
  ).run(id, oldRow.title, oldRow.author, oldRow.summary, oldRow.tags);
  indexBook(db, newRow);
}

// 统计检索字段里"有意义"的字符数(去空白),决定走 FTS 还是 LIKE 兜底。
function meaningfulLen(term) {
  return String(term).replace(/\s+/g, '').length;
}

// 把用户输入转成 FTS5 MATCH 表达式:整体加双引号做短语匹配,
// 内部双引号转义为两个双引号(FTS5 的转义约定)。
function toFtsQuery(term) {
  return '"' + String(term).trim().replace(/"/g, '""') + '"';
}

// LIKE 通配符转义:% _ 在 LIKE 里有特殊含义,用户输入需转义;
// 配合 SQL 里的 ESCAPE '\' 使用。防止 "%" 搜出全库、"_" 意外匹配任意单字。
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/* ---------- 虚拟书库(命名作用域,对标 calibre 的 vl: 字段与 Virtual library) ---------- */

// 把一个虚拟书库名解析成命中的书籍 id 集合。
// 虚拟书库 = saved_searches 里 is_virtual = 1 的一行,query 字段是普通语法串,
// 因此可以嵌套引用别的虚拟书库(vl:A and vl:B)—— 用 stack 挡住自引用与环。
function resolveVirtualIds(db, name, stack = []) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw Object.assign(new Error('虚拟书库名称不能为空'), { code: 'VALIDATION' });
  if (stack.length >= MAX_VL_DEPTH) {
    throw Object.assign(new Error(`虚拟书库嵌套层数超过 ${MAX_VL_DEPTH}`), { code: 'VALIDATION' });
  }
  const lowered = trimmed.toLowerCase();
  if (stack.some((s) => String(s).toLowerCase() === lowered)) {
    throw Object.assign(
      new Error(`虚拟书库循环引用:${[...stack, trimmed].join(' → ')}`),
      { code: 'VALIDATION' },
    );
  }
  const row = db ? savedSearches.getVirtualByName(db, trimmed) : null;
  if (!row) {
    throw Object.assign(new Error(`虚拟书库「${trimmed}」不存在`), { code: 'VALIDATION' });
  }
  return searchBooks(db, { q: row.query }, [...stack, trimmed]).map((b) => b.id);
}

/* ---------- 结构化查询构件(字段谓词 / 自由词 / 布尔 / 否定) ---------- */

// 自由词 LIKE 兜底覆盖的列集合(书名/作者/简介/标签全文)
const LIKE_COLS =
  "(b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\' OR b.summary LIKE ? ESCAPE '\\' OR b.tags LIKE ? ESCAPE '\\')";

function likeClause(term) {
  const v = `%${escapeLike(String(term).trim())}%`;
  return { sql: LIKE_COLS, params: [v, v, v, v] };
}

// 长自由词:走 FTS 子查询 —— 外部内容表按 rowid 回链主表 id,
// 这样自由词能和其它字段谓词以 AND/OR 自由组合(纯 bm25 排序只在
// 整串自由词检索时保留,见 plainSearch)。
function ftsClause(term) {
  return {
    sql: 'b.id IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)',
    params: [toFtsQuery(term)],
  };
}

function freeClause(term, forceLike) {
  return !forceLike && meaningfulLen(term) >= TRIGRAM_MIN ? ftsClause(term) : likeClause(term);
}

// 布尔子树(AST 摊平后的 groups)→ SQL 片段。
// 递归:and 平铺、or 加括号、not 用 NOT (...)。
// 这里只做"结构 → SQL 骨架",叶子(自由词/字段谓词)交给上面的构造器 ——
// 与 calibre 把 search parser 与 field clause 分开是同构设计。
function groupClause(node, columns, ctx = {}) {
  if (!node) return null;

  if (node.type === 'free') return freeClause(node.value);
  if (node.type === 'filter') return fieldClause(node, columns, ctx);

  if (node.op === 'not') {
    const inner = groupClause(node.child, columns, ctx);
    if (!inner) return null;
    // NOT (子查询):含自由词的子句本身已是完整布尔式,套括号最稳
    return { sql: `NOT (${inner.sql})`, params: inner.params };
  }

  const parts = [];
  const params = [];
  for (const child of node.children || []) {
    const c = groupClause(child, columns, ctx);
    if (!c) continue;
    parts.push(c.sql);
    params.push(...c.params);
  }
  if (!parts.length) return null;
  if (parts.length === 1) return { sql: parts[0], params };
  const joiner = node.op === 'or' ? ' OR ' : ' AND ';
  // or 子树必须加括号:否则 `a or (b and c)` 会被 SQL 的 AND 优先级拆错
  // (SQL 里 NOT > AND > OR,与用户输入的同款规则正好相反,不括就会静默改变语义)
  return { sql: `(${parts.join(joiner)})`, params };
}

// 值里带比较符的写法(如 #页数:>=300 / #状态:!=震撼)。
// 对标 calibre db/search.py:284-290 的 NumericSearch:它先看值是否以
// !=/>=/<=/=/</> 开头,是则剥掉比较符并把该符当运算符。
// 本项目原有的等价写法是把运算符写在字段名后(如 `rating>=9`、`tag!=小说`,
// core/query 直接解析),两种都支持:冒号形式更接近 calibre 习惯,
// 不带冒号的形式已写进前端语法文档、不能为了对标而改掉。
const LEADING_OP = [
  ['!=', 'ne'], ['>=', 'ge'], ['<=', 'le'],
  ['=', 'eq'], ['>', 'gt'], ['<', 'lt'],
];

// 只有「比较符 + 后面确实还有值」才认,否则(">=" 这种裸符号)按原文处理。
// 数值类型:6 个比较符全支持(范围比较才有意义)。
// 非数值类型:只认 != 与 = —— 文本字段里 ">=x" 是合法搜索内容,
//   把它当运算符会让"搜一个以 >= 开头的值"变得不可能;
//   而 "!=x" 是几乎不会出现在真实文本开头的写法,收下它收益远大于风险。
function splitLeadingOp(op, value, isNumeric) {
  if (op !== 'eq') return { op, value };
  const s = String(value).trim();
  const allowed = isNumeric ? LEADING_OP : LEADING_OP.filter(([, mapped]) => mapped === 'ne' || mapped === 'eq');
  // 先长后短:避免 '=' 抢先匹配掉 '>=' (LEADING_OP 已按长度排序)
  for (const [sym, mapped] of allowed) {
    if (s.startsWith(sym)) {
      const rest = s.slice(sym.length).trim();
      if (rest) return { op: mapped, value: rest };
    }
  }
  return { op, value };
}

// 字段谓词 → SQL 片段。返回 null 表示无法安全求值(如 rating 非数字),调用方跳过该条。
// op 来自 core/query:eq/ne/ge/le/gt/lt。文本字段只区分 eq(子串)与 ne,范围运算符按 eq 处理。
// kind 来自值里的检索类型前缀:contains(默认)/ eq / regexp / charvariant。
// columns:自定义字段注册表(label → 定义),由调用方一次性查好传入 ——
//          这样本函数保持"纯 SQL 构造"职责,不在循环里反复查库。

// 字符变体归一(对标 calibre 的 character-variant search):
// 去变音符号 + 小写 + 去标点空白。用于 SQLite 侧给列建归一化副本再比对 ——
// 本项目的 books 表没有"折叠列",所以这里退一步:把用户输入折叠后做 LIKE,
// 命中范围比真正的折叠索引窄(列侧未折叠),但比裸 LIKE 宽(输入侧已折叠)。
// 完全对齐 calibre 需要给每个文本列加 generated column + 索引,个人库量级不必要。
function foldVariants(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')     // 组合用变音符号
    .replace(/[\u2018\u2019\u201c\u201d]/g, (ch) => ({ '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"' })[ch])
    .toLowerCase();
}

// 正则无法翻译时的降级词:从正则表达式里提取一个"最像人想搜的东西"的片段。
// 规则(够用且不会更糟):
//   1. 去掉首尾锚点 ^ $
//   2. 拆掉外层括号
//   3. 按 | 取第一个分支(正则的"或"在子串语义下无法表达,取第一个最接近)
//   4. 去掉剩余的 . * + ? 量词与转义反斜杠
// 极端情况会得到空串 → 调用方按 contains '' 处理(恒命中),
// 那比"恒不命中"更接近用户的意图(他至少想看这类书)。
function regexpFallbackTerm(expr) {
  let s = String(expr == null ? '' : expr).trim();
  s = s.replace(/^\^+/, '').replace(/\$+$/, '').trim();
  // 拆外层括号(只拆一层,深度计数的简化版)
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  s = s.split('|')[0];
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  s = s.replace(/\\(.)/g, '$1');      // 反转义
  s = s.replace(/[.*+?^${}()[\]]/g, '');  // 去掉剩余元字符
  return s.trim();
}

// 说明:SQLite 没有正则运算符(除非装扩展),本项目零新增依赖,
// 因此正则检索在 SQL 层退化为:
//   ^前缀 → LIKE 'x%'     后缀$ → LIKE '%x'     .* → %
//   . → _                  其它字符原样(转义 LIKE 通配符)
// 这是**近似**:完整正则语义(|、字符类、量词)不支持。无法翻译的表达式
// 返回 null,调用方降级为该词的普通子串搜索 —— 宁降级不报错(检索是只读路径)。
// 想用完整正则的场景,建议在自由词里用引号短语,或用 #自定义字段 精确匹配。
function regexpToLike(expr) {
  const s = String(expr || '');
  if (!s) return null;
  let out = '';
  let translated = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\') {                       // 转义:下一字符按字面量
      const nxt = s[i + 1];
      if (nxt === undefined) return null;
      out += escapeLike(nxt);
      i += 1;
      continue;
    }
    if (ch === '^') { out += ''; translated = true; continue; }   // 锚点:体现在不带前导 %
    if (ch === '$') { translated = true; continue; }
    if (ch === '.') {
      if (s[i + 1] === '*') { out += '%'; i += 1; translated = true; }
      else { out += '_'; translated = true; }
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '?') {
      // 量词跟在普通字符后:近似成 %(会放宽语义,只在不含分组时安全)
      if (out.length && out[out.length - 1] !== '%') { out += '%'; translated = true; }
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}'
        || ch === '|' || ch === '^' || ch === '$') {
      return null;                           // 分组/字符类/量词界/选择:不支持
    }
    out += escapeLike(ch);
  }
  return translated ? out : null;
}

function fieldClause({ field, op, value, kind = 'contains' }, columns, ctx = {}) {
  // 文本类匹配:按 kind 决定 LIKE 的形态
  //   contains      → LIKE %v%         子串(默认)
  //   eq            → = v 或 LIKE v    相等(标点空格有意义)
  //   regexp        → 近似 LIKE(见 regexpToLike)
  //   charvariant   → 折叠输入后 LIKE %v%
  const rawVal = String(value == null ? '' : value).trim();

  let textMode = 'contains';
  let textVal = rawVal;
  if (kind === 'eq') {
    textMode = 'eq';
  } else if (kind === 'charvariant') {
    textMode = 'contains';
    textVal = foldVariants(rawVal);
  } else if (kind === 'regexp') {
    const like = regexpToLike(rawVal);
    if (like == null) {
      // 正则无法翻译(含分组/字符类/选择)→ 退化成**普通子串**搜索。
      // 注意必须把正则元字符剥掉再当子串,否则 `~^(三体|活着)` 会变成
      // 字面量匹配 "(三体|活着)" 这个串,永远不命中(实测踩过)。
      // 剥法:去掉锚点与前导分组符号,按 | 取第一个分支。
      textMode = 'contains';
      textVal = regexpFallbackTerm(rawVal);
    } else if (rawVal.startsWith('^')) {
      textMode = 'prefix';
      textVal = like;
    } else {
      textMode = 'contains';
      textVal = like;
    }
  }

  // 构造文本匹配片段。mode 决定 % 的位置;eq 模式对空值要小心:
  //   `cover:=` 之类空相等无意义,按 contains 兜底。
  function textSql(col) {
    if (textMode === 'eq' && textVal) {
      return { sql: `${col} = ? COLLATE NOCASE`, params: [textVal] };
    }
    if (textMode === 'prefix' && textVal) {
      return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`${textVal}%`] };
    }
    return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(textVal)}%`] };
  }

  const likeVal = `%${escapeLike(String(value).trim())}%`;
  const numericCmp = { eq: '=', ne: '<>', ge: '>=', le: '<=', gt: '>', lt: '<' };

  // 布尔字段(cover / marked):true = 有,false = 无。
  // calibre 的同款语义:`cover:false` 找没封面的书,`marked:true` 找被标记的书。
  // 本站的 marked 用自定义字段承载(不必新增表),这里按 #marked 查即可 ——
  // 但为了与 calibre 的字段名对齐,给 marked 一个内建别名。
  function boolSql(exprSql) {
    const want = /^(true|1|yes|y|是|真|checked)$/i.test(rawVal);
    if (/^(false|0|no|n|否|假|unchecked|empty|blank)$/i.test(rawVal)) {
      return { sql: `NOT (${exprSql})`, params: [] };
    }
    if (want) return { sql: exprSql, params: [] };
    return null;                                  // 既不是 true 也不是 false:不认
  }

  // ---------- 自定义字段 #label ----------
  // 取值表 book_custom_values 里一书一字段一行,用 EXISTS 子查询挂到主表上,
  // 这样 #字段 谓词能与内置字段、自由词任意 AND/OR 组合(与 tag/author 同构)。
  if (field.startsWith('#')) {
    const label = field.slice(1);
    const col = columns && columns.get(label);
    if (!col) {
      // 未知字段:明确报错,而不是静默匹配全库。
      // 静默降级会让"打错字段名"表现为"筛选没生效",很难排查;
      // 抛带 code 的错误由 HTTP 层转 400,用户能立刻看见问题。
      throw Object.assign(new Error(`未知的自定义字段「${field}」`), { code: 'VALIDATION' });
    }

    // 多值字段存的是 JSON 数组串(如 ["a","b"]),用 '"值"' 精确匹配元素,
    // 避免 "ab" 命中 "abc" —— 与 books.tags 的既有匹配方式一致。
    const isMultiple = !!col.is_multiple;
    // enumeration 不做文字 LIKE 而是精确匹配(选项是受控词表)
    const isEnum = !isMultiple && col.datatype === 'enumeration';
    const isNumeric = !isMultiple && ['int', 'float', 'rating'].includes(col.datatype);

    // 数值字段允许 calibre 风格的 `#页数:>=300`
    const eff = splitLeadingOp(op, value, isNumeric);
    op = eff.op;
    value = eff.value;
    const cmp = numericCmp[op] || '=';

    let inner;
    let params;
    if (isNumeric && ['eq', 'ne', 'ge', 'le', 'gt', 'lt'].includes(op)) {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        // 数值字段给了非数字:明确报错,不静默跳过该条。
        // 跳过会让"#页数:abc"这种输入表现为"筛选没生效、返回全库",极难排查。
        throw Object.assign(
          new Error(`「${field}」是数值字段,「${value}」不是数字`),
          { code: 'VALIDATION' }
        );
      }
      // 空值不参与数值比较(cv.value = '' 时 CAST 成 0 会误命中)
      inner = `cv.value <> '' AND CAST(cv.value AS REAL) ${cmp} ?`;
      params = [n];
    } else if (isMultiple) {
      inner = 'cv.value LIKE ? ESCAPE \'\\\'';
      params = [`%"${escapeLike(String(value).trim())}"%`];
    } else if (isEnum) {
      // 枚举:精确匹配(大小写不敏感),而非子串 —— 受控词表下子串会误命中
      inner = 'cv.value = ? COLLATE NOCASE';
      params = [String(value).trim()];
    } else {
      inner = 'cv.value LIKE ? ESCAPE \'\\\'';
      params = [`%${escapeLike(String(value).trim())}%`];
    }

    // 否定一律由外层 EXISTS / NOT EXISTS 承担,inner 只表达"正向命中"。
    // 早期版本在 inner 里又写了一次 `cv.value <> ?`,与 NOT EXISTS 双重否定
    // 相互抵消,导致 `#心情!=震撼` 反而只剩"震撼"的书(实测踩过,已由
    // test/custom-fields.test.js 的否定检索用例钉死)。
    // 这与内置 tag/author 的写法一致(见上方 fieldClause 的 tag 分支)。
    return {
      sql:
        (op === 'ne' ? 'NOT EXISTS' : 'EXISTS') +
        `(SELECT 1 FROM book_custom_values cv WHERE cv.book = b.id AND cv.column_id = ? AND ${inner})`,
      params: [col.id, ...params],
    };
  }

  switch (field) {
    case 'status':
      return { sql: op === 'ne' ? 'b.status <> ?' : 'b.status = ?', params: [value] };
    // 标签 / 作者:先看是不是"计数检索"(`tags:#>4` / `authors:#=2`)。
    // calibre 的同款语法(manual/gui.rst:490):多值字段用 '#' 前缀 + 数值比较符,
    // 表示"这个字段有几个值"。注意 **# 后面必须紧跟比较符**,否则 `tag:#科幻`
    // 不是计数检索(那种写法本站没有意义,直接不命中)。
    case 'tag':
    case 'tags':
    case 'author':
    case 'authors': {
      const isAuthor = field.startsWith('author');
      const cnt = countClause(rawVal, isAuthor ? 'book_authors' : 'book_tags', isAuthor ? 'author' : 'tag');
      if (cnt) {
        if (op === 'ne') return { sql: `NOT (${cnt.sql})`, params: cnt.params };
        return cnt;
      }
      const sql = isAuthor
        ? (op === 'ne' ? 'NOT EXISTS' : 'EXISTS')
          + '(SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author WHERE ba.book = b.id AND a.name = ?)'
        : (op === 'ne' ? 'NOT EXISTS' : 'EXISTS')
          + '(SELECT 1 FROM book_tags bt JOIN tags t ON t.id = bt.tag WHERE bt.book = b.id AND t.name = ?)';
      return { sql, params: [String(value).trim()] };
    }
    case 'title':
      return negateMaybe(op, textSql('b.title'));
    case 'publisher':
      return negateMaybe(op, textSql('b.publisher'));
    case 'isbn':
      return negateMaybe(op, textSql('b.isbn'));
    case 'comments':
      return negateMaybe(op, textSql('b.summary'));
    // 大小(size):电子书文件总字节数。语法 `size:>1.1M` / `size:<=1K`,
    // 对标 calibre 的 size 字段(值里带单位,先解析成字节再比较)。
    // **必须先 splitLeadingOp**:`size:>2K` 由 core/query 解析成 op=eq + 值 ">2K",
    // 不剥前导比较符就去 parseSize,给到的是 ">2K" 这种带符号的串 ——
    // 解析必然失败(实测踩过:第一版直接 parseSize(rawVal),`size:>2K` 恒不命中)。
    // 无法解析的单位 → 整条不命中(`1 = 0`),而不是丢掉子句(那会返回全库)。
    case 'size': {
      const eff = splitLeadingOp(op, value, true);
      const bytes = parseSize(eff.value);
      if (bytes === null) return { sql: '1 = 0', params: [] };
      const cmp = numericCmp[eff.op] || '=';
      return {
        sql: `(SELECT COALESCE(SUM(bf.size), 0) FROM book_files bf WHERE bf.book = b.id) ${cmp} ?`,
        params: [bytes],
      };
    }
    // A3:系列。区别于 v11 的自定义字段 #series —— 这里是**内置** series 列,
    // 检索写法是裸 `series:基地`;自定义字段走 `#label`,两个命名空间不冲突。
    // **精确匹配**(大小写不敏感),与 tag / author 同款:系列是受控集合,
    // 用子串会让 `series:基地` 误命中 `基地续篇`(实测踩过)。
    case 'series':
      // 系列列**本来就是精确匹配**(与 tag/author 同款):系列是受控集合,
      // 用子串会让 `series:基地` 误命中 `基地续篇`(实测踩过)。
      // 因此 kind 只影响"是否再包一层 NOT":eq/contains 在这里等价。
      //
      // 但系列也支持"有无"语义:`series:true` = 属于某个系列,
      // `series:false` = 未入系列(对标 calibre manual/gui.rst:518)。
      if (/^(true|1|yes|y|是|真|checked)$/i.test(rawVal)) {
        return { sql: `b.series <> ''`, params: [] };
      }
      if (/^(false|0|no|n|否|假|unchecked|empty|blank)$/i.test(rawVal)) {
        return { sql: `b.series = ''`, params: [] };
      }
      return negateMaybe(op, { sql: 'b.series = ? COLLATE NOCASE', params: [String(value).trim()] });
    case 'series_index': {
      // 与自定义数值字段同款:支持 calibre 风格的 `series_index:>=2`
      // (比较符写在值里),也支持本站既有的 `series_index>=2`
      const eff = splitLeadingOp(op, value, true);
      const n = Number(eff.value);
      if (!Number.isFinite(n)) {
        throw Object.assign(new Error(`「series_index」应为数字,收到「${eff.value}」`), { code: 'VALIDATION' });
      }
      return { sql: `b.series_index ${numericCmp[eff.op] || '='} ?`, params: [n] };
    }
    // A5:标识符。`identifier:isbn:978...` 或 `identifier:douban:123`(key:value)
    case 'identifier':
    case 'identifiers': {
      const raw = String(value).trim();
      const i = raw.indexOf(':');
      const t = (i < 0 ? raw : raw.slice(0, i)).toLowerCase().trim();
      const v = i < 0 ? '' : raw.slice(i + 1).trim();
      if (!t) return null;
      if (!v) {
        // 只给类型:该书是否有这个类型的标识符
        return {
          sql:
            (op === 'ne' ? 'NOT EXISTS' : 'EXISTS') +
            '(SELECT 1 FROM book_identifiers bi WHERE bi.book = b.id AND bi.type = ? COLLATE NOCASE)',
          params: [t],
        };
      }
      return {
        sql:
          (op === 'ne' ? 'NOT EXISTS' : 'EXISTS') +
          '(SELECT 1 FROM book_identifiers bi WHERE bi.book = b.id AND bi.type = ? COLLATE NOCASE AND bi.value LIKE ? ESCAPE \'\\\')',
        params: [t, `%${escapeLike(v)}%`],
      };
    }
    // 虚拟书库:`vl:科幻` / `vl:"我的 书库"` / `not vl:草稿`
    // 名称必须已标记为虚拟书库;解析出命中 id 集合后按 id 收口。
    // 递归解析带 stack,循环引用与超深嵌套都报 VALIDATION 而不是栈溢出。
    case 'vl': {
      const ids = resolveVirtualIds(ctx.db, value, ctx.vlStack);
      const clause = inClause('b.id', ids);
      if (op === 'ne') return { sql: `NOT (${clause.sql})`, params: clause.params };
      return clause;
    }
    case 'format': {
      // 格式也有"有无"语义:`format:false` 找没有电子书文件的书(空书记录),
      // 对标 calibre 的 formats:false(manual/gui.rst:521)。
      //
      // **必须先试布尔词再试格式名**:`format:false` 若先走格式名路径会变成
      // `format = 'FALSE'`,恒不命中(实测踩过)。判据是"值是 true/false 系词",
      // 而不是"值是否为空" —— 真实格式名不可能是这些词。
      const bool = boolSql(`EXISTS (SELECT 1 FROM book_files bf WHERE bf.book = b.id)`);
      if (bool) {
        if (op === 'ne') return { sql: `NOT (${bool.sql})`, params: bool.params };
        return bool;
      }
      const f = String(value).trim().toUpperCase();
      if (!f) return null;
      return {
        sql:
          (op === 'ne' ? 'NOT EXISTS' : 'EXISTS') +
          '(SELECT 1 FROM book_files bf WHERE bf.book = b.id AND bf.format = ?)',
        params: [f],
      };
    }
    case 'rating': {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return { sql: `b.rating ${numericCmp[op] || '='} ?`, params: [n] };
    }
    case 'pubyear': {
      const n = Number(value);
      const cmp = { ge: '>=', le: '<=', gt: '>', lt: '<' }[op];
      if (cmp && Number.isFinite(n)) {
        return { sql: `b.pub_year <> '' AND CAST(b.pub_year AS INTEGER) ${cmp} ?`, params: [n] };
      }
      return { sql: op === 'ne' ? 'b.pub_year NOT LIKE ? ESCAPE \'\\\'' : 'b.pub_year LIKE ? ESCAPE \'\\\'', params: [likeVal] };
    }
    // 加入日期(date):书的 created_at。语法 `date:>10daysago` / `date:today`
    // / `date:<=2026-01-01`。对标 calibre 的 date 字段(它把 timestamp 叫 date)。
    //
    // **date:today 的语义是"这一天之内",不是"恰好在 00:00:00"** ——
    // created_at 带时刻,直接与当日零点做 = 比较永远不命中(实测踩过:
    // 第一版写成 `b.created_at = ?`,date:today 恒空)。
    // 做法:eq 运算时展开成 [当天零点, 次日零点) 的区间。
    //
    // **无法解析的日期值必须让整条不命中**(返回 `1 = 0`),而不是丢掉子句 ——
    // 丢掉子句等于"这条过滤没写",`date:胡说` 会返回全库,
    // 表现为"筛选没生效",比报错更难排查。
    case 'date': {
      const eff = splitLeadingOp(op, value, true);
      const date = parseDateValue(eff.value);
      if (!date) return { sql: '1 = 0', params: [] };
      const cmp = numericCmp[eff.op] || '=';
      // created_at 是 ISO 串,字典序即时间序 → 直接与 ISO 边界串比较
      if (cmp === '=') {
        // 等值 = 命中"这一天":>= 当天零点 且 < 次日零点。
        // 次日零点由 parseDateValue 的边界串 +1 天算出(月末/年末/闰年都正确)。
        const next = nextDayIso(date);
        if (next) {
          return { sql: `b.created_at >= ? AND b.created_at < ?`, params: [date, next] };
        }
      }
      return { sql: `b.created_at ${cmp} ?`, params: [date] };
    }
    // 封面有无(cover):对标 calibre `cover:false` / `cover:true`
    case 'cover': {
      const c = boolSql(`b.cover <> ''`);
      if (!c) return null;
      if (op === 'ne') return { sql: `NOT (${c.sql})`, params: c.params };
      return c;
    }
    // 已标记(marked):本站用自定义字段 #marked 承载(不新增表)。
    // 提供内建别名只为对齐 calibre 的字段名,查的还是自定义字段。
    case 'marked': {
      const col = columns && columns.get('marked');
      if (!col) return null;                      // 用户没建 #marked 字段:该条不命中
      const c = boolSql(`cv.value = '1'`);
      if (!c) return null;
      return {
        sql:
          (op === 'ne' ? 'NOT EXISTS' : 'EXISTS') +
          `(SELECT 1 FROM book_custom_values cv WHERE cv.book = b.id AND cv.column_id = ? AND ${c.sql})`,
        params: [col.id],
      };
    }
    default:
      return null;
  }
}

// 布尔值的否定包装:文本类字段的 ne 需要 NOT ( LIKE ... ) 而不是 NOT LIKE ——// 因为 LIKE 的三段式(NULL / 空串 / 值)用 NOT LIKE 会把"字段为空"也算进命中,
// 那不是用户要的"不等于 x"。NOT (LIKE) 与 SQL 的三值逻辑配合才正确:
//   cover 为空 → LIKE 返回 NULL → NOT NULL 仍是 NULL → 整行不进结果
//   cover=''   → LIKE %x% 为 0  → NOT 0 = 1 → 命中(空值确实"不等于 x")
// calibre 的文本否定同样走 NOT (contains) 而不是 not-contains。
function negateMaybe(op, clause) {
  if (op !== 'ne' || !clause) return clause;
  return { sql: `NOT (${clause.sql})`, params: clause.params };
}

// 运算符 → SQL 比较符。fieldClause 内部也用它,故提到模块作用域
// (countClause 在 fieldClause 之外,拿不到函数内的那个常量)。
const NUMERIC_CMP = { eq: '=', ne: '<>', ge: '>=', le: '<=', gt: '>', lt: '<' };

// 多值字段的"计数检索":`tags:#>4` / `authors:#=2` / `tags:#<3`。
// 语法:值以 '#' 开头,紧跟比较符,再跟数字。
//   #>4  → 标签数 > 4        #=2 → 恰好 2 个        #<3 → 少于 3 个
//   #>=1 → 至少 1 个(等价"有标签")
// 对标 calibre manual/gui.rst:490(它同样用 '#' + 数值比较符)。
// 不是计数写法(没有 #、# 后无比较符)返回 null,调用方按普通匹配继续。
//
// 注意比较符是**符号**(> = !=),而 NUMERIC_CMP 的键是**名字**(gt eq ne)——
// 必须先过一遍 LEADING_OP 的符号→名字映射,否则 NUMERIC_CMP['>'] 是 undefined,
// 会静默退化成 '='(实测踩过:第一版 `tags:#>1` 变成 `COUNT = 1`,
// 查回来的是"恰好一个标签"的书,与预期完全相反且不报错)。
const COUNT_OP_SYMBOL = {
  '!=': 'ne', '>=': 'ge', '<=': 'le', '=': 'eq', '>': 'gt', '<': 'lt',
};

function countClause(rawValue, linkTable) {
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (!s.startsWith('#')) return null;
  const rest = s.slice(1);
  const m = /^(!=|>=|<=|=|>|<)?\s*(\d+)$/.exec(rest);
  if (!m) return null;                       // '#科幻' 这类不是计数检索
  const opName = COUNT_OP_SYMBOL[m[1] || '='] || 'eq';
  const cmp = NUMERIC_CMP[opName] || '=';
  const n = Number(m[2]);
  return {
    sql: `(SELECT COUNT(*) FROM ${linkTable} x WHERE x.book = b.id) ${cmp} ?`,
    params: [n],
  };
}

// 大小值解析:`1.1M` → 字节数;支持 K/M/G(二进制 1024)与 B。
// 对标 calibre 的 size 检索(它用 regexp 拆数字与单位)。
// 纯数字按字节。无法解析返回 null(调用方跳过该条)。
function parseSize(raw) {
  const m = /^([\d.]+)\s*([kmg]?)(b)?$/i.exec(String(raw == null ? '' : raw).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  const mult = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1;
  return Math.round(n * mult);
}

// 日期值解析:返回 ISO 串(与 books.created_at 同格式,字典序可比)。
// 支持:
//   today / yesterday / thismonth / daysago(N)
//   _today / _yesterday / _thismonth / _daysago(不翻译形式,脚本用)
//   YYYY-MM-DD / YYYY-MM / YYYY(后者补成月初/年初)
// 对标 calibre get_dates_matches 的特殊串集合(manual/gui.rst:458-476)。
//
// 注意全部按 **UTC** 计算:books.created_at 存的是 `new Date().toISOString()`
// (UTC 串),用本地日期边界去比会差半天。线上 TZ=Asia/Shanghai(UTC+8),
// 用本地零点比会把"北京时间今天 08:00 前加入的书"漏掉 —— 统一 UTC 最稳。
function parseDateValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;

  const now = new Date();
  const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;

  const lower = s.toLowerCase();
  if (lower === 'today' || lower === '_today') return iso(now);
  if (lower === 'yesterday' || lower === '_yesterday') {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    return iso(d);
  }
  if (lower === 'thismonth' || lower === '_thismonth') {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
  }
  // daysago:calibre 的写法是**数字在前**(manual/gui.rst:470-474):
  //   date:>10daysago / date:<=45daysago
  // 同时容错"daysago 10"这种顺序写反的输入(个人站输入框里很常见)。
  // 注意 'daysago' 本身(无数字)不是合法值 —— 返回 null,该条不命中。
  const daysAgo = /^(\d+)\s*(?:_?daysago)$/.exec(lower) || /^(?:_?daysago)\s*(\d+)$/.exec(lower);
  if (daysAgo) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - Number(daysAgo[1]));
    return iso(d);
  }

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-01T00:00:00.000Z`;
  m = /^(\d{4})$/.exec(s);
  if (m) return `${m[1]}-01-01T00:00:00.000Z`;
  return null;
}

// 边界串 +1 天(用于把"某一天"展开成 [当天, 次日) 区间)。
// 用 Date 运算而非字符串拼接:月末/年末/闰年都不出错。
function nextDayIso(isoStr) {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

// 独立入参(status/tag/author)沿用改造前的 SQL,保证向后兼容与既有测试零变化。
// 回收站过滤放在这里:plainSearch / structuredSearch / 空查询三条路径都会经过
// legacy,一处生效,避免新增查询路径时漏掉 deleted_at。
// scopeIds 是「虚拟书库 / 外部作用域」传进来的 id 集合:
// null = 不限定;空数组 = 什么都不命中(不能退化成不限定)。
function legacyFilterClauses(status, tag, author, scopeIds = null) {
  const STATUSES = ['wish', 'reading', 'done'];
  const clauses = [{ sql: 'b.deleted_at IS NULL', params: [] }];
  if (Array.isArray(scopeIds)) clauses.push(inClause('b.id', scopeIds));
  if (status && STATUSES.includes(status)) clauses.push({ sql: 'b.status = ?', params: [status] });
  if (tag) clauses.push({ sql: 'b.tags LIKE ?', params: [`%"${escapeLike(tag)}"%`] });
  if (author) clauses.push({ sql: 'b.author LIKE ?', params: [`%${escapeLike(author)}%`] });
  return clauses;
}

/* ---------- 检索主入口(供 routes 与 books.listBooks 复用) ---------- */

const SORTS = {
  updated: 'updated_at DESC',
  created: 'created_at DESC',
  finish: 'CASE WHEN finish_date = \'\' THEN 1 ELSE 0 END, finish_date DESC',
  // A8:title 走 title_sort(剥引号 + 英语冠词移位);中文书名两者相同
  title: 'title_sort COLLATE NOCASE ASC, title COLLATE NOCASE ASC',
  author: 'author_sort COLLATE NOCASE ASC, title COLLATE NOCASE ASC',
  // A3:按系列 + 系列序号;未入系列排最后
  series: "CASE WHEN series = '' THEN 1 ELSE 0 END, series COLLATE NOCASE ASC, series_index ASC, title COLLATE NOCASE ASC",
};

// 纯自由词检索(整串当一个短语)—— 与结构化改造前的行为逐字一致:
// 短词走 LIKE,长词走 FTS5 trigram 短语匹配 + BM25 相关度排序。
// status/tag/author 独立过滤器始终正交叠加。
function plainSearch(db, rawQ, legacy, order) {
  const legacyWhere = legacy.map((c) => c.sql);
  const legacyParams = legacy.flatMap((c) => c.params);

  if (meaningfulLen(rawQ) < TRIGRAM_MIN) {
    const like = `%${escapeLike(rawQ)}%`;
    const where = [LIKE_COLS, ...legacyWhere].join(' AND ');
    return db
      .prepare(`SELECT b.* FROM books b WHERE ${where} ORDER BY ${order}`)
      .all(like, like, like, like, ...legacyParams);
  }

  const fts = toFtsQuery(rawQ);
  const andLegacy = legacyWhere.length ? 'AND ' + legacyWhere.join(' AND ') : '';
  // 兜底:用户输入可能构成非法 MATCH 表达式(裸引号、运算符组合),
  // FTS 抛异常时回退 LIKE —— 检索是只读操作,宁降级不报错。
  try {
    return db
      .prepare(
        `SELECT b.* FROM books_fts f JOIN books b ON b.id = f.rowid
         WHERE books_fts MATCH ? ${andLegacy}
         ORDER BY bm25(books_fts)`
      )
      .all(fts, ...legacyParams);
  } catch (err) {
    if (!/fts|MATCH/i.test(err.message)) throw err;
    const like = `%${escapeLike(rawQ)}%`;
    const where = [LIKE_COLS, ...legacyWhere].join(' AND ');
    return db
      .prepare(`SELECT b.* FROM books b WHERE ${where} ORDER BY ${order}`)
      .all(like, like, like, like, ...legacyParams);
  }
}

// 结构化检索:字段谓词 + 自由词 + 布尔组(可含 FTS)→ 统一以 books 主表为驱动,
// 各条款按 or 标志整体 OR 或默认 AND;否定条款恒为 AND NOT(...)。
// 这里不追求 BM25(排序交给 SORTS/显式 sort),换取布尔组合的正确与简单。
function structuredSearch(db, parsed, legacy, order, columns, vlStack = []) {
  const ctx = { db, vlStack };
  // 查询是否自带布尔结构(括号/混合优先级)。有结构时不能用旧版的"整体 OR"收尾。
  const hasGroups = (parsed.groups || []).length > 0;
  const build = (forceLike) => {
    const pos = [];
    const posParams = [];
    for (const f of parsed.filters) {
      const c = fieldClause(f, columns, ctx);
      if (c) { pos.push(c.sql); posParams.push(...c.params); }
    }
    for (const t of parsed.free) {
      const c = freeClause(t, forceLike);
      pos.push(c.sql); posParams.push(...c.params);
    }
    // 括号布尔组:每条已是完整 SQL 片段(自带括号),按 and 接入
    for (const g of parsed.groups || []) {
      const c = groupClause(g, columns, ctx);
      if (c) { pos.push(c.sql); posParams.push(...c.params); }
    }
    const neg = [];
    const negParams = [];
    for (const f of parsed.notFilters) {
      const c = fieldClause(f, columns, ctx);
      if (c) { neg.push(`NOT (${c.sql})`); negParams.push(...c.params); }
    }
    for (const t of parsed.notFree) {
      const c = freeClause(t, forceLike);
      neg.push(`NOT (${c.sql})`); negParams.push(...c.params);
    }
    // 顶层 or:把所有正向条款 OR 起来。
    // **仅在没有括号组时生效** —— 有组说明查询自带结构(组里的 OR/AND 已由
    // groupClause 正确加括号翻译),再套一层整体 OR 会把结构抹平:
    //   `(a or b) and c` 的组是 (a OR b),若再 OR 上 c 就变成 (a OR b OR c),
    //   括号白写了(实测踩过:A2/A3 两条测试因此全库命中)。
    // 无括号的 `a or b and c` 走 AST 摊平时已把结构放进 groups,
    // 所以这条分支现在只服务"旧版平铺 or"的极简查询。
    if (parsed.or && !hasGroups && pos.length > 1) {
      const joined = pos.join(' OR ');
      pos.length = 0;
      pos.push(`(${joined})`);
    }
    return { pos, posParams, neg, negParams };
  };

  const assemble = ({ pos, posParams, neg, negParams }) => {
    let positiveSql = '';
    if (pos.length === 1) positiveSql = pos[0];
    else if (pos.length > 1) positiveSql = pos.join(' AND ');
    const chunks = [];
    if (positiveSql) chunks.push(positiveSql);
    for (const c of legacy) chunks.push(c.sql);
    for (const n of neg) chunks.push(n);
    const where = chunks.length ? 'WHERE ' + chunks.join(' AND ') : '';
    const params = [...posParams, ...legacy.flatMap((c) => c.params), ...negParams];
    return { sql: `SELECT b.* FROM books b ${where} ORDER BY ${order}`, params };
  };

  // 自由词在顶层还是括号组里?组里的也要参与"是否用 FTS"的判断,
  // 否则组内含长词时 FTS 语法错误不会被捕获降级。
  const useFts = parsed.free.some((t) => meaningfulLen(t) >= TRIGRAM_MIN)
    || (parsed.groups || []).some((g) => groupHasFree(g));
  try {
    const q = assemble(build(false));
    return db.prepare(q.sql).all(...q.params);
  } catch (err) {
    if (useFts && /fts|MATCH/i.test(err.message)) {
      const q = assemble(build(true)); // 自由词全部降级为 LIKE
      return db.prepare(q.sql).all(...q.params);
    }
    throw err;
  }
}

// 布尔子树里是否含自由词(用于决定 FTS 降级路径)
function groupHasFree(node) {
  if (!node) return false;
  if (node.type === 'free') return true;
  if (node.type === 'filter') return false;
  if (node.op === 'not') return groupHasFree(node.child);
  return (node.children || []).some(groupHasFree);
}

// 返回完整书籍行(SELECT * FROM books 的同构),按相关度或白名单排序。
// 入参 { q, status, tag, author, sort, scopeIds }:q 为空走主表;纯自由词走 plainSearch;
// 含字段谓词/布尔/否定则走 structuredSearch。status/tag/author/scopeIds 恒正交生效。
// vlStack 只在解析虚拟书库时内部传入,用于环检测。
function searchBooks(db, { q, status, tag, author, sort, scopeIds } = {}, vlStack = []) {
  const order = SORTS[sort] || SORTS.updated;
  const legacy = legacyFilterClauses(status, tag, author, scopeIds);

  if (!q || !String(q).trim()) {
    const where = legacy.length ? 'WHERE ' + legacy.map((c) => c.sql).join(' AND ') : '';
    const params = legacy.flatMap((c) => c.params);
    return db.prepare(`SELECT b.* FROM books b ${where} ORDER BY ${order}`).all(...params);
  }

  const parsed = parseQuery(q);
  const hasStructure =
    parsed.filters.length > 0 || parsed.notFilters.length > 0 || parsed.notFree.length > 0
    || parsed.or || (parsed.groups || []).length > 0;

  if (!hasStructure) {
    return plainSearch(db, String(q).trim(), legacy, order);
  }

  // 只有查询里真的出现 #字段 时才查注册表(空 Map 也要传,
  // 这样未知 #字段 依然会被 fieldClause 判为 VALIDATION 错误)
  const columns = new Map(customFieldsRepo.listColumns(db).map((c) => [c.label, c]));
  return structuredSearch(db, parsed, legacy, order, columns, vlStack);
}

module.exports = {
  TRIGRAM_MIN,
  createFts,
  reindexAll,
  indexBook,
  removeBook,
  updateBookIndex,
  searchBooks,
  resolveVirtualIds,
  meaningfulLen,
  toFtsQuery,
  escapeLike,
};
