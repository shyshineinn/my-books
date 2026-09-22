/* ============ 状态与工具 ============ */
const state = { q: '', status: '', tag: '', sort: 'updated', view: 'home', prevView: 'shelf', books: [],
  settings: { notesRepo: '', notesBranch: 'main' } };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STATUS_LABEL = { wish: '想读', reading: '在读', done: '已读' };

/* 默认封面:Apple 产品配色(午夜色/星光色/远峰蓝/银色/原野绿/深空灰,哑光质感)
   mid = 渐变两端的中间色,供无封面书的卡片背景取色用 */
const COVER_STYLES = [
  { bg: 'linear-gradient(180deg, #3a4155 0%, #232837 100%)', fg: '#f5f5f7', mid: [46, 52, 70] },
  { bg: 'linear-gradient(180deg, #f6efe3 0%, #e6ddcc 100%)', fg: '#3a3125', mid: [238, 230, 215] },
  { bg: 'linear-gradient(180deg, #93a5bd 0%, #5f7691 100%)', fg: '#f5f5f7', mid: [121, 141, 167] },
  { bg: 'linear-gradient(180deg, #aebfa3 0%, #7f9573 100%)', fg: '#2c3327', mid: [150, 170, 139] },
  { bg: 'linear-gradient(180deg, #e3e4e0 0%, #cccdc7 100%)', fg: '#3a3b35', mid: [215, 216, 211] },
  { bg: 'linear-gradient(180deg, #565059 0%, #3b3740 100%)', fg: '#efe9f2', mid: [72, 67, 76] },
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ============ 管理令牌(写操作鉴权) ============
 * 服务端对非 GET/HEAD 的 /api/* 要求 Bearer token(应用内鉴权,不依赖 Nginx)。
 * token 首次输入后存 localStorage;401 时清除并重新询问。GET 不需要。
 * 令牌输入用系统 prompt()(用户指定):桌面与主流手机浏览器均支持。
 * 注意:prompt 返回 null 表示取消;空串表示"确定但没填",两者都按取消处理。 */
const TOKEN_KEY = 'mybooks.adminToken';

function adminToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

function authHeaders() {
  const t = adminToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

function forgetToken() { localStorage.removeItem(TOKEN_KEY); }

// 系统弹框询问令牌;取消返回 null
function askForToken() {
  const v = prompt('请输入管理令牌(服务器 data/admin-token 的内容):');
  const t = String(v ?? '').trim();
  return t ? t : null;
}

async function api(url, options = {}) {
  const doFetch = () => fetch(url, {
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...options,
  });

  let res = await doFetch();

  // 401:令牌缺失/失效 → 清掉旧的,系统弹框问一次,重试原请求
  if (res.status === 401) {
    forgetToken();
    const t = askForToken();   // prompt 是同步的,无需 await
    if (t === null) {
      const data0 = await res.json().catch(() => ({}));
      throw new Error(data0.error || '需要管理令牌');
    }
    localStorage.setItem(TOKEN_KEY, t);
    res = await doFetch();
  }

  // 重试后仍 401:令牌错误,清掉避免下次自动带上废 token
  if (res.status === 401) forgetToken();

  // 429:触发限速(双层模式连续输错令牌),提示等待而非笼统"请求失败"
  if (res.status === 429) {
    const data429 = await res.json().catch(() => ({}));
    throw new Error(data429.error || '尝试次数过多,请稍后再试');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

/* ============ 占位封面 ============ */
function coverStyle(title) {
  let sum = 0;
  for (const ch of String(title)) sum = (sum * 31 + ch.codePointAt(0)) >>> 0;
  return COVER_STYLES[sum % COVER_STYLES.length];
}

function phHtml(title, author) {
  const s = coverStyle(title);
  return `<div class="cover-placeholder" style="background: radial-gradient(120% 90% at 18% 0%, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 45%), ${s.bg};color:${s.fg}">
    <div class="ph-text">
      <span class="ph-title">${title}</span>
      ${author ? `<span class="ph-author">${author}</span>` : ''}
    </div>
  </div>`;
}

function coverHtml(book) {
  // 封面唯一来源:书籍自身保存的封面地址,为空或加载失败走渐变占位图
  // 外链封面(如豆瓣图床)统一走 /api/img-proxy:规避防盗链(Referer 检查)
  // 与 Canvas 取色跨域限制;本站 /uploads 相对路径直接用
  const url = String(book.cover ?? '').trim();
  if (url) {
    const src = /^https?:\/\//i.test(url) ? '/api/img-proxy?url=' + encodeURIComponent(url) : url;
    return `<img src="${esc(src)}" alt="${esc(book.title)} 封面" loading="lazy" referrerpolicy="no-referrer" data-ph="${esc(book.title)}" data-ph-author="${esc(book.author || '')}">`;
  }
  return phHtml(esc(book.title), esc(book.author || ''));
}

// 图片加载失败时替换为占位封面(error 事件不冒泡,需捕获阶段监听)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || img.dataset.ph === undefined) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = phHtml(img.dataset.ph, img.dataset.phAuthor || '');
  img.replaceWith(wrap.firstElementChild);
}, true);

/* ============ 书架 ============ */
let fetchSeq = 0; // 请求序号:连续查询时只渲染最后一次的结果,避免旧响应覆盖新结果

async function fetchBooks() {
  const seq = ++fetchSeq;
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.status) params.set('status', state.status);
  if (state.tag) params.set('tag', state.tag);
  params.set('sort', state.sort);

  try {
    const books = await api('/api/books?' + params.toString());
    if (seq !== fetchSeq) return;
    state.books = books;
  } catch (e) {
    if (seq !== fetchSeq) return;
    toast(e.message, true);
    state.books = [];
  }
  renderGrid();
}

function renderGrid() {
  const grid = $('#bookGrid');
  const empty = $('#emptyState');
  grid.innerHTML = '';
  const filtered = state.q || state.status || state.tag;

  if (!state.books.length) {
    if (filtered) {
      $('#emptyTitle').textContent = '没有找到匹配的书籍';
      $('#emptyText').textContent = '试试调整搜索或筛选条件';
    } else {
      $('#emptyTitle').textContent = '书架还是空的';
      $('#emptyText').textContent = '添加第一本书,开始你的阅读记录之旅。';
    }
    $('#emptyAddBtn').classList.toggle('hidden', !!filtered);
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const book of state.books) {
    const card = document.createElement('article');
    card.className = 'book-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `查看《${book.title}》详情`);
    if (book.summary) card.title = book.summary;   // 书架卡片悬停显示简介

    const date = book.status === 'done' && book.finish_date
      ? book.finish_date.slice(0, 10)
      : (book.start_date ? book.start_date.slice(0, 10) : '');

    card.innerHTML = `
      <div class="card-cover">
        ${coverHtml(book)}
        <span class="status-badge ${book.status}">${STATUS_LABEL[book.status]}</span>
        ${book.file_path ? `<a class="card-read-btn" href="/read/${book.id}" title="在线阅读(.${esc((book.file_format || '').toUpperCase())})" aria-label="在线阅读《${esc(book.title)}》" onclick="event.stopPropagation()">📖 在线阅读</a>` : ''}
      </div>
      <div class="card-info">
        <div class="card-title">${esc(book.title)}</div>
        ${book.author ? `<div class="card-author">${esc(book.author)}</div>` : ''}
        <div class="card-meta">
          ${book.notes_url ? '<span class="has-notes" title="这本书有读书心得">✎ 心得</span>' : ''}
          ${date ? `<span class="card-date">${esc(date)}</span>` : ''}
        </div>
      </div>`;

    card.addEventListener('click', () => openDetail(book.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(book.id); }
    });
    grid.appendChild(card);
  }
}

/* ============ 统计 ============ */
let statsSeq = 0;

async function loadStats() {
  const seq = ++statsSeq;
  let data;
  try {
    data = await api('/api/stats');
  } catch (e) {
    return;
  }
  if (seq !== statsSeq) return;

  $('#countAll').textContent = data.total;
  $('#countWish').textContent = data.byStatus.wish;
  $('#countReading').textContent = data.byStatus.reading;
  $('#countDone').textContent = data.byStatus.done;

  updateTagFilter(data.topTags);

  if (state.view !== 'stats') return;
  renderStats(data);
}

function renderStats(data) {
  const donePct = data.total ? Math.round((data.byStatus.done / data.total) * 100) : 0;
  $('#statsHero').innerHTML = `
    <h2>阅读印象</h2>
    <p class="hero-sub">书架上陈列着 ${data.total} 本书,其中 ${data.byStatus.done} 本已抵达终点。</p>
    <div class="stats-hero-grid">
      <div class="hstat"><span class="num">${data.total}</span><span class="label">总藏书</span></div>
      <div class="hstat"><span class="num">${data.byStatus.done}<small> · ${donePct}%</small></span><span class="label">已读</span></div>
      <div class="hstat"><span class="num">${data.byStatus.reading}</span><span class="label">在读</span></div>
      <div class="hstat"><span class="num">${data.byStatus.wish}</span><span class="label">想读</span></div>
    </div>`;

  renderYearChart(data.byYear);
  renderTagCloud(data.topTags);
}

