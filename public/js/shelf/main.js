/* ============================================================
 * 书架工作区:启动、筛选联动、选择手势与浮层
 * ============================================================ */

(function () {
  const S = window.ShelfUI;
  const state = () => S.state;
  const isMobile = () => window.matchMedia('(max-width: 899px)').matches;
  let viewSeq = 0;
  let longPressTimer = null;
  let longPressOrigin = null;
  let longPressId = null;
  let longPressAt = 0;

  function activeFilters() {
    const s = state();
    return !!(s.q || s.status || s.collection || s.tag || s.author || s.series || s.vl);
  }

  function updateCount() {
    const el = $('#wbCount');
    if (!el) return;
    const s = state();
    if (s.total === null || !activeFilters()) { el.textContent = ''; return; }
    el.textContent = s.facets.total
      ? `${s.total} 本 / 共 ${s.facets.total}`
      : `${s.total} 本`;
  }

  function updateEmpty() {
    const s = state();
    const empty = $('#emptyState');
    if (!empty) return;
    const isEmpty = s.books.length === 0;
    empty.classList.toggle('hidden', !isEmpty);
    if (!isEmpty) return;
    const title = $('#emptyTitle');
    const text = $('#emptyText');
    if (title) title.textContent = activeFilters() ? '没有找到匹配的书籍' : '书架还是空的';
    if (text) text.textContent = activeFilters() ? '试试调整左侧分类或搜索条件' : '添加第一本书,开始你的阅读记录之旅。';
  }

  function updateSidebar() {
    S.sidebar.render();
    updateCount();
  }

  function applyView() {
    const buttons = $$('#wbViewToggle button');
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.view === state().view));
  }

  function renderBooks(result) {
    if (!result) return;
    if (result.append) S.grid.append(result.rows);
    else S.grid.render(state().books);
    updateEmpty();
    updateCount();
  }

  async function loadMore() {
    if (state().loading || !state().hasMore) return;
    try {
      const result = await S.loadPage({ append: true });
      if (result) renderBooks(result);
    } catch (err) {
      toast(err.message, true);
    }
  }

  function clearSelectionAndInspector() {
    S.actions.clearSelection();
    if (state().inspectorOpen) S.inspector.hide();
  }

  async function reloadAll({ keepScroll = false } = {}) {
    const seq = ++viewSeq;
    S.resetPage();
    clearSelectionAndInspector();
    if (!keepScroll) S.grid.scrollTop();
    const [page] = await Promise.all([S.loadPage(), S.loadFacets()]);
    if (seq !== viewSeq) return;
    updateSidebar();
    S.grid.render(state().books);
    updateEmpty();
    updateCount();
  }

  async function filterChanged({ refreshFacets = false, reload = false } = {}) {
    const seq = ++viewSeq;
    syncSortUI();
    clearSelectionAndInspector();
    if (isMobile()) $('#shelfWorkbench').classList.add('sidebar-collapsed');
    S.syncUrl();
    if (refreshFacets) await S.loadFacets();
    if (seq !== viewSeq) return;
    if (reload) {
      await reloadAll();
      return;
    }
    S.resetPage();
    S.grid.scrollTop();
    updateSidebar();
    try {
      const result = await S.loadPage();
      if (seq !== viewSeq) return;
      S.grid.render(state().books);
      updateEmpty();
      updateCount();
    } catch (err) {
      if (seq !== viewSeq) return;
      if (state().vl && /虚拟书库/.test(String(err.message || ''))) {
        state().vl = '';
        S.syncUrl();
        toast('该虚拟书库已不存在,已退回全部书籍', true);
        return filterChanged({ refreshFacets: true });
      }
      toast(err.message, true);
      S.grid.render([]);
      updateEmpty();
    }
  }

  async function applySearch(q, { resetSort = true } = {}) {
    const s = state();
    s.q = String(q || '');
    if (resetSort && s.q && s.sort === 'updated') s.sort = 'relevance';
    if (!s.q && s.sort === 'relevance') s.sort = 'updated';
    syncSortUI();
    await filterChanged();
  }

  function syncSortUI() {
    const select = $('#wbSort');
    if (!select) return;
    let relevance = select.querySelector('option[value="relevance"]');
    if (state().q && !relevance) {
      relevance = document.createElement('option');
      relevance.value = 'relevance';
      relevance.textContent = '相关度';
      select.insertBefore(relevance, select.firstChild);
    } else if (!state().q && relevance) {
      relevance.remove();
      if (state().sort === 'relevance') state().sort = 'updated';
    }
    select.value = state().sort;
    if (typeof syncCustomSelect === 'function') syncCustomSelect(select);
  }

  function closeBrandMenu() {
    const brand = $('#wbBrand');
    const menu = $('#wbBrandMenu');
    if (!brand || !menu) return;
    brand.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
  }

  function bindChrome() {
    if (typeof initCustomSelect === 'function') initCustomSelect($('#wbSort'));
    syncSortUI();

    $('#wbBrand').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('#wbBrandMenu');
      const open = menu.hidden;
      menu.hidden = !open;
      $('#wbBrand').setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#wbBrand') && !e.target.closest('#wbBrandMenu')) closeBrandMenu();
    });

    $('#wbAdd').addEventListener('click', () => {
      if (typeof openBookModal === 'function') openBookModal(null);
    });

    $('#wbSort').addEventListener('change', async (e) => {
      state().sort = state().q && e.target.value === 'updated' ? 'relevance' : e.target.value;
      syncSortUI();
      S.syncUrl();
      await filterChanged();
    });

    $('#wbViewToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn) return;
      state().view = btn.dataset.view;
      applyView();
      S.syncUrl();
      S.grid.render(state().books);
      S.actions.syncSelection();
      updateEmpty();
    });

    $('#wbSidebarToggle').addEventListener('click', () => {
      const wb = $('#shelfWorkbench');
      const collapsed = wb.classList.toggle('sidebar-collapsed');
      $('#wbSidebarToggle').setAttribute('aria-pressed', String(!collapsed));
      $('#wbSidebarToggle').setAttribute('aria-label', collapsed ? '显示资料库' : '隐藏资料库');
      try { localStorage.setItem('shelf.sidebar', collapsed ? 'closed' : 'open'); } catch { /* ignore */ }
    });

    $('#wbInspectorToggle').addEventListener('click', () => S.inspector.toggle());
    $('#shelfSearchBtn').addEventListener('click', () => {
      if (document.body.classList.contains('search-open') && typeof window.closeSearchOverlay === 'function') {
        window.closeSearchOverlay(false);
        $('#shelfSearchBtn').focus();
      } else if (typeof window.openSearchOverlay === 'function') {
        window.openSearchOverlay();
      }
    });
    $('#wbSearchClose').addEventListener('click', () => {
      if (typeof window.closeSearchOverlay === 'function') window.closeSearchOverlay(false);
      $('#shelfSearchBtn').focus();
    });
    const syncSearchClose = () => {
      const open = document.body.classList.contains('search-open');
      $('#wbSearchClose').hidden = !open;
    };
    new MutationObserver(syncSearchClose).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    syncSearchClose();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.defaultPrevented) return;
      if (e.key === 'Escape') {
        closeBrandMenu();
        if (state().inspectorOpen) { S.inspector.hide(); return; }
        if (state().selection.size) { S.actions.clearSelection(); return; }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (typeof window.openSearchOverlay === 'function') window.openSearchOverlay();
      }
    });

    if (isMobile()) {
      $('#shelfWorkbench').classList.add('sidebar-collapsed');
    } else {
      let saved = 'open';
      try { saved = localStorage.getItem('shelf.sidebar') || 'open'; } catch { /* ignore */ }
      if (saved === 'closed') $('#shelfWorkbench').classList.add('sidebar-collapsed');
    }
    const collapsed = $('#shelfWorkbench').classList.contains('sidebar-collapsed');
    $('#wbSidebarToggle').setAttribute('aria-pressed', String(!collapsed));
    $('#wbSidebarToggle').setAttribute('aria-label', collapsed ? '显示资料库' : '隐藏资料库');

    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
      const now = isMobile();
      if (now && !wasMobile) {
        $('#shelfWorkbench').classList.add('sidebar-collapsed');
        $('#wbSidebarToggle').setAttribute('aria-pressed', 'false');
      }
      wasMobile = now;
    });
  }

  function bindGridEvents() {
    const grid = $('#bookGrid');
    grid.addEventListener('click', (e) => {
      if (e.target.closest('th')) return;
      const target = e.target.closest('[data-id]');
      if (!target) {
        if (state().selection.size) S.actions.clearSelection();
        return;
      }
      if (e.target.closest('th[data-sort]')) return;
      const id = Number(target.dataset.id);
      if (longPressId === id && Date.now() - longPressAt < 500) { longPressId = null; return; }
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); S.actions.toggleSelected(id); return; }
      if (e.shiftKey) { e.preventDefault(); S.actions.selectRange(id); return; }
      if (state().selectMode) { S.actions.toggleSelected(id); return; }
      if (isMobile()) {
        if (typeof window.openDetail === 'function') window.openDetail(id);
      } else {
        S.actions.selectOnly(id);
      }
    });

    grid.addEventListener('dblclick', (e) => {
      const target = e.target.closest('[data-id]');
      if (!target) return;
      e.preventDefault();
      if (typeof window.openDetail === 'function') window.openDetail(Number(target.dataset.id));
    });

    grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target.closest('[data-id]');
      if (!target) return;
      e.preventDefault();
      S.actions.selectOnly(Number(target.dataset.id));
    });

    grid.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      state().sort = th.dataset.sort === 'updated' ? 'updated' : th.dataset.sort;
      syncSortUI();
      S.syncUrl();
      filterChanged();
    });

    grid.addEventListener('pointerdown', (e) => {
      const target = e.target.closest('.wb-card');
      if (!target || e.button !== 0 || e.pointerType === 'mouse') return;
      longPressOrigin = { x: e.clientX, y: e.clientY };
      longPressId = Number(target.dataset.id);
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        longPressAt = Date.now();
        if (navigator.vibrate) navigator.vibrate(10);
        S.actions.toggleSelected(longPressId);
      }, 500);
    });
    const cancelLongPress = (e) => {
      if (!longPressTimer) return;
      if (e && longPressOrigin && (Math.abs(e.clientX - longPressOrigin.x) > 12
        || Math.abs(e.clientY - longPressOrigin.y) > 12)) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    grid.addEventListener('pointermove', cancelLongPress);
    grid.addEventListener('pointerup', () => { clearTimeout(longPressTimer); longPressTimer = null; });
    grid.addEventListener('pointercancel', () => { clearTimeout(longPressTimer); longPressTimer = null; });
    grid.addEventListener('contextmenu', (e) => {
      if (longPressId && e.pointerType !== 'mouse') e.preventDefault();
    });
  }

  function bindSearchEvents() {
    document.addEventListener('shelf-search', (e) => {
      applySearch(e.detail && e.detail.q);
    });
    document.addEventListener('search-cancel', () => {
      if (!state().q) return;
      applySearch('');
    });
    document.addEventListener('saved-search-apply', async (e) => {
      const detail = e.detail || {};
      state().q = detail.vl ? '' : String(detail.q || '');
      state().vl = String(detail.vl || '');
      if (['updated', 'finish', 'title', 'author', 'series', 'created', 'relevance'].includes(detail.sort)) {
        state().sort = detail.sort;
      }
      syncSortUI();
      await filterChanged({ refreshFacets: true });
    });
    document.addEventListener('virtual-libraries-changed', async () => {
      await S.loadFacets();
      updateSidebar();
      if (state().vl && !state().facets.virtualLibraries.some((v) => v.name === state().vl)) {
        state().vl = '';
        S.syncUrl();
        await filterChanged({ refreshFacets: true });
      }
    });
    document.addEventListener('books-changed', async () => {
      await reloadAll();
    });
  }

  S.hooks = {
    filterChanged,
    facetsChanged: () => { S.sidebar.render(); updateCount(); },
    reloadAll: () => reloadAll(),
    clearSelection: () => S.actions.clearSelection(),
  };

  async function boot() {
    S.parseUrl();
    applyView();
    bindChrome();
    bindGridEvents();
    bindSearchEvents();
    S.sidebar.render();
    S.grid.render([]);
    S.actions.refreshBulkBar();
    updateEmpty();
    const seq = ++viewSeq;
    try {
      const [page] = await Promise.all([S.loadPage(), S.loadFacets()]);
      if (seq !== viewSeq) return;
      updateSidebar();
      S.grid.render(state().books);
      updateEmpty();
      updateCount();
      S.grid.setupSentinel(loadMore);
      if (page && page.rows.length && state().hasMore) requestAnimationFrame(loadMore);
    } catch (err) {
      toast(err.message, true);
      updateEmpty();
    }
  }

  boot();
})();
