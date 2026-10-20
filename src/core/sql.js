/* ============================================================
 * SQL 片段助手(纯函数,无 I/O)
 *
 * inClause 给「按 id 集合限定作用域」这类查询统一生成占位符:
 * 空集合 = 1 = 0(谁都不命中),超大集合按块 OR(SQLite 变量数有上限)。
 * ============================================================ */

const MAX_IN_CHUNK = 500;

function inClause(column, ids) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return { sql: '1 = 0', params: [] };
  const chunks = [];
  const params = [];
  for (let i = 0; i < list.length; i += MAX_IN_CHUNK) {
    const part = list.slice(i, i + MAX_IN_CHUNK);
    chunks.push(`${column} IN (${part.map(() => '?').join(', ')})`);
    params.push(...part);
  }
  return { sql: chunks.length > 1 ? `(${chunks.join(' OR ')})` : chunks[0], params };
}

module.exports = { inClause, MAX_IN_CHUNK };