function renderYearChart(byYear) {
  const el = $('#yearChart');
  const years = Object.keys(byYear).sort();
  if (!years.length) {
    el.innerHTML = '<div class="chart-empty">还没有读完的书,加油!</div>';
    return;
  }
  const max = Math.max(...years.map((y) => byYear[y]));
  el.innerHTML = `<div class="year-chart">${years.map((y) => `
    <div class="year-col" title="${y} 年读完 ${byYear[y]} 本">
      <span class="year-num">${byYear[y]}</span>
      <div class="year-bar-wrap"><div class="year-bar" style="height:${Math.max((byYear[y] / max) * 100, 6)}%"></div></div>
      <span class="year-label">${y}</span>
    </div>`).join('')}</div>`;
}

function renderTagCloud(topTags) {
  const el = $('#tagCloud');
  if (!topTags.length) {
    el.innerHTML = '<div class="chart-empty">还没有标签</div>';
    return;
  }
  el.innerHTML = topTags.map(({ tag, count }) =>
    `<button type="button" class="tag-chip" data-tag="${esc(tag)}">${esc(tag)} <b>${count}</b></button>`
  ).join('');
  $$('#tagCloud .tag-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.tag = chip.dataset.tag;
      $('#tagFilter').value = state.tag;
      syncCustomSelect($('#tagFilter'));   // 程序改 value 不触发 change,需手动同步显示
      switchView('shelf');
      fetchBooks();
    });
  });
}

function updateTagFilter(topTags) {
  const sel = $('#tagFilter');
  const current = state.tag;
  const tags = [...topTags.map((t) => t.tag)];
  if (current && !tags.includes(current)) tags.unshift(current);
  sel.innerHTML = '<option value="">全部标签</option>' +
    tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  sel.value = current;
  $('#tagSuggestions').innerHTML = tags.map((t) => `<option value="${esc(t)}">`).join('');
  syncCustomSelect(sel);   // 选项集合重建后,同步自定义下拉面板
}

/* ============ 自定义下拉:接管原生 <select> 的展开面板 ============
   原生 select 展开后的列表由系统绘制(灰底 / 方角 / 原生高亮),CSS 完全无法介入,
   与全站 Apple 扁平语言冲突。做法:原生 select 保留在 DOM 中作为唯一数据源
   (视觉隐藏、移出键盘序列),在它的位置上渲染「胶囊触发按钮 + 圆角浮层面板」;
   选中后回写 select.value 并派发 change,原有业务逻辑一行不改。 */
const customSelects = [];   // { wrap, sync, close }

function initCustomSelect(select) {
  if (!select || select.dataset.selectEnhanced === '1') return;
  select.dataset.selectEnhanced = '1';
  select.setAttribute('tabindex', '-1');
  select.setAttribute('aria-hidden', 'true');

  const wrap = document.createElement('div');
  wrap.className = 'sel';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sel-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<span class="sel-label"></span>'
    + '<svg class="sel-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">'
    + '<path fill="currentColor" d="M5 6 0 0h10z"></path></svg>';

  const menu = document.createElement('div');
  menu.className = 'sel-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  wrap.appendChild(trigger);
  wrap.appendChild(menu);

  const labelEl = trigger.querySelector('.sel-label');
  const opts = () => [...menu.children];
  let activeIdx = -1;

  const build = () => {
    menu.innerHTML = [...select.options].map((o) =>
      `<button type="button" class="sel-option" role="option" data-value="${esc(o.value)}" aria-selected="false">`
      + `<span class="sel-option-text">${esc(o.textContent)}</span>`
      + '<span class="sel-check" aria-hidden="true">✓</span></button>').join('');
  };

  const markSelected = () => {
    opts().forEach((el) => {
      const on = el.dataset.value === select.value;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  };

  const syncLabel = () => {
    const o = select.options[select.selectedIndex];
    labelEl.textContent = o ? o.textContent : '';
  };

  // 选项集合被重建 / 程序改过 value 之后,由外部调用此函数同步显示
  const sync = () => { build(); syncLabel(); markSelected(); };

  const isOpen = () => !menu.hidden;

  function highlight(i) {
    const list = opts();
    if (!list.length) return;
    activeIdx = ((i % list.length) + list.length) % list.length;
    list.forEach((el, n) => el.classList.toggle('active', n === activeIdx));
    list[activeIdx].scrollIntoView({ block: 'nearest' });
  }

  function open() {
    customSelects.forEach((r) => { if (r.wrap !== wrap) r.close(); });  // 同时只开一个
    build();
    markSelected();
    syncLabel();
    menu.hidden = false;
    wrap.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    const list = opts();
    highlight(Math.max(0, list.findIndex((el) => el.classList.contains('on'))));
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDocDown, true);
  }

  function close() {
    if (!isOpen()) return;
    menu.hidden = true;
    wrap.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDocDown, true);
  }

  function choose(value) {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));  // 复用原有 change 逻辑
    }
    syncLabel();
    markSelected();
    close();
    trigger.focus();
  }

  function onDocDown(e) { if (!wrap.contains(e.target)) close(); }

  function onKey(e) {
    const list = opts();
    if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); return; }
    if (e.key === 'Tab') { close(); return; }
    if (!list.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(activeIdx + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); highlight(activeIdx - 1); return; }
    if (e.key === 'Home') { e.preventDefault(); highlight(0); return; }
    if (e.key === 'End') { e.preventDefault(); highlight(list.length - 1); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();                        // 阻止 button 再合成一次 click
      if (list[activeIdx]) choose(list[activeIdx].dataset.value);
    }
  }

  trigger.addEventListener('click', () => { if (isOpen()) close(); else open(); });
  trigger.addEventListener('keydown', (e) => {
    if (!isOpen() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); open(); }
  });
  menu.addEventListener('click', (e) => {
    const el = e.target.closest('.sel-option');
    if (el) choose(el.dataset.value);
  });

  sync();
  customSelects.push({ wrap, sync, close });
}

function syncCustomSelect(select) {
  if (!select) return;
  const hit = customSelects.find((r) => r.wrap.contains(select));
  if (hit) hit.sync();
}

initCustomSelect($('#tagFilter'));
initCustomSelect($('#sortSelect'));

/* ============ 弹窗通用 ============ */
function openModal(sel) {
  $(sel).classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeModals() {
  $$('.modal').forEach((m) => m.classList.add('hidden'));
  document.body.classList.remove('modal-open');
}

$$('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m) closeModals(); });
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModals();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModals();
    closeMobileMenu();
    closeSearchRow();
  }
});

/* ============ 详情弹窗 ============ */
async function openDetail(id) {
  let book;
  try {
    book = await api('/api/books/' + id);
  } catch (e) {
    toast(e.message, true);
    return;
  }

  const tags = JSON.parse(book.tags || '[]');
  const logs = JSON.parse(book.read_logs || '[]');
  // 阅读记录为唯一展示来源;仅旧数据(无记录但有日期)兜底显示起止日期行
  const legacyDates = !logs.length && (book.start_date || book.finish_date)
    ? [book.start_date ? `开始于 ${book.start_date}` : '', book.finish_date ? `读完于 ${book.finish_date}` : ''].filter(Boolean)
    : [];
  const autoNotes = !book.notes_url && !!state.settings.notesRepo;
  const notesSrc = book.notes_url || (autoNotes ? book.title + '.md' : '');
  $('#detailBody').innerHTML = `
    <div class="detail-cover">${coverHtml(book)}</div>
    <div class="detail-info">
      <h2>${esc(book.title)}</h2>
      ${book.author ? `<div class="detail-author">${esc(book.author)}</div>` : ''}
      <div class="card-meta">
        <span class="status-inline ${book.status}">${STATUS_LABEL[book.status]}</span>
      </div>
      <div class="detail-rows">
        ${legacyDates.length ? `<div class="detail-row"><span class="k">日期</span><span class="v">${esc(legacyDates.join(' · '))}</span></div>` : ''}
        ${logs.length ? `<div class="detail-row"><span class="k">阅读记录</span><span class="v detail-logs">${logs.map((l) => `<span class="log-chip">${esc(l.start || '开始未记')}${l.finish ? ' 至 ' + esc(l.finish) : ' · 进行中'}</span>`).join('')}</span></div>` : ''}
        ${tags.length ? `<div class="detail-row"><span class="k">标签</span><span class="v detail-tags">${tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join('')}</span></div>` : ''}
      </div>
      ${book.summary ? `<div class="detail-block"><div class="detail-block-k">简介</div><p class="detail-block-v">${esc(book.summary)}</p></div>` : ''}
      ${book.file_path ? `<div class="detail-actions" style="margin-bottom:10px">
        <a class="btn btn-primary" style="text-decoration:none" href="/read/${book.id}">📖 在线阅读(.${esc((book.file_format || '').toUpperCase())})</a>
        <a class="btn btn-ghost" style="text-decoration:none" href="/books-files/${esc(book.file_path)}" download="《${esc(book.title)}》.${esc((book.file_format || '').toLowerCase())}">⬇ 下载</a>
      </div>` : ''}
      <button type="button" class="notes-entry" id="detailNotesEntry" title="${autoNotes ? '自动匹配《' + esc(book.title) + '》.md' : '打开读书心得'}">读书心得</button>
      <div class="detail-actions">
        <button type="button" class="btn btn-ghost" id="detailEdit">✎ 编辑</button>
        <button type="button" class="btn btn-danger-tint" id="detailDelete">删除</button>
      </div>
    </div>`;

  openModal('#detailModal');

  $('#detailEdit').addEventListener('click', () => openBookModal(book));
  $('#detailDelete').addEventListener('click', () => deleteBook(book.id, book.title));
  $('#detailNotesEntry').addEventListener('click', () => {
    closeModals();
    openNotesPage(book.id);
  });
}

