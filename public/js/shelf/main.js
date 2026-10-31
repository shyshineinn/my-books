/* ============================================================
 * 书架工作区:启动、筛选联动、选择手势与浮层
 * ============================================================ */

(function () {
  const S = window.ShelfUI;
  const state = () => S.state;
  const isMobile = () => window.matchMedia('(max-width: 819px)').matches;
  let viewSeq = 0;
  let longPressTimer = null;
  let longPressOrigin = null;
  let longPressId = null;
  let marqueeState = null;
  let marqueeFrame = 0;
  let marqueeGuard = false;

  const SCROLL_KEY = 'shelf.scroll';

  function saveScroll() {
    const content = $('#wbContent');
    if (!content) return;
    try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ url: location.search, top: content.scrollTop })); } catch { /* ignore */ }
  }

  function restoreScroll() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null');
      if (!saved || saved.url !== location.search || !(saved.top > 0)) return;
      const apply = () => {
        const content = $('#wbContent');
        if (content && content.scrollTop === 0) content.scrollTop = saved.top;
      };
      // 先同步应用;再给字体/图片布局一次修正机会(后台标签页的 rAF 可能被节流)。
      apply();
      requestAnimationFrame(apply);
      setTimeout(apply, 80);
    } catch { /* ignore */ }
  }

  function activeFilters() {
    const s = state();
    return !!(s.q || s.status || s.collection || s.tag || s.author || s.series || s.vl);
  }

  function updateCount() {
    const el = $('#wbScope');
    if (!el) return;
    const s = state();
    const parts = [];
    if (s.q) parts.push(`搜索「${s.q}」`);
    if (s.status) parts.push(STATUS_LABEL[s.status] || s.status);
    if (s.collection) {
      const collection = (s.facets.collections || []).find((c) => String(c.id) === String(s.collection));
      parts.push(collection ? collection.name : '分类');
    }
    if (s.tag) parts.push(s.tag);
    if (s.author) parts.push(s.author);
    if (s.series) parts.push(s.series);
    if (s.vl) parts.push(s.vl);
    const label = parts.length ? parts.join(' · ') : '全部图书';
    el.textContent = s.total === null ? label : `${label} · ${s.total} 本`;
    el.title = el.textContent;
  }

  const SIDEBAR_KEY = 'shelf.sidebar';
  // 这份偏好只代表**桌面端**那一栏要不要占位。手机端侧栏是抽屉,
  // 开合是一次性的,不该写进这个键(否则在手机上拉开通道,下次坐回电脑前会莫名多出一栏)。
  function desktopSidebarOpen() {
    try { return localStorage.getItem(SIDEBAR_KEY) !== 'closed'; } catch { return true; }
  }

  function setSidebarOpen(open, { persist = true } = {}) {
    const wb = $('#shelfWorkbench');
    if (!wb) return;
    wb.classList.toggle('sidebar-collapsed', !open);
    const btn = $('#wbSidebarToggle');
    if (btn) {
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? '隐藏资料库' : '显示资料库');
    }
    if (persist) {
      try { localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed'); } catch { /* ignore */ }
    }
  }

  function closeSidebar(options = { persist: false }) {
    setSidebarOpen(false, options);
  }

  function syncSearchPill() {
    const label = $('#wbSearchLabel');
    const pill = $('#shelfSearchBtn');
    if (!label || !pill) return;
    const q = state().q;
    label.textContent = q || '搜索';
    pill.classList.toggle('has-query', !!q);
    pill.title = q ? `搜索：${q}` : '搜索';
    pill.setAttribute('aria-label', q ? `当前搜索：${q}` : '搜索');
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
    ensureFill();
  }

  function ensureFill() {
    requestAnimationFrame(() => {
      const sentinel = $('#shelfSentinel');
      if (!sentinel || state().loading || !state().hasMore) return;
      if (sentinel.getBoundingClientRect().top < window.innerHeight + 600) loadMore();
    });
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
    ensureFill();
  }

  async function filterChanged({ refreshFacets = false, reload = false, restoreId = 0 } = {}) {
    const seq = ++viewSeq;
    syncSortUI();
    syncSearchPill();
    clearSelectionAndInspector();
    if (isMobile()) closeSidebar();
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
      ensureFill();
      // 编辑后服务端重查(restoreId):书仍在结果里就恢复选中与详情面板。
      // 不在就是不再符合筛选(或已落到后面的页),此时按原样收起。
      if (restoreId && state().books.some((b) => b.id === restoreId)) {
        S.actions.selectOnly(restoreId);
      }
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
    if (resetSort) {
      if (s.q && !s.sortExplicit && s.sort === 'updated') s.sort = 'relevance';
      else if (!s.q && s.sort === 'relevance') {
        s.sort = 'updated';
        s.sortExplicit = false;
      }
    }
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
      if (state().sort === 'relevance') {
        state().sort = 'updated';
        state().sortExplicit = false;
      }
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

  function syncLayoutUI() {
    const s = state();
    $$('#wbLayoutView button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.layoutView === s.view);
    });
    $$('#wbDensity button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.density === s.density);
    });
    const info = $('#wbShowInfo');
    if (info) info.checked = s.showInfo;
    const densityRow = $('#wbDensity') && $('#wbDensity').closest('.wb-layout-row');
    if (densityRow) densityRow.hidden = s.view === 'list';
    if (info && info.closest('.wb-layout-check')) info.closest('.wb-layout-check').hidden = s.view === 'list';
    $$('#wbColumns [data-column]').forEach((input) => {
      input.checked = (s.columns || []).includes(input.dataset.column);
    });
    const columns = $('#wbColumns');
    if (columns) columns.hidden = s.view !== 'list' || isMobile();
  }

  function applyLayoutPreferences() {
    const wb = $('#shelfWorkbench');
    if (!wb) return;
    wb.dataset.density = state().density;
    wb.dataset.coverInfo = state().showInfo ? '1' : '0';
    syncLayoutUI();
  }

  function closeLayoutMenu() {
    const menu = $('#wbLayoutMenu');
    if (!menu) return;
    menu.hidden = true;
    $('#wbLayoutBtn').setAttribute('aria-expanded', 'false');
  }

  function setView(view) {
    state().view = view;
    applyView();
    syncLayoutUI();
    S.syncUrl();
    S.grid.render(state().books);
    S.actions.syncSelection();
    updateEmpty();
    ensureFill();
    closeLayoutMenu();
  }

  function syncGlassUI() {
    const glass = window.LiquidGlass;
    if (!glass || typeof glass.getStats !== 'function') return;
    const stats = glass.getStats();
    $$('#wbGlassMode [data-glass-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.glassMode === glass.mode);
    });
    const note = $('#wbGlassNote');
    if (!note) return;
    let message = '';
    if (glass.mode === 'solid') message = '已关闭透明与模糊。';
    else if (glass.mode === 'frost') message = '柔和档：磨砂材质，无实时背景折射。';
    else if (glass.mode === 'full' && stats.tier !== 'full') {
      message = `此浏览器不支持实时折射，已使用${stats.tierLabel}。`;
    } else if (glass.mode === 'auto' && stats.tier === 'frost') {
      message = '当前环境自动使用磨砂（无实时折射）。';
    } else if (glass.mode === 'auto' && stats.tier === 'solid') {
      message = '当前环境自动使用纯色（减少透明度或性能不足）。';
    }
    note.hidden = !message;
    note.textContent = message;
  }

  function bindGlassSetting() {
    const group = $('#wbGlassMode');
    if (group) {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-glass-mode]');
        if (!btn || !window.LiquidGlass || !window.LiquidGlass.setMode) return;
        window.LiquidGlass.setMode(btn.dataset.glassMode);
        syncGlassUI();
      });
    }
    document.addEventListener('glass-tier-changed', syncGlassUI);
    document.addEventListener('glass-ready', syncGlassUI);
    syncGlassUI();
  }

  function bindChrome() {
    if (typeof initCustomSelect === 'function') initCustomSelect($('#wbSort'));
    syncSortUI();
    bindGlassSetting();

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
      if (isMobile()) closeSidebar();
      if (typeof openBookModal === 'function') openBookModal(null);
    });

    $('#wbSort').addEventListener('change', async (e) => {
      state().sort = e.target.value;
      state().sortExplicit = true;
      syncSortUI();
      S.syncUrl();
      await filterChanged();
    });

    $('#wbViewToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (btn) setView(btn.dataset.view);
    });

    $('#wbLayoutBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $('#wbLayoutMenu');
      const open = menu.hidden;
      menu.hidden = !open;
      $('#wbLayoutBtn').setAttribute('aria-expanded', String(open));
      closeBrandMenu();
    });
    $('#wbLayoutView').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-layout-view]');
      if (btn) setView(btn.dataset.layoutView);
    });
    $('#wbDensity').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-density]');
      if (!btn) return;
      state().density = btn.dataset.density;
      S.saveLayout();
      applyLayoutPreferences();
    });
    $('#wbShowInfo').addEventListener('change', (e) => {
      state().showInfo = !!e.target.checked;
      S.saveLayout();
      applyLayoutPreferences();
    });
    $('#wbColumns').addEventListener('change', (e) => {
      if (!e.target.matches('[data-column]')) return;
      state().columns = $$('#wbColumns [data-column]')
        .filter((input) => input.checked)
        .map((input) => input.dataset.column);
      S.saveLayout();
      if (state().view === 'list') {
        S.grid.render(state().books);
        S.actions.syncSelection();
        ensureFill();
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#wbLayoutMenu') && !e.target.closest('#wbLayoutBtn')) closeLayoutMenu();
    });

    $('#wbSidebarToggle').addEventListener('click', () => {
      setSidebarOpen($('#shelfWorkbench').classList.contains('sidebar-collapsed'), { persist: !isMobile() });
    });
    $('#wbScrim').addEventListener('click', () => closeSidebar());
    $('#wbInspectorScrim').addEventListener('click', () => S.inspector.hide());

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
    const syncBodyUi = () => {
      const searchOpen = document.body.classList.contains('search-open');
      $('#wbSearchClose').hidden = !searchOpen;
      if ((searchOpen || document.body.classList.contains('modal-open')) && isMobile()) closeSidebar();
    };
    new MutationObserver(syncBodyUi).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    syncBodyUi();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.defaultPrevented) return;
      if (e.key === 'Escape') {
        // Escape 一次只关最上面一层：先菜单，再侧栏/详情，最后清选择。
        const menuOpen = !$('#wbBrandMenu').hidden || !$('#wbLayoutMenu').hidden;
        if (menuOpen) {
          closeBrandMenu();
          closeLayoutMenu();
          return;
        }
        if (isMobile() && !$('#shelfWorkbench').classList.contains('sidebar-collapsed')) {
          closeSidebar();
          return;
        }
        if (state().inspectorOpen) { S.inspector.hide(); return; }
        if (state().selection.size) { S.actions.clearSelection(); return; }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (typeof window.openSearchOverlay === 'function') window.openSearchOverlay();
      }
    });

    setSidebarOpen(!isMobile() && desktopSidebarOpen(), { persist: false });

    let wasMobile = isMobile();
    let wasLandscape = window.innerWidth > window.innerHeight;
    window.addEventListener('resize', () => {
      const now = isMobile();
      const landscape = window.innerWidth > window.innerHeight;
      if (now && landscape !== wasLandscape) {
        // 手机横竖屏切换时收起抽屉,避免旋转后侧栏与详情叠在一起。
        closeSidebar();
      }
      if (now !== wasMobile) {
        // 跨断点一律先收起;回到桌面宽度才按**当前**偏好恢复侧栏 ——
        // 不能用进页面时读到的旧值,否则本次会话里刚收起/展开的选择不作数。
        // 详情/弹窗/搜索浮层正打开时保持收起,避免三栏叠在一起。
        if (now || state().inspectorOpen || document.body.classList.contains('modal-open')
          || document.body.classList.contains('search-open')) closeSidebar();
        else setSidebarOpen(desktopSidebarOpen(), { persist: false });
        wasMobile = now;
        if (state().view === 'list') {
          S.grid.render(state().books);
          S.actions.syncSelection();
          ensureFill();
        }
        syncLayoutUI();
      }
      wasLandscape = landscape;
    });
  }

  function bindGridEvents() {
    const grid = $('#bookGrid');
    grid.addEventListener('dragstart', (e) => {
      if (isMobile()) { e.preventDefault(); return; }
      const target = e.target.closest('[data-id]');
      if (!target) return;
      const id = Number(target.dataset.id);
      const ids = state().selection.has(id) ? [...state().selection] : [id];
      try {
        e.dataTransfer.setData('application/x-mybooks-books', JSON.stringify(ids));
        e.dataTransfer.setData('text/plain', ids.map((bookId) => `#${bookId}`).join(' '));
        e.dataTransfer.effectAllowed = 'copy';
      } catch { return; }
      document.body.classList.add('dragging-books');
    });
    grid.addEventListener('dragend', () => {
      document.body.classList.remove('dragging-books');
      $$('#wbSidebar .is-drop-target').forEach((row) => row.classList.remove('is-drop-target'));
    });
    grid.addEventListener('click', (e) => {
      if (e.target.closest('th')) return;
      const target = e.target.closest('[data-id]');
      if (!target) {
        if (state().selection.size) S.actions.clearSelection();
        return;
      }
      if (e.target.closest('th[data-sort]')) return;
      const id = Number(target.dataset.id);
      // 长按触发后浏览器补发的 click 只吞一次;不用时间窗,
      // 否则按住超过 1 秒松手后,click 会把刚选中的书取消。
      if (longPressId === id) { longPressId = null; return; }
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); S.actions.toggleSelected(id); }
      else if (e.shiftKey) { e.preventDefault(); S.actions.selectRange(id); }
      else if (state().selectMode) S.actions.toggleSelected(id);
      else S.actions.selectOnly(id);
      S.grid.focusItem(id, { scroll: false });
    });

    grid.addEventListener('dblclick', (e) => {
      if (isMobile()) return;
      const target = e.target.closest('[data-id]');
      if (!target) return;
      e.preventDefault();
      // 双击不再打开旧的 detailModal；直接进入唯一的完整编辑 Sheet。
      const id = Number(target.dataset.id);
      const book = state().books.find((b) => b.id === id)
        || (state().inspectorBook && state().inspectorBook.id === id ? state().inspectorBook : null);
      if (book && S.inspector.editBook) S.inspector.editBook(book);
    });

    const isEditable = (el) => !!(el && el.closest
      && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));

    function rowEntries() {
      return $$('#bookGrid [data-id]').map((el) => ({
        el, id: Number(el.dataset.id), rect: el.getBoundingClientRect(),
      }));
    }

    function nearestInRow(row, centerX) {
      let best = null;
      row.items.forEach((item) => {
        const distance = Math.abs(item.rect.left + item.rect.width / 2 - centerX);
        if (!best || distance < best.distance) best = { item, distance };
      });
      return best ? best.item : null;
    }

    function nextEntry(key) {
      const entries = rowEntries();
      if (!entries.length) return null;
      const current = entries.find((item) => item.el === document.activeElement)
        || entries.find((item) => item.id === state().focusId)
        || entries[0];
      if (key === 'Home') return entries[0];
      if (key === 'End') return entries[entries.length - 1];
      if (state().view === 'list') {
        const index = entries.indexOf(current);
        if (key === 'ArrowDown' || key === 'ArrowRight') return entries[index + 1] || null;
        if (key === 'ArrowUp' || key === 'ArrowLeft') return entries[index - 1] || null;
        return null;
      }
      const rows = [];
      entries.forEach((entry) => {
        const row = rows.find((item) => Math.abs(item.top - entry.rect.top) <= 2);
        if (row) row.items.push(entry);
        else rows.push({ top: entry.rect.top, items: [entry] });
      });
      rows.sort((a, b) => a.top - b.top);
      rows.forEach((row) => row.items.sort((a, b) => a.rect.left - b.rect.left));
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const row = rows.find((item) => item.items.includes(current));
        if (!row) return null;
        const index = row.items.indexOf(current);
        return row.items[index + (key === 'ArrowRight' ? 1 : -1)] || null;
      }
      const rowIndex = rows.findIndex((row) => row.items.includes(current));
      const row = rows[rowIndex + (key === 'ArrowDown' ? 1 : -1)];
      if (!row) return null;
      return nearestInRow(row, current.rect.left + current.rect.width / 2);
    }

    function moveFocus(key, e) {
      const next = nextEntry(key);
      if (!next) return;
      if (e.shiftKey) {
        if (state().anchorId == null) state().anchorId = state().focusId;
        S.actions.selectRange(next.id);
      } else if (!(e.ctrlKey || e.metaKey)) {
        S.actions.selectOnly(next.id, { openInspector: false });
      }
      S.grid.focusItem(next.id);
    }

    grid.addEventListener('keydown', (e) => {
      if (e.altKey || isEditable(e.target)) return;
      const th = e.target.closest('th[data-sort]');
      if (th) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          th.click();
        }
        return;
      }
      const target = e.target.closest('[data-id]');
      if (!target) return;
      const id = Number(target.dataset.id);
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.repeat) return;
        state().focusId = id;
        if (state().selection.size > 1 && state().selection.has(id)) S.actions.openBulk();
        else S.actions.selectOnly(id);
        return;
      }
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        state().focusId = id;
        S.actions.toggleSelected(id);
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        state().focusId = id;
        moveFocus(e.key, e);
      }
    });

    grid.addEventListener('click', async (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const key = th.dataset.sort === 'updated' ? 'updated' : th.dataset.sort;
      state().sort = key;
      syncSortUI();
      S.syncUrl();
      await filterChanged();
      const head = $(`#bookGrid th[data-sort="${key}"]`);
      if (head) head.focus({ preventScroll: true });
    });

    grid.addEventListener('pointerdown', (e) => {
      const target = e.target.closest('.wb-card, .wb-list-row');
      if (!target || e.button !== 0 || e.pointerType === 'mouse') return;
      const id = Number(target.dataset.id);
      longPressOrigin = { x: e.clientX, y: e.clientY };
      longPressId = null;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        longPressId = id;
        if (navigator.vibrate) navigator.vibrate(10);
        S.actions.toggleSelected(id);
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
    bindMarquee();
  }

  function bindMarquee() {
    const content = $('#wbContent');
    const main = $('.wb-main');
    if (!content || !main) return;
    const overlay = document.createElement('div');
    overlay.className = 'wb-marquee';
    overlay.hidden = true;
    main.appendChild(overlay);

    const sameSelection = (a, b) => a.size === b.size && [...a].every((id) => b.has(id));

    function paint() {
      const m = marqueeState;
      if (!m || !m.active) return;
      const left = Math.min(m.startX, m.x);
      const right = Math.max(m.startX, m.x);
      const top = Math.min(m.startY, m.y);
      const bottom = Math.max(m.startY, m.y);
      const clip = content.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const x1 = Math.max(clip.left, left) - mainRect.left;
      const y1 = Math.max(clip.top, top) - mainRect.top;
      const x2 = Math.min(clip.right, right) - mainRect.left;
      const y2 = Math.min(clip.bottom, bottom) - mainRect.top;
      if (x2 > x1 && y2 > y1) {
        overlay.hidden = false;
        overlay.style.transform = `translate(${x1}px, ${y1}px)`;
        overlay.style.width = `${x2 - x1}px`;
        overlay.style.height = `${y2 - y1}px`;
      } else {
        overlay.hidden = true;
      }

      // 命中按内容坐标计算:自动滚动时已扫过的书不会因为移出视口而被取消。
      const endX = m.x - clip.left + content.scrollLeft;
      const endY = m.y - clip.top + content.scrollTop;
      const hitLeft = Math.min(m.startContentX, endX);
      const hitRight = Math.max(m.startContentX, endX);
      const hitTop = Math.min(m.startContentY, endY);
      const hitBottom = Math.max(m.startContentY, endY);
      const next = new Set(m.additive ? m.base : []);
      let firstHit = null;
      $$('#bookGrid [data-id]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const left = r.left - clip.left + content.scrollLeft;
        const top = r.top - clip.top + content.scrollTop;
        if (left + r.width < hitLeft || left > hitRight
          || top + r.height < hitTop || top > hitBottom) return;
        const id = Number(el.dataset.id);
        next.add(id);
        if (firstHit === null) firstHit = id;
      });
      if (firstHit !== null) state().anchorId = firstHit;
      else if (!m.additive) state().anchorId = null;
      if (sameSelection(next, state().selection)) return;
      state().selection = next;
      S.grid.updateSelection();
      S.actions.refreshBulkBar();
    }

    function scrollStep() {
      marqueeFrame = 0;
      const m = marqueeState;
      if (!m || !m.active) return;
      const rect = content.getBoundingClientRect();
      const edge = 34;
      let dy = 0;
      if (m.y < rect.top + edge) dy = -Math.ceil(Math.min(18, (rect.top + edge - m.y) / 2));
      else if (m.y > rect.bottom - edge) dy = Math.ceil(Math.min(18, (m.y - (rect.bottom - edge)) / 2));
      if (!dy) return;
      content.scrollTop += dy;
      paint();
      marqueeFrame = requestAnimationFrame(scrollStep);
    }

    function queueScroll() {
      if (!marqueeFrame && marqueeState && marqueeState.active) {
        marqueeFrame = requestAnimationFrame(scrollStep);
      }
    }

    content.addEventListener('pointerdown', (e) => {
      if (isMobile() || e.pointerType !== 'mouse' || e.button !== 0 || marqueeState) return;
      if (e.target.closest('[data-id], th, a, button, input, select, textarea, label')) return;
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      const rect = content.getBoundingClientRect();
      marqueeState = {
        pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        startContentX: e.clientX - rect.left + content.scrollLeft,
        startContentY: e.clientY - rect.top + content.scrollTop,
        x: e.clientX, y: e.clientY,
        active: false, additive,
        base: additive ? new Set(state().selection) : new Set(),
      };
      try { content.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });

    content.addEventListener('pointermove', (e) => {
      const m = marqueeState;
      if (!m || e.pointerId !== m.pointerId) return;
      m.x = e.clientX;
      m.y = e.clientY;
      if (!m.active) {
        if (Math.hypot(m.x - m.startX, m.y - m.startY) < 5) return;
        m.active = true;
        document.body.classList.add('marquee-selecting');
        if (window.getSelection) window.getSelection().removeAllRanges();
      }
      e.preventDefault();
      paint();
      queueScroll();
    });

    const finish = (e, cancelled) => {
      const m = marqueeState;
      if (!m || e.pointerId !== m.pointerId) return;
      marqueeState = null;
      if (marqueeFrame) { cancelAnimationFrame(marqueeFrame); marqueeFrame = 0; }
      overlay.hidden = true;
      document.body.classList.remove('marquee-selecting');
      try { content.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (m.active && !cancelled) {
        // 拖拽结束后浏览器仍会补发一次 click，别让它把框选结果改成单选。
        marqueeGuard = true;
        setTimeout(() => { marqueeGuard = false; }, 0);
        if (state().selection.size && !state().selection.has(state().focusId)) {
          state().focusId = state().anchorId ?? [...state().selection][0];
        }
        if (state().selection.size === 1) {
          S.actions.selectOnly([...state().selection][0]);
        } else {
          if (state().selection.size) state().selectMode = true;
          S.actions.syncSelection();
        }
        if (state().selection.size && state().selection.has(state().focusId)) {
          S.grid.focusItem(state().focusId, { scroll: false });
        }
      } else if (!m.active && !cancelled && !m.additive) {
        if (state().selection.size || state().selectMode) S.actions.clearSelection();
      } else if (cancelled && m.active) {
        S.actions.syncSelection();
      }
    };
    content.addEventListener('pointerup', (e) => finish(e, false));
    content.addEventListener('pointercancel', (e) => finish(e, true));

    $('#bookGrid').addEventListener('click', (e) => {
      if (!marqueeGuard) return;
      marqueeGuard = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);
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
      const input = document.getElementById('searchInput');
      if (input) input.value = state().q;
      if (['updated', 'finish', 'title', 'author', 'series', 'created', 'relevance'].includes(detail.sort)) {
        state().sort = detail.sort;
        state().sortExplicit = true;
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
    closeSidebar: () => closeSidebar(),
    bookRemoved: (id) => {
      const s = state();
      s.books = s.books.filter((b) => b.id !== id);
      if (s.total !== null && s.total > 0) s.total -= 1;
      s.start = s.books.length;
      s.hasMore = s.total === null ? s.hasMore : s.books.length < s.total;
      S.actions.clearSelection();
      S.inspector.hide();
      S.grid.render(s.books);
      updateEmpty();
      updateCount();
    },
  };

  window.addEventListener('pagehide', saveScroll);

  async function boot() {
    S.parseUrl();
    S.parseLayout();
    syncSearchPill();
    applyView();
    applyLayoutPreferences();
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
      restoreScroll();
      if (page && page.rows.length && state().hasMore) ensureFill();
    } catch (err) {
      toast(err.message, true);
      updateEmpty();
    }
  }

  boot();
})();
