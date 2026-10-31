/* ============================================================
 * 标签 / 作者 归一化数据访问层(对标 calibre db/categories.py)
 *
 * 真源是这四张表:tags / book_tags / authors / book_authors。
 * books.tags、books.author、books.author_sort 降级为「派生缓存」:
 *   · 展示、FTS、统计、前端契约全部继续读缓存 → 归一化改造零波及
 *   · 任何改动分类(重命名 / 合并 / 删除)后,重算受影响书的缓存,
 *     只重建这些书的 FTS 行(不再整库 reindex,大书库改名不再卡住)
 *
 * 依赖方向纪律:只接收传入的 db 句柄,不 require ./index(避免与
 * index→categories 的循环引用);仅依赖 node: 内置与 core/book。
 * ============================================================ */

const { splitAuthors } = require('../core/book');
const { inClause, scopeClause } = require('../core/sql');

const AUTHOR_JOIN = '、';

// 从 books.tags 缓存(JSON 串)取出标签名数组,容错坏 JSON
function parseTagNames(tagsJson) {
  let arr;
  try { arr = JSON.parse(tagsJson || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return arr.map((t) => String(t).trim()).filter(Boolean);
}

/* ---------- 归一化写入(供 books.js 的 add/update 调用) ---------- */

function ensureTag(db, name) {
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
  return db.prepare('SELECT id FROM tags WHERE name = ?').get(name).id;
}

function ensureAuthor(db, name) {
  db.prepare('INSERT OR IGNORE INTO authors (name, sort) VALUES (?, ?)').run(name, name);
  return db.prepare('SELECT id FROM authors WHERE name = ?').get(name).id;
}

// 用给定标签名数组替换某本书的标签链接(顺序无关;缓存由调用方写)
function syncBookTags(db, bookId, names) {
  db.prepare('DELETE FROM book_tags WHERE book = ?').run(bookId);
  const link = db.prepare('INSERT OR IGNORE INTO book_tags (book, tag) VALUES (?, ?)');
  for (const n of [...new Set(names.map((x) => String(x).trim()).filter(Boolean))]) {
    link.run(bookId, ensureTag(db, n));
  }
}

// 用给定作者名数组替换某本书的作者链接(保留数组顺序为 position)
function syncBookAuthors(db, bookId, names) {
  db.prepare('DELETE FROM book_authors WHERE book = ?').run(bookId);
  const link = db.prepare('INSERT OR IGNORE INTO book_authors (book, author, position) VALUES (?, ?, ?)');
  names.forEach((n, i) => link.run(bookId, ensureAuthor(db, n), i));
}

/* ---------- 缓存重算(分类变更后把真源回写进 books 缓存) ---------- */

function tagNamesForBook(db, bookId) {
  return db.prepare(`
    SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag
    WHERE bt.book = ? ORDER BY t.name COLLATE NOCASE
  `).all(bookId).map((r) => r.name);
}

function authorNamesForBook(db, bookId) {
  return db.prepare(`
    SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author
    WHERE ba.book = ? ORDER BY ba.position, a.name COLLATE NOCASE
  `).all(bookId).map((r) => r.name);
}

// 依据链接表重算某本书的 tags / author / author_sort 缓存
function recomputeBookCaches(db, bookId) {
  const tags = tagNamesForBook(db, bookId);
  const authors = authorNamesForBook(db, bookId);
  db.prepare('UPDATE books SET tags = ?, author = ?, author_sort = ? WHERE id = ?')
    .run(JSON.stringify(tags), authors.join(AUTHOR_JOIN), authors[0] || '', bookId);
}

// 分类操作影响面可能很大(改名一个常用标签 = 上千本书),缓存重算走集合式 UPDATE,
// 避免逐本 JS 往返。单本写入路径仍走 recomputeBookCaches。
function refreshTagCaches(db, ids) {
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 500) {
    const clause = inClause('id', list.slice(i, i + 500));
    db.prepare(`
      UPDATE books SET tags = COALESCE((
        SELECT json_group_array(name) FROM (
          SELECT t.name AS name
          FROM book_tags bt JOIN tags t ON t.id = bt.tag
          WHERE bt.book = books.id
          ORDER BY t.name COLLATE NOCASE
        )
      ), '[]')
      WHERE ${clause.sql}
    `).run(...clause.params);
  }
}

function refreshAuthorCaches(db, ids) {
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 500) {
    const clause = inClause('id', list.slice(i, i + 500));
    db.prepare(`
      UPDATE books SET
        author = COALESCE((
          SELECT GROUP_CONCAT(name, '、') FROM (
            SELECT a.name AS name
            FROM book_authors ba JOIN authors a ON a.id = ba.author
            WHERE ba.book = books.id
            ORDER BY ba.position, a.name COLLATE NOCASE
          )
        ), ''),
        author_sort = COALESCE((
          SELECT name FROM (
            SELECT a.name AS name
            FROM book_authors ba JOIN authors a ON a.id = ba.author
            WHERE ba.book = books.id
            ORDER BY ba.position, a.name COLLATE NOCASE
          ) LIMIT 1
        ), '')
      WHERE ${clause.sql}
    `).run(...clause.params);
  }
}

