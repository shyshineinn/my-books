/* ============================================================
 * 书籍 CRUD 与查询(数据访问层)
 * 排序 / 筛选在 SQL 层完成;标签匹配走 JSON 字符串 LIKE(与原版一致)。
 * ============================================================ */

const { db, now } = require('./index');
const { STATUSES, coverUploadFile } = require('../core/book');
const search = require('./search');
const bookFiles = require('./book_files');

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
    INSERT INTO books (title, author, status, summary, tags, start_date, finish_date, cover, notes_url, read_count, read_logs, publisher, pub_year, isbn, rating, douban_id, created_at, updated_at)
    VALUES (@title, @author, @status, @summary, @tags, @start_date, @finish_date, @cover, @notes_url, @read_count, @read_logs, @publisher, @pub_year, @isbn, @rating, @douban_id, @ts, @ts)
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
      cover = @cover, notes_url = @notes_url, read_count = @read_count, read_logs = @read_logs,
      publisher = @publisher, pub_year = @pub_year, isbn = @isbn, rating = @rating, douban_id = @douban_id,
      updated_at = @ts
    WHERE id = @id
  `).run({ ...merged, ts: now(), id });
  const updated = getBook(id);
  search.updateBookIndex(db, id, oldRow, updated);
  return updated;
}

// 收集一本书占用的磁盘资产:{ ebookFiles:[books-files 相对名], coverFiles:[uploads 相对名] }
// db 句柄由调用方传入(与 search.js / book_files.js 同纪律)—— 测试可用
// openDb(临时目录) 隔离验证,不碰生产库。
//
// 必须在 DELETE **之前**调用:book_files 行随外键 ON DELETE CASCADE 一起消失,
// 删完再查只剩磁盘上的孤儿文件、无从对应。
// 封面:cover 列只有"/uploads/<文件名>"这一种本地形态(外链封面没有本地文件)。
// 同一张封面图可能被多本书引用(手动复制同一个 URL),仍被引用的不删。
function collectAssets(handleDb, id) {
  const row = handleDb.prepare('SELECT * FROM books WHERE id = ?').get(id);
  if (!row) return null;

  const coverFile = coverUploadFile(row.cover);
  const coverRefs = coverFile
    ? handleDb.prepare('SELECT COUNT(*) AS n FROM books WHERE id != ? AND cover = ?')
      .get(id, `/uploads/${coverFile}`).n
    : 0;

  return {
    ebookFiles: bookFiles.listFiles(handleDb, id).map((f) => f.path),
    coverFiles: coverFile && coverRefs === 0 ? [coverFile] : [],
  };
}

// 删除书籍,并返回它占用的磁盘资产(约定见 migrateV7 注释:登记在 db 层清,
// 磁盘文件由路由层删 —— 这里把资产清单交出去,补上此前漏掉的那一半)。
// 返回 { ok, assets }:ok=false 时 assets 为 null,路由层据此不删任何文件
// (书没删成,文件必须留在原地)。
function deleteBook(id) {
  const assets = collectAssets(db, id);
  if (!assets) return { ok: false, assets: null };

  const result = db.prepare('DELETE FROM books WHERE id = ?').run(id);
  if (result.changes > 0) search.removeBook(db, id); // 同步全文索引
  return { ok: result.changes > 0, assets };
}

module.exports = { listBooks, getBook, addBook, updateBook, deleteBook, collectAssets, SORTS };
