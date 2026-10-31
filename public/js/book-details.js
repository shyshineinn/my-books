/* ============================================================
 * 统一书籍详情组件
 *
 * Inspector（书架右栏 / 手机 Bottom Sheet）和其他页面的详情抽屉
 * 共用这一份内容、数据加载与快捷编辑逻辑。旧 detailModal 的详情 HTML
 * 已迁移到这里，不再维护第二套展示。
 * ============================================================ */

(function () {
  const TAG_PREVIEW = 8;
  const STATUS = [['wish', '想读'], ['reading', '在读'], ['done', '已读']];

  function parseJson(value, fallback) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function tagsOf(book) {
    const tags = parseJson(book && book.tags, []);
    return Array.isArray(tags) ? tags : [];
  }

  function logsOf(book) {
    const logs = parseJson(book && book.read_logs, []);
    return Array.isArray(logs) ? logs : [];
  }

  function fileRows(book) {
    const files = Array.isArray(book.files) ? book.files : [];
    if (!files.length) return '<p class="bd-muted">未上传电子书</p>';
    return `<div class="bd-files">${files.map((f) => `
      <a class="bd-file" href="${esc(f.download_url || `/books-files/${f.path}`)}" download>
        <span class="bd-file-format">.${esc(f.format)}</span>
        <span class="bd-file-size">${fileSizeText(f.size)}</span>
        <span class="bd-file-arrow" aria-hidden="true">↓</span>
      </a>`).join('')}</div>`;
  }

  function identifierRows(book) {
    const list = (book && book.identifier_list) || [];
    const rest = list.filter((x) => !['isbn', 'douban', 'douban_id'].includes(String(x.type).toLowerCase()));
    if (!rest.length) return '';
    return `<div class="bd-row"><span class="bd-k">标识符</span><span class="bd-v">${rest.map((x) => (x.url
      ? `<a class="bd-link" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.label)} ↗</a>`
      : `${esc(x.label)}:${esc(x.value)}`)).join(' · ')}</span></div>`;
  }

  function valueRows(book) {
    const pub = [book.publisher, book.pub_year].filter(Boolean).join(' · ');
    return `
      <div class="bd-row"><span class="bd-k">出版</span><span class="bd-v">${pub ? esc(pub) : '未设置'}</span></div>
      <div class="bd-row"><span class="bd-k">ISBN</span><span class="bd-v">${book.isbn ? esc(book.isbn) : '未设置'}</span></div>
      ${book.douban_id ? `<div class="bd-row"><span class="bd-k">豆瓣</span><span class="bd-v"><a class="bd-link" href="https://book.douban.com/subject/${esc(book.douban_id)}/" target="_blank" rel="noopener noreferrer">查看豆瓣条目 ↗</a></span></div>` : ''}
      ${identifierRows(book)}`;
  }

  function logsHtml(book) {
    const logs = logsOf(book);
    if (!logs.length) {
      if (!book.start_date && !book.finish_date) return '';
      const legacy = [book.start_date ? `开始于 ${book.start_date}` : '', book.finish_date ? `读完于 ${book.finish_date}` : ''].filter(Boolean).join(' · ');
      return `<section class="bd-section">
        <h3 class="bd-section-title">阅读记录</h3>
        <div class="bd-chips"><span class="log-chip">${esc(legacy)}</span></div>
      </section>`;
    }
    return `<section class="bd-section">
      <h3 class="bd-section-title">阅读记录</h3>
      <div class="bd-chips">${logs.map((l) => `<span class="log-chip">${esc(l.start || '开始未记')}${l.finish ? ' 至 ' + esc(l.finish) : ' · 进行中'}</span>`).join('')}</div>
    </section>`;
  }

  function headHtml() {
    return `<div class="bd-head">
      <span class="bd-grabber" data-bd-grabber aria-hidden="true"></span>
      <button type="button" class="icon-btn bd-close" data-bd-close aria-label="关闭详情">✕</button>
    </div>`;
  }

  function contentHtml(book, state) {
    const tags = tagsOf(book);
    const visibleTags = state.tagsExpanded ? tags : tags.slice(0, TAG_PREVIEW);
    const rating = Number(book.rating) > 0 ? book.rating : '';
    const custom = book.custom_display && typeof book.custom_display === 'object' ? book.custom_display : {};
    const memberships = Array.isArray(book.collections) ? book.collections : [];
    const available = (state.collections || []).filter((c) => !memberships.some((m) => String(m.id) === String(c.id)));
    const pop = state.collectionPop ? `<div class="bd-pop" data-glass="refract" role="dialog" aria-label="加入分类">
      ${state.collectionsLoading ? '<div class="bd-pop-empty">载入中…</div>' : (available.length
        ? available.map((c) => `<button type="button" data-bd-add-collection="${c.id}">${esc(c.name)}</button>`).join('')
        : '<div class="bd-pop-empty">已在该书的全部分类中</div>')}
      <form class="bd-inline-form" data-bd-new-collection>
        <input class="bd-inline-input" name="name" placeholder="新建分类并加入" maxlength="100" aria-label="新建分类并加入">
        <button class="btn btn-primary btn-sm" type="submit">加入</button>
      </form>
    </div>` : '';

    return `<div class="bd-scroll">
      ${headHtml()}
      <div class="bd-hero">
        <div class="bd-cover">${coverHtml(book)}</div>
        <div class="bd-intro">
          <h2 class="bd-title">${esc(book.title)}</h2>
          <p class="bd-author">${book.author ? esc(book.author) : '未设置作者'}</p>
          <div class="seg seg--track bd-status" role="group" aria-label="阅读状态">
            ${STATUS.map(([value, label]) => `<button type="button" class="${book.status === value ? 'active' : ''}" data-bd-status="${value}">${label}</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="bd-meta">
        <div class="bd-row">
          <span class="bd-k">评分</span>
          <span class="bd-v bd-rating-line"><input class="bd-input bd-rating-input" type="number" min="0" max="10" step="0.1" value="${esc(String(rating))}" placeholder="未设置" data-bd-rating aria-label="评分（满分 10）"><span class="bd-unit">/ 10</span></span>
        </div>
        <div class="bd-row">
          <span class="bd-k">系列</span>
          <span class="bd-v bd-series">
            <input class="bd-input" type="text" value="${esc(book.series || '')}" placeholder="系列名" data-bd-series-name aria-label="系列名">
            <input class="bd-input bd-series-index" type="text" value="${esc(book.series_index || '')}" placeholder="序号" data-bd-series-index aria-label="系列序号">
          </span>
        </div>
        ${valueRows(book)}
      </div>

      ${book.summary ? `<section class="bd-section"><h3 class="bd-section-title">简介</h3><p class="bd-summary">${esc(book.summary)}</p></section>` : ''}
      ${logsHtml(book)}

      <section class="bd-section">
        <h3 class="bd-section-title">标签</h3>
        <div class="bd-chips">
          ${visibleTags.map((t) => `<span class="tag-chip bd-tag">${esc(t)}<button type="button" data-bd-remove-tag="${esc(t)}" aria-label="移除标签 ${esc(t)}">✕</button></span>`).join('')}
          ${tags.length > TAG_PREVIEW ? `<button type="button" class="bd-chip-more" data-bd-tags-more>${state.tagsExpanded ? '收起' : `显示更多 (${tags.length - TAG_PREVIEW})`}</button>` : ''}
          <input class="bd-chip-input" type="text" placeholder="+ 标签" data-bd-new-tag aria-label="添加标签">
        </div>
      </section>

      <section class="bd-section">
        <h3 class="bd-section-title">分类</h3>
        <div class="bd-collection">
          <div class="bd-chips">
            ${memberships.map((c) => `<span class="tag-chip bd-tag">${esc(c.name)}<button type="button" data-bd-remove-collection="${c.id}" aria-label="移出分类 ${esc(c.name)}">✕</button></span>`).join('')}
            <button type="button" class="bd-chip-add" data-bd-collection-add>+ 分类</button>
          </div>
          ${pop}
        </div>
      </section>

      <section class="bd-section">
        <h3 class="bd-section-title">电子书</h3>
        ${fileRows(book)}
      </section>

      ${Object.keys(custom).length ? `<section class="bd-section"><h3 class="bd-section-title">自定义字段</h3><div class="bd-meta">${Object.entries(custom).map(([k, v]) => `<div class="bd-row"><span class="bd-k">${esc(k)}</span><span class="bd-v">${esc(v)}</span></div>`).join('')}</div></section>` : ''}

      <div class="bd-actions">
        <button type="button" class="btn btn-primary" data-bd-edit>编辑全部</button>
        <a class="btn btn-ghost" href="/notes/${book.id}">读书心得</a>
        <button type="button" class="btn btn-danger-tint" data-bd-delete>移到回收站</button>
      </div>
    </div>`;
  }

  async function defaultLoadBook(id) {
    return api('/api/books/' + id);
  }

  async function defaultPatchBook(book, patch) {
    let base = book;
    if (!base || !base.revision || !base.uuid) base = await defaultLoadBook(book.id);
    const body = { ...patch, expected_revision: base.revision, expected_uuid: base.uuid };
    return api('/api/books/' + book.id, { method: 'PATCH', body: JSON.stringify(body) });
  }

  async function defaultCollections() {
    const list = await api('/api/collections').catch(() => []);
    return Array.isArray(list) ? list : [];
  }

  function create(host, options = {}) {
    if (!host) throw new Error('BookDetails requires a host element');
    const sheet = options.sheet || host.closest('.wb-inspector, .book-detail-sheet') || host;
    const state = {
      book: null,
      seq: 0,
      tagsExpanded: false,
      collectionPop: false,
      collections: null,
      collectionsLoading: false,
      busy: false,
    };
    let destroyed = false;
    let drag = null;

    const loadBook = options.loadBook || defaultLoadBook;
    const patchBook = options.patchBook || defaultPatchBook;
    const loadCollections = options.loadCollections || defaultCollections;

    function toastSafe(message, isError = false) {
      if (typeof toast === 'function') toast(message, isError);
    }

    function render() {
      if (destroyed || !state.book) return;
      const previous = host.querySelector('.bd-scroll');
      const scrollTop = previous ? previous.scrollTop : 0;
      host.innerHTML = contentHtml(state.book, state);
      const next = host.querySelector('.bd-scroll');
      if (next && scrollTop) next.scrollTop = scrollTop;
    }

    function setBook(book) {
      if (!book) { showMessage('选择一本书'); return; }
      if (!state.book || state.book.id !== book.id) {
        state.tagsExpanded = false;
        state.collectionPop = false;
        state.collections = null;
      }
      state.book = book;
      render();
    }

    function showMessage(message, { loading = false } = {}) {
      host.innerHTML = `<div class="bd-scroll">
        ${headHtml()}
        <div class="bd-empty"${loading ? ' aria-busy="true"' : ''}>${esc(message)}</div>
      </div>`;
    }

    async function reload() {
      if (!state.book) return null;
      const book = await loadBook(state.book.id);
      if (book) setBook(book);
      return book;
    }

    async function patch(patchData, message) {
      if (!state.book || state.busy) return;
      state.busy = true;
      try {
        const updated = await patchBook(state.book, patchData);
        if (updated) state.book = updated;
        render();
        await options.onChanged?.(state.book, patchData);
        if (message) toastSafe(message);
      } catch (err) {
        toastSafe(err.message, true);
        if (err.code === 'CONFLICT') {
          try { await reload(); } catch { /* ignore */ }
        }
      } finally {
        state.busy = false;
      }
    }

    async function ensureCollections() {
      if (state.collections) return;
      state.collectionsLoading = true;
      render();
      state.collections = await loadCollections() || [];
      state.collectionsLoading = false;
      render();
    }

    async function addCollection(id) {
      if (!state.book) return;
      try {
        await api('/api/collections/' + id + '/books', { method: 'POST', body: JSON.stringify({ ids: [state.book.id] }) });
        state.collectionPop = false;
        await reload();
        toastSafe('已加入分类');
        await options.onChanged?.(state.book, { collection: true });
      } catch (err) { toastSafe(err.message, true); }
    }

    async function removeCollection(id) {
      if (!state.book) return;
      try {
        await api('/api/collections/' + id + '/books', { method: 'DELETE', body: JSON.stringify({ ids: [state.book.id] }) });
        await reload();
        toastSafe('已移出分类');
        await options.onChanged?.(state.book, { collection: true });
      } catch (err) { toastSafe(err.message, true); }
    }

    async function createCollection(name) {
      if (!state.book) return;
      try {
        const created = await api('/api/collections', { method: 'POST', body: JSON.stringify({ name }) });
        const id = created && created.item ? created.item.id : created && created.id;
        if (id) await api('/api/collections/' + id + '/books', { method: 'POST', body: JSON.stringify({ ids: [state.book.id] }) });
        state.collectionPop = false;
        await reload();
        toastSafe('分类已创建并加入');
        await options.onChanged?.(state.book, { collection: true });
      } catch (err) { toastSafe(err.message, true); }
    }

    function closePop() {
      if (!state.collectionPop) return false;
      state.collectionPop = false;
      render();
      return true;
    }

    function onClick(e) {
      if (!state.book) {
        if (e.target.closest('[data-bd-close]')) { e.preventDefault(); options.onClose?.(); }
        return;
      }
      if (e.target.closest('[data-bd-close]')) { e.preventDefault(); options.onClose?.(); return; }
      const status = e.target.closest('[data-bd-status]');
      if (status) { patch({ status: status.dataset.bdStatus }, '状态已更新'); return; }
      if (e.target.closest('[data-bd-tags-more]')) { state.tagsExpanded = !state.tagsExpanded; render(); return; }
      const removeTag = e.target.closest('[data-bd-remove-tag]');
      if (removeTag) {
        const tags = tagsOf(state.book).filter((t) => t !== removeTag.dataset.bdRemoveTag);
        patch({ tags }, '标签已更新');
        return;
      }
      if (e.target.closest('[data-bd-collection-add]')) {
        state.collectionPop = !state.collectionPop;
        if (state.collectionPop) {
          state.collections = null;
          ensureCollections();
        } else {
          render();
        }
        return;
      }
      const addCollectionBtn = e.target.closest('[data-bd-add-collection]');
      if (addCollectionBtn) { addCollection(Number(addCollectionBtn.dataset.bdAddCollection)); return; }
      const removeCollectionBtn = e.target.closest('[data-bd-remove-collection]');
      if (removeCollectionBtn) { removeCollection(Number(removeCollectionBtn.dataset.bdRemoveCollection)); return; }
      if (e.target.closest('[data-bd-edit]')) { options.onEdit?.(state.book); return; }
      if (e.target.closest('[data-bd-delete]')) { options.onDelete?.(state.book); }
    }

    function onChange(e) {
      if (!state.book) return;
      if (e.target.matches('[data-bd-rating]')) {
        patch({ rating: e.target.value === '' ? 0 : Number(e.target.value) }, '评分已更新');
        return;
      }
      if (e.target.matches('[data-bd-series-name], [data-bd-series-index]')) {
        const name = host.querySelector('[data-bd-series-name]');
        const index = host.querySelector('[data-bd-series-index]');
        patch({
          series: name ? name.value.trim() : '',
          series_index: index ? index.value.trim() : '',
        }, '系列已更新');
      }
    }

    function onKeydown(e) {
      if (e.key === 'Enter' && e.target.matches('[data-bd-new-tag]')) {
        e.preventDefault();
        const value = e.target.value.trim();
        if (!value) return;
        const tags = [...new Set([...tagsOf(state.book), value])];
        e.target.value = '';
        patch({ tags }, '标签已添加');
      }
    }

    function onSubmit(e) {
      const form = e.target.closest('[data-bd-new-collection]');
      if (!form) return;
      e.preventDefault();
      const name = String(new FormData(form).get('name') || '').trim();
      if (name) createCollection(name);
    }

    function onDocPointer(e) {
      if (!state.collectionPop) return;
      if (e.target.closest('.bd-pop') || e.target.closest('[data-bd-collection-add]')) return;
      closePop();
    }

    function onDocKey(e) {
      if (e.key !== 'Escape') return;
      const modalHost = host.closest('.modal');
      if (host.hidden || (modalHost && modalHost.classList.contains('hidden'))) return;
      const other = document.querySelector(
        '.modal:not(.hidden), .sel-menu:not([hidden]), #mobileMenu.open, #searchFlyout.open, .wb-brand-menu:not([hidden]), .wb-layout-menu:not([hidden])'
      );
      // 详情自身的 modal 容器不算“上层浮层”；上层弹窗/菜单先处理自己的 Escape。
      if (other && !other.contains(host)) return;
      if (state.collectionPop) {
        e.preventDefault();
        e.stopPropagation();
        closePop();
        return;
      }
      if (host.closest('.modal.hidden')) return;
      e.preventDefault();
      e.stopPropagation();
      options.onClose?.();
    }

    function startDrag(e) {
      if (!e.target.closest('[data-bd-grabber]')) return;
      if (e.pointerType === 'mouse') return;
      drag = { id: e.pointerId, y: e.clientY, dy: 0 };
      sheet.style.transition = 'none';
      try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }

    function moveDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag.dy = Math.max(0, e.clientY - drag.y);
      sheet.style.transform = `translateY(${drag.dy}px)`;
      e.preventDefault();
    }

    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = drag.dy;
      drag = null;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 80) options.onClose?.();
    }

    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('keydown', onKeydown);
    host.addEventListener('submit', onSubmit);
    host.addEventListener('pointerdown', startDrag);
    host.addEventListener('pointermove', moveDrag);
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', endDrag);
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey, true);

    return {
      setBook,
      showMessage,
      reload,
      closePop,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        host.removeEventListener('click', onClick);
        host.removeEventListener('change', onChange);
        host.removeEventListener('keydown', onKeydown);
        host.removeEventListener('submit', onSubmit);
        host.removeEventListener('pointerdown', startDrag);
        host.removeEventListener('pointermove', moveDrag);
        host.removeEventListener('pointerup', endDrag);
        host.removeEventListener('pointercancel', endDrag);
        document.removeEventListener('pointerdown', onDocPointer, true);
        document.removeEventListener('keydown', onDocKey, true);
      },
      get book() { return state.book; },
    };
  }

  window.BookDetails = {
    create,
    defaultLoadBook,
    defaultPatchBook,
    defaultCollections,
    tagsOf,
  };
})();
