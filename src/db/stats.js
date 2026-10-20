/* ============================================================
 * 统计(数据访问层):取全量行后交给 core/computeStats 聚合。
 * 个人书架数据量小,全表扫描即可;行为与原 SQL 聚合版一致。
 * scopeIds(虚拟书库)只让统计口径跟着收窄,聚合规则不变。
 * ============================================================ */

const { db } = require('./index');
const { computeStats } = require('../core/stats');
const { inClause } = require('../core/sql');

// handleDb 可选,便于测试用 openDb(临时目录) 隔离
function getStats(handleDb = db, scopeIds = null) {
  const scope = Array.isArray(scopeIds) ? ` AND ${inClause('id', scopeIds).sql}` : '';
  const params = Array.isArray(scopeIds) ? inClause('id', scopeIds).params : [];
  return computeStats(handleDb.prepare(`
    SELECT status, tags, finish_date, author, publisher
    FROM books
    WHERE deleted_at IS NULL${scope}
  `).all(...params));
}

module.exports = { getStats };
