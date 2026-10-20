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
const customFieldsRepo = require('./custom_fields');

const TRIGRAM_MIN = 3; // trigram 只索引/匹配 >=3 字符的片段

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
// columns:自定义字段注册表(label → 定义),由调用方一次性查好传入 ——
//          这样本函数保持"纯 SQL 构造"职责,不在循环里反复查库。
function fieldClause({ field, op, value }, columns) {
  const likeVal = `%${escapeLike(String(value).trim())}%`;
  const numericCmp = { eq: '=', ne: '<>', ge: '>=', le: '<=', gt: '>', lt: '<' };

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
    case 'tag':
      return {
        sql:
          (op === 'ne' ? 'NOT EXISTS' : 'EXISTS') +
          '(SELECT 1 FROM book_tags bt JOIN tags t ON t.id = bt.tag WHERE bt.book = b.id AND t.name = ?)',
        params: [value],
      };
    case 'author':
      return {
        sql:
          (op === 'ne' ? 'NOT EXISTS' : 'EXISTS') +
          '(SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author WHERE ba.book = b.id AND a.name = ?)',
        params: [value],
      };
    case 'title':
      return { sql: op === 'ne' ? 'b.title NOT LIKE ? ESCAPE \'\\\'' : 'b.title LIKE ? ESCAPE \'\\\'', params: [likeVal] };
    case 'publisher':
      return { sql: op === 'ne' ? 'b.publisher NOT LIKE ? ESCAPE \'\\\'' : 'b.publisher LIKE ? ESCAPE \'\\\'', params: [likeVal] };
    case 'isbn':
      return { sql: op === 'ne' ? 'b.isbn NOT LIKE ? ESCAPE \'\\\'' : 'b.isbn LIKE ? ESCAPE \'\\\'', params: [likeVal] };
    // A3:系列。区别于 v11 的自定义字段 #series —— 这里是**内置** series 列,
    // 检索写法是裸 `series:基地`;自定义字段走 `#label`,两个命名空间不冲突。
    // **精确匹配**(大小写不敏感),与 tag / author 同款:系列是受控集合,
    // 用子串会让 `series:基地` 误命中 `基地续篇`(实测踩过)。
    case 'series':
      return {
        sql: op === 'ne' ? 'b.series <> ? COLLATE NOCASE' : 'b.series = ? COLLATE NOCASE',
        params: [String(value).trim()],
      };
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
    case 'format': {
      const f = String(value).trim().toUpperCase();
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
    default:
      return null;
  }
}

// 独立入参(status/tag/author)沿用改造前的 SQL,保证向后兼容与既有测试零变化。
// 回收站过滤放在这里:plainSearch / structuredSearch / 空查询三条路径都会经过
// legacy,一处生效,避免新增查询路径时漏掉 deleted_at。
function legacyFilterClauses(status, tag, author) {
  const STATUSES = ['wish', 'reading', 'done'];
  const clauses = [{ sql: 'b.deleted_at IS NULL', params: [] }];
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

// 结构化检索:字段谓词 + 自由词(可含 FTS)→ 统一以 books 主表为驱动,
// 各条款按 or 标志整体 OR 或默认 AND;否定条款恒为 AND NOT(...)。
// 这里不追求 BM25(排序交给 SORTS/显式 sort),换取布尔组合的正确与简单。
function structuredSearch(db, parsed, legacy, order, columns) {
  const build = (forceLike) => {
    const pos = [];
    const posParams = [];
    for (const f of parsed.filters) {
      const c = fieldClause(f, columns);
      if (c) { pos.push(c.sql); posParams.push(...c.params); }
    }
    for (const t of parsed.free) {
      const c = freeClause(t, forceLike);
      pos.push(c.sql); posParams.push(...c.params);
    }
    const neg = [];
    const negParams = [];
    for (const f of parsed.notFilters) {
      const c = fieldClause(f, columns);
      if (c) { neg.push(`NOT (${c.sql})`); negParams.push(...c.params); }
    }
    for (const t of parsed.notFree) {
      const c = freeClause(t, forceLike);
      neg.push(`NOT (${c.sql})`); negParams.push(...c.params);
    }
    return { pos, posParams, neg, negParams };
  };

  const assemble = ({ pos, posParams, neg, negParams }) => {
    let positiveSql = '';
    if (pos.length === 1) positiveSql = pos[0];
    else if (pos.length > 1) positiveSql = parsed.or ? `(${pos.join(' OR ')})` : pos.join(' AND ');
    const chunks = [];
    if (positiveSql) chunks.push(positiveSql);
    for (const c of legacy) chunks.push(c.sql);
    for (const n of neg) chunks.push(n);
    const where = chunks.length ? 'WHERE ' + chunks.join(' AND ') : '';
    const params = [...posParams, ...legacy.flatMap((c) => c.params), ...negParams];
    return { sql: `SELECT b.* FROM books b ${where} ORDER BY ${order}`, params };
  };

  const useFts = parsed.free.some((t) => meaningfulLen(t) >= TRIGRAM_MIN);
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

// 返回完整书籍行(SELECT * FROM books 的同构),按相关度或白名单排序。
// 入参 { q, status, tag, author, sort }:q 为空走主表;纯自由词走 plainSearch;
// 含字段谓词/布尔/否定则走 structuredSearch。status/tag/author 独立过滤器恒正交生效。
function searchBooks(db, { q, status, tag, author, sort } = {}) {
  const order = SORTS[sort] || SORTS.updated;
  const legacy = legacyFilterClauses(status, tag, author);

  if (!q || !String(q).trim()) {
    const where = legacy.length ? 'WHERE ' + legacy.map((c) => c.sql).join(' AND ') : '';
    const params = legacy.flatMap((c) => c.params);
    return db.prepare(`SELECT b.* FROM books b ${where} ORDER BY ${order}`).all(...params);
  }

  const parsed = parseQuery(q);
  const hasStructure =
    parsed.filters.length > 0 || parsed.notFilters.length > 0 || parsed.notFree.length > 0 || parsed.or;

  if (!hasStructure) {
    return plainSearch(db, String(q).trim(), legacy, order);
  }

  // 只有查询里真的出现 #字段 时才查注册表(空 Map 也要传,
  // 这样未知 #字段 依然会被 fieldClause 判为 VALIDATION 错误)
  const columns = new Map(customFieldsRepo.listColumns(db).map((c) => [c.label, c]));
  return structuredSearch(db, parsed, legacy, order, columns);
}

module.exports = {
  TRIGRAM_MIN,
  createFts,
  reindexAll,
  indexBook,
  removeBook,
  updateBookIndex,
  searchBooks,
  meaningfulLen,
  toFtsQuery,
  escapeLike,
};
