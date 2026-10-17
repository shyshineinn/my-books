/* ============================================================
 * 统计页(/stats) —— 阅读印象英雄区 + 每年读完柱状图 + 标签云
 * + 作者 / 出版社排行
 * 逻辑自旧单页 app.js 拆出;/api/stats 全站只拉一次(sharedStats)。
 * ============================================================ */

function renderStats(data) {
  const donePct = data.total ? Math.round((data.byStatus.done / data.total) * 100) : 0;
  $('#statsHero').innerHTML = `
    <h2>阅读印象</h2>
    <p class="hero-sub">书架上陈列着 ${data.total} 本书,其中 ${data.byStatus.done} 本已抵达终点。</p>
    <div class="stats-hero-grid">
      <div class="hstat"><span class="num">${data.total}</span><span class="label">总藏书</span></div>
      <div class="hstat"><span class="num">${data.byStatus.done}<small> · ${donePct}%</small></span><span class="label">已读</span></div>
      <div class="hstat"><span class="num">${data.byStatus.reading}</span><span class="label">在读</span></div>
      <div class="hstat"><span class="num">${data.byStatus.wish}</span><span class="label">想读</span></div>
    </div>`;

  renderYearChart(data.byYear);
  renderTagCloud(data.topTags);

  $('#authorTotal').textContent = data.authorTotal ? `共 ${data.authorTotal} 位` : '';
  $('#publisherTotal').textContent = data.publisherTotal ? `共 ${data.publisherTotal} 家` : '';
  renderRank('#authorRank', data.topAuthors,
    (name) => '/shelf?author=' + encodeURIComponent(name), '还没有作者信息');
  renderRank('#publisherRank', data.topPublishers,
    (name) => '/shelf?q=' + encodeURIComponent(`publisher:"${name}"`), '还没有出版社信息');
}

function renderYearChart(byYear) {
  const el = $('#yearChart');
  const years = Object.keys(byYear).sort();
  if (!years.length) {
    el.innerHTML = '<div class="chart-empty">还没有读完的书,加油!</div>';
    return;
  }
  const max = Math.max(...years.map((y) => byYear[y]));
  el.innerHTML = `<div class="year-chart">${years.map((y) => `
    <div class="year-col" title="${y} 年读完 ${byYear[y]} 本">
      <span class="year-num">${byYear[y]}</span>
      <div class="year-bar-wrap"><div class="year-bar" style="height:${Math.max((byYear[y] / max) * 100, 6)}%"></div></div>
      <span class="year-label">${y}</span>
    </div>`).join('')}</div>`;
}

// 标签云点击 → 跳书架页并按该标签筛选(跨页导航,URL 携带条件)
function renderTagCloud(topTags) {
  const el = $('#tagCloud');
  if (!topTags.length) {
    el.innerHTML = '<div class="chart-empty">还没有标签</div>';
    return;
  }
  el.innerHTML = topTags.map(({ tag, count }) =>
    `<a class="tag-chip" href="/shelf?tag=${encodeURIComponent(tag)}">${esc(tag)} <b>${count}</b></a>`
  ).join('');
}

// 作者 / 出版社排行:横向比例条 + 名称 + 数量;点击跳书架对应筛选
function renderRank(sel, items, hrefOf, emptyText) {
  const el = $(sel);
  if (!items.length) {
    el.innerHTML = `<div class="chart-empty">${emptyText}</div>`;
    return;
  }
  const max = Math.max(...items.map((x) => x.count));
  el.innerHTML = items.map(({ name, count }) => `
    <a class="stat-rank-row" href="${hrefOf(name)}" title="${esc(name)} · ${count} 本">
      <span class="stat-rank-bar" style="width:${Math.max((count / max) * 100, 6)}%"></span>
      <span class="stat-rank-name">${esc(name)}</span>
      <span class="stat-rank-count">${count}</span>
    </a>`).join('');
}

async function loadStats() {
  const data = await sharedStats();
  if (!data) return;
  renderStats(data);
}

initCollapsibleSections('.stats-panels > .panel', 'h3');

// 本页数据变更(弹窗保存/删除)后刷新:作废共享缓存再重拉
document.addEventListener('books-changed', () => {
  invalidateSharedStats();
  loadStats();
});

loadStats();
