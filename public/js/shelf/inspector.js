/* ============================================================
 * 书架工作区:右侧 Inspector
 * 单本详情复用 public/js/book-details.js；这里只保留书架宿主逻辑
 * （选中态、多选面板、筛选重查与完整编辑回跳）。
 * ============================================================ */

(function () {
  const S = window.ShelfUI = window.ShelfUI || {};
  const state = () => S.state;
  let loadSeq = 0;
  let details = null;

  function selectedBooks() {
    return state().books.filter((b) => state().selection.has(b.id));
  }

  function getDetails() {
    if (details) return details;
    details = window.BookDetails.create($('#wbInspector'), {
      mode: 'inspector',
      sheet: $('#wbInspector'),
      loadBook: (id) => S.loadDetail(id),
      patchBook: (book, patch) => S.patchBook(book.id, patch),
      loadCollections: () => Promise.resolve(state().facets.collections || []),
      onClose: hide,
      onEdit: editBook,
      onDelete: (book) => {
        if (typeof window.deleteBook === 'function') window.deleteBook(book.id, book.title);
      },
      onChanged: (updated, patch) => afterDetailChange(updated, patch),
    });
    return details;
  }

  function show() {
    const root = $('#wbInspector');
    if (!root) return;
    state().inspectorOpen = true;
    if (window.matchMedia('(max-width: 1180px)').matches && S.hooks.closeSidebar) {
      S.hooks.closeSidebar();
    }
    root.hidden = false;
    $('#shelfWorkbench').classList.add('inspector-open');
    $('#wbInspectorToggle').setAttribute('aria-pressed', 'true');
    $('#wbInspectorToggle').setAttribute('aria-label', '隐藏详情');
    getDetails();
    render();
    loadSelection();
  }

  function hide() {
    const root = $('#wbInspector');
    if (!root) return;
    root.hidden = true;
    $('#shelfWorkbench').classList.remove('inspector-open');
    $('#wbInspectorToggle').setAttribute('aria-pressed', 'false');
    $('#wbInspectorToggle').setAttribute('aria-label', '显示详情');
    state().inspectorOpen = false;
    details?.closePop();
  }

  function toggle() {
    if (state().inspectorOpen) hide();
    else {
      state().inspectorOpen = true;
      show();
    }
  }

  function multiHtml() {
    const selected = selectedBooks();
    const covers = selected.slice(0, 4).map((b) => `<span class="wb-multi-cover">${coverHtml(b)}</span>`).join('');
    const collections = state().facets.collections;
    return `<div class="wb-inspector-head">
        <span class="bd-grabber" data-bd-grabber aria-hidden="true"></span>
        <button type="button" class="icon-btn" data-bd-close aria-label="关闭详情">✕</button>
      </div>
      <div class="wb-inspector-multi">
        <div class="wb-multi-covers">${covers}</div>
        <div class="wb-multi-count">${selected.length} 本</div>
        <div>已选择</div>
        <div class="wb-multi-actions">
          <button type="button" class="wb-action" data-multi="collection">加入分类</button>
          ${S.multiPop ? `<div class="wb-multi-collections">
            ${collections.length ? collections.map((c) => `<button type="button" data-multi-add-collection="${c.id}">${esc(c.name)}</button>`).join('') : '<div class="wb-pop-empty">先在左侧新建一个分类</div>'}
          </div>` : ''}
          <button type="button" class="wb-action" data-multi="bulk">批量编辑</button>
          <button type="button" class="wb-action" data-multi="enrich">补全元数据</button>
          <button type="button" class="wb-action" data-multi="clear">取消选择</button>
        </div>
      </div>`;
  }

  function render() {
    const root = $('#wbInspector');
    if (!root) return;
    if (!state().inspectorOpen) { root.hidden = true; return; }
    root.hidden = false;
    const s = state();
    getDetails();
    if (s.selection.size > 1) {
      root.innerHTML = `<div class="bd-scroll">${multiHtml()}</div>`;
      return;
    }
    if (!s.selection.size) {
      details.showMessage('选择一本书');
      return;
    }
    const id = [...s.selection][0];
    const book = s.inspectorBook && s.inspectorBook.id === id ? s.inspectorBook : null;
    if (!book) {
      details.showMessage('载入中…', { loading: true });
      return;
    }
    details.setBook(book);
  }

  async function loadSelection() {
    const s = state();
    const seq = ++loadSeq;
    if (!s.inspectorOpen) return;
    if (s.selection.size !== 1) {
      s.inspectorBook = null;
      render();
      return;
    }
    const id = [...s.selection][0];
    if (s.inspectorBook && s.inspectorBook.id === id) { render(); return; }
    s.inspectorBook = null;
    s.inspectorLoading = true;
    render();
    try {
      const book = await S.loadDetail(id);
      if (seq !== loadSeq || !s.inspectorOpen || s.selection.size !== 1
          || [...s.selection][0] !== id) return;
      s.inspectorBook = book;
      render();
    } catch (err) {
      if (seq !== loadSeq) return;
      toast(err.message, true);
      hide();
    } finally {
      if (seq === loadSeq) s.inspectorLoading = false;
    }
  }

  function editBook(book) {
    if (!book || typeof window.openBookModal !== 'function') return;
    window.openBookModal(book, { onSaved: (id) => refreshAfterEdit(id) });
  }

  async function refreshAfterEdit(id) {
    try {
      const updated = await S.loadDetail(id);
      state().inspectorBook = updated;
      S.updateBook(updated);
      invalidateSharedStats();
      const s = state();
      if (s.q || s.vl || !S.matchesFilters(updated)) {
        await S.hooks.filterChanged({ refreshFacets: true, restoreId: id });
        return;
      }
      if (s.selection.size === 1 && [...s.selection][0] === id && s.inspectorOpen) {
        S.grid.render(s.books);
        S.actions.syncSelection();
        details.setBook(updated);
      }
      await S.loadFacets();
      S.hooks.facetsChanged();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function afterDetailChange(updated, patch) {
    if (!updated) return;
    const s = state();
    S.updateBook(updated);
    s.inspectorBook = updated;
    invalidateSharedStats();
    if (s.q || s.vl || !S.matchesFilters(updated)) {
      await S.hooks.filterChanged({ refreshFacets: true, restoreId: updated.id });
      return;
    }
    if (s.view === 'list') {
      S.grid.render(s.books);
      S.actions.syncSelection();
    }
    await S.loadFacets();
    S.hooks.facetsChanged();
    if (patch && patch.tags) details?.closePop();
  }

  /* 多选 Inspector 的操作仍属于书架宿主，不混入单本详情组件。 */
  rootEvents();
  function rootEvents() {
    const root = $('#wbInspector');
    if (!root) return;
    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-multi="collection"]')) {
        S.multiPop = !S.multiPop;
        render();
        return;
      }
      const multiAdd = e.target.closest('[data-multi-add-collection]');
      if (multiAdd) {
        const ids = [...state().selection];
        try {
          const res = await S.collections.add(Number(multiAdd.dataset.multiAddCollection), ids);
          S.multiPop = false;
          await S.loadFacets();
          S.hooks.facetsChanged();
          render();
          toast(`已把 ${res.added} 本加入分类`);
        } catch (err) { toast(err.message, true); }
        return;
      }
      if (e.target.closest('[data-multi="bulk"]')) { S.actions.openBulk(); return; }
      if (e.target.closest('[data-multi="enrich"]')) { S.actions.runEnrich(); return; }
      if (e.target.closest('[data-multi="clear"]')) { S.hooks.clearSelection(); }
    });
  }

  S.inspector = { show, hide, toggle, render, loadSelection, editBook };
})();
