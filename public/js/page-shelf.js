/* ============================================================
 * 书架页(/shelf) —— 网格 + 状态页签 + 标签/排序筛选 + 实时搜索
 * 逻辑自旧单页 app.js 拆出;筛选状态存本页闭包,
 * URL 查询参数(?q=&status=&tag=&sort=)是跨页进入时的初始条件来源。
 * ============================================================ */

const shelf = {
  q: '', status: '', tag: '', author: '', sort: 'updated', books: [],
};

let fetchSeq = 0; // 请求序号:连续查询时只渲染最后一次的结果,避免旧响应覆盖新结果

async function fetchBooks() {
  const seq = ++fetchSeq;
  const params = new URLSearchParams();
  if (shelf.q) params.set('q', shelf.q);
  if (shelf.status) params.set('status', shelf.status);
  if (shelf.tag) params.set('tag', shelf.tag);
  if (shelf.author) params.set('author', shelf.author);
  params.set('sort', shelf.sort);

  try {
    const books = await api('/api/books?' + params.toString());
    if (seq !== fetchSeq) return;
    shelf.books = books;
  } catch (e) {
    if (seq !== fetchSeq) return;
    toast(e.message, true);
    shelf.books = [];
  }
  renderGrid();
}

function renderGrid() {
  const grid = $('#bookGrid');
  const empty = $('#emptyState');
  grid.innerHTML = '';
  const filtered = shelf.q || shelf.status || shelf.tag || shelf.author;

  if (!shelf.books.length) {
    if (filtered) {
      $('#emptyTitle').textContent = '没有找到匹配的书籍';
      $('#emptyText').textContent = '试试调整搜索或筛选条件';
    } else {
      $('#emptyTitle').textContent = '书架还是空的';
      $('#emptyText').textContent = '添加第一本书,开始你的阅读记录之旅。';
    }
    $('#emptyAddBtn').classList.toggle('hidden', !!filtered);
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const book of shelf.books) {
    const card = document.createElement('article');
    card.className = 'book-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `查看《${book.title}》详情`);
    if (book.summary) card.title = book.summary;   // 书架卡片悬停显示简介

    const date = book.status === 'done' && book.finish_date
      ? book.finish_date.slice(0, 10)
      : (book.start_date ? book.start_date.slice(0, 10) : '');

    card.innerHTML = `
      <div class="card-cover">
        ${coverHtml(book)}
        <span class="status-badge ${book.status}">${STATUS_LABEL[book.status]}</span>
        ${book.file_formats ? `<span class="card-file-badge" title="已有电子书文件: ${esc(book.file_formats)}">📁 ${esc(book.file_formats)}</span>` : ''}
      </div>
      <div class="card-info">
        <div class="card-title">${esc(book.title)}</div>
        ${book.author ? `<div class="card-author">${esc(book.author)}</div>` : ''}
        <div class="card-meta">
          ${book.notes_url ? '<span class="has-notes" title="这本书有读书心得">✎ 心得</span>' : ''}
          ${date ? `<span class="card-date">${esc(date)}</span>` : ''}
        </div>
      </div>`;

    card.addEventListener('click', () => openDetail(book.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(book.id); }
    });
    grid.appendChild(card);
  }
}

/* ============ 页签计数与标签下拉(共享 /api/stats) ============ */
async function loadShelfStats() {
  const data = await sharedStats();
  if (!data) return;
  $('#countAll').textContent = data.total;
  $('#countWish').textContent = data.byStatus.wish;
  $('#countReading').textContent = data.byStatus.reading;
  $('#countDone').textContent = data.byStatus.done;
  updateTagFilter(data.topTags);
}

function updateTagFilter(topTags) {
  const sel = $('#tagFilter');
  const current = shelf.tag;
  const tags = [...topTags.map((t) => t.tag)];
  if (current && !tags.includes(current)) tags.unshift(current);
  sel.innerHTML = '<option value="">全部标签</option>' +
    tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  sel.value = current;
  syncCustomSelect(sel);   // 选项集合重建后,同步自定义下拉面板
}

// 作者下拉取自归一化后的 /api/authors(全量,带引用数)
async function loadAuthorFilter() {
  let authors;
  try {
    authors = await api('/api/authors');
  } catch { return; }   // 拉取失败静默:保留「全部作者」,不影响其它筛选
  const sel = $('#authorFilter');
  const current = shelf.author;
  const names = authors.map((a) => a.name);
  if (current && !names.includes(current)) names.unshift(current);
  sel.innerHTML = '<option value="">全部作者</option>' +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = current;
  syncCustomSelect(sel);
}

initCustomSelect($('#authorFilter'));
initCustomSelect($('#tagFilter'));
initCustomSelect($('#sortSelect'));

/* ============ 筛选交互 ============ */
$('#statusTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  shelf.status = btn.dataset.status;
  $$('#statusTabs button').forEach((b) => b.classList.toggle('active', b === btn));
  fetchBooks();
});

