/* ============================================================
 * 统计聚合(纯函数)
 *
 * 双数据库下的分工:
 *   · computeReadingStats —— 只管 reading 表算得出的(状态分布/按年读完/重读榜)
 *   · topTags            —— 标签在 calibre 侧,由路由层取回标签后调用
 *   · computeStats       —— 旧 books 表单表版本,保留仅为兼容既有测试/调用方,
 *                          新代码请用上面两个
 * ============================================================ */

/* 阅读统计:输入阅读记录行(reading 表全量) */
function computeReadingStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byStatus = { wish: 0, reading: 0, done: 0 };
  const byYear = {};

  for (const row of list) {
    if (byStatus[row.status] !== undefined) byStatus[row.status] += 1;

    // byYear 只统计"已读完且有读完日期"的
    if (row.status === 'done' && row.finish_date) {
      const y = String(row.finish_date).slice(0, 4);
      if (/^\d{4}$/.test(y)) byYear[y] = (byYear[y] || 0) + 1;
    }
  }

  // 重读榜:读过两次以上,按次数降序(榜单页用)
  const rereads = list
    .filter((r) => (r.read_count || 0) > 1)
    .map((r) => ({ calibre_uuid: r.calibre_uuid, read_count: r.read_count }))
    .sort((a, b) => b.read_count - a.read_count);

  return { total: list.length, byStatus, byYear, rereads };
}

/* 标签分布:输入标签数组的数组,输出 Top N。标签来自 calibre 元数据。 */
function topTags(tagLists, limit = 12) {
  const count = {};
  for (const tags of tagLists || []) {
    for (const t of Array.isArray(tags) ? tags : []) {
      if (t) count[t] = (count[t] || 0) + 1;
    }
  }
  return Object.entries(count)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, n]) => ({ tag, count: n }));
}

/* ---------- 旧版(books 表单表):保留兼容 ---------- */
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

  const top = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, count]) => ({ tag, count }));

  return { total, byStatus, byYear, topTags: top };
}

module.exports = { computeReadingStats, topTags, computeStats };
