/* ============================================================
 * 书架页(/shelf) —— 纯网格,页面内不放任何按钮与下拉框
 * 逻辑自旧单页 app.js 拆出;筛选状态存本页闭包,
 * URL 查询参数(?q=&status=&tag=&vl=&sort=)是跨页进入时的初始条件来源。
 * 两个能力的入口:虚拟书库 = 搜索面板的「书库」词条 + 地址栏 ?vl=;
 * 多选 = 长按卡片(手机)或 Ctrl/⌘+点击(电脑)。
 * ============================================================ */

const shelf = {
  q: '', status: '', tag: '', author: '', sort: 'updated', books: [],
  selectMode: false, selected: new Set(),
  vl: '',
};

let fetchSeq = 0; // 请求序号:连续查询时只渲染最后一次的结果,避免旧响应覆盖新结果

async function fetchBooks() {
  const seq = ++fetchSeq;
  const params = new URLSearchParams();
  if (shelf.q) params.set('q', shelf.q);
  if (shelf.status) params.set('status', shelf.status);
  if (shelf.tag) params.set('tag', shelf.tag);
  if (shelf.author) params.set('author', shelf.author);
  if (shelf.vl) params.set('vl', shelf.vl);
  params.set('sort', shelf.sort);

  try {
    const books = await api('/api/books?' + params.toString());
    if (seq !== fetchSeq) return;
    shelf.books = books;
    // 刷新后把已不在当前结果里的书从选择集中剔除(避免对不可见的 id 批量操作)
    if (shelf.selectMode) {
      const visible = new Set(books.map((b) => b.id));
      for (const id of [...shelf.selected]) if (!visible.has(id)) shelf.selected.delete(id);
    }
  } catch (e) {
    if (seq !== fetchSeq) return;
    const msg = String(e.message || '');
    // 地址栏里的 ?vl= 可能指向已被删/改名的书库:退回全部,别让用户卡在错误页
    if (shelf.vl && /虚拟书库/.test(msg)) {
      shelf.vl = '';
      syncUrl();
      invalidateSharedStats();
      toast('该虚拟书库已不存在,已退回全部书籍', true);
      fetchBooks();
      return;
    }
    toast(msg, true);
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
    empty.classList.remove('hidden');
    updateBulkBar();
    return;
  }
  empty.classList.add('hidden');

  for (const book of shelf.books) {
    const card = document.createElement('article');
    const selected = shelf.selected.has(book.id);
    card.className = 'book-card' + (selected ? ' is-selected' : '');
    card.dataset.id = book.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', shelf.selectMode ? `选择《${book.title}》` : `查看《${book.title}》详情`);
    if (shelf.selectMode) card.setAttribute('aria-pressed', String(selected));
    if (book.summary) card.title = book.summary;   // 书架卡片悬停显示简介

    const date = book.status === 'done' && book.finish_date
      ? book.finish_date.slice(0, 10)
      : (book.start_date ? book.start_date.slice(0, 10) : '');

    card.innerHTML = `
      <div class="card-cover">
        ${coverHtml(book)}
        ${shelf.selectMode ? `<span class="select-check" aria-hidden="true">${selected ? '✓' : ''}</span>` : ''}
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

    bindCardGestures(card, book.id);
    grid.appendChild(card);
  }
  updateBulkBar();
}

/* ============ 多选手势(页面上没有多选按钮) ============
 * 进入多选只有两条路:卡片长按 500ms(手机),或 Ctrl/⌘+点击(电脑)。
 * 长按的两个坑:① 手指/鼠标一动就该当作滚动,否则翻页时误进多选;
 * ② 长按生效后浏览器还会补一个 click,不抑制它会立刻又走「打开详情」。 */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 12;
const CLICK_AFTER_PRESS_MS = 500;
let pressTimer = null;
let pressOrigin = null;
let pressIsTouch = false;
// 长按生效后浏览器还会补一个 click(不抑制它会立刻又走「打开详情」)。
// 长按进入多选时网格会整片重渲染,补发的 click 落在同 id 的**新**卡片上,
// 所以按 id 判定而不是按元素;时限内只吞一次,免得误吃用户下一次真点击。
let longPressId = null;
let longPressAt = 0;

function cancelPress() {
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = null;
  pressOrigin = null;
}

function bindCardGestures(card, id) {
  card.addEventListener('pointerdown', (e) => {
    // 带修饰键的按下交给 click 分支处理(Ctrl/⌘+点击),不占用长按
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    cancelPress();
    pressIsTouch = e.pointerType !== 'mouse';
    pressOrigin = { x: e.clientX, y: e.clientY };
    pressTimer = setTimeout(() => {
      cancelPress();
      longPressId = id;
      longPressAt = Date.now();
      if (pressIsTouch && navigator.vibrate) navigator.vibrate(12);
      enterSelectMode(id, card);
    }, LONG_PRESS_MS);
  });
  const moved = (e) => pressOrigin
    && (Math.abs(e.clientX - pressOrigin.x) > LONG_PRESS_SLOP
      || Math.abs(e.clientY - pressOrigin.y) > LONG_PRESS_SLOP);
  card.addEventListener('pointermove', (e) => { if (pressTimer && moved(e)) cancelPress(); });
  card.addEventListener('pointerleave', cancelPress);
  card.addEventListener('pointerup', cancelPress);
  card.addEventListener('pointercancel', cancelPress);
  // 安卓长按会弹系统菜单并吞掉手势;鼠标右键菜单不动
  card.addEventListener('contextmenu', (e) => { if (pressIsTouch) e.preventDefault(); });

  card.addEventListener('click', (e) => {
    if (longPressId === id && Date.now() - longPressAt < CLICK_AFTER_PRESS_MS) {
      longPressId = null;
      return;
    }
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); enterSelectMode(id, card); return; }
    if (shelf.selectMode) toggleSelected(id, card);
    else openDetail(id);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { enterSelectMode(id, card); return; }
    if (shelf.selectMode) toggleSelected(id, card);
    else openDetail(id);
  });
}

function enterSelectMode(id, card) {
  if (shelf.selectMode) { toggleSelected(id, card); return; }
  setSelectMode(true, id);
  toast('多选已开启:点卡片继续勾选,Esc 退出');
}

/* ============ 多选与批量编辑 ============ */
function updateBulkBar() {
  const bar = $('#bulkBar');
  if (!bar) return;
  const n = shelf.selected.size;
  bar.classList.toggle('hidden', !shelf.selectMode || !shelf.books.length);
  $('#bulkCount').textContent = `已选 ${n} 本`;
  $('#bulkEditBtn').disabled = n === 0;
  $('#bulkSaveBtn').textContent = `应用到 ${n} 本`;
}

// preselectId:手势落在哪本书上进入多选 —— 那本书要立刻算选中
function setSelectMode(on, preselectId = null) {
  shelf.selectMode = on;
  shelf.selected.clear();
  if (on && preselectId !== null) shelf.selected.add(preselectId);
  document.body.classList.toggle('select-mode', on);
  if (!on) closeModals();
  renderGrid();
}

function toggleSelected(id, card) {
  if (shelf.selected.has(id)) shelf.selected.delete(id);
  else shelf.selected.add(id);
  const on = shelf.selected.has(id);
  card.classList.toggle('is-selected', on);
  card.setAttribute('aria-pressed', String(on));
  const check = card.querySelector('.select-check');
  if (check) check.textContent = on ? '✓' : '';
  updateBulkBar();
}

function openBulkModal() {
  if (!shelf.selected.size) return;
  $('#bulkStatus').value = '';
  syncCustomSelect($('#bulkStatus'));
  ['bulkRating', 'bulkTagsAdd', 'bulkTagsRemove', 'bulkSeries',
    'bulkSeriesIndex', 'bulkPublisher', 'bulkPubYear']
    .forEach((id) => { $('#' + id).value = ''; });
  $('#bulkError').textContent = '';
  $('#bulkSaveBtn').disabled = false;
  updateBulkBar();
  openModal('#bulkModal');
}

async function applyBulkEdit() {
  const errEl = $('#bulkError');
  errEl.textContent = '';
  const patch = {};

  const status = $('#bulkStatus').value;
  if (status) patch.status = status;
  const tagsAdd = $('#bulkTagsAdd').value.trim();
  if (tagsAdd) patch.tags_add = tagsAdd;
  const tagsRemove = $('#bulkTagsRemove').value.trim();
  if (tagsRemove) patch.tags_remove = tagsRemove;
  const series = $('#bulkSeries').value.trim();
  if (series) patch.series = series;
  const seriesIndex = $('#bulkSeriesIndex').value.trim();
  if (seriesIndex !== '') patch.series_index = seriesIndex;
  const publisher = $('#bulkPublisher').value.trim();
  if (publisher) patch.publisher = publisher;
  const pubYear = $('#bulkPubYear').value.trim();
  if (pubYear) patch.pub_year = pubYear;
  const rating = $('#bulkRating').value.trim();
  if (rating !== '') patch.rating = rating;

  if (!Object.keys(patch).length) {
    errEl.textContent = '至少选择一个要修改的字段';
    return;
  }

  const btn = $('#bulkSaveBtn');
  btn.disabled = true;
  try {
    const res = await api('/api/books/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: [...shelf.selected], patch }),
    });
    closeModals();
    toast(`已更新 ${res.updated} 本`);
    invalidateSharedStats();
    setSelectMode(false);
    fetchBooks();
  } catch (e) {
    errEl.textContent = e.message;
    btn.disabled = false;
  }
}

/* ============ 筛选条件(来自地址栏 / 导航菜单) ============ */
/* 检索是全库检索:只要搜索词非空,就清掉「状态 / 标签 / 作者」条件 ——
   否则会出现在某个标签(或某个状态)下搜索时只在该范围内命中,查不到明明存在的书。
   注意:清空搜索框不会动筛选,只有"发起检索"才清。 */
function clearShelfFilters() {
  shelf.status = '';
  shelf.tag = '';
  shelf.author = '';
}

// 搜索浮层提交(common.js 在书架页派发 shelf-search):
// 不在 input 上实时过滤 —— 浮层盖住书架时过滤不可见,取消后却会留下结果。
document.addEventListener('shelf-search', (e) => {
  shelf.q = String(e.detail.q || '');
  if (shelf.q) clearShelfFilters();
  fetchBooks();
  syncUrl();
});

// 顶栏搜索浮层里的保存项(common.js 派发):套用查询串/虚拟书库 + 排序并写回地址栏
document.addEventListener('saved-search-apply', (e) => {
  const { q = '', sort = 'updated', vl = '' } = e.detail || {};
  shelf.vl = String(vl || '');
  shelf.q = shelf.vl ? '' : String(q);
  $('#searchInput').value = shelf.q;
  if (['updated', 'finish', 'title', 'author', 'series', 'created'].includes(sort)) shelf.sort = sort;
  if (shelf.q || shelf.vl) clearShelfFilters();
  invalidateSharedStats();
  fetchBooks();
  syncUrl();
});

/* ============ 从 URL 恢复筛选条件 ============
 * 其它页面跳来的链接携带条件:/shelf?q=三体、/shelf?tag=科幻、/shelf?status=reading。
 * 搜索浮层常驻 DOM,同步回显 q,界面与条件不脱节。 */
function applyUrlParams() {
  const p = new URLSearchParams(location.search);
  shelf.q = p.get('q') || '';
  shelf.status = p.get('status') || '';
  shelf.tag = p.get('tag') || '';
  shelf.author = p.get('author') || '';
  shelf.vl = p.get('vl') || '';
  if (['updated', 'finish', 'title', 'author', 'series', 'created'].includes(p.get('sort'))) shelf.sort = p.get('sort');

  if (shelf.q) $('#searchInput').value = shelf.q;
}

/* ============ 数据变更刷新 + 地址栏同步 ============ */
// 弹窗保存/删除后:统计缓存已在 common.js 作废,这里只重拉列表
document.addEventListener('books-changed', () => {
  fetchBooks();
});

// 筛选条件写回地址栏(replaceState 不新增历史),刷新/分享保住当前视图
function syncUrl() {
  const p = new URLSearchParams();
  if (shelf.q) p.set('q', shelf.q);
  if (shelf.status) p.set('status', shelf.status);
  if (shelf.tag) p.set('tag', shelf.tag);
  if (shelf.author) p.set('author', shelf.author);
  if (shelf.vl) p.set('vl', shelf.vl);
  if (shelf.sort !== 'updated') p.set('sort', shelf.sort);
  const qs = p.toString();
  history.replaceState(null, '', qs ? '/shelf?' + qs : '/shelf');
}

document.addEventListener('shelf-search', syncUrl);

/* ============ 批量编辑事件(多选由卡片手势进入,页面上没有按钮) ============ */
$('#bulkCancelBtn').addEventListener('click', () => setSelectMode(false));
$('#bulkEditBtn').addEventListener('click', openBulkModal);
$('#bulkSaveBtn').addEventListener('click', applyBulkEdit);
initCustomSelect($('#bulkStatus'));

// 在搜索面板里设/取消虚拟书库:若正用着 ?vl=,该名字可能已失效 → 重拉(失效会退回全部)
document.addEventListener('virtual-libraries-changed', () => {
  if (!shelf.vl) return;
  invalidateSharedStats();
  fetchBooks();
});

// 没有弹窗/搜索/菜单时,Esc 退出多选;有浮层时交给 common.js 逐层关闭
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !shelf.selectMode || e.defaultPrevented) return;
  if (document.body.classList.contains('search-open')
    || document.body.classList.contains('menu-open')
    || document.body.classList.contains('mm-sub-open')) return;
  setSelectMode(false);
});

/* ============ 启动 ============ */
applyUrlParams();
fetchBooks();
