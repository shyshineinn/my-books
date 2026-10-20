/* ============================================================
 * 重复书籍扫描(数据访问层)
 *
 * 取在架书 -> core/duplicates 分组 -> 补上电子书格式给前端展示。
 * 只读,不写库。
 * ============================================================ */

const books = require('./books');
const { findDuplicateGroups } = require('../core/duplicates');

function listDuplicateGroups(handleDb) {
  const rows = books.listBooks({}, handleDb);
  if (rows.length < 2) return [];

  const compact = rows.map((r) => ({
    id: r.id,
    title: r.title,
    author: r.author,
    status: r.status,
    isbn: r.isbn,
    publisher: r.publisher,
    pub_year: r.pub_year,
    cover: r.cover,
  }));
  const groups = findDuplicateGroups(compact);
  if (!groups.length) return [];

  const ids = groups.flatMap((g) => g.books.map((b) => b.id));
  const placeholders = ids.map(() => '?').join(',');
  const fileRows = handleDb.prepare(`
    SELECT book, format FROM book_files
    WHERE book IN (${placeholders})
    ORDER BY format
  `).all(...ids);

  const formats = new Map();
  for (const f of fileRows) {
    if (!formats.has(f.book)) formats.set(f.book, []);
    formats.get(f.book).push(f.format);
  }

  return groups.map((g) => ({
    ...g,
    books: g.books.map((b) => ({
      ...b,
      file_formats: (formats.get(b.id) || []).join(', '),
    })),
  }));
}

module.exports = { listDuplicateGroups };
