/* ============================================================
 * 标识符数据访问层(A5,对标 calibre identifiers 表)
 *
 * 表结构见 src/db/index.js 的 migrateV12:
 *   book_identifiers(book, type, value),PRIMARY KEY(book, type)
 *   —— 与 calibre 的 UNIQUE(book,type) 同义:每类型一个值。
 *
 * **双写纪律(重要)**:`books.isbn` / `books.douban_id` 两列与
 * `book_identifiers` 表并存。为避免"两处不一致"这个经典陷阱,
 * 读写都收口到本模块:
 *   · 写入:setIdentifiers 同时维护两处
 *   · 读取:getIdentifiers 以表为准,旧列兜底(表里没有而列里有 → 返回列值)
 * 这样无论数据从哪条路径进来(豆瓣抓取、表单、迁移),对外只有一个真相。
 *
 * 依赖方向纪律:只接收传入的 db 句柄,不 require ./index。
 * ============================================================ */

const core = require('../core/identifiers');
const { isbnKey } = require('../core/isbn');

// isbn / douban_id 这两个"有专用列"的类型(双写的对象)
const COLUMN_BACKED = { isbn: 'isbn', douban: 'douban_id', douban_id: 'douban_id' };

// 读某本书的全部标识符 → { type: value }
// 以表为准;表里缺而旧列有的补上(兼容迁移前写入或手工改库的行)
function getIdentifiers(handleDb, bookId) {
  const out = {};
  const rows = handleDb
    .prepare('SELECT type, value FROM book_identifiers WHERE book = ?')
    .all(bookId);
  for (const r of rows) {
    const t = core.cleanType(r.type);
    const v = String(r.value || '').trim();
    if (t && v) out[t] = v;
  }
  // 旧列兜底:表里没有的用列值补
  const book = handleDb.prepare('SELECT isbn, douban_id FROM books WHERE id = ?').get(bookId);
  if (book) {
    if (book.isbn && !out.isbn) out.isbn = String(book.isbn).trim();
    if (book.douban_id && !out.douban) out.douban = String(book.douban_id).trim();
  }
  return out;
}