/* ---------- 受影响书的 FTS 增量重建 ---------- */
/* 外部内容表(FTS5 content='books')的 delete 命令必须传"旧行内容",
   所以改动前先快照;改完缓存后再逐本 updateBookIndex。 */
const FTS_COLS = 'id, title, author, summary, tags';

function snapshotSearchRows(db, ids) {
  const clause = inClause('id', ids);
  const rows = db.prepare(`SELECT ${FTS_COLS} FROM books WHERE ${clause.sql}`).all(...clause.params);
  return new Map(rows.map((r) => [r.id, r]));
}

function reindexBooks(db, oldRows) {
  if (!oldRows.size) return;
  const search = require('./search');
  // 基准(30k 本):全量重建约 160ms,逐本 delete+insert 约 190µs/本。
  // 受影响的书面很广时,全量重建反而更快,也更省内存;小批量才逐本。
  const total = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
  const threshold = Math.max(100, Math.ceil(total / 32));
  if (oldRows.size >= threshold) {
    search.reindexAll(db);
    return;
  }
  const get = db.prepare(`SELECT ${FTS_COLS} FROM books WHERE id = ?`);
  for (const [id, oldRow] of oldRows) {
    const fresh = get.get(id);
    if (fresh) search.updateBookIndex(db, id, oldRow, fresh);
  }
}

/* ---------- 列表(带每本计数) ---------- */

// 计数只算在架书:回收站里的书不应影响标签 / 作者的引用数。
// scopeIds(虚拟书库)语义照 calibre:只列出该作用域内出现过的分类,
// 且计数只统计作用域内的书。
function listTags(db, { scopeIds = null } = {}) {
  const scoped = scopeClause('b.id', scopeIds);
  if (scoped) {
    return db.prepare(`
      SELECT t.id, t.name, COUNT(b.id) AS count
      FROM tags t
      JOIN book_tags bt ON bt.tag = t.id
      JOIN books b ON b.id = bt.book AND b.deleted_at IS NULL
      WHERE ${scoped.sql}
      GROUP BY t.id ORDER BY count DESC, t.name COLLATE NOCASE
    `).all(...scoped.params);
  }
  return db.prepare(`
    SELECT t.id, t.name, COUNT(b.id) AS count
    FROM tags t
    LEFT JOIN book_tags bt ON bt.tag = t.id
    LEFT JOIN books b ON b.id = bt.book AND b.deleted_at IS NULL
    GROUP BY t.id ORDER BY count DESC, t.name COLLATE NOCASE
  `).all();
}

function listAuthors(db, { scopeIds = null } = {}) {
  const scoped = scopeClause('b.id', scopeIds);
  if (scoped) {
    return db.prepare(`
      SELECT a.id, a.name, COUNT(b.id) AS count
      FROM authors a
      JOIN book_authors ba ON ba.author = a.id
      JOIN books b ON b.id = ba.book AND b.deleted_at IS NULL
      WHERE ${scoped.sql}
      GROUP BY a.id ORDER BY count DESC, a.name COLLATE NOCASE
    `).all(...scoped.params);
  }
  return db.prepare(`
    SELECT a.id, a.name, COUNT(b.id) AS count
    FROM authors a
    LEFT JOIN book_authors ba ON ba.author = a.id
    LEFT JOIN books b ON b.id = ba.book AND b.deleted_at IS NULL
    GROUP BY a.id ORDER BY count DESC, a.name COLLATE NOCASE
  `).all();
}

