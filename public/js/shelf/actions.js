/* ============================================================
 * 书架工作区:选择、批量编辑与批量补全
 * ============================================================ */

(function () {
  const S = window.ShelfUI = window.ShelfUI || {};
  const ENRICH_MAX = 100;
  const state = () => S.state;

  function refreshBulkBar() {
    const bar = $('#bulkBar');
    if (!bar) return;
    document.body.classList.toggle('select-mode', state().selectMode);
    const n = state().selection.size;
    const visible = (state().selectMode || n > 1) && n > 0;
    bar.classList.toggle('hidden', !visible);
    const count = $('#bulkCount');
    if (count) count.textContent = `已选 ${n} 本`;
    const edit = $('#bulkEditBtn');
    const enrich = $('#bulkEnrichBtn');
    if (edit) edit.disabled = n === 0;
    if (enrich) {
      const tooMany = n > ENRICH_MAX;
      enrich.disabled = n === 0 || tooMany;
      enrich.title = tooMany ? `一次最多补全 ${ENRICH_MAX} 本,请分批` : '从豆瓣/Open Library 补全简介、出版社、评分、封面等';
    }
    const save = $('#bulkSaveBtn');
    if (save) save.textContent = `应用到 ${n} 本`;
  }

  function syncSelection() {
    if (state().selection.size <= 1) S.multiPop = false;
    S.grid.updateSelection();
    refreshBulkBar();
    S.inspector.loadSelection();
  }

  function clearSelection() {
    state().selection.clear();
    state().anchorId = null;
    state().selectMode = false;
    syncSelection();
  }

  function selectOnly(id, { openInspector = true } = {}) {
    const s = state();
    s.selection.clear();
    s.selection.add(id);
    s.anchorId = id;
    s.selectMode = false;
    if (window.matchMedia('(max-width: 899px)').matches) {
      $('#shelfWorkbench').classList.add('sidebar-collapsed');
    }
    syncSelection();
    if (openInspector && !s.inspectorOpen) {
      s.inspectorOpen = true;
      S.inspector.show();
    }
  }

  function toggleSelected(id) {
    const s = state();
    s.selectMode = true;
    if (s.selection.has(id)) s.selection.delete(id);
    else s.selection.add(id);
    s.anchorId = id;
    syncSelection();
  }

  function selectRange(id) {
    const s = state();
    const ids = s.books.map((b) => b.id);
    const to = ids.indexOf(id);
    const anchor = s.anchorId != null ? ids.indexOf(s.anchorId) : to;
    if (to < 0) return;
    const from = anchor < 0 ? to : anchor;
    s.selection = new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
    s.selectMode = true;
    syncSelection();
  }

  function openBulk() {
    if (!state().selection.size) return;
    const status = $('#bulkStatus');
    if (status) { status.value = ''; syncCustomSelect(status); }
    ['bulkRating', 'bulkTagsAdd', 'bulkTagsRemove', 'bulkSeries',
      'bulkSeriesIndex', 'bulkPublisher', 'bulkPubYear'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const err = $('#bulkError');
    if (err) err.textContent = '';
    const save = $('#bulkSaveBtn');
    if (save) save.disabled = false;
    openModal('#bulkModal');
  }

  async function applyBulkEdit() {
    const errEl = $('#bulkError');
    if (errEl) errEl.textContent = '';
    const patch = {};
    const value = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };
    if (value('bulkStatus')) patch.status = value('bulkStatus');
    if (value('bulkTagsAdd')) patch.tags_add = value('bulkTagsAdd');
    if (value('bulkTagsRemove')) patch.tags_remove = value('bulkTagsRemove');
    if (value('bulkSeries')) patch.series = value('bulkSeries');
    if (value('bulkSeriesIndex') !== '') patch.series_index = value('bulkSeriesIndex');
    if (value('bulkPublisher')) patch.publisher = value('bulkPublisher');
    if (value('bulkPubYear')) patch.pub_year = value('bulkPubYear');
    if (value('bulkRating') !== '') patch.rating = value('bulkRating');

    if (!Object.keys(patch).length) {
      if (errEl) errEl.textContent = '至少选择一个要修改的字段';
      return;
    }
    const btn = $('#bulkSaveBtn');
    if (btn) btn.disabled = true;
    try {
      const res = await api('/api/books/bulk', {
        method: 'POST',
        body: JSON.stringify({ ids: [...state().selection], patch }),
      });
      closeModals();
      clearSelection();
      await S.hooks.reloadAll();
      toast(`已更新 ${res.updated} 本`);
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      if (btn) btn.disabled = false;
    }
  }

  async function runEnrich() {
    const ids = [...state().selection];
    if (!ids.length) return;
    const btn = $('#bulkEnrichBtn');
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '补全中…'; }
    try {
      const res = await api('/api/books/enrich', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      const s = res.summary || {};
      const parts = [];
      if (s.updated) parts.push(`补全 ${s.updated} 本`);
      if (s.unchanged) parts.push(`${s.unchanged} 本无可补`);
      if (s.not_found) parts.push(`${s.not_found} 本未找到`);
      if (s.blocked) parts.push(`${s.blocked} 本被豆瓣拒绝`);
      if (s.skipped) parts.push(`${s.skipped} 本缺 ISBN/书名`);
      if (s.error) parts.push(`${s.error} 本出错`);
      if (s.cover_failed) parts.push(`${s.cover_failed} 本封面未下载`);
      toast(parts.length ? parts.join(' · ') : '没有可补全的书');
      if (btn) { btn.textContent = oldText; btn.disabled = false; }
      clearSelection();
      await S.hooks.reloadAll();
    } catch (err) {
      toast(err.message || '批量补全失败', true);
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  S.actions = {
    refreshBulkBar, syncSelection, clearSelection, selectOnly, toggleSelected, selectRange,
    openBulk, applyBulkEdit, runEnrich,
  };

  $('#bulkCancelBtn').addEventListener('click', clearSelection);
  $('#bulkEditBtn').addEventListener('click', openBulk);
  $('#bulkEnrichBtn').addEventListener('click', runEnrich);
  $('#bulkSaveBtn').addEventListener('click', applyBulkEdit);
  initCustomSelect($('#bulkStatus'));
})();
