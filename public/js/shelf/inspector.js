/* ============================================================
 * 书架工作区:右侧 Inspector
 * 单本详情 + 快速编辑(状态/评分/标签/系列) + 手动分类
 * ============================================================ */

(function () {
  const S = window.ShelfUI = window.ShelfUI || {};
  const state = () => S.state;
  let loadSeq = 0;
  let tagsBookId = null;
  let tagsExpanded = false;
  const TAG_PREVIEW = 8;

  function parseJson(value, fallback) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function tagsOf(book) {
    const tags = parseJson(book.tags || '[]', []);
    return Array.isArray(tags) ? tags : [];
  }

  function selectedBooks() {
    return state().books.filter((b) => state().selection.has(b.id));
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
    S.inspectorPop = false;
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
        <button type="button" class="wb-inspector-close" data-inspector-close aria-label="关闭详情">✕</button>
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

  function fileRows(book) {
    const files = Array.isArray(book.files) ? book.files : [];
    if (!files.length) return '<span class="wb-meta-v">未上传电子书</span>';
    return `<div class="wb-files">${files.map((f) => `
      <a class="wb-file" href="${esc(f.download_url || `/books-files/${f.path}`)}" download>
        <span class="wb-file-format">.${esc(f.format)}</span>
        <span class="wb-file-size">${fileSizeText(f.size)}</span>
      </a>`).join('')}</div>`;
  }

  function collectionChips(book) {
    const memberships = Array.isArray(book.collections) ? book.collections : [];
    const chips = memberships.map((c) => `<span class="wb-chip">${esc(c.name)}
      <button type="button" data-remove-collection="${c.id}" aria-label="移出 ${esc(c.name)}">✕</button></span>`).join('');
    const available = state().facets.collections.filter((c) => !memberships.some((m) => m.id === c.id));
    const pop = S.inspectorPop
      ? `<div class="wb-collection-pop">
          ${available.length ? available.map((c) => `<button type="button" data-add-collection="${c.id}">${esc(c.name)}</button>`).join('') : '<div class="wb-pop-empty">已在该书的全部分类中</div>'}
          <form class="wb-inline-form" data-new-collection>
            <input class="wb-inline-input" name="name" placeholder="新建分类并加入" maxlength="100" aria-label="新建分类并加入">
            <button class="wb-inline-ok" type="submit">加入</button>
          </form>
        </div>`
      : '';
    return `<div class="wb-collection-picker">
      <div class="wb-chips">${chips}<button type="button" class="wb-chip-add" data-collection-add>+ 分类</button></div>
      ${pop}
    </div>`;
  }

  function contentHtml(book) {
    const tags = tagsOf(book);
    if (tagsBookId !== book.id) {
      tagsBookId = book.id;
      tagsExpanded = false;
    }
    const visibleTags = tagsExpanded ? tags : tags.slice(0, TAG_PREVIEW);
    const moreTags = tags.length > TAG_PREVIEW;
    const rating = Number(book.rating) > 0 ? book.rating : '';
    const logs = parseJson(book.read_logs || '[]', []);
    const lastLog = Array.isArray(logs) && logs.length ? logs[logs.length - 1] : null;
    const custom = book.custom_display && typeof book.custom_display === 'object' ? book.custom_display : {};
    const pub = [book.publisher, book.pub_year].filter(Boolean).join(' · ');
    return `<div class="wb-inspector-head">
        <button type="button" class="wb-inspector-close" data-inspector-close aria-label="关闭详情">✕</button>
      </div>
      <div class="wb-inspector-cover">${coverHtml(book)}</div>
      <h2 class="wb-inspector-title">${esc(book.title)}</h2>
      <p class="wb-inspector-author${book.author ? '' : ' is-empty'}">${book.author ? esc(book.author) : '未设置作者'}</p>

      <div class="wb-meta">
        <div class="wb-meta-row">
          <span class="wb-meta-k">状态</span>
          <span class="wb-meta-v"><span class="wb-inspector-status">
            ${[['wish', '想读'], ['reading', '在读'], ['done', '已读']].map(([value, label]) =>
              `<button type="button" class="${book.status === value ? 'is-on' : ''}" data-inspector-status="${value}">${label}</button>`).join('')}
          </span></span>
        </div>
        <div class="wb-meta-row">
          <span class="wb-meta-k">评分</span>
          <span class="wb-meta-v wb-rating"><input type="number" min="0" max="10" step="0.1" value="${esc(String(rating))}" placeholder="未设置" data-inspector-rating aria-label="评分（满分 10）"><span class="wb-rating-unit">/ 10</span></span>
        </div>
        <div class="wb-meta-row">
          <span class="wb-meta-k">系列</span>
          <span class="wb-meta-v"><span class="wb-series-inputs">
            <input type="text" value="${esc(book.series || '')}" placeholder="未设置" data-series-name aria-label="系列名">
            <input type="text" value="${esc(book.series_index || '')}" placeholder="未设置" data-series-index aria-label="系列序号">
          </span></span>
        </div>
        <div class="wb-meta-row"><span class="wb-meta-k">出版</span><span class="wb-meta-v${pub ? '' : ' is-empty'}">${pub ? esc(pub) : '未设置'}</span></div>
        <div class="wb-meta-row"><span class="wb-meta-k">ISBN</span><span class="wb-meta-v${book.isbn ? '' : ' is-empty'}">${book.isbn ? esc(book.isbn) : '未设置'}</span></div>
        ${lastLog && (lastLog.start || lastLog.finish) ? `<div class="wb-meta-row"><span class="wb-meta-k">阅读</span><span class="wb-meta-v">${esc([lastLog.start, lastLog.finish].filter(Boolean).join(' → '))}</span></div>` : ''}
      </div>

      <div class="wb-section-title">标签</div>
      <div class="wb-chips">
        ${visibleTags.map((t) => `<span class="wb-chip">${esc(t)}<button type="button" data-remove-tag="${esc(t)}" aria-label="移除标签 ${esc(t)}">✕</button></span>`).join('')}
        ${moreTags ? `<button type="button" class="wb-chip-more" data-tags-more>${tagsExpanded ? '收起' : `显示更多 (${tags.length - TAG_PREVIEW})`}</button>` : ''}
        <input type="text" class="wb-chip-input" placeholder="+ 标签" data-new-tag aria-label="添加标签">
      </div>

      <div class="wb-section-title">分类</div>
      ${collectionChips(book)}

      <div class="wb-section-title">电子书</div>
      ${fileRows(book)}

      ${Object.keys(custom).length ? `<div class="wb-section-title">自定义字段</div>
        <div class="wb-meta">${Object.entries(custom).map(([k, v]) => `<div class="wb-meta-row"><span class="wb-meta-k">${esc(k)}</span><span class="wb-meta-v">${esc(v)}</span></div>`).join('')}</div>` : ''}

      <div class="wb-inspector-actions">
        <button type="button" class="wb-action" data-inspector-edit>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 11.5 11 2.7l2.3 2.3-8.8 8.8H2.2v-2.3Z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="m9.8 3.9 2.3 2.3" stroke="currentColor" stroke-width="1.15"/></svg>
          编辑全部
        </button>
        <a class="wb-action" href="/notes/${book.id}">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.6" y="1.9" width="10.8" height="12.2" rx="2" fill="none" stroke="currentColor" stroke-width="1.15"/><path d="M5.3 5.3h5.4M5.3 8h5.4M5.3 10.7h3.4" stroke="currentColor" stroke-width="1.05" stroke-linecap="round"/></svg>
          读书心得
        </a>
        <button type="button" class="wb-action is-danger" data-inspector-delete>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 4.4h9.6M6.2 4.4V2.8h3.6v1.6M4.5 4.4l.6 8.1c.03.5.44.9.94.9h3.9c.5 0 .91-.4.94-.9l.6-8.1" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>
          移到回收站
        </button>
      </div>`;
  }

  function render() {
    const root = $('#wbInspector');
    if (!root) return;
    if (!state().inspectorOpen) { root.hidden = true; return; }
    root.hidden = false;
    const previousScroll = root.querySelector('.wb-inspector-scroll')?.scrollTop || 0;
    const s = state();
    if (s.selection.size > 1) {
      root.innerHTML = `<div class="wb-inspector-scroll">${multiHtml()}</div>`;
      return;
    }
    if (!s.selection.size) {
      root.innerHTML = `<div class="wb-inspector-head">
          <button type="button" class="wb-inspector-close" data-inspector-close aria-label="关闭详情">✕</button>
        </div><div class="wb-inspector-empty">选择一本书</div>`;
      return;
    }
    const id = [...s.selection][0];
    const book = s.inspectorBook && s.inspectorBook.id === id ? s.inspectorBook : null;
    if (!book) {
      root.innerHTML = `<div class="wb-inspector-empty">载入中…</div>`;
      return;
    }
    root.innerHTML = `<div class="wb-inspector-scroll">${contentHtml(book)}</div>`;
    const scroller = root.querySelector('.wb-inspector-scroll');
    if (scroller) scroller.scrollTop = previousScroll;
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
      // 请求期间可能已经切到另一本书:过期的 A 不能覆盖 B。
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

  async function patch(patch, message) {
    const book = state().inspectorBook;
    if (!book) return;
    try {
      const updated = await S.patchBook(book.id, patch);
      state().inspectorBook = updated;
      S.updateBook(updated);
      invalidateSharedStats();

      // q 依赖 FTS,虚拟书库依赖查询语法,客户端判不准:让服务端重查。
      const needsServerRecheck = !!state().vl
        || (!!state().q && Object.prototype.hasOwnProperty.call(patch, 'tags'));
      if (needsServerRecheck) {
        if (message) toast(message);
        await S.hooks.filterChanged({ refreshFacets: true });
        return;
      }
      if (!S.matchesFilters(updated)) {
        await S.loadFacets();
        S.hooks.facetsChanged();
        S.hooks.bookRemoved(updated.id);
        toast('修改后不再符合当前筛选,已从列表移除');
        return;
      }

      render();
      await S.loadFacets();
      S.hooks.facetsChanged();
      if (message) toast(message);
    } catch (err) {
      toast(err.message, true);
      if (err.code === 'CONFLICT') {
        state().inspectorBook = null;
        await loadSelection();
      }
    }
  }

  function currentBook() {
    return state().selection.size === 1 ? state().inspectorBook : null;
  }

  rootEvents();
  function rootEvents() {
    const root = $('#wbInspector');
    if (!root) return;
    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-inspector-close]')) { hide(); return; }
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
      if (e.target.closest('[data-multi="clear"]')) { S.hooks.clearSelection(); return; }
      const status = e.target.closest('[data-inspector-status]');
      if (status) { await patch({ status: status.dataset.inspectorStatus }, '状态已更新'); return; }
      if (e.target.closest('[data-tags-more]')) {
        tagsExpanded = !tagsExpanded;
        render();
        return;
      }
      if (e.target.closest('[data-collection-add]')) {
        S.inspectorPop = !S.inspectorPop;
        render();
        return;
      }
      const addCollection = e.target.closest('[data-add-collection]');
      if (addCollection) {
        const book = currentBook();
        if (!book) return;
        try {
          await S.collections.add(Number(addCollection.dataset.addCollection), [book.id]);
          S.inspectorPop = false;
          state().inspectorBook = await S.loadDetail(book.id);
          render();
          await S.loadFacets();
          S.hooks.facetsChanged();
          toast('已加入分类');
        } catch (err) { toast(err.message, true); }
        return;
      }
      const removeCollection = e.target.closest('[data-remove-collection]');
      if (removeCollection) {
        const book = currentBook();
        if (!book) return;
        const collectionId = Number(removeCollection.dataset.removeCollection);
        try {
          await S.collections.removeBooks(collectionId, [book.id]);
          if (String(state().collection) === String(collectionId)) {
            toast('已移出分类');
            await S.hooks.filterChanged();
            return;
          }
          state().inspectorBook = await S.loadDetail(book.id);
          render();
          await S.loadFacets();
          S.hooks.facetsChanged();
          toast('已移出分类');
        } catch (err) { toast(err.message, true); }
        return;
      }
      const removeTag = e.target.closest('[data-remove-tag]');
      if (removeTag) {
        const book = currentBook();
        if (!book) return;
        const tags = tagsOf(book).filter((t) => t !== removeTag.dataset.removeTag);
        await patch({ tags }, '标签已更新');
        return;
      }
      if (e.target.closest('[data-inspector-edit]')) {
        const book = currentBook();
        if (book && typeof window.openBookModal === 'function') window.openBookModal(book);
        return;
      }
      if (e.target.closest('[data-inspector-delete]')) {
        const book = currentBook();
        if (book && typeof window.deleteBook === 'function') window.deleteBook(book.id, book.title);
      }
    });

    root.addEventListener('change', async (e) => {
      const book = currentBook();
      if (!book) return;
      if (e.target.matches('[data-inspector-rating]')) {
        await patch({ rating: e.target.value === '' ? 0 : Number(e.target.value) }, '评分已更新');
        return;
      }
      if (e.target.matches('[data-series-name], [data-series-index]')) {
        const nameEl = root.querySelector('[data-series-name]');
        const indexEl = root.querySelector('[data-series-index]');
        await patch({
          series: nameEl ? nameEl.value.trim() : '',
          series_index: indexEl ? indexEl.value.trim() : '',
        }, '系列已更新');
      }
    });

    root.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.matches('[data-new-tag]')) {
        e.preventDefault();
        const book = currentBook();
        if (!book) return;
        const value = e.target.value.trim();
        if (!value) return;
        const tags = [...new Set([...tagsOf(book), value])];
        e.target.value = '';
        await patch({ tags }, '标签已添加');
      }
    });

    root.addEventListener('submit', async (e) => {
      const form = e.target.closest('[data-new-collection]');
      if (!form) return;
      e.preventDefault();
      const book = currentBook();
      if (!book) return;
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) return;
      try {
        const created = await S.collections.create(name);
        await S.collections.add(created.item.id, [book.id]);
        S.inspectorPop = false;
        state().inspectorBook = await S.loadDetail(book.id);
        render();
        await S.loadFacets();
        S.hooks.facetsChanged();
        toast('分类已创建并加入');
      } catch (err) { toast(err.message, true); }
    });
  }

  S.inspector = { show, hide, toggle, render, loadSelection };
})();
