/* ============================================================
 * 榜单页(/rank) —— Apple 瓦片节奏:parchment 英雄区 → 暗色重读榜
 * 逻辑自旧单页 app.js 拆出。个人书架数据量小,全量拉取后前端排序。
 * ============================================================ */

const RANK_SIZE = 8;

// 从全量书目计算各榜单
function computeRankings(books) {
  const reread = books
    .filter((b) => (b.read_count || 0) >= 2)
    .sort((a, b) => (b.read_count || 0) - (a.read_count || 0)
      || String(b.finish_date || '').localeCompare(String(a.finish_date || '')))
    .slice(0, RANK_SIZE);
  return { reread };
}

function rankRowsHtml(list, metric) {
  return `<ol class="rank-list">${list.map((b, i) => `
    <li>
      <button type="button" class="rank-row" data-open-detail="${b.id}"
        aria-label="查看《${esc(b.title)}》详情,第 ${i + 1} 名">
        <span class="rank-num">${i + 1}</span>
        <span class="rank-cover">${coverHtml(b)}</span>
        <span class="rank-info">
          <span class="rank-title">${esc(b.title)}</span>
          <span class="rank-meta">${esc([b.author, (b.read_count || 0) > 1 ? `读过 ${b.read_count} 次` : ''].filter(Boolean).join(' · ')) || '&nbsp;'}</span>
        </span>
        <span class="rank-metric">${metric(b)}</span>
      </button>
    </li>`).join('')}</ol>`;
}

function rankBoardHtml(title, sub, list, metric) {
  return `
    <section class="rank-tile">
      <div class="rank-inner">
        <h2 class="rank-board-title">${esc(title)}</h2>
        <p class="rank-board-sub">${esc(sub)}</p>
        ${list.length ? rankRowsHtml(list, metric)
          : '<p class="rank-empty">还没有书被读过两次以上,重读会在这里留下痕迹。</p>'}
      </div>
    </section>`;
}

function renderRank(books, { reread }) {
  const root = $('#rankContent');
  if (!root) return;

  const total = books.length;
  const doneCount = books.filter((b) => b.status === 'done').length;

  root.innerHTML = `
    <section class="rank-tile rank-hero">
      <div class="rank-inner">
        <p class="rank-eyebrow">My books · 榜单</p>
        <h1 class="rank-hero-title">好书,<br>值得被反复翻开。</h1>
        <p class="rank-hero-sub">共 ${total} 本 · 读完 ${doneCount} 本</p>
      </div>
    </section>
    ${rankBoardHtml('重读榜', `读过两次以上的书 · 至多 ${RANK_SIZE} 本`, reread,
      (b) => `<span class="rank-count"><b>${b.read_count}</b> 次</span>`)}
  `;
}

async function loadRankings() {
  let books;
  try {
    books = await api('/api/books');
  } catch {
    return; // 静默:保留上次内容
  }
  renderRank(books, computeRankings(books));
}

// 榜单交互:事件委托,渲染后无需重复绑定
$('#rankContent').addEventListener('click', (e) => {
  const t = e.target.closest('[data-open-detail]');
  if (t) openDetail(Number(t.dataset.openDetail));
});
$('#rankContent').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest('[data-open-detail]');
  if (t) { e.preventDefault(); openDetail(Number(t.dataset.openDetail)); }
});

// 本页数据变更(弹窗保存/删除)后刷新
document.addEventListener('books-changed', loadRankings);

loadRankings();
