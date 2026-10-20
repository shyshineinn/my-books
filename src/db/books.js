/* ============================================================
 * 书籍 CRUD 与查询(数据访问层)
 * 排序 / 筛选在 SQL 层完成;标签匹配走 JSON 字符串 LIKE(与原版一致)。
 * ============================================================ */

const { db, now, inTransaction } = require('./index');
const crypto = require('node:crypto');
const { STATUSES, coverUploadFile, splitAuthors } = require('../core/book');
const { isbnKey } = require('../core/isbn');
const { applyStatusTransition, deriveLogFields, todayStr } = require('../core/bulk');
const search = require('./search');
const bookFiles = require('./book_files');
const categories = require('./categories');
const customFields = require('./custom_fields');
const identifiers = require('./identifiers');

// 回收站保留期:与 calibre 默认值一致(db/constants.py:11)
const TRASH_RETENTION_DAYS = 14;
const TRASH_DAY_MS = 24 * 3600 * 1000;

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

// 书籍列表:有搜索词时走独立全文检索层(search.js),其余走主表。
// handleDb 可选,便于测试用 openDb(临时目录) 隔离。
function listBooks({ q, status, tag, author, sort } = {}, handleDb = db) {
  if (q && String(q).trim()) {
    return search.searchBooks(handleDb, { q, status, tag, author, sort });
  }
  const where = ['deleted_at IS NULL'];
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
  const sql = `SELECT * FROM books WHERE ${where.join(' AND ')} ORDER BY ${order}`;
  return handleDb.prepare(sql).all(...params);
}