/* ============ 读书心得子页面 ============ */
async function openNotesPage(id, fromHash = false) {
  let book;
  try {
    book = await api('/api/books/' + id);
  } catch (e) {
    toast(e.message, true);
    return;
  }
  if (state.view !== 'notes') state.prevView = state.view;

  const autoNotes = !book.notes_url && !!state.settings.notesRepo;
  const src = book.notes_url || (autoNotes ? book.title + '.md' : '');

  $('#notesCover').innerHTML = coverHtml(book);
  $('#notesTitle').textContent = book.title;
  const dates = [book.start_date, book.finish_date].filter(Boolean);
  $('#notesMeta').innerHTML =
    (book.author ? `<span class="nm-author">${esc(book.author)}</span>` : '') +
    `<span class="status-inline ${book.status}">${STATUS_LABEL[book.status]}</span>` +
    (dates.length ? `<span class="nm-date">${esc(dates.join(' · '))}</span>` : '');

  const body = $('#notesPageBody');
  if (!src) {
    body.innerHTML = `
      <div class="detail-notes notes-empty">
        <div class="notes-state">这本书还没有读书心得。把心得文件按书名《${esc(book.title)}》.md 上传到心得仓库,
          或<button type="button" class="notes-retry" id="notesEditBtn">去编辑填写链接</button></div>
      </div>`;
    $('#notesEditBtn').addEventListener('click', () => openBookModal(book));
  } else {
    body.innerHTML = '<div class="detail-notes"><div class="notes-state">正在加载读书心得…</div></div>';
    loadNotes(body.querySelector('.detail-notes'), src, autoNotes, book.title);
  }

  switchView('notes');
  if (!fromHash) {
    hashNav = true;
    location.hash = '/notes/' + id;
  }
  window.scrollTo(0, 0);
}

function loadNotes(box, url, auto = false, title = '') {
  const head = '<div class="notes-head"><span class="notes-orn">❖</span> 读书心得</div>';
  api('/api/notes?url=' + encodeURIComponent(url)).then((data) => {
    box.innerHTML = head +
      `<div class="markdown-body">${DOMPurify.sanitize(marked.parse(data.content))}</div>`;
  }).catch((e) => {
    const notFound = auto && /HTTP 404/.test(e.message);
    // 按书名自动匹配 404 属于"还没上传"的引导,不是错误,用中性色
    const msg = notFound
      ? `仓库里还没有《${esc(title)}》.md —— 把心得文件按书名命名后上传即可,或在编辑里填写心得链接`
      : `心得加载失败:${esc(e.message)}`;
    box.innerHTML = head +
      `<div class="notes-state${notFound ? '' : ' notes-error'}">${msg}
        <button type="button" class="notes-retry">重试</button></div>`;
    box.querySelector('.notes-retry').addEventListener('click', () => {
      box.innerHTML = '<div class="notes-state">正在加载读书心得…</div>';
      loadNotes(box, url, auto, title);
    });
  });
}

/* ============ 设置(心得仓库) ============ */
async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
  } catch { /* 保持默认 */ }

}

function openSettingsModal() {
  closeModals();
  $('#sRepo').value = state.settings.notesRepo || '';
  $('#sBranch').value = state.settings.notesBranch || 'main';
  $('#settingsError').textContent = '';
  openModal('#settingsModal');
}

$('#settingsBtn').addEventListener('click', openSettingsModal);

$('#settingsSave').addEventListener('click', async () => {
  const errEl = $('#settingsError');
  errEl.textContent = '';
  try {
    state.settings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ notesRepo: $('#sRepo').value, notesBranch: $('#sBranch').value }),
    });
    closeModals();
    toast(state.settings.notesRepo
      ? '心得仓库已保存,详情页将按《书名》.md 自动获取心得'
      : '已清空心得仓库配置');

  } catch (e) {
    errEl.textContent = e.message;
  }
});

/* ============ 移动端全屏菜单 ============ */
const mobileMenu = $('#mobileMenu');

function closeMobileMenu() {
  mobileMenu.classList.remove('open');
  document.body.classList.remove('menu-open', 'modal-open');
}

$('#menuBtn').addEventListener('click', () => {
  const opening = !mobileMenu.classList.contains('open');
  mobileMenu.classList.toggle('open');
  document.body.classList.toggle('menu-open', opening);
  document.body.classList.toggle('modal-open', opening);
  // 展开时把焦点移进对话框本身(原来是落在搜索框上;搜索已独立到顶栏)。
  // 焦点给容器而非第一个导航项:Tab 一下即进入「首页」,且容器不画聚焦描边,
  // 不依赖 :focus-visible 的输入模态启发式 —— 避免每次开菜单都闪一圈蓝框
  if (opening) setTimeout(() => mobileMenu.focus(), 300);
});

$$('#mobileMenu .mm-links button').forEach((b) => {
  b.addEventListener('click', () => {
    switchView(b.dataset.view);
    closeMobileMenu();
  });
});

$('#mmSettings').addEventListener('click', () => {
  closeMobileMenu();
  openSettingsModal();
});

async function deleteBook(id, title) {
  if (!confirm(`确定要删除《${title}》吗?此操作不可恢复。`)) return;
  try {
    await api('/api/books/' + id, { method: 'DELETE' });
    closeModals();
    toast('已删除');
    refreshAll();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ============ 添加 / 编辑表单 ============ */
let formStatus = 'wish';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderStatusUI() {
  $$('#fStatus button').forEach((b) => b.classList.toggle('active', b.dataset.value === formStatus));
}

// 状态与阅读记录双向联动:
// 切到「已读」→ 自动补完最近一次记录的读完日期(没有记录则补一条今天的);
// 切到「在读」→ 没有进行中的记录时自动新增一条今天开读的记录
function setStatus(s) {
  formStatus = s;
  renderStatusUI();

  if (s === 'done' && !formLogs.some((l) => l.finish)) {
    if (formLogs.length) {
      const last = formLogs[formLogs.length - 1];
      last.finish = todayStr();
    } else {
      formLogs.push({ start: '', finish: todayStr() });
    }
    renderReadLogs();
  }
  if (s === 'reading' && !formLogs.some((l) => !l.finish)) {
    formLogs.push({ start: todayStr(), finish: '' });
    renderReadLogs();
  }
}

function openBookModal(book) {
  closeModals();
  $('#modalTitle').textContent = book ? '编辑书籍' : '添加书籍';
  $('#bookId').value = book ? book.id : '';
  $('#fTitle').value = book ? book.title : '';
  $('#fAuthor').value = book ? book.author : '';
  $('#fTags').value = book ? JSON.parse(book.tags).join(', ') : '';
  $('#fSummary').value = book ? (book.summary || '') : '';
  $('#fCoverUrl').value = book ? book.cover : '';
  formLogs = book ? JSON.parse(book.read_logs || '[]') : [];
  // 兼容旧数据:没有阅读记录但有起止日期时,迁移为一条记录,避免两套日期并存
  if (!formLogs.length && book && (book.start_date || book.finish_date)) {
    formLogs = [{ start: book.start_date || '', finish: book.finish_date || '' }];
  }
  renderReadLogs();
  $('#formError').textContent = '';
  // 打开表单时只回显状态,不触发联动(联动仅在用户主动操作时发生)
  formStatus = book ? book.status : 'wish';
  renderStatusUI();
  setCoverPreview(book ? book.cover : '');
  resetCoverEditor();
  renderEbookInfo(book && book.file_path ? book : null);
  // 豆瓣隐藏字段回填(编辑已有书时带上,提交时保留)
  $('#fPublisher').value = book ? (book.publisher || '') : '';
  $('#fPubYear').value = book ? (book.pub_year || '') : '';
  $('#fIsbn').value = book ? (book.isbn || '') : '';
  $('#fRating').value = book ? (book.rating || 0) : 0;
  $('#fDoubanId').value = book ? (book.douban_id || '') : '';
  doubanStatus.textContent = '';
  doubanCandidates.classList.add('hidden');
  openModal('#bookModal');
  setTimeout(() => $('#fTitle').focus(), 60);
}

function setCoverPreview(url) {
  const box = $('#coverPreview');
  if (url) {
    box.innerHTML = `<img src="${esc(url)}" alt="封面预览"
      onerror="this.parentElement.innerHTML='图片无法加载'" referrerpolicy="no-referrer">`;
  } else {
    box.innerHTML = '暂无封面';
  }
}

/* ============ 封面编辑器(链接 / 上传 / 移除) ============ */
const COVER_UPLOAD_ACCEPT = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const COVER_UPLOAD_TEXT = '上传本地图片';
let coverUploading = false;
let coverSession = 0;
const coverUploadLabel = $('#fCoverFile').closest('label.btn');
const coverUploadText = coverUploadLabel.querySelector('.cover-upload-text');

// 复位封面编辑器:打开表单时调用,会话号递增使进行中的旧上传回调失效
function resetCoverEditor() {
  coverSession += 1;
  coverUploading = false;
  coverUploadLabel.classList.remove('is-disabled');
  $('#fCoverFile').disabled = false;
  coverUploadText.textContent = COVER_UPLOAD_TEXT;
  $('#coverRemove').disabled = false;
}

$('#fCoverUrl').addEventListener('input', (e) => {
  setCoverPreview(e.target.value.trim());
});

$('#coverRemove').addEventListener('click', () => {
  $('#fCoverUrl').value = '';
  setCoverPreview('');
});

$('#fCoverFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (coverUploading) return;
  if (!COVER_UPLOAD_ACCEPT.includes(file.type)) {
    toast('仅支持 png/jpg/gif/webp 图片', true);
    return;
  }

  const session = coverSession;
  coverUploading = true;
  coverUploadLabel.classList.add('is-disabled');
  $('#fCoverFile').disabled = true;
  coverUploadText.textContent = '上传中…';
  $('#coverRemove').disabled = true;
  toast('正在上传封面…');

  // 关窗防护:会话号一致且弹窗仍打开,才允许触碰表单 UI
  const stale = () => coverSession !== session || $('#bookModal').classList.contains('hidden');
  const restore = () => {
    coverUploadLabel.classList.remove('is-disabled');
    $('#fCoverFile').disabled = false;
    coverUploadText.textContent = COVER_UPLOAD_TEXT;
    $('#coverRemove').disabled = false;
  };

  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(file);
    });
    const res = await api('/api/upload', { method: 'POST', body: JSON.stringify({ data }) });
    coverUploading = false;
    if (stale()) return;
    $('#fCoverUrl').value = res.url;
    setCoverPreview(res.url);
    restore();
  } catch (err) {
    coverUploading = false;
    if (stale()) return;
    toast(err.message, true);
    restore();
  }
});

