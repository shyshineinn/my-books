/* ============================================================
 * 全站公共逻辑(多页版):工具函数、鉴权、API、封面渲染、
 * 弹窗(添加/编辑、详情、设置)、移动端菜单、顶栏搜索、侧滑返回。
 *
 * 页面专属逻辑在 page-<name>.js;外壳 DOM 由 chrome.js 先行注入。
 * 加载顺序(defer 保序):chrome.js → common.js → page-*.js
 *
 * 跨页协作约定:
 *   · 数据变更(保存/删除书籍)后派发 document 事件 'books-changed',
 *     当前页面自行刷新;其它视图在各自跳转后自然重新拉取。
 *   · 搜索:书架页实时过滤(派发 'shelf-search');其它页面回车跳 /shelf?q=。
 * ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STATUS_LABEL = { wish: '想读', reading: '在读', done: '已读' };

const state = {
  settings: { notesRepo: '', notesBranch: 'main' },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// 评分星级(5 星图形;输入为豆瓣 10 分制,÷2 折算星宽,四舍五入到半星)
// 只渲染图形,数值由调用处决定是否展示
function starHtml(rating) {
  const score = Math.max(0, Math.min(10, Number(rating) || 0));
  const stars = Math.round(score) / 2;
  let out = '';
  for (let i = 1; i <= 5; i++) {
    const cls = stars >= i ? 'on' : (stars >= i - 0.5 ? 'half' : '');
    out += `<span class="star${cls ? ' ' + cls : ''}">★</span>`;
  }
  return out;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

// 数据变更后广播:当前页监听刷新,弹窗(编辑/删除)调用方无需关心页面差异
function notifyBooksChanged() {
  document.dispatchEvent(new Event('books-changed'));
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
// 默认封面:Apple 产品配色(午夜色/星光色/远峰蓝/银色/原野绿/深空灰,哑光质感)
// mid = 渐变两端的中间色,供无封面书的卡片背景取色用
const COVER_STYLES = [
  { bg: 'linear-gradient(180deg, #3a4155 0%, #232837 100%)', fg: '#f5f5f7', mid: [46, 52, 70] },
  { bg: 'linear-gradient(180deg, #f6efe3 0%, #e6ddcc 100%)', fg: '#3a3125', mid: [238, 230, 215] },
  { bg: 'linear-gradient(180deg, #93a5bd 0%, #5f7691 100%)', fg: '#f5f5f7', mid: [121, 141, 167] },
  { bg: 'linear-gradient(180deg, #aebfa3 0%, #7f9573 100%)', fg: '#2c3327', mid: [150, 170, 139] },
  { bg: 'linear-gradient(180deg, #e3e4e0 0%, #cccdc7 100%)', fg: '#3a3b35', mid: [215, 216, 211] },
  { bg: 'linear-gradient(180deg, #565059 0%, #3b3740 100%)', fg: '#efe9f2', mid: [72, 67, 76] },
];

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
    return `<img src="${esc(coverSrc(url))}" alt="${esc(book.title)} 封面" loading="lazy" referrerpolicy="no-referrer" data-ph="${esc(book.title)}" data-ph-author="${esc(book.author || '')}">`;
  }
  return phHtml(esc(book.title), esc(book.author || ''));
}

// 外链封面统一转同源代理地址。
// 必须走代理:豆瓣图床对直连(无 Referer)回 418 防盗链,且 <img referrerpolicy="no-referrer">
// 只会让浏览器一个 Referer 都不带 —— 直连必然加载失败。
// 代理侧按域名定向补 Referer(见 src/http/routes.proxy.js 的 refererFor)。
// 本站相对路径(/uploads/...)原样返回。
function coverSrc(url) {
  const u = String(url ?? '').trim();
  return /^https?:\/\//i.test(u) ? '/api/img-proxy?url=' + encodeURIComponent(u) : u;
}

// 图片加载失败时替换为占位封面(error 事件不冒泡,需捕获阶段监听)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || img.dataset.ph === undefined) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = phHtml(img.dataset.ph, img.dataset.phAuthor || '');
  img.replaceWith(wrap.firstElementChild);
}, true);

// 文件大小展示:字节 → KB / MB
function fileSizeText(bytes) {
  const kb = Math.max(1, Math.round((bytes || 0) / 1024));
  return kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
}

/* ============ 统计共享缓存 ============
 * /api/stats 一次拉取,多处使用:书架页签计数与标签下拉、编辑弹窗标签建议。
 * 数据变更后 invalidateSharedStats() 作废,下次访问重新拉。 */
