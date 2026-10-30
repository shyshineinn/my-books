/* ============================================================
 * 书架工作区:封面网格与表格视图
 * ============================================================ */

(function () {
  const S = window.ShelfUI = window.ShelfUI || {};
  const state = () => S.state;

  function cardHtml(book) {
    const selected = state().selection.has(book.id);
    const author = book.author || '';
    return `<article class="wb-card${selected ? ' is-selected' : ''}" data-id="${book.id}"
      tabindex="0" role="option" aria-selected="${selected}"
      aria-label="《${esc(book.title)}》${author ? ' · ' + esc(author) : ''}">
      ${coverHtml(book)}
      <span class="wb-card-check" aria-hidden="true">✓</span>
      <span class="wb-card-overlay" aria-hidden="true">
        <span class="wb-card-title">${esc(book.title)}</span>
        ${author ? `<span class="wb-card-author">${esc(author)}</span>` : ''}
      </span>
    </article>`;
  }

  function rowHtml(book) {
    const selected = state().selection.has(book.id);
    const updated = String(book.updated_at || '').slice(0, 10);
    return `<tr class="${selected ? 'is-selected' : ''}" data-id="${book.id}" tabindex="0" aria-selected="${selected}">
      <td><div class="wb-thumb">${coverHtml(book)}</div></td>
      <td class="wb-t-title" title="${esc(book.title)}">${esc(book.title)}</td>
      <td>${esc(book.author || '—')}</td>
      <td>${esc(book.series_label || book.series || '—')}</td>
      <td>${esc(STATUS_LABEL[book.status] || '')}</td>
      <td class="wb-t-num">${Number(book.rating) > 0 ? esc(String(book.rating)) : '—'}</td>
      <td class="wb-t-format">${esc(book.file_formats || '—')}</td>
      <td class="wb-t-num">${esc(updated || '—')}</td>
    </tr>`;
  }

  const TABLE_HEAD = `<table class="wb-table">
    <thead><tr>
      <th aria-label="封面"></th>
      <th data-sort="title">书名</th>
      <th data-sort="author">作者</th>
      <th data-sort="series">系列</th>
      <th>状态</th>
      <th>评分</th>
      <th>格式</th>
      <th data-sort="updated">更新</th>
    </tr></thead>
    <tbody></tbody>
  </table>`;

  function render(books) {
    const root = $('#bookGrid');
    if (state().view === 'list') {
      root.className = 'wb-table-wrap';
      root.innerHTML = TABLE_HEAD;
      root.querySelector('tbody').innerHTML = books.map(rowHtml).join('');
    } else {
      root.className = 'wb-grid';
      root.innerHTML = books.map(cardHtml).join('');
    }
  }

  function append(books) {
    const root = $('#bookGrid');
    if (!books.length) return;
    if (state().view === 'list') {
      const tbody = root.querySelector('tbody');
      if (tbody) tbody.insertAdjacentHTML('beforeend', books.map(rowHtml).join(''));
    } else {
      const frag = document.createDocumentFragment();
      const wrap = document.createElement('div');
      wrap.innerHTML = books.map(cardHtml).join('');
      while (wrap.firstElementChild) frag.appendChild(wrap.firstElementChild);
      root.appendChild(frag);
    }
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

  S.grid = { render, append, updateSelection, scrollTop, setupSentinel, cardHtml, rowHtml };
})();