// 默认只在“在架书”里查;回收站里的书要显式 includeDeleted 才能读到
function getBook(id, handleDb = db, { includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? 'SELECT * FROM books WHERE id = ?'
    : 'SELECT * FROM books WHERE id = ? AND deleted_at IS NULL';
  return handleDb.prepare(sql).get(id);
}

// 系列列表(带计数与序号范围)。放在 db 层而不是路由里,便于统一过滤与测试。
function listSeries(handleDb = db) {
  return handleDb.prepare(`
    SELECT series AS name,
           COUNT(*) AS count,
           MIN(series_index) AS min_index,
           MAX(series_index) AS max_index
    FROM books
    WHERE series <> '' AND deleted_at IS NULL
    GROUP BY series COLLATE NOCASE
    ORDER BY series COLLATE NOCASE
  `).all();
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
// handleDb 可选:合并等内部路径需要在临时库/外层事务里复用同一句柄
function updateBook(id, merged, customValues = null, handleDb = db) {
  const oldRow = getBook(id, handleDb);
  if (!oldRow) return null;
  return inTransaction(handleDb, () => {
    // 同上:identifiers 不是 books 表的列,剔出命名参数(否则 node:sqlite 报错)
    const { identifiers: idMap, ...cols } = merged;
    handleDb.prepare(`
      UPDATE books SET title = @title, title_sort = @title_sort, author = @author, author_sort = @author_sort, status = @status,
        summary = @summary, tags = @tags, start_date = @start_date, finish_date = @finish_date,
        cover = @cover, notes_url = @notes_url, read_count = @read_count, read_logs = @read_logs,
        publisher = @publisher, pub_year = @pub_year, isbn = @isbn, rating = @rating, douban_id = @douban_id,
        series = @series, series_index = @series_index,
        updated_at = @ts
      WHERE id = @id
    `).run({ ...cols, ts: now(), id });
    const updated = getBook(id, handleDb);
    categories.syncBookTags(handleDb, id, categories.parseTagNames(updated.tags));
    categories.syncBookAuthors(handleDb, id, splitAuthors(updated.author));
    if (customValues) customFields.setValues(handleDb, id, customValues);
    // identifiers 为 null 表示"请求体没提这件事" → 完全不动;
    // 传了对象才按"未出现的类型保持不动"处理(见 db/identifiers.js 注释)
    if (idMap) identifiers.setIdentifiers(handleDb, id, idMap);
    search.updateBookIndex(handleDb, id, oldRow, updated);
    return updated;
  });
}

// 批量编辑:只改 patch 里出现的字段,其余保持原值。
// 状态变更复用单本编辑的阅读记录联动(已读补读完日 / 在读补开读日);
// 标签是“增/删”而不是覆盖,避免批量操作误清用户已有分类。
// 所有书在一个事务内更新:任一失败整体回滚,不会出现“改了一半”。
function bulkUpdateBooks(handleDb, ids, patch) {
  const rows = ids.map((id) => getBook(id, handleDb));
  const missing = ids.filter((id, i) => !rows[i]);
  if (missing.length) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      error: `书籍不存在或已在回收站:${missing.join(', ')}`,
    };
  }

  inTransaction(handleDb, () => {
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const oldRow = rows[i];

      let tags = categories.parseTagNames(oldRow.tags);
      const tagsChanged = !!(patch.tags_add || patch.tags_remove);
      if (tagsChanged) {
        const remove = new Set((patch.tags_remove || []).map((t) => t.toLowerCase()));
        tags = tags.filter((t) => !remove.has(t.toLowerCase()));
        const seen = new Set(tags.map((t) => t.toLowerCase()));
        for (const t of patch.tags_add || []) {
          if (seen.has(t.toLowerCase())) continue;
          tags.push(t);
          seen.add(t.toLowerCase());
        }
      }
      const tagsJson = tagsChanged ? JSON.stringify(tags) : oldRow.tags;

      let status = oldRow.status;
      let startDate = oldRow.start_date;
      let finishDate = oldRow.finish_date;
      let readCount = oldRow.read_count;
      let readLogs = oldRow.read_logs;
      if (patch.status) {
        status = patch.status;
        let logs = [];
        try { logs = JSON.parse(oldRow.read_logs || '[]'); } catch { logs = []; }
        if (!Array.isArray(logs)) logs = [];
        logs = logs
          .map((l) => ({
            start: String((l && l.start) || '').trim(),
            finish: String((l && l.finish) || '').trim(),
          }))
          .filter((l) => l.start || l.finish);
        applyStatusTransition(status, logs, todayStr());
        const derived = deriveLogFields(logs);
        startDate = derived.start_date;
        finishDate = derived.finish_date;
        readCount = derived.read_count;
        readLogs = JSON.stringify(logs);
      }

      handleDb.prepare(`
        UPDATE books SET status = ?, tags = ?, start_date = ?, finish_date = ?,
          read_count = ?, read_logs = ?, series = ?, series_index = ?,
          publisher = ?, pub_year = ?, rating = ?, updated_at = ?
        WHERE id = ?
      `).run(
        status, tagsJson, startDate, finishDate, readCount, readLogs,
        patch.series !== undefined ? patch.series : oldRow.series,
        patch.series_index !== undefined ? patch.series_index : oldRow.series_index,
        patch.publisher !== undefined ? patch.publisher : oldRow.publisher,
        patch.pub_year !== undefined ? patch.pub_year : oldRow.pub_year,
        patch.rating !== undefined ? patch.rating : oldRow.rating,
        now(), id,
      );

      if (tagsChanged) {
        categories.syncBookTags(handleDb, id, tags);
        search.updateBookIndex(handleDb, id, oldRow, getBook(id, handleDb));
      }
    }
  });

  return { ok: true, updated: ids.length };
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