let sharedStatsPromise = null;
function sharedStats() {
  if (!sharedStatsPromise) sharedStatsPromise = api('/api/stats').catch(() => null);
  return sharedStatsPromise;
}
function invalidateSharedStats() { sharedStatsPromise = null; }

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
  await settingsReady;   // 心得入口文案依赖 settings,首屏未加载完时先等
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

  // 出版信息(豆瓣抓取落库的字段;此前只入库不展示)
  const pubBits = [book.publisher, book.pub_year].filter(Boolean);
  const rating = Number(book.rating) || 0;
  $('#detailBody').innerHTML = `
    <div class="detail-cover">${coverHtml(book)}</div>
    <div class="detail-info">
      <h2>${esc(book.title)}</h2>
      ${book.author ? `<div class="detail-author">${esc(book.author)}</div>` : ''}
      <div class="card-meta">
        <span class="status-inline ${book.status}">${STATUS_LABEL[book.status]}</span>
        ${rating > 0 ? `<span class="detail-rating" title="豆瓣评分 ${rating} / 10">${starHtml(rating)}<b>${rating}</b></span>` : ''}
      </div>
      <div class="detail-rows">
        ${legacyDates.length ? `<div class="detail-row"><span class="k">日期</span><span class="v">${esc(legacyDates.join(' · '))}</span></div>` : ''}
        ${logs.length ? `<div class="detail-row"><span class="k">阅读记录</span><span class="v detail-logs">${logs.map((l) => `<span class="log-chip">${esc(l.start || '开始未记')}${l.finish ? ' 至 ' + esc(l.finish) : ' · 进行中'}</span>`).join('')}</span></div>` : ''}
        ${tags.length ? `<div class="detail-row"><span class="k">标签</span><span class="v detail-tags">${tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join('')}</span></div>` : ''}
        ${pubBits.length ? `<div class="detail-row"><span class="k">出版</span><span class="v">${esc(pubBits.join(' · '))}</span></div>` : ''}
        ${book.isbn ? `<div class="detail-row"><span class="k">ISBN</span><span class="v detail-isbn">${esc(book.isbn)}</span></div>` : ''}
        ${book.douban_id ? `<div class="detail-row"><span class="k">豆瓣</span><span class="v"><a class="detail-link" href="https://book.douban.com/subject/${esc(book.douban_id)}/" target="_blank" rel="noopener noreferrer">查看豆瓣条目 ↗</a></span></div>` : ''}
      </div>
      ${book.summary ? `<div class="detail-block"><div class="detail-block-k">简介</div><p class="detail-block-v">${esc(book.summary)}</p></div>` : ''}
      ${book.files && book.files.length ? `<div class="detail-block"><div class="detail-block-k">电子书文件</div><div class="detail-files">${book.files.map((f) => `
        <a class="detail-file-link" href="/books-files/${esc(f.path)}" download="《${esc(book.title)}》.${esc(f.format.toLowerCase())}" title="下载 ${esc(f.format)} 文件(${fileSizeText(f.size)})">
          <span class="ebook-tag">.${esc(f.format)}</span><span>${fileSizeText(f.size)}</span> ⬇
        </a>`).join('')}</div></div>` : ''}
      <button type="button" class="notes-entry" id="detailNotesEntry" title="${autoNotes ? '自动匹配《' + esc(book.title) + '》.md' : '打开读书心得'}">读书心得</button>
      <div class="detail-actions">
        <button type="button" class="btn btn-ghost" id="detailEdit">✎ 编辑</button>
        <button type="button" class="btn btn-danger-tint" id="detailDelete">删除</button>
      </div>
    </div>`;

  openModal('#detailModal');

  $('#detailEdit').addEventListener('click', () => openBookModal(book));
  $('#detailDelete').addEventListener('click', () => deleteBook(book.id, book.title));
  // 心得是独立页面;无心得时心得页会给出"如何上传"的引导,入口始终保留(与旧版一致)
  $('#detailNotesEntry').addEventListener('click', () => {
    closeModals();
    location.href = '/notes/' + book.id;
  });
}