/* ============ 电子书文件上传(路 B:存储与阅读) ============
 * 直接上传:编辑前必须已保存书籍(有 bookId 才能关联)。
 * 上传即时生效(不走表单保存),成功后详情页出现"在线阅读/下载"。
 * 用 XMLHttpRequest 而非 fetch:支持上传进度回调,大文件(几十 MB)不卡页面。 */
const ebookFileEl = $('#fEbookFile');
let ebookUploading = false;

function renderEbookInfo(book) {
  const box = $('#ebookInfo');
  if (book && book.file_path) {
    const kb = Math.max(1, Math.round((book.file_size || 0) / 1024));
    const sizeText = kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
    box.innerHTML = `<span class="ebook-tag">.${esc((book.file_format || '').toUpperCase())}</span>已关联 · ${sizeText}`;
    $('#ebookRemove').disabled = false;
  } else {
    box.textContent = '未上传文件';
    $('#ebookRemove').disabled = true;
  }
}

// multipart 上传 + 进度显示;返回 Promise,失败抛带 code 的错误
function uploadEbookWithProgress(bookId, file, authHeadersObj) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/books/${bookId}/file`);
    if (authHeadersObj.Authorization) xhr.setRequestHeader('Authorization', authHeadersObj.Authorization);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        $('#ebookUploadText').textContent = `上传中 ${pct}%`;
      }
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* 非 JSON 响应 */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || '上传失败'), { code: data.code, status: xhr.status }));
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误,上传失败')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

async function handleEbookUpload(file) {
  const bookId = $('#bookId').value;
  if (!bookId) {
    toast('请先保存书籍,再上传电子书文件', true);
    return;
  }
  ebookUploading = true;
  const text = $('#ebookUploadText');
  try {
    try {
      const d = await uploadEbookWithProgress(bookId, file, authHeaders());
      renderEbookInfo({ file_path: d.file.path, file_format: d.file.format, file_size: d.file.size });
      toast('电子书已上传');
    } catch (err) {
      if (err.status === 401) {
        forgetToken();
        const t = askForToken();
        if (t === null) throw new Error('需要管理令牌');
        localStorage.setItem(TOKEN_KEY, t);
        const d = await uploadEbookWithProgress(bookId, file, { Authorization: 'Bearer ' + t });
        renderEbookInfo({ file_path: d.file.path, file_format: d.file.format, file_size: d.file.size });
        toast('电子书已上传');
      } else {
        throw err;
      }
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    ebookUploading = false;
    text.textContent = '选择文件上传';
  }
}

ebookFileEl.addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || ebookUploading) return;
  handleEbookUpload(file);
});

$('#ebookRemove').addEventListener('click', async () => {
  const bookId = $('#bookId').value;
  if (!bookId || ebookUploading) return;
  ebookUploading = true;
  try {
    await fetch(`/api/books/${bookId}/file`, { method: 'DELETE', headers: { ...authHeaders() } });
    renderEbookInfo(null);
    toast('已移除电子书文件');
  } catch (err) {
    toast(err.message, true);
  } finally {
    ebookUploading = false;
  }
});

$('#fStatus').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-value]');
  if (btn) setStatus(btn.dataset.value);
});

/* ============ 豆瓣元数据填充(NewDouban 移植) ============ */
const doubanBtn = $('#doubanFetchBtn');
const doubanStatus = $('#doubanStatus');
const doubanCandidates = $('#doubanCandidates');
let doubanSearching = false;

// 把豆瓣候选的元数据写进编辑表单(隐藏字段带 publisher 等新字段)
function applyDoubanBook(d) {
  $('#fTitle').value = d.title || '';
  $('#fAuthor').value = d.author || '';
  $('#fSummary').value = d.summary || '';
  $('#fTags').value = (d.tags || []).join(', ');
  if (d.cover) {
    $('#fCoverUrl').value = d.cover;
    setCoverPreview(d.cover);
  }
  $('#fPublisher').value = d.publisher || '';
  $('#fPubYear').value = d.pubYear || '';
  $('#fIsbn').value = d.isbn || '';
  $('#fRating').value = d.rating || 0;
  $('#fDoubanId').value = d.doubanId || '';
}

doubanBtn.addEventListener('click', async () => {
  if (doubanSearching) return;
  const q = $('#fTitle').value.trim();
  if (!q) {
    doubanStatus.textContent = '先填书名(或 ISBN)再检索';
    return;
  }
  doubanSearching = true;
  doubanBtn.disabled = true;
  doubanStatus.textContent = '正在检索豆瓣…';
  doubanCandidates.classList.add('hidden');
  doubanCandidates.innerHTML = '';
  try {
    const data = await api('/api/v1/metadata/search?q=' + encodeURIComponent(q));
    if (!data.results.length) {
      doubanStatus.textContent = '豆瓣没有找到,试试换个关键词';
      return;
    }
    if (data.cookieless) doubanStatus.textContent = '提示:配置豆瓣 Cookie 可提高成功率(见 README)';
    else doubanStatus.textContent = `找到 ${data.results.length} 个候选,点击选用:`;
    doubanCandidates.innerHTML = data.results.map((d, i) => `
      <button type="button" class="douban-candidate" data-i="${i}">
        <span>
          <strong>${esc(d.title)}</strong>
          <div class="dc-meta">${esc([d.author, d.publisher, d.pubYear].filter(Boolean).join(' · '))}${d.rating ? ' · ★ ' + d.rating : ''}</div>
        </span>
        <span>${d.cover ? `<img src="${esc(d.cover)}" alt="" style="width:32px;height:44px;object-fit:cover;border-radius:3px">` : ''}</span>
      </button>`).join('');
    doubanCandidates.classList.remove('hidden');
    doubanCandidates.querySelectorAll('.douban-candidate').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyDoubanBook(data.results[Number(btn.dataset.i)]);
        doubanCandidates.classList.add('hidden');
        doubanStatus.textContent = '已填充,可继续修改';
      });
    });
  } catch (err) {
    doubanStatus.textContent = '';
    toast(err.message, true);
  } finally {
    doubanSearching = false;
    doubanBtn.disabled = false;
  }
});

/* ============ 阅读记录(唯一数据源:起止日期与读过次数由记录自动推导) ============ */
let formLogs = [];

// 展示推导结果:开始/读完日期与读过次数不再单独输入,这里实时汇总给用户确认
function updateLogsSummary() {
  const box = $('#readLogsSummary');
  const finished = formLogs.filter((l) => l.finish);
  const withStart = formLogs.filter((l) => l.start);
  let latest = null;
  for (const l of withStart) if (!latest || l.start >= latest.start) latest = l;

  if (!formLogs.length) {
    box.textContent = '尚未记录:添加后自动生成开始/读完日期与读过次数';
    return;
  }
  if (!finished.length && !latest) {
    box.textContent = `已记 ${formLogs.length} 条,补上日期后自动生成开始/读完日期与读过次数`;
    return;
  }
  const bits = [];
  if (finished.length) bits.push(`读过 ${finished.length} 次`);
  if (latest) bits.push(`${latest.start} 开读`);
  const lastFinish = finished.reduce((m, l) => (l.finish > m ? l.finish : m), '');
  bits.push(lastFinish ? `${lastFinish} 读完` : '尚未读完');
  box.textContent = '将自动生成:' + bits.join(' · ');
}

function renderReadLogs() {
  const box = $('#readLogs');
  box.innerHTML = formLogs.map((l, i) => `
    <div class="log-row">
      <input type="date" class="log-start" value="${esc(l.start)}" aria-label="第 ${i + 1} 次开始日期">
      <span class="log-sep">至</span>
      <input type="date" class="log-finish" value="${esc(l.finish)}" aria-label="第 ${i + 1} 次读完日期">
      <button type="button" class="log-del" aria-label="删除这条记录">✕</button>
    </div>`).join('');

  box.querySelectorAll('.log-row').forEach((row, i) => {
    row.querySelector('.log-start').addEventListener('change', (e) => {
      formLogs[i].start = e.target.value;
      updateLogsSummary();
    });
    row.querySelector('.log-finish').addEventListener('change', (e) => {
      formLogs[i].finish = e.target.value;
      // 记录 → 状态联动:填上读完日期自动变「已读」;清空最后一条读完日期回到「在读」
      if (e.target.value && formStatus === 'reading') {
        formStatus = 'done';
        renderStatusUI();
      } else if (!e.target.value && formStatus === 'done' && !formLogs.some((l) => l.finish)) {
        formStatus = 'reading';
        renderStatusUI();
      }
      updateLogsSummary();
    });
    row.querySelector('.log-del').addEventListener('click', () => {
      formLogs.splice(i, 1);
      renderReadLogs();
    });
  });

  updateLogsSummary();
}

$('#addLogBtn').addEventListener('click', () => {
  formLogs.push({ start: '', finish: '' });
  // 开始记录阅读时,「想读」自动变为「在读」
  if (formStatus === 'wish') {
    formStatus = 'reading';
    renderStatusUI();
  }
  renderReadLogs();
  const rows = $$('#readLogs .log-row');
  if (rows.length) rows[rows.length - 1].querySelector('.log-start').focus();
});

$('#bookForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#formError');
  errEl.textContent = '';

  const title = $('#fTitle').value.trim();
  if (!title) {
    errEl.textContent = '请填写书名';
    $('#fTitle').focus();
    return;
  }

  const payload = {
    title,
    author: $('#fAuthor').value.trim(),
    status: formStatus,
    tags: $('#fTags').value,
    read_logs: formLogs.filter((l) => l.start || l.finish),
    // 起/止日期与读过次数由阅读记录推导(服务端权威计算);
    // 无记录时显式传空,保证删光记录能同步清空日期
    start_date: '',
    finish_date: '',
    read_count: 0,
    summary: $('#fSummary').value.trim(),
    cover: $('#fCoverUrl').value.trim(),
    publisher: $('#fPublisher').value,
    pub_year: $('#fPubYear').value,
    isbn: $('#fIsbn').value,
    rating: Number($('#fRating').value) || 0,
    douban_id: $('#fDoubanId').value,
  };

  const id = $('#bookId').value;
  const saveBtn = $('#saveBtn');
  saveBtn.disabled = true;
  try {
    if (id) {
      await api('/api/books/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存修改');
    } else {
      await api('/api/books', { method: 'POST', body: JSON.stringify(payload) });
      toast('添加成功');
    }
    closeModals();
    refreshAll();
  } catch (e2) {
    errEl.textContent = e2.message;
  } finally {
    saveBtn.disabled = false;
  }
});

/* ============ 榜单(Apple 瓦片节奏:parchment 英雄区 → 暗色年度之书 → 白色最近读完 → 暗色重读榜) ============ */
const RANK_SIZE = 8;

// 从全量书目计算各榜单(个人书架数据量小,前端排序足够)
function computeRankings(books) {
  const reread = books
    .filter((b) => (b.read_count || 0) >= 2)
    .sort((a, b) => (b.read_count || 0) - (a.read_count || 0)
      || String(b.finish_date || '').localeCompare(String(a.finish_date || '')))
    .slice(0, RANK_SIZE);
  return { reread };
}

function rankRowsHtml(list, metric) {
  return `<ol class="rank-list">${list.map((b, i) => `
    <li>
      <button type="button" class="rank-row" data-open-detail="${b.id}"
        aria-label="查看《${esc(b.title)}》详情,第 ${i + 1} 名">
        <span class="rank-num">${i + 1}</span>
        <span class="rank-cover">${coverHtml(b)}</span>
        <span class="rank-info">
          <span class="rank-title">${esc(b.title)}</span>
          <span class="rank-meta">${esc([b.author, (b.read_count || 0) > 1 ? `读过 ${b.read_count} 次` : ''].filter(Boolean).join(' · ')) || '&nbsp;'}</span>
        </span>
        <span class="rank-metric">${metric(b)}</span>
      </button>
    </li>`).join('')}</ol>`;
}

function rankBoardHtml(title, sub, list, metric) {
  return `
    <section class="rank-tile">
      <div class="rank-inner">
        <h2 class="rank-board-title">${esc(title)}</h2>
        <p class="rank-board-sub">${esc(sub)}</p>
        ${list.length ? rankRowsHtml(list, metric)
          : '<p class="rank-empty">还没有书被读过两次以上,重读会在这里留下痕迹。</p>'}
      </div>
    </section>`;
}

async function loadRankings() {
  let books;
  try {
    books = await api('/api/books');
  } catch {
    return; // 静默:保留上次内容
  }
  if (state.view !== 'rank') return;
  renderRank(books, computeRankings(books));
}

function renderRank(books, { reread }) {
  const root = $('#rankContent');
  if (!root) return;

  const total = books.length;
  const doneCount = books.filter((b) => b.status === 'done').length;

  root.innerHTML = `
    <section class="rank-tile rank-hero">
      <div class="rank-inner">
        <p class="rank-eyebrow">My books · 榜单</p>
        <h1 class="rank-hero-title">好书,<br>值得被反复翻开。</h1>
        <p class="rank-hero-sub">共 ${total} 本 · 读完 ${doneCount} 本</p>
      </div>
    </section>
    ${rankBoardHtml('重读榜', `读过两次以上的书 · 至多 ${RANK_SIZE} 本`, reread,
      (b) => `<span class="rank-count"><b>${b.read_count}</b> 次</span>`)}
  `;
}

// 榜单交互:事件委托,渲染后无需重复绑定
$('#rankContent').addEventListener('click', (e) => {
  const t = e.target.closest('[data-open-detail]');
  if (t) openDetail(Number(t.dataset.openDetail));
});
$('#rankContent').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest('[data-open-detail]');
  if (t) { e.preventDefault(); openDetail(Number(t.dataset.openDetail)); }
});

/* ============ 视图切换与筛选 ============ */
function switchView(view) {
  // 非 notes 视图:静默清掉残留 hash(notes/rank 深链),不触发 hashchange 处理
  if (view !== 'notes' && location.hash) {
    hashNav = true;
    location.hash = '';
  }
  state.view = view;
  $$('#viewSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#homeView').classList.toggle('hidden', view !== 'home');
  $('#shelfView').classList.toggle('hidden', view !== 'shelf');
  $('#rankView').classList.toggle('hidden', view !== 'rank');
  $('#statsView').classList.toggle('hidden', view !== 'stats');
  $('#notesView').classList.toggle('hidden', view !== 'notes');
  if (view === 'stats') loadStats();
  if (view === 'rank') loadRankings();
  if (view === 'home') fetchHome();
}

/* ============ 首页(Apple 式展示页) ============ */
async function fetchHome() {
  try {
    renderHome(await api('/api/books?sort=created'));
  } catch { /* 静默:首页保持上次内容 */ }
}

function homeTileHtml(b) {
  const summary = String(b.summary || '').replace(/\s+/g, ' ').trim();
  const intro = summary.length > 92 ? summary.slice(0, 92) + '…' : summary;
  const metaBits = [b.author, `读过 ${b.read_count || 1} 次`].filter(Boolean).join(' · ');
  const tone = fallbackTone(b.title); // 初始兜底(有封面时会被真实取色覆盖)
  return `
    <div class="home-tile" style="background:${tone.bg};--tile-fg:${tone.fg};--tile-sub:${tone.sub};--tile-scrim:${tone.scrim};--tile-link:${tone.link}"${b.cover ? ` data-tint-src="${esc(b.cover)}"` : ''}>
      ${homeStatusLabel(b) ? `<div class="home-eyebrow">${homeStatusLabel(b)}</div>` : ''}
      <h3 class="tile-title" data-open-detail="${b.id}" role="button" tabindex="0" aria-label="查看《${esc(b.title)}》详情">${esc(b.title)}</h3>
      ${intro
        ? `<p class="tile-summary">${esc(intro)}</p>`
        : `<p class="tile-tagline">${esc([b.author, b.finish_date ? `读完于 ${b.finish_date}` : ''].filter(Boolean).join(' · '))}</p>`}
      <div class="home-meta">
        ${metaBits ? `<span class="tile-meta-text">${esc(metaBits)}</span>` : ''}
      </div>
      <div class="tile-links">
        <button type="button" class="home-link" data-open-notes="${b.id}">读书心得 ›</button>
        <button type="button" class="home-link" data-open-detail="${b.id}">详情 ›</button>
      </div>
      <div class="tile-cover" data-open-detail="${b.id}" role="button" tabindex="0" aria-label="查看《${esc(b.title)}》详情">${coverHtml(b)}</div>
    </div>`;
}

/* ---------- 未完待续:apple.com「Endless entertainment.」画廊(两排) ----------
   第一排 tv-media-gallery:大卡轮播 —— 左文案 + 右封面,不让图片铺满
   第二排 fam-media-gallery:小卡横滑 —— 与 apple.com 的 services 行同构 */

const ENT_LIMIT = 16;         // 未完待续书单总量上限
const ENT_PRIMARY_MAX = 10;   // 第一排大卡数量(>7 时 dotnav 启用 apple 的变距窗口)
const GRID_MAX = 4;           // 书格双列卡片固定展示 4 本(次多的)
const ENT_FAM_MIN = 3;        // 小卡排少于 3 张就整排不渲染(与下方模板判断共用一个常量)
const ENT_BIG_RATIO = 0.6;    // 大卡占画廊的比例,其余进小卡排

/* 两排切分:大卡取 60% 并夹在 [ENT_FAM_MIN, ENT_PRIMARY_MAX]。
   旧写法是 famReserve = n > 10 ? n - 3 : 0,把 3 写死成小卡下限 ——
   书多时小卡永远压在 3 张,而 n ≤ 10 时又反转为「大卡只有 3 张」,
   同一份逻辑在两种书量下行为相反。改按比例后两个毛病一起消失。
   书太少(n ≤ 6)时小卡凑不满一排,则全部并入大卡,避免有书被凭空吞掉。 */
function splitBigCount(n) {
  if (n <= ENT_FAM_MIN * 2) return n;
  return Math.min(ENT_PRIMARY_MAX, Math.max(ENT_FAM_MIN, Math.round(n * ENT_BIG_RATIO)));
}

const ENT_ICON_PAUSE = 'M21.7334 36.67h2.5342c1.1483 0 1.7324-.5796 1.7324-1.7193v-13.9015c0-1.12-.5841-1.6898-1.7324-1.7193h-2.5342c-1.1483 0-1.7324.5698-1.7324 1.7193v13.9015c-.0297 1.1396.5544 1.7193 1.7324 1.7193zm9.9992 0h2.5347c1.1485 0 1.7327-.5796 1.7327-1.7193v-13.9015c0-1.12-.5842-1.7193-1.7327-1.7193h-2.5347c-1.1485 0-1.7327.5698-1.7327 1.7193v13.9015c0 1.1396.5545 1.7193 1.7327 1.7193z';
const ENT_ICON_PLAY = 'M23.7555 36.6237c.4478 0 .8598-.1343 1.4241-.4568l10.9178-6.3322c.8598-.5016 1.3614-1.021 1.3614-1.8361 0-.8061-.5016-1.3255-1.3614-1.8271l-10.9178-6.3322c-.5643-.3314-.9762-.4657-1.4241-.4657-.9315 0-1.7555.7165-1.7555 1.9435v13.3629c0 1.227.824 1.9435 1.7555 1.9435z';

function entStatusOf(b) { return STATUS_LABEL[b.status] || '想读'; }
/* 首页展示框内不再出现「已读」标签:读完的书用"读过 N 次"等信息代替 */
function homeStatusLabel(b) {
  return b.status === 'done' ? '' : (STATUS_LABEL[b.status] || '');
}

/* ---------- 封面取色:卡片背景根据封面真实颜色渲染 ---------- */
// 外链封面经服务端代理转成同源图片(规避 Canvas 跨域限制),本站 /uploads 直接用
function imgSampleUrl(u) {
  return /^https?:\/\//i.test(u) ? '/api/img-proxy?url=' + encodeURIComponent(u) : u;
}

const coverColorCache = new Map(); // url -> Promise<{r,g,b}|null>(成功与失败都缓存,避免重复请求)

function loadImageEl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });
}

function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

// 提取封面主色:缩到 24×24 canvas,3bit/通道量化分桶,取占面积最多的颜色;
// 再把与最优桶颜色相近的桶合并统计(防止同一色块因明暗渐变被拆成多个桶而输给小色块)
function extractDominantColor(url) {
  let p = coverColorCache.get(url);
  if (p) return p;
  p = (async () => {
    try {
      const img = await loadImageEl(url);
      const N = 24;
      const canvas = document.createElement('canvas');
      canvas.width = N;
      canvas.height = N;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, N, N);
      const data = ctx.getImageData(0, 0, N, N).data; // canvas 被污染时在此抛异常 → null
      const buckets = new Map();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 125) continue; // 忽略透明像素
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5); // 3bit/通道
        const bucket = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        bucket.n += 1;
        bucket.r += r; bucket.g += g; bucket.b += b;
        buckets.set(key, bucket);
      }
      let best = null;
      for (const bucket of buckets.values()) {
        if (!best || bucket.n > best.n) best = bucket; // 面积占比最大者胜出
      }
      if (!best) return null;
      const meanOf = (bk) => ({ r: bk.r / bk.n, g: bk.g / bk.n, b: bk.b / bk.n });
      const mean = meanOf(best);
      const dist = (m) => Math.hypot(m.r - mean.r, m.g - mean.g, m.b - mean.b);
      let n = best.n, r = best.r, g = best.g, b = best.b;
      for (const bucket of buckets.values()) {
        if (bucket === best) continue;
        if (dist(meanOf(bucket)) < 90) { // 相近色并入,面积更接近真实占比
          n += bucket.n; r += bucket.r; g += bucket.g; b += bucket.b;
        }
      }
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
    } catch {
      return null;
    }
  })();
  coverColorCache.set(url, p);
  return p;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 无封面书的兜底配色:取"默认封面"(占位封面)自身的中间色,过同一个 derivePalette 调色,
// 卡片背景与卡内占位封面同源同色,并与封面取色卡片共用一套深浅自适应文字/薄纱体系
function fallbackTone(title) {
  return derivePalette({
    r: coverStyle(title).mid[0],
    g: coverStyle(title).mid[1],
    b: coverStyle(title).mid[2],
  });
}

// 由封面主色派生卡片配色:忠实呈现封面主色,仅做可用性钳制(不刺眼/不全黑);
// 按明暗自适应:深底白字+暗纱,浅底深字+白纱
function derivePalette({ r, g, b }) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const S = Math.min(s * 0.9, 0.82);                              // 色彩保持忠实,仅轻微收敛
  const L = Math.min(0.78, Math.max(0.32, l));                    // 钳制可用性区间
  const hsl = (ll) => `hsl(${Math.round(h * 360)}, ${Math.round(S * 100)}%, ${Math.round(clamp01(ll) * 100)}%)`;
  const bg = `linear-gradient(180deg, ${hsl(L + 0.08)} 0%, ${hsl(L)} 55%, ${hsl(L - 0.1)} 100%)`;
  const dark = L < 0.55;
  const fg = dark ? '#f5f5f7' : '#1d1d1f';
  const sub = dark ? 'rgba(245,245,247,0.72)' : 'rgba(29,29,31,0.62)';
  const scrim = dark
    ? 'linear-gradient(150deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.16) 55%, rgba(0,0,0,0.32) 100%)'
    : 'linear-gradient(150deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.12) 55%, rgba(255,255,255,0.3) 100%)';
  const soft = sub;
  const link = dark ? '#2997ff' : '#0066cc';
  return { bg, fg, sub, scrim, soft, link };
}

// 给带 data-tint-src 的卡片写回封面取色背景;会话号丢弃过期更新,防旧渲染覆盖
let tintSeq = 0;
async function applyCoverTints() {
  const seq = ++tintSeq;
  const els = $$('#homeContent [data-tint-src]');
  for (const el of els) {
    const src = el.dataset.tintSrc;
    if (!src) continue;
    const rgb = await extractDominantColor(imgSampleUrl(src));
    if (seq !== tintSeq || !el.isConnected) return;
    if (!rgb) continue;
    const p = derivePalette(rgb);
    el.style.background = p.bg;
    // 深底/浅底自适应:文字、副文字、薄纱、链接色全部随主色明暗切换
    el.style.setProperty('--tile-fg', p.fg);
    el.style.setProperty('--tile-sub', p.sub);
    el.style.setProperty('--tile-scrim', p.scrim);
    el.style.setProperty('--tile-link', p.link);
    if (el.classList.contains('fam-card')) {
      el.style.color = p.fg;
      el.style.setProperty('--card-scrim', p.scrim);
      el.style.setProperty('--card-soft', p.soft);
    }
  }
}

function entNote(b) {
  // 首页大卡的一句话介绍:优先用图书简介,没有再用阅读状态
  if (b.summary) {
    const s = b.summary.replace(/\s+/g, ' ').trim();
    return s.length > 44 ? s.slice(0, 44) + '…' : s;
  }
  if (b.status === 'reading') {
    return b.start_date ? `${b.start_date} 开读,正在路上。` : '正在读,还没舍得合上。';
  }
  if (b.status === 'done') {
    const bits = [];
    if ((b.read_count || 0) > 1) bits.push(`读过 ${b.read_count} 次`);
    if (b.finish_date) bits.push(`读完于 ${b.finish_date}`);
    return bits.join(' · ') || '已经合上书,故事还留在心里。';
  }
  return '在书单里排队,等你翻牌。';
}

/* 第一排:大卡(文案 + 封面,封面不铺满) */
function entItemHtml(b, i) {
  // 眉标只保留"读过 N 次"这类事实信息,不出现「想读 / 在读 / 已读」状态字样
  // (与小卡一致:首页画廊整体不再展示阅读状态;二者都为空的卡片,眉标整行不渲染)
  const counts = (b.read_count || 0) > 1 ? `读过 ${b.read_count} 次` : '';
  const eyebrow = b.status === 'done' ? `读过 ${b.read_count || 1} 次` : counts;
  const meta = [b.author, b.finish_date ? `读完于 ${b.finish_date}` : ''].filter(Boolean).join(' · ');
  const note = entNote(b);
  const id = `ent-gallery-item-${i + 1}`;
  const tone = fallbackTone(b.title); // 初始兜底(有封面时会被真实取色覆盖)
  return `
    <li id="${id}" class="media-gallery-item" aria-label="《${esc(b.title)}》">
      <div class="media-gallery-wrapper-link" data-open-detail="${b.id}" tabindex="-1" aria-label="查看《${esc(b.title)}》详情">
        <div class="ent-scene" style="background:${tone.bg};--tile-fg:${tone.fg};--tile-sub:${tone.sub};--tile-scrim:${tone.scrim};--tile-link:${tone.link}"${b.cover ? ` data-tint-src="${esc(b.cover)}"` : ''}>
          <div class="ent-scene-copy">
            ${eyebrow ? `<p class="ent-eyebrow">${esc(eyebrow)}</p>` : ''}
            <h3 class="ent-scene-title">${esc(b.title)}</h3>
            ${meta ? `<p class="ent-scene-meta">${esc(meta)}</p>` : ''}
            <p class="ent-scene-note">${esc(note)}</p>
          </div>
          <div class="ent-scene-cover">${coverHtml(b)}</div>
        </div>
      </div>
    </li>`;
}

/* 第二排:小卡(封面 + 标题),与第一排共用同一份书单和索引
   注:小卡不再渲染「想读 / 在读」状态角标(.fam-chip),样式规则仍保留在 style.css,
       需要恢复时补回下面那行 span 即可 */
function entSmallHtml(b, i) {
  const tone = fallbackTone(b.title); // 初始兜底(有封面时会被真实取色覆盖)
  const summary = String(b.summary || '').replace(/\s+/g, ' ').trim();
  const intro = summary.length > 60 ? summary.slice(0, 60) + '…' : summary;
  return `
    <li class="media-gallery-item fam-item" aria-label="《${esc(b.title)}》">
      <div class="media-gallery-wrapper-link fam-card" data-open-detail="${b.id}" tabindex="-1" aria-label="查看《${esc(b.title)}》详情"
        style="background:${tone.bg};color:${tone.fg};--card-scrim:${tone.scrim};--card-soft:${tone.soft}"${b.cover ? ` data-tint-src="${esc(b.cover)}"` : ''}>
        <div class="fam-cover">${coverHtml(b)}</div>
        <div class="fam-foot">
          <p class="fam-note"><strong>${esc(b.title)}</strong>${b.author ? `<span>${esc(b.author)}</span>` : ''}</p>
          ${intro ? `<p class="fam-summary">${esc(intro)}</p>` : ''}
        </div>
      </div>
    </li>`;
}

function entDotnavHtml(count) {
  if (count < 2) return '';
  const items = [];
  for (let i = 1; i <= count; i++) {
    items.push(`<li class="media-gallery-dotnav-item dotnav-item">
      <button type="button" class="media-gallery-dotnav-link dotnav-link" aria-controls="ent-gallery-item-${i}" aria-label="第 ${i} 本"></button>
    </li>`);
  }
  return `
    <div class="media-gallery-dotnav dotnav dotnav-scrim-solid dotnav-timed dotnav-timed-paused">
      <ul class="media-gallery-dotnav-items dotnav-items">${items.join('')}</ul>
      <button type="button" class="media-gallery-dotnav-iconcontrol dotnav-iconcontrol" aria-label="开始自动播放">
        <span class="media-gallery-dotnav-iconcontrol-icon dotnav-iconcontrol-icon">
          <svg class="media-gallery-dotnav-iconcontrol-pause dotnav-iconcontrol-pause" viewBox="0 0 56 56" aria-hidden="true"><path d="${ENT_ICON_PAUSE}"></path></svg>
          <svg class="media-gallery-dotnav-iconcontrol-play dotnav-iconcontrol-play" viewBox="0 0 56 56" aria-hidden="true"><path d="${ENT_ICON_PLAY}"></path></svg>
        </span>
      </button>
    </div>`;
}

let entGallery = null; // 画廊实例:重渲染前需销毁旧的定时器与监听

function mountEndlessGallery() {
  if (entGallery) { entGallery.destroy(); entGallery = null; }
  const root = $('#homeContent .endless-entertainment');
  if (!root || typeof window.EndlessGallery !== 'function') return;
  entGallery = new window.EndlessGallery(root);
}

function homeFeatureHtml(b) {
  const dates = [b.start_date, b.finish_date].filter(Boolean);
  const intro = (b.summary || '').replace(/\s+/g, ' ').trim();
  const excerpt = intro.length > 80 ? intro.slice(0, 80) + '…' : intro;
  return `
    <section class="home-feature">
      <div class="home-eyebrow">最新上架 · 读过 ${b.read_count || 1} 次</div>
      <h2 class="home-title" data-open-detail="${b.id}" role="button" tabindex="0" aria-label="查看《${esc(b.title)}》详情">${esc(b.title)}</h2>
      ${b.author ? `<p class="home-author">${esc(b.author)}</p>` : ''}
      <div class="home-meta">
        ${homeStatusLabel(b) ? `<span class="status-inline ${b.status}">${homeStatusLabel(b)}</span>` : ''}
        ${dates.length ? `<span class="nm-date">${esc(dates.join(' · '))}</span>` : ''}
      </div>
      ${excerpt ? `<p class="home-excerpt">${esc(excerpt)}</p>` : ''}
      <div class="home-links">
        <button type="button" class="home-link" data-open-notes="${b.id}">读书心得 ›</button>
        <button type="button" class="home-link" data-open-detail="${b.id}">查看详情 ›</button>
      </div>
      <div class="home-cover" data-open-detail="${b.id}" role="button" tabindex="0" aria-label="查看《${esc(b.title)}》详情">${coverHtml(b)}</div>
    </section>`;
}

function renderHome(books) {
  const root = $('#homeContent');
  if (!root) return;

  // 大屏只展示已读完且读过次数 ≥2 的书,按次数排序;还没有达标时展示全部已读完的书兜底
  const done = books.filter((b) => b.status === 'done');
  const counted = done
    .filter((b) => (b.read_count || 0) >= 2)
    .sort((a, b) => (b.read_count || 0) - (a.read_count || 0)
      || String(b.finish_date || '').localeCompare(String(a.finish_date || '')));
  const bigScreen = counted.length ? counted : done;
  const restDone = done.filter((b) => !bigScreen.includes(b));
  const others = books.filter((b) => b.status !== 'done');
  // 书格只放次多的 4 本,其余(含更靠后的已读书)全部进 Endless entertainment
  const gallery = [...bigScreen.slice(1 + GRID_MAX), ...restDone, ...others].slice(0, ENT_LIMIT);
  // 两排分配:按比例切分(见 splitBigCount)。小卡凑不满一排时整排不渲染,书全在大卡里
  const entPrimary = gallery.slice(0, splitBigCount(gallery.length));
  const entSecondary = gallery.slice(entPrimary.length);
  const featured = bigScreen[0];
  const gridBooks = bigScreen.slice(1, 1 + GRID_MAX);

  root.innerHTML = `
    <div class="home-hero">
      <div class="home-eyebrow">My books</div>
      <h1>每一本读过的书,<br>都值得被好好安放。</h1>
      <p class="home-sub">心得与收藏,从一个书架开始。</p>
      <div class="home-cta-row">
        <button type="button" class="btn btn-primary" data-home-cta="shelf">浏览书架</button>
        <button type="button" class="btn btn-ghost" data-home-cta="stats">查看统计</button>
      </div>
    </div>
    ${featured ? homeFeatureHtml(featured) : ''}
    ${gridBooks.length ? `<div class="home-grid">${gridBooks.map(homeTileHtml).join('')}</div>` : ''}
    ${gallery.length ? `
    <section class="home-ent">
      <div class="endless-entertainment">
        <div class="media-gallery-headline-container">
          <h2 class="media-gallery-headline">Endless entertainment.</h2>
        </div>

        <!-- 第一排:大卡(前 6 本) / 第二排:小卡(其余) —— 共用索引,一起轮播 -->
        <div class="media-gallery tv-media-gallery" role="group" aria-label="正在读与最近读完">
          <ul class="media-gallery-item-container" role="list" tabindex="0" aria-label="精选书,用左右方向键切换">
            ${entPrimary.map(entItemHtml).join('')}
          </ul>
        </div>
        ${entDotnavHtml(entPrimary.length)}
        ${entSecondary.length >= ENT_FAM_MIN ? `
        <div class="media-gallery fam-media-gallery" role="group" aria-label="书架上的其他书" aria-hidden="true">
          <ul class="media-gallery-item-container" role="list">
            ${entSecondary.map(entSmallHtml).join('')}
          </ul>
        </div>` : ''}
      </div>
    </section>` : ''}
  `;

  mountEndlessGallery();
  applyCoverTints();
}

// 首页交互:事件委托,渲染后无需重复绑定
$('#homeContent').addEventListener('click', (e) => {
  const notes = e.target.closest('[data-open-notes]');
  if (notes) { openNotesPage(Number(notes.dataset.openNotes)); return; }
  const detail = e.target.closest('[data-open-detail]');
  if (detail) { openDetail(Number(detail.dataset.openDetail)); return; }
  const cta = e.target.closest('[data-home-cta]');
  if (cta) switchView(cta.dataset.homeCta);
});
$('#homeContent').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest('[data-open-detail]');
  if (t) { e.preventDefault(); openDetail(Number(t.dataset.openDetail)); }
});

$('#viewSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) switchView(btn.dataset.view);
});

/* 点击品牌标返回首页:行为与「首页」导航项完全一致,并顺带收起移动端全屏菜单 */
$('#brandBtn').addEventListener('click', () => {
  switchView('home');
  closeMobileMenu();
});

$('#statusTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  state.status = btn.dataset.status;
  $$('#statusTabs button').forEach((b) => b.classList.toggle('active', b === btn));
  fetchBooks();
});

$('#tagFilter').addEventListener('change', () => {
  state.tag = $('#tagFilter').value;
  fetchBooks();
});

$('#sortSelect').addEventListener('change', () => {
  state.sort = $('#sortSelect').value;
  fetchBooks();
});

/* 检索是全库检索:只要搜索词非空,就清掉「状态 / 标签」筛选 ——
   否则会出现在某个标签(或某个状态)下搜索时只在该范围内命中,查不到明明存在的书。
   筛选 UI 一并回到「全部 / 全部标签」,避免界面与实际条件脱节。
   注意:清空搜索框不会动筛选,只有"发起检索"才清。 */
function clearShelfFilters() {
  if (!state.status && !state.tag) return;
  state.status = '';
  state.tag = '';
  $$('#statusTabs button').forEach((b) => b.classList.toggle('active', b.dataset.status === ''));
  const sel = $('#tagFilter');
  if (sel) {
    sel.value = '';
    syncCustomSelect(sel);   // 程序改 value 不触发 change,自定义下拉需手动同步
  }
}

let searchTimer;
$('#searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = $('#searchInput').value.trim();
    if (state.q) clearShelfFilters();
    fetchBooks();
  }, 300);
});

/* 竖屏:搜索是顶栏一级入口(与「添加书籍」平级),不是菜单里的附属品。
   点搜索图标 → 整行展开为搜索栏并聚焦;取消 / Esc / 回车提交 / 点顶栏外部都会收起。
   桌面端不显示图标,`.search-box` 常驻,这两个函数在桌面端点了也无副作用。 */
function openSearchRow() {
  document.body.classList.add('search-open');
  const si = $('#searchInput');
  if (si) setTimeout(() => si.focus(), 30);
}

function closeSearchRow() {
  if (!document.body.classList.contains('search-open')) return;
  document.body.classList.remove('search-open');
  const si = $('#searchInput');
  if (si) si.blur();
}

$('#searchBtn').addEventListener('click', openSearchRow);
$('#searchCancel').addEventListener('click', closeSearchRow);

document.addEventListener('pointerdown', (e) => {
  if (!document.body.classList.contains('search-open')) return;
  if (e.target.closest('.topbar')) return;   // 顶栏内的操作不关闭
  closeSearchRow();
});

/* 回车提交搜索:立即生效(不等防抖),跳到结果所在的「书架」视图,并收起搜索栏。
   移动端还必须收起全屏菜单 —— 否则屏幕被菜单盖住,等于什么都没发生。 */
function submitSearch(raw) {
  clearTimeout(searchTimer);
  state.q = String(raw || '').trim();
  if (state.q) clearShelfFilters();
  closeSearchRow();
  closeMobileMenu();
  if (state.view !== 'shelf') switchView('shelf');
  fetchBooks();
}

$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitSearch($('#searchInput').value);
  }
});

$('#addBtn').addEventListener('click', () => openBookModal(null));
$('#emptyAddBtn').addEventListener('click', () => openBookModal(null));

/* ============ 启动 ============ */
function refreshAll() {
  fetchBooks();
  loadStats();
  fetchHome();
}

// 心得子页面与榜单的 hash 路由:#/notes/<id>、#/rank,浏览器前进后退可用
let hashNav = false;
window.addEventListener('hashchange', () => {
  if (hashNav) { hashNav = false; return; }
  const m = location.hash.match(/^#\/notes\/(\d+)$/);
  if (m) {
    openNotesPage(Number(m[1]), true);
  } else if (location.hash === '#/rank') {
    if (state.view !== 'rank') switchView('rank');
  } else if (state.view === 'notes') {
    switchView(state.prevView || 'shelf');
  }
});

$('#notesBack').addEventListener('click', () => {
  if (location.hash) {
    hashNav = true;
    location.hash = '';
  }
  switchView(state.prevView || 'shelf');
});

/* ============ 竖屏侧滑返回 ============
   从左边缘向右滑 → 返回上一级。层级由外到内,与页面内的返回按钮共用同一套判断:
   弹窗 → 全屏菜单 → 顶栏搜索栏 → 自定义下拉 → 心得子页面/深链 → 非首页视图。
   仅在竖屏/窄屏(≤819px,与全站断点一致)启用,横屏保持桌面行为。 */
function goBack() {
  // 1. 任何浮层弹窗
  if ($$('.modal').some((m) => !m.classList.contains('hidden'))) { closeModals(); return true; }
  // 2. 移动端全屏菜单
  if (mobileMenu.classList.contains('open')) { closeMobileMenu(); return true; }
  // 3. 顶栏展开的搜索栏
  if (document.body.classList.contains('search-open')) { closeSearchRow(); return true; }
  // 4. 展开中的自定义下拉
  const openSel = customSelects.filter((r) => r.wrap.classList.contains('open'));
  if (openSel.length) { openSel.forEach((r) => r.close()); return true; }
  // 5. 心得子页面 / 榜单深链:回到进入前的视图,并清掉 hash
  if (state.view === 'notes' || location.hash) {
    const back = state.view === 'notes' ? (state.prevView || 'shelf') : 'home';
    if (location.hash) { hashNav = true; location.hash = ''; }
    switchView(back);
    return true;
  }
  // 6. 书架 / 榜单 / 统计 → 回首页
  if (state.view !== 'home') { switchView('home'); return true; }
  return false;   // 已在首页顶层,无可返回
}

(function initEdgeSwipeBack() {
  const EDGE = 28;        // 起始判定:落点须在距左边缘 28px 内
  const TRIGGER = 60;     // 触发阈值:水平位移 ≥ 60px
  const MAX_DY = 60;      // 纵向容差:超过即判定为纵向滚动,放弃本次手势
  const portrait = window.matchMedia('(max-width: 819px)');

  let sx = 0, sy = 0, maxDy = 0, active = false, horizontal = false;

  // touchmove 用非被动监听才能 preventDefault(挡掉系统级边缘返回与横向滚动)。
  // 但常驻一个非被动 touchmove 会让全站滚动失去快速通道,所以只在命中边缘时临时挂上,
  // 手势结束立刻摘掉 —— 代价只落在真正触发手势的那一次滑动上。
  function onMove(e) {
    if (!active) return;
    const t = e.touches[0];
    const dx = t.clientX - sx;
    const dy = Math.abs(t.clientY - sy);
    if (dy > maxDy) maxDy = dy;
    if (maxDy > MAX_DY && !horizontal) { finish(); return; }   // 明显在纵向滚动
    if (!horizontal && dx > 8 && dx > dy * 1.2) horizontal = true;  // 横向意图明确
    if (horizontal) e.preventDefault();
  }

  function finish() {
    active = false;
    horizontal = false;
    maxDy = 0;
    document.removeEventListener('touchmove', onMove);
  }

  document.addEventListener('touchstart', (e) => {
    finish();
    if (!portrait.matches || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX > EDGE) return;
    sx = t.clientX;
    sy = t.clientY;
    active = true;
    document.addEventListener('touchmove', onMove, { passive: false });
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!active) { finish(); return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = Math.abs(t.clientY - sy);
    const hit = horizontal && dx >= TRIGGER && Math.max(dy, maxDy) < MAX_DY;
    finish();
    if (hit) goBack();
  }, { passive: true });

  document.addEventListener('touchcancel', finish, { passive: true });
})();

(async () => {
  await loadSettings();
  refreshAll();
  fetchHome();
  const m = location.hash.match(/^#\/notes\/(\d+)$/);
  if (m) openNotesPage(Number(m[1]), true);
  else if (location.hash === '#/rank') switchView('rank');
})();
