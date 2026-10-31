/* ============================================================
 * 书架工作区:左侧资料库
 * 全部图书 / 阅读状态 / 我的分类 / 智能书架 / 系列 / 作者 / 标签
 * ============================================================ */

(function () {
  const S = window.ShelfUI = window.ShelfUI || {};
  const state = () => S.state;
  const facetUI = S.facetUI;
  const LIMIT = 8;
  const FACET_LIMITS = { author: 5, series: 8, tag: 8 };
  const FACET_KEYS = { series: 'series', author: 'authors', tag: 'tags' };
  const SERVER_FACETS = new Set(['author', 'tag', 'series']);
  const SEARCH_DELAY = 250;

  const chevron = '<svg class="wb-chevron" width="8" height="5" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function row({ label, count, active, axis, value, extra = '' }) {
    return `<button type="button" class="wb-row${active ? ' is-active' : ''}" data-axis="${axis}" data-value="${esc(value)}" title="${esc(label)}">
      <span class="wb-row-name">${esc(label)}</span>
      <span class="wb-row-count">${count === null || count === undefined ? '—' : count}</span>
      ${extra}
    </button>`;
  }

  function sectionHead(id, title, extra = '') {
    const collapsed = S.collapsed.has(id);
    return `<div class="wb-section-head-row">
      <button type="button" class="wb-section-head" data-section="${id}" aria-expanded="${!collapsed}">
        ${chevron}<span>${title}</span>
      </button>${extra}
    </div>`;
  }

  function sectionBody(id, html) {
    return S.collapsed.has(id) ? '' : html;
  }

  function facetRows(key, items, param) {
    const activeValue = state()[key];
    return items.map((item) => row({
      label: item.name,
      count: item.count,
      active: String(activeValue) === String(item.name),
      axis: key,
      value: item.name,
    })).join('');
  }

  function matches(item, q) {
    return String(item.name).toLowerCase().includes(q.toLowerCase());
  }

  function sortFacetItems(key, items) {
    if (key !== 'author' && key !== 'series') return items;
    return items.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  }

  function withPinned(key, items) {
    const active = String(state()[key] || '');
    if (!active || items.some((item) => String(item.name) === active)) return items;
    const pinned = facetUI.pinned[key];
    const count = pinned && String(pinned.name) === active ? pinned.count : null;
    return [{ name: active, count }, ...items];
  }

  function rememberPinned(key, value) {
    if (!SERVER_FACETS.has(key)) return;
    const name = String(value);
    const sources = [facetUI.results[key]?.items || [], state().facets[FACET_KEYS[key]] || []];
    let match = null;
    for (const list of sources) {
      match = list.find((item) => String(item.name) === name);
      if (match) break;
    }
    if (match) facetUI.pinned[key] = { name, count: match.count };
    else if (!facetUI.pinned[key] || facetUI.pinned[key].name !== name) {
      facetUI.pinned[key] = { name, count: null };
    }
  }

  function collapsedItems(key, items, limit) {
    const list = withPinned(key, items);
    const active = String(state()[key] || '');
    if (!active) return list.slice(0, limit);
    const index = list.findIndex((item) => String(item.name) === active);
    if (index < 0 || index < limit) return list.slice(0, limit);
    return [list[index], ...list.filter((_, i) => i !== index).slice(0, limit - 1)];
  }

  function facetRowsHtml(key, items) {
    return items.length
      ? facetRows(key, items, key)
      : '<div class="wb-facet-empty">没有匹配项</div>';
  }

  function facetSection(key, title, items) {
    const open = !!facetUI.expanded[key];
    const limit = FACET_LIMITS[key] || LIMIT;
    const q = String(facetUI.query[key] || '').trim();
    const server = SERVER_FACETS.has(key);
    const result = open && q ? facetUI.results[key] : null;
    const active = result && result.q === q ? result : null;
    let base = items;
    if (open && q) {
      if (active) base = sortFacetItems(key, active.items);
      else base = sortFacetItems(key, items.filter((item) => matches(item, q)).slice(0, 100));
    }
    const shown = open ? withPinned(key, base) : collapsedItems(key, items, limit);
    const rowsHtml = facetRowsHtml(key, shown);
    const input = open
      ? `<input class="wb-facet-filter" data-facet="${key}" value="${esc(facetUI.query[key] || '')}" maxlength="100" placeholder="筛选${title}" aria-label="筛选${title}">`
      : '';
    const knownTotal = key === 'author' ? state().facets.authorTotal
      : key === 'tag' ? state().facets.tagTotal
        : key === 'series' ? state().facets.seriesTotal : null;
    const total = server ? (active ? active.total : (knownTotal ?? items.length)) : items.length;
    let note = '';
    if (active && active.total > active.items.length) {
      note = `仅显示前 ${active.items.length} 项，请输入更精确的关键词`;
    } else if (open && server && !q && total > items.length) {
      note = `仅显示前 ${items.length} 项，输入关键词可查找全部`;
    }
    const more = !open && total > limit
      ? `<button type="button" class="wb-facet-more" data-facet-more="${key}">显示更多 · ${total}</button>`
      : (open ? `<button type="button" class="wb-facet-more" data-facet-close="${key}">收起</button>` : '');
    return `<section class="wb-section">
      ${sectionHead(key, title)}
      ${sectionBody(key, `<div class="wb-facet-body" data-facet-body="${key}">${input}<div class="wb-facet-list" data-facet-list="${key}">${rowsHtml}</div><div class="wb-facet-note" data-facet-note="${key}"${note ? '' : ' hidden'}>${esc(note)}</div>${more}</div>`)}
    </section>`;
  }

  function collectionRows() {
    const items = state().facets.collections;
    const editing = S.sidebarEdit || null;
    let html = items.map((c) => {
      if (editing && editing.mode === 'rename' && Number(editing.id) === c.id) {
        return `<form class="wb-inline-form" data-collection-form="rename" data-id="${c.id}">
          <input class="wb-inline-input" name="name" value="${esc(c.name)}" maxlength="100" aria-label="重命名藏书集">
          <button class="wb-inline-ok" type="submit">保存</button>
        </form>`;
      }
      return `<div class="wb-collection-row">
        <button type="button" class="wb-row${String(state().collection) === String(c.id) ? ' is-active' : ''}" data-axis="collection" data-value="${c.id}">
          <span class="wb-row-name">${esc(c.name)}</span>
          <span class="wb-row-count">${c.count}</span>
        </button>
        <span class="wb-row-actions">
          <button type="button" class="wb-row-act" data-collection-act="rename" data-id="${c.id}" title="重命名" aria-label="重命名 ${esc(c.name)}">✎</button>
          <button type="button" class="wb-row-act is-danger" data-collection-act="delete" data-id="${c.id}" title="删除" aria-label="删除 ${esc(c.name)}">✕</button>
        </span>
      </div>`;
    }).join('');
    if (!items.length && !(editing && editing.mode === 'create')) {
      html += '<div class="wb-facet-empty">还没有分类</div>';
    }
    if (editing && editing.mode === 'create') {
      html += `<form class="wb-inline-form" data-collection-form="create">
        <input class="wb-inline-input" name="name" placeholder="新分类名称" maxlength="100" aria-label="新分类名称">
        <button class="wb-inline-ok" type="submit">新建</button>
      </form>`;
    }
    return html;
  }

  function render() {
    const s = state();
    const f = s.facets;
    const root = $('#wbSidebar');
    if (!root) return;
    const allActive = !s.q && !s.status && !s.collection && !s.tag && !s.author && !s.series && !s.vl;
    const vls = (f.virtualLibraries || []).map((v) => ({ name: v.name, count: v.count }));
    const series = (f.series || []).filter((x) => x.count > 0)
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    const authors = (f.authors || []).filter((x) => x.count > 0)
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    const tags = (f.tags || []).filter((x) => x.count > 0);

    root.innerHTML = `<div class="wb-side-scroll">
      <div class="wb-side-head">
        <span>资料库</span>
        <button type="button" class="wb-side-close" data-sidebar-close aria-label="关闭资料库">✕</button>
      </div>
      <section class="wb-section">
        ${row({ label: '全部图书', count: f.total, active: allActive, axis: 'all', value: '' })}
      </section>

      <section class="wb-section">
        ${sectionHead('status', '阅读状态')}
        ${sectionBody('status', `<div>
          ${row({ label: '想读', count: f.byStatus.wish, active: s.status === 'wish', axis: 'status', value: 'wish' })}
          ${row({ label: '在读', count: f.byStatus.reading, active: s.status === 'reading', axis: 'status', value: 'reading' })}
          ${row({ label: '已读', count: f.byStatus.done, active: s.status === 'done', axis: 'status', value: 'done' })}
        </div>`)}
      </section>

      <section class="wb-section">
        ${sectionHead('collections', '我的分类', '<button type="button" class="wb-section-add" data-collection-act="create" title="新建分类" aria-label="新建分类">+</button>')}
        ${sectionBody('collections', collectionRows())}
      </section>

      ${vls.length ? `<section class="wb-section">
        ${sectionHead('vl', '智能书架')}
        ${sectionBody('vl', vls.map((v) => row({
          label: v.name, count: v.count, active: s.vl === v.name, axis: 'vl', value: v.name,
        })).join(''))}
      </section>` : ''}

      ${series.length ? facetSection('series', '系列', series) : ''}
      ${authors.length ? facetSection('author', '作者', authors) : ''}
      ${tags.length ? facetSection('tag', '标签', tags) : ''}
    </div>`;
  }

  function toggleAxis(axis, value) {
    const s = state();
    if (axis === 'all') {
      Object.assign(s, {
        q: '', status: '', collection: '', tag: '', author: '', series: '', vl: '',
        sort: 'updated', sortExplicit: false,
      });
      const input = document.getElementById('searchInput');
      if (input) input.value = '';
      if (document.body.classList.contains('search-open') && typeof window.closeSearchOverlay === 'function') {
        window.closeSearchOverlay(false);
      }
      S.hooks.filterChanged({ refreshFacets: true, resetSearch: true });
      return;
    }
    if (!['status', 'collection', 'tag', 'author', 'series', 'vl'].includes(axis)) return;
    if (SERVER_FACETS.has(axis)) rememberPinned(axis, value);
    const current = String(s[axis] || '');
    s[axis] = current === String(value) ? '' : String(value);
    S.hooks.filterChanged({ refreshFacets: axis === 'vl' });
  }

  rootEvents();
  function rootEvents() {
    const root = $('#wbSidebar');
    if (!root) return;
    const searchTimers = {};
    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-sidebar-close]')) {
        S.hooks.closeSidebar();
        return;
      }
      const section = e.target.closest('[data-section]');
      if (section) {
        const id = section.dataset.section;
        if (S.collapsed.has(id)) S.collapsed.delete(id);
        else S.collapsed.add(id);
        S.saveCollapsed();
        render();
        return;
      }
      const more = e.target.closest('[data-facet-more]');
      if (more) {
        facetUI.expanded[more.dataset.facetMore] = true;
        render();
        return;
      }
      const closeFacet = e.target.closest('[data-facet-close]');
      if (closeFacet) {
        facetUI.expanded[closeFacet.dataset.facetClose] = false;
        render();
        return;
      }
      const cAct = e.target.closest('[data-collection-act]');
      if (cAct) {
        e.stopPropagation();
        const act = cAct.dataset.collectionAct;
        if (act === 'create') {
          S.sidebarEdit = { mode: 'create' };
          render();
          const input = root.querySelector('form[data-collection-form="create"] input');
          if (input) input.focus();
          return;
        }
        if (act === 'rename') {
          S.sidebarEdit = { mode: 'rename', id: Number(cAct.dataset.id) };
          render();
          const input = root.querySelector('form[data-collection-form="rename"] input');
          if (input) input.focus();
          return;
        }
        if (act === 'delete') {
          const id = Number(cAct.dataset.id);
          const collection = state().facets.collections.find((c) => c.id === id);
          if (!collection) return;
          if (!confirm(`删除分类「${collection.name}」?书不会被删除。`)) return;
          try {
            await S.collections.remove(id);
            if (String(state().collection) === String(id)) state().collection = '';
            S.sidebarEdit = null;
            await S.loadFacets();
            S.hooks.facetsChanged();
            S.hooks.filterChanged({ reload: true });
            toast('分类已删除');
          } catch (err) { toast(err.message, true); }
          return;
        }
      }
      const axisBtn = e.target.closest('[data-axis]');
      if (axisBtn && !e.target.closest('[data-collection-act]')) {
        toggleAxis(axisBtn.dataset.axis, axisBtn.dataset.value);
      }
    });

    const hasBooksDrag = (e) => Array.from(e.dataTransfer.types || []).includes('application/x-mybooks-books');
    const draggedIds = (e) => {
      try {
        if (!hasBooksDrag(e)) return [];
        const ids = JSON.parse(e.dataTransfer.getData('application/x-mybooks-books') || '[]');
        return Array.isArray(ids) ? ids.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
      } catch { return []; }
    };
    root.addEventListener('dragover', (e) => {
      const row = e.target.closest('[data-axis="collection"]');
      if (!row || !hasBooksDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      $$('#wbSidebar .is-drop-target').forEach((el) => { if (el !== row.closest('.wb-collection-row')) el.classList.remove('is-drop-target'); });
      row.closest('.wb-collection-row')?.classList.add('is-drop-target');
    });
    root.addEventListener('dragleave', (e) => {
      const row = e.target.closest('[data-axis="collection"]');
      if (!row) return;
      const wrap = row.closest('.wb-collection-row');
      if (wrap && !wrap.contains(e.relatedTarget)) wrap.classList.remove('is-drop-target');
    });
    root.addEventListener('drop', async (e) => {
      const row = e.target.closest('[data-axis="collection"]');
      if (!row) return;
      const ids = draggedIds(e);
      if (!ids.length) return;
      e.preventDefault();
      const wrap = row.closest('.wb-collection-row');
      wrap?.classList.remove('is-drop-target');
      document.body.classList.remove('dragging-books');
      const collectionId = Number(row.dataset.value);
      const collection = state().facets.collections.find((c) => c.id === collectionId);
      try {
        const res = await S.collections.add(collectionId, ids);
        await S.loadFacets();
        S.hooks.facetsChanged();
        toast(res.added
          ? `已把 ${res.added} 本加入「${collection ? collection.name : '分类'}」`
          : '这些书已在该分类中');
      } catch (err) { toast(err.message, true); }
    });

    root.addEventListener('input', (e) => {
      const input = e.target.closest('[data-facet]');
      if (!input) return;
      const key = input.dataset.facet;
      const q = input.value.trim();
      facetUI.query[key] = input.value;
      const list = root.querySelector(`[data-facet-list="${key}"]`);
      if (!list) return;
      const items = state().facets[FACET_KEYS[key]] || [];
      const local = withPinned(key, sortFacetItems(key, q
        ? items.filter((item) => matches(item, q)).slice(0, 100)
        : items));
      list.innerHTML = facetRowsHtml(key, local);
      const note = root.querySelector(`[data-facet-note="${key}"]`);
      if (note) { note.hidden = true; note.textContent = ''; }
      if (!SERVER_FACETS.has(key)) return;
      clearTimeout(searchTimers[key]);
      if (!q) { facetUI.results[key] = null; return; }
      searchTimers[key] = setTimeout(async () => {
        const result = await S.searchFacet(key, q);
        if (!result || !facetUI.expanded[key] || facetUI.query[key].trim() !== q) return;
        const currentList = root.querySelector(`[data-facet-list="${key}"]`);
        if (!currentList) return;
        currentList.innerHTML = facetRowsHtml(key, withPinned(key, sortFacetItems(key, result.items)));
        const currentNote = root.querySelector(`[data-facet-note="${key}"]`);
        if (currentNote) {
          const text = result.total > result.items.length
            ? `仅显示前 ${result.items.length} 项，请输入更精确的关键词` : '';
          currentNote.hidden = !text;
          currentNote.textContent = text;
        }
      }, SEARCH_DELAY);
    });

    root.addEventListener('submit', async (e) => {
      const form = e.target.closest('[data-collection-form]');
      if (!form) return;
      e.preventDefault();
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) return;
      const mode = form.dataset.collectionForm;
      try {
        if (mode === 'create') await S.collections.create(name);
        else await S.collections.rename(Number(form.dataset.id), name);
        S.sidebarEdit = null;
        await S.loadFacets();
        S.hooks.facetsChanged();
        toast(mode === 'create' ? '分类已创建' : '分类已重命名');
      } catch (err) {
        toast(err.message, true);
      }
    });

    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (S.sidebarEdit) {
        S.sidebarEdit = null;
        render();
      }
    });
  }

  S.sidebar = { render, toggleAxis };
})();