async function deleteBook(id, title) {
  if (!confirm(`确定要删除《${title}》吗?此操作不可恢复。`)) return;
  try {
    await api('/api/books/' + id, { method: 'DELETE' });
    closeModals();
    toast('已删除');
    invalidateSharedStats();
    notifyBooksChanged();
  } catch (e) {
    toast(e.message, true);
  }
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
    notifyBooksChanged();   // 心得自动匹配影响详情弹窗文案,当前页刷新
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
  mobileMenu.classList.toggle('open', opening);
  document.body.classList.toggle('menu-open', opening);
  document.body.classList.toggle('modal-open', opening);
  // 展开时把焦点移进对话框本身(原来是落在搜索框上;搜索已独立到顶栏)。
  // 焦点给容器而非第一个导航项:Tab 一下即进入「首页」,且容器不画聚焦描边,
  // 不依赖 :focus-visible 的输入模态启发式 —— 避免每次开菜单都闪一圈蓝框
  if (opening) setTimeout(() => mobileMenu.focus(), 300);
});

// 菜单里的导航项是真实链接(跨页跳转),只需点按时收起菜单
$$('#mobileMenu .mm-links a').forEach((a) => {
  a.addEventListener('click', closeMobileMenu);
});

$('#mmSettings').addEventListener('click', () => {
  closeMobileMenu();
  openSettingsModal();
});

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
  renderEbookList([]);
  refreshEbookList(); // 有 bookId 时异步拉取该书的文件列表
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
    // 走 coverSrc 代理:豆瓣图床直连会被防盗链拒绝(418),预览会显示不出来
    box.innerHTML = `<img src="${esc(coverSrc(url))}" alt="封面预览"
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

/* ============ 电子书文件管理(多文件:epub / pdf 等各存一份) ============
 * 直接上传:编辑前必须已保存书籍(有 bookId 才能关联)。
 * 上传即时生效(不走表单保存);同一格式重复上传 = 覆盖替换。
 * 用 XMLHttpRequest 而非 fetch:支持上传进度回调,大文件(几十 MB)不卡页面。 */
const ebookFileEl = $('#fEbookFile');
let ebookUploading = false;

// 渲染编辑弹窗里的文件列表;files 为空数组时显示占位文案
function renderEbookList(files) {
  const box = $('#ebookInfo');
  if (!files || !files.length) {
    box.innerHTML = '<span class="ebook-info-empty">未上传文件</span>';
    return;
  }
  box.innerHTML = files.map((f) => `
    <span class="ebook-item">
      <span class="ebook-tag">.${esc(f.format)}</span>
      <a href="/books-files/${esc(f.path)}" download title="下载该文件">${fileSizeText(f.size)}</a>
      <button type="button" class="ebook-item-del" data-format="${esc(f.format)}" title="删除 ${esc(f.format)} 文件" aria-label="删除 ${esc(f.format)} 文件">✕</button>
    </span>`).join('');
  box.querySelectorAll('.ebook-item-del').forEach((btn) => {
    btn.addEventListener('click', () => removeEbookFile(btn.dataset.format));
  });
}

// 拉取当前书籍的文件列表(打开弹窗 / 上传 / 删除后调用)
async function refreshEbookList() {
  const bookId = $('#bookId').value;
  if (!bookId) {
    renderEbookList([]);
    return;
  }
  try {
    const data = await api(`/api/books/${bookId}/file`);
    renderEbookList(data.files || []);
  } catch {
    renderEbookList([]);
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
      await uploadEbookWithProgress(bookId, file, authHeaders());
    } catch (err) {
      if (err.status === 401) {
        forgetToken();
        const t = askForToken();
        if (t === null) throw new Error('需要管理令牌');
        localStorage.setItem(TOKEN_KEY, t);
        await uploadEbookWithProgress(bookId, file, { Authorization: 'Bearer ' + t });
      } else {
        throw err;
      }
    }
    await refreshEbookList();
    toast('文件已上传');
    notifyBooksChanged();   // file_formats 徽标要跟着变
  } catch (err) {
    toast(err.message, true);
  } finally {
    ebookUploading = false;
    text.textContent = '选择文件上传';
  }
}

async function removeEbookFile(format) {
  const bookId = $('#bookId').value;
  if (!bookId || ebookUploading) return;
  ebookUploading = true;
  try {
    const res = await fetch(`/api/books/${bookId}/file?format=${encodeURIComponent(format)}`, {
      method: 'DELETE', headers: { ...authHeaders() },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '删除失败');
    }
    await refreshEbookList();
    toast(`已删除 ${format} 文件`);
    notifyBooksChanged();
  } catch (err) {
    toast(err.message, true);
  } finally {
    ebookUploading = false;
  }
}

ebookFileEl.addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || ebookUploading) return;
  handleEbookUpload(file);
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
        <span>${d.cover ? `<img src="${esc(coverSrc(d.cover))}" alt="" style="width:32px;height:44px;object-fit:cover;border-radius:3px">` : ''}</span>
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
    invalidateSharedStats();
    notifyBooksChanged();
  } catch (e2) {
    errEl.textContent = e2.message;
  } finally {
    saveBtn.disabled = false;
  }
});

/* ============ 顶栏搜索(跨页) ============
 * 书架页:输入实时过滤(派发 shelf-search 给 page-shelf.js)。
 * 其它页:回车跳转 /shelf?q=…(与旧单页"回车进书架看结果"一致)。 */
const IS_SHELF_PAGE = document.body.dataset.page === 'shelf';

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

$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  closeSearchRow();
  closeMobileMenu();
  if (IS_SHELF_PAGE) {
    document.dispatchEvent(new CustomEvent('shelf-search', { detail: { q } }));
  } else if (q) {
    location.href = '/shelf?q=' + encodeURIComponent(q);
  }
});

$('#addBtn').addEventListener('click', () => openBookModal(null));

/* ============ 竖屏侧滑返回 ============
 * 从左边缘向右滑 → 返回上一级。多页后层级更简单:
 * 先收浮层(弹窗 → 全屏菜单 → 搜索栏 → 自定义下拉),
 * 再走页面层级:心得页 → 历史回退,其它非首页 → 回首页。
 * 仅在竖屏/窄屏(≤819px,与全站断点一致)启用,横屏保持桌面行为。 */
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
  // 5. 页面层级
  const page = document.body.dataset.page;
  if (page === 'home') return false;   // 已在首页顶层,无可返回
  if (page === 'notes') {
    // 心得页回到进入前的页面;直接输入 URL 进来的没有历史,退回书架
    if (history.length > 1) history.back();
    else location.href = '/shelf';
    return true;
  }
  location.href = '/';
  return true;
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

/* ============ 启动 ============ */
// settingsReady:settings 首屏拉取的 Promise。详情弹窗/心得页的心得文案依赖
// state.settings.notesRepo,用户操作可能早于首屏请求返回,先 await 再判定。
const settingsReady = (async () => {
  await loadSettings();
  // 标签建议(datalist):编辑弹窗打开前备好,失败静默(不影响其它功能)
  sharedStats().then((data) => {
    if (!data) return;
    $('#tagSuggestions').innerHTML =
      data.topTags.map((t) => `<option value="${esc(t.tag)}">`).join('');
  });
})();