// 为侧栏的"只取前 N 项 + 关键词搜索"服务。
// 与上面的全量列表不同:内连接天然排除 0 本作者/标签,排序也贴合侧栏展示
// (作者按名称、标签按引用数),默认无参数路径保持原样。
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

function facetFilter(column, q) {
  const text = String(q || '').trim();
  if (!text) return null;
  return { sql: `${column} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(text)}%`] };
}

function searchTags(db, { scopeIds = null, q = '', limit = 100, offset = 0 } = {}) {
  const scoped = scopeClause('b.id', scopeIds);
  const name = facetFilter('t.name', q);
  const clauses = [];
  const params = [];
  if (scoped) { clauses.push(scoped.sql); params.push(...scoped.params); }
  if (name) { clauses.push(name.sql); params.push(...name.params); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const from = `FROM tags t
    JOIN book_tags bt ON bt.tag = t.id
    JOIN books b ON b.id = bt.book AND b.deleted_at IS NULL
    ${where}`;
  const total = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n ${from}`).get(...params).n;
  const items = db.prepare(`
    SELECT t.id, t.name, COUNT(b.id) AS count
    ${from}
    GROUP BY t.id
    ORDER BY count DESC, t.name COLLATE NOCASE, t.id
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { items, total };
}

function searchAuthors(db, { scopeIds = null, q = '', limit = 100, offset = 0 } = {}) {
  const scoped = scopeClause('b.id', scopeIds);
  const name = facetFilter('a.name', q);
  const clauses = [];
  const params = [];
  if (scoped) { clauses.push(scoped.sql); params.push(...scoped.params); }
  if (name) { clauses.push(name.sql); params.push(...name.params); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const from = `FROM authors a
    JOIN book_authors ba ON ba.author = a.id
    JOIN books b ON b.id = ba.book AND b.deleted_at IS NULL
    ${where}`;
  const total = db.prepare(`SELECT COUNT(DISTINCT a.id) AS n ${from}`).get(...params).n;
  const items = db.prepare(`
    SELECT a.id, a.name, COUNT(b.id) AS count
    ${from}
    GROUP BY a.id
    ORDER BY a.name COLLATE NOCASE, a.id
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { items, total };
}

/* ---------- 变更操作:重命名 / 合并 / 删除 ----------
 * 统一模式:快照旧 FTS 行 → 改链接层 → 重算受影响书缓存 → 只重建这些书的索引。
 * 调用方负责事务边界(routes 层单条包一次,rebuildAll 迁移期已在事务内)。 */

function affectedBooksByTag(db, tagId) {
  return db.prepare('SELECT book FROM book_tags WHERE tag = ?').all(tagId).map((r) => r.book);
}
function affectedBooksByAuthor(db, authorId) {
  return db.prepare('SELECT book FROM book_authors WHERE author = ?').all(authorId).map((r) => r.book);
}

function renameTag(db, id, newName) {
  const name = String(newName || '').trim();
  if (!name) throw Object.assign(new Error('标签名不能为空'), { code: 'VALIDATION' });
  const row = db.prepare('SELECT id FROM tags WHERE id = ?').get(id);
  if (!row) throw Object.assign(new Error('标签不存在'), { code: 'NOT_FOUND' });
  const books = affectedBooksByTag(db, id);
  const targetId = ensureTag(db, name); // 大小写不敏感命中已有则返回其 id
  if (targetId !== id) {
    // 撞名:等价于合并到已存在的同名标签
    mergeTags(db, id, targetId);
    return targetId;
  }
  const oldRows = snapshotSearchRows(db, books);
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
  refreshTagCaches(db, books);
  reindexBooks(db, oldRows);
  return id;
}

function mergeTags(db, fromId, toId) {
  const from = db.prepare('SELECT id FROM tags WHERE id = ?').get(fromId);
  const to = db.prepare('SELECT id FROM tags WHERE id = ?').get(toId);
  if (!from || !to) throw Object.assign(new Error('标签不存在'), { code: 'NOT_FOUND' });
  if (fromId === toId) return toId;
  const books = new Set([...affectedBooksByTag(db, fromId), ...affectedBooksByTag(db, toId)]);
  const oldRows = snapshotSearchRows(db, [...books]);
  db.prepare(`
    INSERT OR IGNORE INTO book_tags (book, tag)
    SELECT book, ? FROM book_tags WHERE tag = ?
  `).run(toId, fromId);
  db.prepare('DELETE FROM book_tags WHERE tag = ?').run(fromId);
  db.prepare('DELETE FROM tags WHERE id = ?').run(fromId);
  refreshTagCaches(db, books);
  reindexBooks(db, oldRows);
  return toId;
}

function removeTag(db, id) {
  const books = affectedBooksByTag(db, id);
  const oldRows = snapshotSearchRows(db, books);
  db.prepare('DELETE FROM book_tags WHERE tag = ?').run(id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  refreshTagCaches(db, books);
  reindexBooks(db, oldRows);
}

function renameAuthor(db, id, newName) {
  const name = String(newName || '').trim();
  if (!name) throw Object.assign(new Error('作者名不能为空'), { code: 'VALIDATION' });
  if (!db.prepare('SELECT id FROM authors WHERE id = ?').get(id)) {
    throw Object.assign(new Error('作者不存在'), { code: 'NOT_FOUND' });
  }
  const books = affectedBooksByAuthor(db, id);
  const targetId = ensureAuthor(db, name);
  if (targetId !== id) {
    mergeAuthors(db, id, targetId);
    return targetId;
  }
  const oldRows = snapshotSearchRows(db, books);
  db.prepare('UPDATE authors SET name = ?, sort = ? WHERE id = ?').run(name, name, id);
  refreshAuthorCaches(db, books);
  reindexBooks(db, oldRows);
  return id;
}

function mergeAuthors(db, fromId, toId) {
  const from = db.prepare('SELECT id FROM authors WHERE id = ?').get(fromId);
  const to = db.prepare('SELECT id FROM authors WHERE id = ?').get(toId);
  if (!from || !to) throw Object.assign(new Error('作者不存在'), { code: 'NOT_FOUND' });
  if (fromId === toId) return toId;
  const books = new Set([...affectedBooksByAuthor(db, fromId), ...affectedBooksByAuthor(db, toId)]);
  const oldRows = snapshotSearchRows(db, [...books]);
  // 迁移链接:同一本书若两边都有,保留较小 position,忽略冲突
  db.prepare(`
    INSERT OR IGNORE INTO book_authors (book, author, position)
    SELECT book, ?, position FROM book_authors WHERE author = ?
  `).run(toId, fromId);
  db.prepare('DELETE FROM book_authors WHERE author = ?').run(fromId);
  db.prepare('DELETE FROM authors WHERE id = ?').run(fromId);
  refreshAuthorCaches(db, books);
  reindexBooks(db, oldRows);
  return toId;
}

function removeAuthor(db, id) {
  const books = affectedBooksByAuthor(db, id);
  const oldRows = snapshotSearchRows(db, books);
  db.prepare('DELETE FROM book_authors WHERE author = ?').run(id);
  db.prepare('DELETE FROM authors WHERE id = ?').run(id);
  refreshAuthorCaches(db, books);
  reindexBooks(db, oldRows);
}

// 清理零引用的标签 / 作者(删书或解除链接后调用,保持分类表干净)
function pruneOrphans(db) {
  db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag FROM book_tags)');
  db.exec('DELETE FROM authors WHERE id NOT IN (SELECT author FROM book_authors)');
}

/* ---------- 全量重建(迁移回填 / 种子后) ----------
 * 清空四表,按 books 现有 tags 缓存 + author 缓存重建链接并回写规范化缓存。 */

function rebuildAll(db) {
  db.exec('DELETE FROM book_tags; DELETE FROM book_authors; DELETE FROM tags; DELETE FROM authors;');
  const rows = db.prepare('SELECT id, tags, author FROM books').all();
  for (const r of rows) {
    const tags = parseTagNames(r.tags);
    const authors = splitAuthors(r.author);
    syncBookTags(db, r.id, tags);
    syncBookAuthors(db, r.id, authors);
    recomputeBookCaches(db, r.id);
  }
}

module.exports = {
  parseTagNames,
  syncBookTags,
  syncBookAuthors,
  recomputeBookCaches,
  listTags,
  listAuthors,
  searchTags,
  searchAuthors,
  renameTag,
  mergeTags,
  removeTag,
  renameAuthor,
  mergeAuthors,
  removeAuthor,
  pruneOrphans,
  rebuildAll,
};
