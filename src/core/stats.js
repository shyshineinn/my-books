/* ============================================================
 * 统计聚合(纯函数):输入全部书籍行,输出统计对象
 * 与原 SQL 版行为一致:byYear 只统计 status='done' 且 finish_date 非空,
 * topTags 按出现次数降序取前 12 个。
 * 作者/出版社同样取前 12:
 *   · 作者从 books.author 展示缓存拆分(「、」连接,由 categories 与链接表同步维护);
 *   · 出版社按去空白后的原值分组(库中没有出版社归一化表)。
 * ============================================================ */

const { splitAuthors } = require('./book');

const TOP_LIMIT = 12;

function topN(countMap) {
  return Object.entries(countMap)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, TOP_LIMIT)
    .map(([name, count]) => ({ name, count }));
}

function computeStats(rows) {
  const total = rows.length;
  const byStatus = { wish: 0, reading: 0, done: 0 };
  const byYear = {};
  const tagCount = {};
  const authorCount = {};
  const publisherCount = {};

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

    for (const author of splitAuthors(row.author)) {
      authorCount[author] = (authorCount[author] || 0) + 1;
    }

    const publisher = String(row.publisher || '').trim();
    if (publisher) publisherCount[publisher] = (publisherCount[publisher] || 0) + 1;
  }

  const topTags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_LIMIT)
    .map(([tag, count]) => ({ tag, count }));

  return {
    total,
    byStatus,
    byYear,
    topTags,
    authorTotal: Object.keys(authorCount).length,
    publisherTotal: Object.keys(publisherCount).length,
    topAuthors: topN(authorCount),
    topPublishers: topN(publisherCount),
  };
}

module.exports = { computeStats };
