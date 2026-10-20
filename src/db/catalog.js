/* ============================================================
 * CSV 目录数据组装(数据访问层)
 *
 * 复用 books.listBooks 的筛选/排序(与书架、/api/books 完全同一套查询),
 * 再把一本书拆成"固定列 + 自定义字段列"的二维表,交给 core/csv 序列化。
 * 参考 calibre library/catalogs/csv_xml.py:字段名做表头,多值字段拼成
 * 可读字符串;本项目额外保留 read_logs/uuid/标识符,便于数据迁移。
 * ============================================================ */

const books = require('./books');
const customFields = require('./custom_fields');
const identifiers = require('./identifiers');
const bookFiles = require('./book_files');

const STATUS_LABEL = { wish: '想读', reading: '在读', done: '已读' };

const FIXED_HEADERS = [
  'id', 'title', 'title_sort', 'author', 'author_sort',
  'status', 'status_label', 'tags', 'series', 'series_index', 'rating',
  'publisher', 'pub_year', 'isbn', 'douban_id',
  'start_date', 'finish_date', 'read_count', 'read_logs',
  'summary', 'notes_url', 'cover', 'uuid',
  'file_formats', 'identifiers', 'created_at', 'updated_at',
];

function parseTags(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.map((t) => String(t)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function formatIdentifiers(map) {
  return Object.entries(map || {})
    .filter(([, value]) => String(value || '').trim())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, value]) => `${type}:${value}`)
    .join('; ');
}

function buildCatalog(handleDb, query = {}) {
  const rows = books.listBooks(query, handleDb);
  const cols = customFields.listColumns(handleDb);
  const headers = [...FIXED_HEADERS, ...cols.map((c) => `#${c.label}`)];

  if (!rows.length) return { headers, rows: [] };

  const ids = rows.map((r) => r.id);
  const custom = customFields.getValuesForBooks(handleDb, ids, { columns: cols });
  const idMap = identifiers.getIdentifiersForBooks(handleDb, ids);
  // 一次查完所有书的文件格式(早期版本在这里写 for 循环逐本 listFiles,
  // 书一多就是 N+1 查询 —— CSV 导出会随书量线性变慢)。
  const fileMap = bookFiles.listFormatsForBooks(handleDb, ids);

  const data = rows.map((r) => {
    const customValues = custom[r.id] || {};
    return [
      r.id,
      r.title,
      r.title_sort,
      r.author,
      r.author_sort,
      r.status,
      STATUS_LABEL[r.status] || r.status,
      parseTags(r.tags).join(', '),
      r.series,
      Number(r.series_index) || '',
      Number(r.rating) || '',
      r.publisher,
      r.pub_year,
      r.isbn,
      r.douban_id,
      r.start_date,
      r.finish_date,
      r.read_count,
      r.read_logs || '[]',
      r.summary,
      r.notes_url,
      r.cover,
      r.uuid,
      (fileMap.get(r.id) || []).join(', '),
      formatIdentifiers(idMap[r.id]),
      r.created_at,
      r.updated_at,
      ...cols.map((c) => customValues[c.label] ?? ''),
    ];
  });

  return { headers, rows: data };
}

module.exports = { buildCatalog, FIXED_HEADERS, STATUS_LABEL };
