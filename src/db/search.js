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
 * 依赖方向纪律:本模块只 import node: 内置,不 import express / core,
 * 操作由调用方传入的 db 句柄完成 —— 便于 books.js 复用,也利于测试
 * 用 openDb(临时目录) 隔离验证。
 * ============================================================ */

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

/* ---------- 检索主入口(供 routes 与 books.listBooks 复用) ---------- */

// 返回完整书籍行(SELECT * FROM books 的同构),按相关度或白名单排序。
// 入参 { q, status, tag, sort } 与 listBooks 一致;q 为空时行为与 listBooks 相同。
function searchBooks(db, { q, status, tag, sort } = {}) {
  const STATUSES = ['wish', 'reading', 'done'];
  const SORTS = {
    updated: 'updated_at DESC',
    created: 'created_at DESC',
    finish: 'CASE WHEN finish_date = \'\' THEN 1 ELSE 0 END, finish_date DESC',
    title: 'title COLLATE NOCASE ASC',
  };

  const filters = [];
  const params = [];
  if (status && STATUSES.includes(status)) {
    filters.push('b.status = ?');
    params.push(status);
  }
  if (tag) {
    filters.push('b.tags LIKE ?');
    params.push(`%"${escapeLike(tag)}"%`);
  }

  // 无搜索词:原样走主表(排序白名单生效)
  if (!q || !String(q).trim()) {
    const order = SORTS[sort] || SORTS.updated;
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
    return db.prepare(`SELECT b.* FROM books b ${where} ORDER BY ${order}`).all(...params);
  }

  // 短词(1~2 字):trigram 无法索引,回退 LIKE(覆盖书名/作者/简介/标签)
  if (meaningfulLen(q) < TRIGRAM_MIN) {
    const like = `%${escapeLike(String(q).trim())}%`;
    const likeClause = '(b.title LIKE ? ESCAPE \'\\\' OR b.author LIKE ? ESCAPE \'\\\' OR b.summary LIKE ? ESCAPE \'\\\' OR b.tags LIKE ? ESCAPE \'\\\')';
    const where = [likeClause, ...filters].join(' AND ');
    const order = SORTS[sort] || SORTS.updated;
    return db
      .prepare(`SELECT b.* FROM books b WHERE ${where} ORDER BY ${order}`)
      .all(like, like, like, like, ...params);
  }

  // 长词:FTS5 trigram 短语匹配 + BM25 相关度排序;status/tag 仍生效。
  // 兜底:用户输入可能构成非法 MATCH 表达式(如裸引号、特殊运算符组合),
  // FTS 抛异常时回退 LIKE —— 检索是只读操作,宁降级不报错。
  const fts = toFtsQuery(q);
  const where = filters.length ? 'AND ' + filters.join(' AND ') : '';
  try {
    return db
      .prepare(
        `SELECT b.* FROM books_fts f JOIN books b ON b.id = f.rowid
         WHERE books_fts MATCH ? ${where}
         ORDER BY bm25(books_fts)`
      )
      .all(fts, ...params);
  } catch (err) {
    if (!/fts|MATCH/i.test(err.message)) throw err; // 非 FTS 错误原样抛出
    const like = `%${escapeLike(String(q).trim())}%`;
    const likeClause = '(b.title LIKE ? ESCAPE \'\\\' OR b.author LIKE ? ESCAPE \'\\\' OR b.summary LIKE ? ESCAPE \'\\\' OR b.tags LIKE ? ESCAPE \'\\\')';
    const likeWhereFull = [likeClause, ...filters].join(' AND ');
    return db
      .prepare(`SELECT b.* FROM books b WHERE ${likeWhereFull} ORDER BY ${SORTS[sort] || SORTS.updated}`)
      .all(like, like, like, like, ...params);
  }
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
