/* ============================================================
 * 书架工作区:左侧资料库
 * 全部图书 / 阅读状态 / 我的分类 / 智能书架 / 系列 / 作者 / 标签
 * ============================================================ */

(function () {
  const S = window.ShelfUI = window.ShelfUI || {};
  const state = () => S.state;
  const facetUI = S.facetUI;
  const LIMIT = 8;
  const FACET_KEYS = { series: 'series', author: 'authors', tag: 'tags' };

  const chevron = '<svg class="wb-chevron" width="8" height="5" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function row({ label, count, active, axis, value, extra = '' }) {
    return `<button type="button" class="wb-row${active ? ' is-active' : ''}" data-axis="${axis}" data-value="${esc(value)}">
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

  function filteredItems(key, items) {
    const q = (facetUI.query[key] || '').trim().toLowerCase();
    const filtered = q ? items.filter((item) => String(item.name).toLowerCase().includes(q)) : items;
    return filtered.slice(0, 100);
  }

  function facetSection(key, title, items) {
    const open = !!facetUI.expanded[key];
    const shown = open ? filteredItems(key, items) : items.slice(0, LIMIT);
    const activeValue = state()[key];
    const rowsHtml = shown.length
      ? shown.map((item) => row({
        label: item.name,
        count: item.count,
        active: String(activeValue) === String(item.name),
        axis: key,
        value: item.name,
      })).join('')
      : '<div class="wb-facet-empty">没有匹配项</div>';
    const input = open
      ? `<input class="wb-facet-filter" data-facet="${key}" value="${esc(facetUI.query[key] || '')}" placeholder="筛选${title}" aria-label="筛选${title}">`
      : '';
    const more = !open && items.length > LIMIT
      ? `<button type="button" class="wb-facet-more" data-facet-more="${key}">显示全部 ${items.length}</button>`
      : (open ? `<button type="button" class="wb-facet-more" data-facet-close="${key}">收起</button>` : '');
    return `<section class="wb-section">
      ${sectionHead(key, title)}
      ${sectionBody(key, `<div class="wb-facet-body" data-facet-body="${key}">${input}<div class="wb-facet-list" data-facet-list="${key}">${rowsHtml}</div>${more}</div>`)}
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
    const series = (f.series || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    const authors = (f.authors || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    const tags = f.tags || [];

    root.innerHTML = `<div class="wb-side-scroll">
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
      Object.assign(s, { q: '', status: '', collection: '', tag: '', author: '', series: '', vl: '', sort: 'updated' });
      const input = document.getElementById('searchInput');
      if (input) input.value = '';
      if (document.body.classList.contains('search-open') && typeof window.closeSearchOverlay === 'function') {
        window.closeSearchOverlay(false);
      }
      S.hooks.filterChanged({ refreshFacets: true, resetSearch: true });
      return;
    }
    if (!['status', 'collection', 'tag', 'author', 'series', 'vl'].includes(axis)) return;
    const current = String(s[axis] || '');
    s[axis] = current === String(value) ? '' : String(value);
    S.hooks.filterChanged({ refreshFacets: axis === 'vl' });
  }

  rootEvents();
  function rootEvents() {
    const root = $('#wbSidebar');
    if (!root) return;
    root.addEventListener('click', async (e) => {
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

    root.addEventListener('input', (e) => {
      const input = e.target.closest('[data-facet]');
      if (!input) return;
      const key = input.dataset.facet;
      facetUI.query[key] = input.value;
      const list = root.querySelector(`[data-facet-list="${key}"]`);
      if (!list) return;
      const items = filteredItems(key, state().facets[FACET_KEYS[key]] || []);
      list.innerHTML = items.length
        ? facetRows(key, items, key)
        : '<div class="wb-facet-empty">没有匹配项</div>';
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
