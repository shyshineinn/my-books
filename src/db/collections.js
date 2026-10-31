/* ============================================================
 * 手动藏书集(数据访问层)
 *
 * collections         分组本身:名称大小写不敏感唯一
 * book_collections    书与分组的多对多关系;成员变化不是书目元数据,
 *                     不推进 books.revision/updated_at,避免污染安卓增量同步。
 *
 * 与 tags 的区别:标签是书上的可编辑字段,藏书集是独立分组;
 * 一本书可以同时属于多个藏书集,删除藏书集不会删除书。
 * ============================================================ */

const { inClause, scopeClause } = require('../core/sql');
const { inTransaction } = require('./index');

const MAX_NAME = 100;
const MAX_BATCH = 1000;

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'VALIDATION' });
}

function normalizeName(name) {
  const value = String(name == null ? '' : name).trim();
  if (!value) throw badRequest('藏书集名称不能为空');
  if (value.length > MAX_NAME) throw badRequest(`藏书集名称不能超过 ${MAX_NAME} 字`);
  return value;
}

function normalizeIds(ids) {
  if (!Array.isArray(ids) || !ids.length) throw badRequest('ids 应为非空数组');
  if (ids.length > MAX_BATCH) throw badRequest(`一次最多处理 ${MAX_BATCH} 本书`);
  const values = [...new Set(ids.map(Number))];
  if (values.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw badRequest('ids 只能包含正整数');
  }
  return values;
}

function now() {
  return new Date().toISOString();
}

function getCollection(handleDb, id) {
  return handleDb.prepare('SELECT id, name, created_at, updated_at FROM collections WHERE id = ?').get(id) || null;
}

// 列表带计数;虚拟书库作用域放在 JOIN 条件里,零成员的藏书集仍然保留。
function listCollections(handleDb, { scopeIds = null } = {}) {
  const scope = scopeIds ? scopeClause('b.id', scopeIds) : null;
  const scopeSql = scope ? ` AND ${scope.sql}` : '';
  const params = scope ? scope.params : [];
  return handleDb.prepare(`
    SELECT c.id, c.name, COUNT(b.id) AS count
    FROM collections c
    LEFT JOIN book_collections bc ON bc.collection_id = c.id
    LEFT JOIN books b ON b.id = bc.book_id AND b.deleted_at IS NULL${scopeSql}
    GROUP BY c.id
    ORDER BY c.name COLLATE NOCASE
  `).all(...params);
}

function createCollection(handleDb, name) {
  const value = normalizeName(name);
  const ts = now();
  try {
    const r = handleDb
      .prepare('INSERT INTO collections(name, created_at, updated_at) VALUES (?, ?, ?)')
      .run(value, ts, ts);
    return { ...getCollection(handleDb, Number(r.lastInsertRowid)), count: 0 };
  } catch (err) {
    if (/UNIQUE constraint failed: collections.name/i.test(err.message)) {
      throw Object.assign(new Error('该藏书集名称已存在'), { code: 'CONFLICT' });
    }
    throw err;
  }
}

function renameCollection(handleDb, id, name) {
  const value = normalizeName(name);
  const existing = getCollection(handleDb, id);
  if (!existing) return null;
  try {
    handleDb.prepare('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?')
      .run(value, now(), id);
    return { ...getCollection(handleDb, id), count: countBooks(handleDb, id) };
  } catch (err) {
    if (/UNIQUE constraint failed: collections.name/i.test(err.message)) {
      throw Object.assign(new Error('该藏书集名称已存在'), { code: 'CONFLICT' });
    }
    throw err;
  }
}

function removeCollection(handleDb, id) {
  return handleDb.prepare('DELETE FROM collections WHERE id = ?').run(id).changes > 0;
}

function countBooks(handleDb, id) {
  return handleDb.prepare(`
    SELECT COUNT(*) AS n FROM book_collections bc
    JOIN books b ON b.id = bc.book_id AND b.deleted_at IS NULL
    WHERE bc.collection_id = ?
  `).get(id).n;
}

// 加入是幂等的;不存在的书、回收站里的书静默跳过。
function addBooks(handleDb, collectionId, ids) {
  const values = normalizeIds(ids);
  const ts = now();
  const insert = handleDb.prepare(`
    INSERT OR IGNORE INTO book_collections(collection_id, book_id, added_at)
    SELECT ?, b.id, ? FROM books b WHERE b.id = ? AND b.deleted_at IS NULL
  `);
  let added = 0;
  inTransaction(handleDb, () => {
    for (const bookId of values) added += insert.run(collectionId, ts, bookId).changes;
  });
  return added;
}

function removeBooks(handleDb, collectionId, ids) {
  const values = normalizeIds(ids);
  const remove = handleDb.prepare('DELETE FROM book_collections WHERE collection_id = ? AND book_id = ?');
  let removed = 0;
  inTransaction(handleDb, () => {
    for (const bookId of values) removed += remove.run(collectionId, bookId).changes;
  });
  return removed;
}

function listForBook(handleDb, bookId) {
  return handleDb.prepare(`
    SELECT c.id, c.name
    FROM book_collections bc
    JOIN collections c ON c.id = bc.collection_id
    WHERE bc.book_id = ?
    ORDER BY c.name COLLATE NOCASE
  `).all(bookId);
}

// CSV 导出:一次取完一批书的藏书集名称,避免逐本 N+1。
function listNamesForBooks(handleDb, bookIds) {
  const ids = [...new Set((bookIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const clause = inClause('bc.book_id', ids);
  const rows = handleDb.prepare(`
    SELECT bc.book_id AS book, c.name
    FROM book_collections bc
    JOIN collections c ON c.id = bc.collection_id
    WHERE ${clause.sql}
    ORDER BY c.name COLLATE NOCASE, c.id
  `).all(...clause.params);
  for (const row of rows) {
    if (!map.has(row.book)) map.set(row.book, []);
    map.get(row.book).push(row.name);
  }
  return map;
}

// CSV 导入:按名称找到或创建藏书集,再把书加入;已属于同一集时保持幂等。
// 名称大小写去重,空名称/超长名称会在建集前抛 VALIDATION。
function addBookToCollections(handleDb, bookId, names) {
  const values = [];
  const seen = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    const name = normalizeName(raw);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(name);
  }
  if (!values.length) return 0;
  const find = handleDb.prepare('SELECT id FROM collections WHERE name = ? COLLATE NOCASE');
  const insertLink = handleDb.prepare(`
    INSERT OR IGNORE INTO book_collections(collection_id, book_id, added_at)
    SELECT ?, id, ? FROM books WHERE id = ? AND deleted_at IS NULL
  `);
  const ts = now();
  let added = 0;
  inTransaction(handleDb, () => {
    for (const name of values) {
      let row = find.get(name);
      if (!row) row = createCollection(handleDb, name);
      added += insertLink.run(row.id, ts, bookId).changes;
    }
  });
  return added;
}

// 合并书籍:把来源书的成员关系并到目标书;目标已在同一藏书集时保持一条。
function mergeForBook(handleDb, sourceId, targetId) {
  return handleDb.prepare(`
    INSERT OR IGNORE INTO book_collections(collection_id, book_id, added_at)
    SELECT collection_id, ?, added_at FROM book_collections WHERE book_id = ?
  `).run(targetId, sourceId).changes;
}

module.exports = {
  MAX_NAME, MAX_BATCH,
  listCollections, getCollection, createCollection, renameCollection, removeCollection,
  addBooks, removeBooks, countBooks, listForBook, listNamesForBooks, addBookToCollections, mergeForBook,
};
