/* ============================================================
 * 统计聚合(纯函数):输入全部书籍行,输出统计对象
 * 与原 SQL 版行为一致:byYear 只统计 status='done' 且 finish_date 非空,
 * topTags 按出现次数降序取前 12 个。
 * ============================================================ */

function computeStats(rows) {
  const total = rows.length;
  const byStatus = { wish: 0, reading: 0, done: 0 };
  const byYear = {};
  const tagCount = {};

  for (const row of rows) {
    if (byStatus[row.status] !== undefined) byStatus[row.status] += 1;

    if (row.status === 'done' && row.finish_date) {
      const y = String(row.finish_date).slice(0, 4);
      byYear[y] = (byYear[y] || 0) + 1;
    }

    let tags = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
    if (!Array.isArray(tags)) tags = [];
    for (const t of tags) {
      if (t) tagCount[t] = (tagCount[t] || 0) + 1;
    }
  }

  const topTags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, count]) => ({ tag, count }));

  return { total, byStatus, byYear, topTags };
}

module.exports = { computeStats };
