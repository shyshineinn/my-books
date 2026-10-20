/* ============================================================
 * 书籍文件(数据访问层):一本书可挂多个电子书文件
 *
 * 表结构见 src/db/index.js 的 migrateV7(book_files)。
 * 唯一键 UNIQUE(book, format):同一格式只保留一份,重新上传即覆盖
 * 替换(UPSERT);外键 ON DELETE CASCADE 保证删书自动清登记,
 * 磁盘文件由路由层负责删除。
 *
 * 依赖方向纪律:与 search.js / positions.js 同策略 —— db 句柄由
 * 调用方传入,不在模块顶层 require 单例,测试可完全隔离。
 * ============================================================ */

const COLUMNS = `id, book, format, path, size, created_at, updated_at`;

// 列出某本书的全部文件(按格式名排序,列表展示用)
function listFiles(db, bookId) {
  return db.prepare(
    `SELECT ${COLUMNS} FROM book_files WHERE book = ? ORDER BY format`
  ).all(bookId);
}

function getFile(db, bookId, format) {
  return db.prepare(
    `SELECT ${COLUMNS} FROM book_files WHERE book = ? AND format = ?`
  ).get(bookId, format) || null;
}

function getFileById(db, fileId) {
  return db.prepare(`SELECT ${COLUMNS} FROM book_files WHERE id = ?`).get(fileId) || null;
}

// 登记/替换一个文件(幂等 UPSERT):values 来自 core/ebook 的校验输出
function upsertFile(db, bookId, { format, path, size }) {
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO book_files (book, format, path, size, created_at, updated_at)
    VALUES (@book, @format, @path, @size, @ts, @ts)
    ON CONFLICT(book, format) DO UPDATE SET
      path = excluded.path,
      size = excluded.size,
      updated_at = excluded.updated_at
  `).run({ book: bookId, format, path, size, ts });
  return getFile(db, bookId, format);
}

// 合并书籍:把来源书独有格式的登记迁到目标书(目标已有的格式不覆盖)。
// 只改数据库登记,不搬磁盘文件;来源书剩余的重复格式会随它被彻底删除。
function moveFormatsToBook(db, sourceId, targetId) {
  const files = listFiles(db, sourceId);
  const ts = new Date().toISOString();
  const upd = db.prepare('UPDATE book_files SET book = ?, updated_at = ? WHERE id = ?');
  let moved = 0;
  for (const f of files) {
    if (getFile(db, targetId, f.format)) continue;
    upd.run(targetId, ts, f.id);
    moved += 1;
  }
  return moved;
}

// 批量取多本书的文件(格式名列表),返回 Map<bookId, string[]>。
// 与 identifiers.getIdentifiersForBooks / custom_fields.getValuesForBooks
// 同一动机:避免调用方写 for 循环逐本查 —— 那会随书的数量线性增加往返
// (CSV 导出、列表接口都会踩到),而这里一条 IN 查完。
function listFormatsForBooks(db, bookIds) {
  const ids = [...new Set((bookIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  // 分块:SQLite 的默认变量上限(SQLITE_MAX_VARIABLE_NUMBER)通常是 32766,
  // 本项目 node:sqlite 走 APSW 包装,同样有上限;500 一块与 core/sql.js 对齐。
  const MAX_CHUNK = 500;
  for (let i = 0; i < ids.length; i += MAX_CHUNK) {
    const part = ids.slice(i, i + MAX_CHUNK);
    const ph = part.map(() => '?').join(',');
    const rows = db.prepare(`SELECT book, format FROM book_files WHERE book IN (${ph}) ORDER BY format`).all(...part);
    for (const r of rows) {
      if (!out.has(r.book)) out.set(r.book, []);
      out.get(r.book).push(r.format);
    }
  }
  return out;
}

// 删除登记(磁盘文件删除后调用);format 省略则清空该书全部登记
function removeFile(db, bookId, format) {
  if (format) {
    return db.prepare('DELETE FROM book_files WHERE book = ? AND format = ?')
      .run(bookId, format).changes;
  }
  return db.prepare('DELETE FROM book_files WHERE book = ?').run(bookId).changes;
}

module.exports = { listFiles, getFile, getFileById, upsertFile, moveFormatsToBook, listFormatsForBooks, removeFile };
