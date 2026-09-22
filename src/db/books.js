/* ============================================================
 * 书籍 CRUD 与查询(数据访问层)
 * 排序 / 筛选在 SQL 层完成;标签匹配走 JSON 字符串 LIKE(与原版一致)。
 * ============================================================ */

const { db, now } = require('./index');
const { STATUSES } = require('../core/book');
const search = require('./search');

const SORTS = {
  updated: 'updated_at DESC',
  created: 'created_at DESC',
  finish: 'CASE WHEN finish_date = \'\' THEN 1 ELSE 0 END, finish_date DESC',
  title: 'title COLLATE NOCASE ASC',
};

// 书籍列表:有搜索词时走独立全文检索层(search.js),其余走主表
function listBooks({ q, status, tag, sort } = {}) {
  if (q && String(q).trim()) {
    return search.searchBooks(db, { q, status, tag, sort });
  }
  const where = [];
  const params = [];
  if (status && STATUSES.includes(status)) {
    where.push('status = ?');
    params.push(status);
  }
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%"${tag}"%`);
  }

  const order = SORTS[sort] || SORTS.updated;
  const sql = `SELECT * FROM books ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`;
  return db.prepare(sql).all(...params);
}

function getBook(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

// 新增书籍:values 来自 core/parseBook 的规范化输出
function addBook(values) {
  const ts = now();
  const result = db.prepare(`
    INSERT INTO books (title, author, status, summary, tags, start_date, finish_date, cover, notes_url, read_count, read_logs, created_at, updated_at)
    VALUES (@title, @author, @status, @summary, @tags, @start_date, @finish_date, @cover, @notes_url, @read_count, @read_logs, @ts, @ts)
  `).run({ ...values, ts });
  const created = getBook(result.lastInsertRowid);
  search.indexBook(db, created); // 同步全文索引
  return created;
}

// 更新书籍:merged 为 core/mergeUpdate 的合并结果。
// 索引同步:外部内容 FTS 表不自动感知 UPDATE,且"先改主表再删索引"会因
// content 表内容已变而清错词条 —— 所以必须在 UPDATE **前**捕获旧行,
// 之后用 updateBookIndex(旧行显式 delete + 新行 index)完成同步。
function updateBook(id, merged) {
  const oldRow = getBook(id);
  if (!oldRow) return null;
  db.prepare(`
    UPDATE books SET title = @title, author = @author, status = @status,
      summary = @summary, tags = @tags, start_date = @start_date, finish_date = @finish_date,
      cover = @cover, notes_url = @notes_url, read_count = @read_count, read_logs = @read_logs, updated_at = @ts
    WHERE id = @id
  `).run({ ...merged, ts: now(), id });
  const updated = getBook(id);
  search.updateBookIndex(db, id, oldRow, updated);
  return updated;
}

function deleteBook(id) {
  const result = db.prepare('DELETE FROM books WHERE id = ?').run(id);
  if (result.changes > 0) search.removeBook(db, id); // 同步全文索引
  return result.changes > 0;
}

module.exports = { listBooks, getBook, addBook, updateBook, deleteBook, SORTS };