// 软删除:只写墓碑,保留行、关联数据与磁盘资产(14 天内可恢复)。
// 对标 calibre 的 move_book_to_trash;区别是数据不搬走,查询层统一过滤。
function softDeleteBook(handleDb, id) {
  const ts = now();
  const result = handleDb.prepare(
    'UPDATE books SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(ts, id);
  return result.changes > 0 ? { id, deleted_at: ts } : null;
}

// 回收站列表:按删除时间倒序,dates_left 给前端展示“剩余 N 天”。
function listTrash(handleDb = db) {
  const rows = handleDb.prepare(`
    SELECT id, title, author, status, cover, deleted_at
    FROM books
    WHERE deleted_at IS NOT NULL
    ORDER BY deleted_at DESC, id DESC
  `).all();
  const nowMs = Date.now();
  return rows.map((r) => {
    const deletedMs = Date.parse(r.deleted_at);
    const daysLeft = Number.isFinite(deletedMs)
      ? Math.max(0, Math.ceil((deletedMs + TRASH_RETENTION_DAYS * TRASH_DAY_MS - nowMs) / TRASH_DAY_MS))
      : 0;
    return { ...r, days_left: daysLeft };
  });
}

// 恢复:清墓碑即可,关联数据与 FTS 索引都还在。
// 恢复前查 ISBN 冲突(在架书优先):my-books 的“不重复 ISBN”是不变量,
// 若回收期间同一 ISBN 被新书占用,阻止恢复并给出冲突书名。
function restoreBook(handleDb, id) {
  const row = handleDb.prepare(
    'SELECT * FROM books WHERE id = ? AND deleted_at IS NOT NULL'
  ).get(id);
  if (!row) return { ok: false, code: 'NOT_FOUND' };

  const ids = identifiers.getIdentifiers(handleDb, id);
  const isbn = String(ids.isbn || '').trim();
  if (isbn) {
    const key = isbnKey(isbn);
    const hit = key ? identifiers.listIsbnIndex(handleDb).get(key) : null;
    if (hit && hit.id !== id) {
      return {
        ok: false,
        code: 'CONFLICT',
        error: `ISBN ${isbn} 已被《${hit.title}》占用,无法恢复`,
      };
    }
  }

  handleDb.prepare('UPDATE books SET deleted_at = NULL WHERE id = ?').run(id);
  return { ok: true, book: getBook(id, handleDb) };
}

// 彻底删除:只允许回收站里的书。先收集磁盘资产(book_files 行会随外键
// 级联消失),再删行 + 清 FTS + 清分类孤儿;文件由调用方在 DB 提交后删。
// 硬删除(合并等内部路径使用;调用方保证行存在)。返回磁盘资产清单,
// 文件由调用方在事务提交后删除。回滚时资产不会被删。
function hardDeleteBook(handleDb, id) {
  const assets = collectAssets(handleDb, id);
  handleDb.prepare('DELETE FROM books WHERE id = ?').run(id);
  search.removeBook(handleDb, id);
  return assets;
}

function purgeBook(handleDb, id) {
  const row = handleDb.prepare('SELECT id, deleted_at FROM books WHERE id = ?').get(id);
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  if (!row.deleted_at) return { ok: false, code: 'CONFLICT', error: '书籍不在回收站,不能彻底删除' };

  let assets;
  inTransaction(handleDb, () => {
    assets = hardDeleteBook(handleDb, id);
    categories.pruneOrphans(handleDb);
  });
  return { ok: true, assets };
}

// 过期清理:对标 calibre expire_old_trash。返回 [{id, assets}] 供调用方
// 在数据库提交后删磁盘文件(server.js 启动时与定时任务使用)。
function purgeExpired(handleDb = db, days = TRASH_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - days * TRASH_DAY_MS).toISOString();
  const rows = handleDb.prepare(`
    SELECT id FROM books
    WHERE deleted_at IS NOT NULL AND deleted_at <= ?
    ORDER BY deleted_at
  `).all(cutoff);
  const purged = [];
  for (const r of rows) {
    const result = purgeBook(handleDb, r.id);
    if (result.ok) purged.push({ id: r.id, assets: result.assets });
  }
  return purged;
}

module.exports = {
  listBooks,
  getBook,
  addBook,
  updateBook,
  bulkUpdateBooks,
  hardDeleteBook,
  softDeleteBook,
  listTrash,
  restoreBook,
  purgeBook,
  purgeExpired,
  collectAssets,
  listSeries,
  TRASH_RETENTION_DAYS,
  SORTS,
};
