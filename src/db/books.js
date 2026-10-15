/* ============================================================
 * 书籍 CRUD 与查询(数据访问层)
 * 排序 / 筛选在 SQL 层完成;标签匹配走 JSON 字符串 LIKE(与原版一致)。
 * ============================================================ */

const { db, now, inTransaction } = require('./index');
const crypto = require('node:crypto');
const { STATUSES, coverUploadFile, splitAuthors } = require('../core/book');
const search = require('./search');
const bookFiles = require('./book_files');
const categories = require('./categories');
const customFields = require('./custom_fields');
const identifiers = require('./identifiers');

const SORTS = {
  updated: 'updated_at DESC',
  created: 'created_at DESC',
  finish: 'CASE WHEN finish_date = \'\' THEN 1 ELSE 0 END, finish_date DESC',
  // title 改用 title_sort(A8):剥引号 + 英语冠词移位,「The Hobbit」排到 H 组。
  // 中文书名不含冠词,title_sort === title,排序结果不变
  title: 'title_sort COLLATE NOCASE ASC, title COLLATE NOCASE ASC',
  author: 'author_sort COLLATE NOCASE ASC, title COLLATE NOCASE ASC',
  // A3 新增:按系列 + 系列序号排序(未入系列的书排在最后)
  series: "CASE WHEN series = '' THEN 1 ELSE 0 END, series COLLATE NOCASE ASC, series_index ASC, title COLLATE NOCASE ASC",
};

// 书籍列表:有搜索词时走独立全文检索层(search.js),其余走主表
function listBooks({ q, status, tag, author, sort } = {}) {
  if (q && String(q).trim()) {
    return search.searchBooks(db, { q, status, tag, author, sort });
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
  if (author) {
    where.push('author LIKE ?');
    params.push(`%${search.escapeLike(author)}%`);
  }

  const order = SORTS[sort] || SORTS.updated;
  const sql = `SELECT * FROM books ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`;
  return db.prepare(sql).all(...params);
}

function getBook(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

// 新增书籍:values 来自 core/parseBook 的规范化输出。
// customValues(可选)= { label: 规范化字符串 },来自 core/normalizeBookValues。
// 主表 + 标签/作者链接 + 自定义值 + FTS 索引必须同生共死,故整体裹事务
// (inTransaction 是嵌套安全的:若外层 routes 已开事务则并入)。
function addBook(values, customValues = null) {
  return inTransaction(db, () => {
    const ts = now();
    // identifiers 不是 books 表的列(它落 book_identifiers 表),必须从命名参数里
    // 剔掉 —— node:sqlite 对**多余的命名参数**是严格报错的(ERR_INVALID_STATE:
    // Unknown named parameter),不像某些驱动会忽略。
    const { identifiers: idMap, ...cols } = values;
    const result = db.prepare(`
      INSERT INTO books (title, title_sort, author, author_sort, status, summary, tags, start_date, finish_date, cover, notes_url, read_count, read_logs, publisher, pub_year, isbn, rating, douban_id, series, series_index, uuid, created_at, updated_at)
      VALUES (@title, @title_sort, @author, @author_sort, @status, @summary, @tags, @start_date, @finish_date, @cover, @notes_url, @read_count, @read_logs, @publisher, @pub_year, @isbn, @rating, @douban_id, @series, @series_index, @uuid, @ts, @ts)
    `).run({ ...cols, uuid: crypto.randomUUID(), ts });
    const created = getBook(result.lastInsertRowid);
    categories.syncBookTags(db, created.id, categories.parseTagNames(created.tags));
    categories.syncBookAuthors(db, created.id, splitAuthors(created.author));
    if (customValues) customFields.setValues(db, created.id, customValues);
    // 标识符:isbn/douban 双写进 book_identifiers,其余类型也在这一步落库
    if (idMap) identifiers.setIdentifiers(db, created.id, idMap);
    search.indexBook(db, created); // 同步全文索引
    return created;
  });
}

// 更新书籍:merged 为 core/mergeUpdate 的合并结果。
// 索引同步:外部内容 FTS 表不自动感知 UPDATE,且"先改主表再删索引"会因
// content 表内容已变而清错词条 —— 所以必须在 UPDATE **前**捕获旧行,
// 之后用 updateBookIndex(旧行显式 delete + 新行 index)完成同步。
function updateBook(id, merged, customValues = null) {
  const oldRow = getBook(id);
  if (!oldRow) return null;
  return inTransaction(db, () => {
    // 同上:identifiers 不是 books 表的列,剔出命名参数(否则 node:sqlite 报错)
    const { identifiers: idMap, ...cols } = merged;
    db.prepare(`
      UPDATE books SET title = @title, title_sort = @title_sort, author = @author, author_sort = @author_sort, status = @status,
        summary = @summary, tags = @tags, start_date = @start_date, finish_date = @finish_date,
        cover = @cover, notes_url = @notes_url, read_count = @read_count, read_logs = @read_logs,
        publisher = @publisher, pub_year = @pub_year, isbn = @isbn, rating = @rating, douban_id = @douban_id,
        series = @series, series_index = @series_index,
        updated_at = @ts
      WHERE id = @id
    `).run({ ...cols, ts: now(), id });
    const updated = getBook(id);
    categories.syncBookTags(db, id, categories.parseTagNames(updated.tags));
    categories.syncBookAuthors(db, id, splitAuthors(updated.author));
    if (customValues) customFields.setValues(db, id, customValues);
    // identifiers 为 null 表示"请求体没提这件事" → 完全不动;
    // 传了对象才按"未出现的类型保持不动"处理(见 db/identifiers.js 注释)
    if (idMap) identifiers.setIdentifiers(db, id, idMap);
    search.updateBookIndex(db, id, oldRow, updated);
    return updated;
  });
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
  if (result.changes > 0) {
    search.removeBook(db, id); // 同步全文索引
    categories.pruneOrphans(db); // 删书后清掉失去全部引用的标签 / 作者
  }
  return { ok: result.changes > 0, assets };
}

module.exports = { listBooks, getBook, addBook, updateBook, deleteBook, collectAssets, SORTS };