$('#tagFilter').addEventListener('change', () => {
  shelf.tag = $('#tagFilter').value;
  fetchBooks();
});

$('#authorFilter').addEventListener('change', () => {
  shelf.author = $('#authorFilter').value;
  fetchBooks();
});

$('#sortSelect').addEventListener('change', () => {
  shelf.sort = $('#sortSelect').value;
  fetchBooks();
});

/* 检索是全库检索:只要搜索词非空,就清掉「状态 / 标签」筛选 ——
   否则会出现在某个标签(或某个状态)下搜索时只在该范围内命中,查不到明明存在的书。
   筛选 UI 一并回到「全部 / 全部标签」,避免界面与实际条件脱节。
   注意:清空搜索框不会动筛选,只有"发起检索"才清。 */
function clearShelfFilters() {
  if (!shelf.status && !shelf.tag && !shelf.author) return;
  shelf.status = '';
  shelf.tag = '';
  shelf.author = '';
  $$('#statusTabs button').forEach((b) => b.classList.toggle('active', b.dataset.status === ''));
  for (const id of ['#tagFilter', '#authorFilter']) {
    const sel = $(id);
    if (sel) {
      sel.value = '';
      syncCustomSelect(sel);   // 程序改 value 不触发 change,自定义下拉需手动同步
    }
  }
}

// 搜索浮层提交(common.js 在书架页派发 shelf-search):
// 不在 input 上实时过滤 —— 浮层盖住书架时过滤不可见,取消后却会留下结果。
document.addEventListener('shelf-search', (e) => {
  shelf.q = String(e.detail.q || '');
  if (shelf.q) clearShelfFilters();
  fetchBooks();
  syncUrl();
});

// 顶栏搜索浮层里的保存项(common.js 派发):套用查询串 + 排序并写回地址栏
document.addEventListener('saved-search-apply', (e) => {
  const { q = '', sort = 'updated' } = e.detail || {};
  shelf.q = String(q);
  $('#searchInput').value = shelf.q;
  const sortSel = $('#sortSelect');
  if ([...sortSel.options].some((o) => o.value === sort)) {
    shelf.sort = sort;
    sortSel.value = sort;
    syncCustomSelect(sortSel);   // 程序改 value 不触发 change,自定义下拉需手动同步
  }
  if (shelf.q) clearShelfFilters();
  fetchBooks();
  syncUrl();
});

$('#emptyAddBtn').addEventListener('click', () => openBookModal(null));

/* ============ 从 URL 恢复筛选条件 ============
 * 其它页面跳来的链接携带条件:/shelf?q=三体、/shelf?tag=科幻、/shelf?status=reading。
 * 搜索浮层常驻 DOM,同步回显 q,界面与条件不脱节。 */
function applyUrlParams() {
  const p = new URLSearchParams(location.search);
  shelf.q = p.get('q') || '';
  shelf.status = p.get('status') || '';
  shelf.tag = p.get('tag') || '';
  shelf.author = p.get('author') || '';
  if (['updated', 'finish', 'title', 'author', 'series', 'created'].includes(p.get('sort'))) shelf.sort = p.get('sort');

  if (shelf.q) $('#searchInput').value = shelf.q;
  if (shelf.sort !== 'updated') {
    const sortSel = $('#sortSelect');
    sortSel.value = shelf.sort;
    syncCustomSelect(sortSel);
  }
  if (shelf.status) {
    $$('#statusTabs button').forEach((b) => b.classList.toggle('active', b.dataset.status === shelf.status));
  }
}

/* ============ 数据变更刷新 + 地址栏同步 ============ */
// 弹窗保存/删除后:统计缓存已在 common.js 作废,这里只重拉列表与计数
document.addEventListener('books-changed', () => {
  fetchBooks();
  loadShelfStats();
  loadAuthorFilter();
});

// 筛选条件写回地址栏(replaceState 不新增历史),刷新/分享保住当前视图
function syncUrl() {
  const p = new URLSearchParams();
  if (shelf.q) p.set('q', shelf.q);
  if (shelf.status) p.set('status', shelf.status);
  if (shelf.tag) p.set('tag', shelf.tag);
  if (shelf.author) p.set('author', shelf.author);
  if (shelf.sort !== 'updated') p.set('sort', shelf.sort);
  const qs = p.toString();
  history.replaceState(null, '', qs ? '/shelf?' + qs : '/shelf');
}

document.addEventListener('shelf-search', syncUrl);
$('#statusTabs').addEventListener('click', syncUrl);
$('#tagFilter').addEventListener('change', syncUrl);
$('#authorFilter').addEventListener('change', syncUrl);
$('#sortSelect').addEventListener('change', syncUrl);

/* ============ 启动 ============ */
applyUrlParams();
fetchBooks();
loadShelfStats();
loadAuthorFilter();