// 批量读(列表页用,避免 N+1)
function getIdentifiersForBooks(handleDb, bookIds) {
  const ids = [...new Set((bookIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const rows = handleDb
    .prepare(`SELECT book, type, value FROM book_identifiers WHERE book IN (${ph})`)
    .all(...ids);
  const out = {};
  for (const r of rows) {
    const t = core.cleanType(r.type);
    const v = String(r.value || '').trim();
    if (!t || !v) continue;
    if (!out[r.book]) out[r.book] = {};
    out[r.book][t] = v;
  }
  // 旧列兜底
  const books = handleDb
    .prepare(`SELECT id, isbn, douban_id FROM books WHERE id IN (${ph})`)
    .all(...ids);
  for (const b of books) {
    if (b.isbn && !(out[b.id] && out[b.id].isbn)) {
      if (!out[b.id]) out[b.id] = {};
      out[b.id].isbn = String(b.isbn).trim();
    }
    if (b.douban_id && !(out[b.id] && out[b.id].douban)) {
      if (!out[b.id]) out[b.id] = {};
      out[b.id].douban = String(b.douban_id).trim();
    }
  }
  return out;
}

// 整体替换某本书的标识符(语义:values 里出现的类型被设置,value 为空则删除;
// **未出现的类型保持不动** —— 与 PUT 的局部更新语义一致)。
// 同时把 isbn / douban 双写回 books 的两列。
// 调用方负责事务边界。
function setIdentifiers(handleDb, bookId, values) {
  const src = values && typeof values === 'object' ? values : {};
  const entries = Object.entries(src);
  if (!entries.length) return 0;

  const del = handleDb.prepare('DELETE FROM book_identifiers WHERE book = ? AND type = ?');
  const upsert = handleDb.prepare(`
    INSERT INTO book_identifiers (book, type, value) VALUES (?, ?, ?)
    ON CONFLICT(book, type) DO UPDATE SET value = excluded.value
  `);
  let touched = 0;
  for (const [rawType, rawVal] of entries) {
    const type = core.cleanType(rawType);
    if (!type) continue;
    const value = core.cleanVal(rawVal);
    if (!value) del.run(bookId, type);
    else upsert.run(bookId, type, value);
    touched += 1;

    // 双写:回填到 books 的专用列(isbn / douban_id)
    const col = type === 'isbn' ? 'isbn' : (type === 'douban' || type === 'douban_id' ? 'douban_id' : null);
    if (col) {
      handleDb.prepare(`UPDATE books SET ${col} = ? WHERE id = ?`).run(value, bookId);
    }
  }
  return touched;
}

// 删除某本书的某个标识符
function removeIdentifier(handleDb, bookId, type) {
  const t = core.cleanType(type);
  if (!t) return 0;
  const r = handleDb.prepare('DELETE FROM book_identifiers WHERE book = ? AND type = ?').run(bookId, t);
  const col = t === 'isbn' ? 'isbn' : (t === 'douban' || t === 'douban_id' ? 'douban_id' : null);
  if (col) handleDb.prepare(`UPDATE books SET ${col} = '' WHERE id = ?`).run(bookId);
  return r.changes || 0;
}

// 某类型的所有取值(带书名),用于"标识符冲突/重复"排查
function listByType(handleDb, type) {
  const t = core.cleanType(type);
  if (!t) return [];
  return handleDb.prepare(`
    SELECT i.book, i.value, b.title
    FROM book_identifiers i JOIN books b ON b.id = i.book
    WHERE i.type = ? AND b.deleted_at IS NULL
    ORDER BY b.title COLLATE NOCASE
  `).all(t);
}

// 找出"同一类型 + 同一取值"被多本书占用的冲突(数据体检用)。
// 回收站里的书不参与:它们不占用在架书的标识符命名空间。
function findDuplicates(handleDb) {
  return handleDb.prepare(`
    SELECT i.type, i.value, COUNT(*) AS n, GROUP_CONCAT(i.book) AS books
    FROM book_identifiers i
    JOIN books b ON b.id = i.book AND b.deleted_at IS NULL
    WHERE i.value <> ''
    GROUP BY i.type, i.value COLLATE NOCASE
    HAVING n > 1
    ORDER BY n DESC, i.type
  `).all();
}

// ISBN 查重索引:「按 ISBN 添加」用,归一化键 → { id, title }。
// 读两边(books.isbn 列 + book_identifiers 表)并用同一套 isbnKey 归一 ——
// 连字符、ISBN-10 与对应 ISBN-13 混存也能比中(calibre 的做法也是
// normalize_isbn 两边归一后比对,见 gui2/actions/add.py:421)。
// 同一键被多本书占用时保留先遇到的一行;这类脏数据由
// /api/identifiers/duplicates 体检暴露,不在这里静默纠正。
function listIsbnIndex(handleDb) {
  const out = new Map();
  const rows = handleDb.prepare(`
    SELECT id, title, isbn AS value FROM books
    WHERE isbn <> '' AND deleted_at IS NULL
    UNION ALL
    SELECT b.id AS id, b.title AS title, i.value AS value
    FROM book_identifiers i JOIN books b ON b.id = i.book
    WHERE i.type = 'isbn' AND i.value <> '' AND b.deleted_at IS NULL
  `).all();
  for (const r of rows) {
    const key = isbnKey(r.value);
    if (key && !out.has(key)) out.set(key, { id: r.id, title: r.title });
  }
  return out;
}

// 清理孤儿(字段被删/书被删后;外键 CASCADE 已能处理,这是兜底)
function pruneOrphans(handleDb) {
  const r = handleDb.prepare(
    'DELETE FROM book_identifiers WHERE book NOT IN (SELECT id FROM books)'
  ).run();
  return r.changes || 0;
}

module.exports = {
  COLUMN_BACKED,
  getIdentifiers,
  getIdentifiersForBooks,
  setIdentifiers,
  removeIdentifier,
  listByType,
  listIsbnIndex,
  findDuplicates,
  pruneOrphans,
};
