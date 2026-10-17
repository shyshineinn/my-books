/* ============================================================
 * 统计(数据访问层):取全量行后交给 core/computeStats 聚合。
 * 个人书架数据量小,全表扫描即可;行为与原 SQL 聚合版一致。
 * ============================================================ */

const { db } = require('./index');
const { computeStats } = require('../core/stats');

function getStats() {
  return computeStats(db.prepare('SELECT status, tags, finish_date, author, publisher FROM books').all());
}

module.exports = { getStats };
