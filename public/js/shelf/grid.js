/* ============================================================
 * 书架工作区:封面网格与表格视图
 * ============================================================ */

(function () {
  const S = window.ShelfUI = window.ShelfUI || {};
  const state = () => S.state;

  const isMobile = () => window.matchMedia('(max-width: 819px)').matches;

  function cardHtml(book) {
    const selected = state().selection.has(book.id);
    const author = book.author || '';
    return `<article class="wb-card${selected ? ' is-selected' : ''}" data-id="${book.id}"
      tabindex="-1" role="option" aria-selected="${selected}" draggable="${isMobile() ? 'false' : 'true'}"
      aria-label="《${esc(book.title)}》${author ? ' · ' + esc(author) : ''}">
      <div class="wb-card-cover">
        ${coverHtml(book)}
        <span class="wb-card-check" aria-hidden="true">✓</span>
        <span class="wb-card-overlay" aria-hidden="true">
          <span class="wb-card-title">${esc(book.title)}</span>
          ${author ? `<span class="wb-card-author">${esc(author)}</span>` : ''}
        </span>
      </div>
      <div class="wb-card-info">
        <span class="wb-card-name">${esc(book.title)}</span>
        ${author ? `<span class="wb-card-byline">${esc(author)}</span>` : ''}
      </div>
    </article>`;
  }

  function listRowHtml(book) {
    const selected = state().selection.has(book.id);
    const author = book.author || '';
    const formats = book.file_formats ? `<span class="wb-list-format">${esc(book.file_formats)}</span>` : '';
    return `<article class="wb-list-row${selected ? ' is-selected' : ''}" data-id="${book.id}"
      tabindex="-1" role="option" aria-selected="${selected}" draggable="false"
      aria-label="《${esc(book.title)}》${author ? ' · ' + esc(author) : ''}">
      <div class="wb-list-cover">${coverHtml(book)}</div>
      <div class="wb-list-main">
        <span class="wb-list-title">${esc(book.title)}</span>
        <span class="wb-list-author">${esc(author || '—')}</span>
      </div>
      <div class="wb-list-side">
        <span class="wb-list-status ${esc(book.status)}">${esc(STATUS_LABEL[book.status] || '')}</span>
        ${formats}
      </div>
    </article>`;
  }

  const COLUMN_ORDER = ['cover', 'title', 'author', 'series', 'status', 'rating', 'format', 'publisher', 'pubYear', 'isbn', 'tags', 'readCount', 'updated'];
  const COLUMN_DEFS = {
    cover: { label: '', cell: (b) => `<td><div class="wb-thumb">${coverHtml(b)}</div></td>` },
    title: { label: '书名', sort: 'title', cell: (b) => `<td class="wb-t-title" title="${esc(b.title)}">${esc(b.title)}</td>` },
    author: { label: '作者', sort: 'author', cell: (b) => `<td>${esc(b.author || '—')}</td>` },
    series: { label: '系列', sort: 'series', cell: (b) => `<td>${esc(b.series_label || b.series || '—')}</td>` },
    status: { label: '状态', cell: (b) => `<td>${esc(STATUS_LABEL[b.status] || '')}</td>` },
    rating: { label: '评分', cell: (b) => `<td class="wb-t-num">${Number(b.rating) > 0 ? esc(String(b.rating)) : '—'}</td>` },
    format: { label: '格式', cell: (b) => `<td class="wb-t-format">${esc(b.file_formats || '—')}</td>` },
    publisher: { label: '出版社', cell: (b) => `<td>${esc(b.publisher || '—')}</td>` },
    pubYear: { label: '出版年', cell: (b) => `<td>${esc(b.pub_year || '—')}</td>` },
    isbn: { label: 'ISBN', cell: (b) => `<td class="wb-t-format">${esc(b.isbn || '—')}</td>` },
    tags: {
      label: '标签',
      cell: (b) => {
        let tags = [];
        try { tags = JSON.parse(b.tags || '[]'); } catch { tags = []; }
        return `<td class="wb-t-format">${esc(Array.isArray(tags) ? tags.join(', ') : '') || '—'}</td>`;
      },
    },
    readCount: { label: '读过', cell: (b) => `<td class="wb-t-num">${(b.read_count || 0) > 1 ? `${b.read_count} 次` : '—'}</td>` },
    updated: { label: '更新', sort: 'updated', cell: (b) => `<td class="wb-t-num">${esc(String(b.updated_at || '').slice(0, 10) || '—')}</td>` },
  };
  const FIXED_COLUMNS = new Set(['cover', 'title', 'author', 'status', 'updated']);

  function tableKeys() {
    const visible = new Set([...FIXED_COLUMNS, ...(state().columns || [])]);
    return COLUMN_ORDER.filter((key) => visible.has(key));
  }

  function rowHtml(book, keys = tableKeys()) {
    const selected = state().selection.has(book.id);
    return `<tr class="${selected ? 'is-selected' : ''}" data-id="${book.id}" tabindex="-1" aria-selected="${selected}" draggable="true">
      ${keys.map((key) => COLUMN_DEFS[key].cell(book)).join('')}
    </tr>`;
  }

  function tableHeadHtml(keys = tableKeys()) {
    return `<table class="wb-table" aria-label="书籍">
      <thead><tr>${keys.map((key) => {
        const col = COLUMN_DEFS[key];
        const sorted = col.sort && state().sort === col.sort;
        return `<th${col.sort ? ` data-sort="${col.sort}" tabindex="0"${sorted ? ' aria-sort="ascending"' : ''}` : ''}${key === 'cover' ? ' aria-label="封面"' : ''}>${col.label}</th>`;
      }).join('')}</tr></thead>
      <tbody></tbody>
    </table>`;
  }

  function itemEls() {
    return $$('#bookGrid [data-id]');
  }

  function applyRoving(activeId) {
    const items = itemEls();
    if (!items.length) { state().focusId = null; return; }
    const wanted = activeId != null ? Number(activeId) : state().focusId;
    let active = items.find((el) => Number(el.dataset.id) === wanted);
    if (!active) {
      active = items.find((el) => state().selection.has(Number(el.dataset.id))) || items[0];
    }
    items.forEach((el) => { el.tabIndex = el === active ? 0 : -1; });
    state().focusId = Number(active.dataset.id);
  }

  function focusItem(id, { scroll = true } = {}) {
    const el = itemEls().find((item) => Number(item.dataset.id) === Number(id));
    if (!el) return false;
    applyRoving(id);
    el.focus({ preventScroll: true });
    if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  function render(books) {
    const root = $('#bookGrid');
    if (state().view === 'list' && isMobile()) {
      root.className = 'wb-mobile-list';
      root.setAttribute('role', 'listbox');
      root.setAttribute('aria-multiselectable', 'true');
      root.innerHTML = books.map(listRowHtml).join('');
    } else if (state().view === 'list') {
      const keys = tableKeys();
      root.className = 'wb-table-wrap';
      root.removeAttribute('role');
      root.removeAttribute('aria-multiselectable');
      root.innerHTML = tableHeadHtml(keys);
      root.querySelector('tbody').innerHTML = books.map((book) => rowHtml(book, keys)).join('');
    } else {
      root.className = 'wb-grid';
      root.setAttribute('role', 'listbox');
      root.setAttribute('aria-multiselectable', 'true');
      root.innerHTML = books.map(cardHtml).join('');
    }
    applyRoving();
  }

  function append(books) {
    const root = $('#bookGrid');
    if (!books.length) return;
    if (state().view === 'list' && isMobile()) {
      root.insertAdjacentHTML('beforeend', books.map(listRowHtml).join(''));
    } else if (state().view === 'list') {
      const tbody = root.querySelector('tbody');
      if (tbody) tbody.insertAdjacentHTML('beforeend', books.map((book) => rowHtml(book)).join(''));
    } else {
      const frag = document.createDocumentFragment();
      const wrap = document.createElement('div');
      wrap.innerHTML = books.map(cardHtml).join('');
      while (wrap.firstElementChild) frag.appendChild(wrap.firstElementChild);
      root.appendChild(frag);
    }
    applyRoving();
  }

  function updateSelection() {
    const selected = state().selection;
    $$('#bookGrid [data-id]').forEach((el) => {
      const on = selected.has(Number(el.dataset.id));
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-selected', String(on));
    });
  }

  function scrollTop() {
    const content = $('#wbContent');
    if (content) content.scrollTop = 0;
  }

  function setupSentinel(onReach) {
    const sentinel = $('#shelfSentinel');
    if (!sentinel || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onReach();
    }, { root: $('#wbContent'), rootMargin: '700px 0px' });
    observer.observe(sentinel);
  }

  S.grid = {
    render, append, updateSelection, scrollTop, setupSentinel, applyRoving, focusItem,
    cardHtml, rowHtml, listRowHtml,
  };
})();
