/* ============================================================
 * 书架工作区:状态、URL 与 API
 * 不直接操作 DOM;render 模块读取 ShelfUI.store.state。
 * ============================================================ */

(function () {
  const S = window.ShelfUI = window.ShelfUI || {};
  const PAGE_SIZE = 60;
  const SORTS = ['updated', 'created', 'title', 'author', 'series', 'finish', 'relevance'];

  S.PAGE_SIZE = PAGE_SIZE;
  S.state = {
    q: '',
    status: '',
    collection: '',
    tag: '',
    author: '',
    series: '',
    vl: '',
    sort: 'updated',
    view: 'grid',
    books: [],
    total: null,
    start: 0,
    loading: false,
    hasMore: true,
    selection: new Set(),
    anchorId: null,
    selectMode: false,
    inspectorOpen: false,
    inspectorId: null,
    inspectorBook: null,
    inspectorLoading: false,
    facets: {
      total: 0,
      byStatus: { wish: 0, reading: 0, done: 0 },
      collections: [],
      virtualLibraries: [],
      series: [],
      authors: [],
      tags: [],
    },
  };
  S.ui = { pageSeq: 0, facetSeq: 0, detailSeq: 0 };
  S.facetUI = { expanded: {}, query: {} };

  const COLLAPSE_KEY = 'shelf.sidebar.collapsed';
  function readCollapsed() {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw : []);
    } catch { return new Set(); }
  }
  S.collapsed = readCollapsed();
  S.saveCollapsed = function () {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...S.collapsed])); } catch { /* ignore */ }
  };

  S.parseUrl = function () {
    const p = new URLSearchParams(location.search);
    const s = S.state;
    s.q = p.get('q') || '';
    s.status = ['wish', 'reading', 'done'].includes(p.get('status')) ? p.get('status') : '';
    s.collection = /^\d+$/.test(p.get('collection') || '') ? p.get('collection') : '';
    s.tag = p.get('tag') || '';
    s.author = p.get('author') || '';
    s.series = p.get('series') || '';
    s.vl = p.get('vl') || '';
    const sort = p.get('sort');
    s.sort = SORTS.includes(sort) ? sort : 'updated';
    if (s.q && s.sort === 'updated') s.sort = 'relevance';
    if (!s.q && s.sort === 'relevance') s.sort = 'updated';
    s.view = p.get('view') === 'list' ? 'list' : 'grid';
    if (s.q) {
      const input = document.getElementById('searchInput');
      if (input) input.value = s.q;
    }
  };

  S.params = function () {
    const s = S.state;
    const p = new URLSearchParams();
    if (s.q) p.set('q', s.q);
    if (s.status) p.set('status', s.status);
    if (s.collection) p.set('collection', s.collection);
    if (s.tag) p.set('tag', s.tag);
    if (s.author) p.set('author', s.author);
    if (s.series) p.set('series', s.series);
    if (s.vl) p.set('vl', s.vl);
    if (s.sort && !(s.sort === 'updated' && !s.q)) p.set('sort', s.sort);
    return p;
  };

  S.syncUrl = function () {
    const p = S.params();
    if (S.state.view === 'list') p.set('view', 'list');
    const qs = p.toString();
    history.replaceState(null, '', qs ? '/shelf?' + qs : '/shelf');
  };

  S.resetPage = function () {
    const s = S.state;
    s.books = [];
    s.start = 0;
    s.total = null;
    s.hasMore = true;
  };

  S.loadPage = async function ({ append = false } = {}) {
    const s = S.state;
    if (append && (s.loading || !s.hasMore)) return null;
    const seq = ++S.ui.pageSeq;
    s.loading = true;
    const p = S.params();
    p.set('size', String(PAGE_SIZE));
    p.set('start', String(s.start));
    try {
      const { data, total } = await apiPage('/api/books?' + p.toString());
      if (seq !== S.ui.pageSeq) return null;
      const rows = Array.isArray(data) ? data : [];
      s.books = append ? s.books.concat(rows) : rows;
      s.total = total;
      s.start = s.books.length;
      s.hasMore = total === null ? rows.length === PAGE_SIZE : s.books.length < total;
      return { rows, total, append };
    } finally {
      if (seq === S.ui.pageSeq) s.loading = false;
    }
  };

  const vlQuery = () => (S.state.vl ? '?vl=' + encodeURIComponent(S.state.vl) : '');

  S.loadFacets = async function () {
    const seq = ++S.ui.facetSeq;
    const query = vlQuery();
    const fallback = (value) => api(value).catch(() => null);
    const [stats, collections, virtualLibraries, series, authors, tags] = await Promise.all([
      fallback('/api/stats' + query),
      fallback('/api/collections' + query),
      fallback('/api/virtual-libraries'),
      fallback('/api/series' + query),
      fallback('/api/authors' + query),
      fallback('/api/tags' + query),
    ]);
    if (seq !== S.ui.facetSeq) return;
    S.state.facets = {
      total: Number(stats && stats.total) || 0,
      byStatus: (stats && stats.byStatus) || { wish: 0, reading: 0, done: 0 },
      collections: Array.isArray(collections) ? collections : [],
      virtualLibraries: Array.isArray(virtualLibraries) ? virtualLibraries : [],
      series: Array.isArray(series) ? series : [],
      authors: Array.isArray(authors) ? authors : [],
      tags: Array.isArray(tags) ? tags : [],
    };
  };

  S.loadDetail = async function (id) {
    const seq = ++S.ui.detailSeq;
    try {
      const book = await api('/api/books/' + id);
      if (seq === S.ui.detailSeq) S.state.inspectorBook = book;
      return book;
    } finally {
      if (seq === S.ui.detailSeq) S.state.inspectorLoading = false;
    }
  };

  S.updateBook = function (book) {
    const s = S.state;
    if (s.inspectorBook && s.inspectorBook.id === book.id) s.inspectorBook = book;
    const row = s.books.find((b) => b.id === book.id);
    if (row) Object.assign(row, book);
  };

  S.patchBook = async function (id, patch) {
    const s = S.state;
    let base = s.inspectorBook && s.inspectorBook.id === id ? s.inspectorBook : s.books.find((b) => b.id === id);
    if (!base || !base.revision || !base.uuid) base = await S.loadDetail(id);
    const body = { ...patch, expected_revision: base.revision, expected_uuid: base.uuid };
    const updated = await api('/api/books/' + id, { method: 'PATCH', body: JSON.stringify(body) });
    S.updateBook(updated);
    return updated;
  };

  S.collections = {
    create: (name) => api('/api/collections', { method: 'POST', body: JSON.stringify({ name }) }),
    rename: (id, name) => api('/api/collections/' + id, { method: 'PUT', body: JSON.stringify({ name }) }),
    remove: (id) => api('/api/collections/' + id, { method: 'DELETE' }),
    add: (id, ids) => api('/api/collections/' + id + '/books', { method: 'POST', body: JSON.stringify({ ids }) }),
    removeBooks: (id, ids) => api('/api/collections/' + id + '/books', { method: 'DELETE', body: JSON.stringify({ ids }) }),
  };
})();
