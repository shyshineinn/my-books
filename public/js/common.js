/* ============================================================
 * 全站公共 UI 逻辑(多页版):弹窗(添加/编辑、详情、设置)、
 * 移动端菜单、顶栏搜索、侧滑返回。
 * 基础 DOM/格式化在 base.js;API 与鉴权在 api.js;封面在 cover.js;
 * 下拉/弹窗在 select.js、modal.js;移动菜单与搜索浮层在 overlay.js。
 *
 * 页面专属逻辑在 page-<name>.js;外壳 DOM 由 chrome.js 先行注入。
 * 加载顺序(defer 保序):chrome.js → base.js → api.js → cover.js → select.js
 *   → modal.js → overlay.js → common.js → page-*.js
 *
 * 跨页协作约定:
 *   · 数据变更(保存/删除书籍)后派发 document 事件 'books-changed',
 *     当前页面自行刷新;其它视图在各自跳转后自然重新拉取。
 *   · 搜索:书架页实时过滤(派发 'shelf-search');其它页面回车跳 /shelf?q=。
 * ============================================================ */

const state = {
  editPrecondition: null,
  customColumns: [],       // 自定义字段定义(启动时拉取,见 loadCustomColumns)
  customStamp: null,       // 上次拉取时的跨页版本戳
};

// action 可选:{ label, onClick } —— 用于删除后的「撤销」等短时操作。
// 带操作时展示 6 秒,给用户留出点击时间。
function toast(msg, isError = false, action = null) {
  const el = $('#toast');
  el.textContent = '';
  el.classList.toggle('error', isError);

  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      el.classList.add('hidden');
      clearTimeout(toast._t);
      action.onClick();
    });
    el.appendChild(btn);
  }

  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), action ? 6000 : 2200);
}

// 数据变更后广播:当前页监听刷新,弹窗(编辑/删除)调用方无需关心页面差异
function notifyBooksChanged() {
  document.dispatchEvent(new Event('books-changed'));
}

/* ============ 统计共享缓存 ============
 * /api/stats 一次拉取,多处使用:书架页签计数与标签下拉、编辑弹窗标签建议。
 * 数据变更后 invalidateSharedStats() 作废,下次访问重新拉。
 * 书架上若带着 ?vl=(虚拟书库作用域),统计口径要跟着收窄。 */
let sharedStatsPromise = null;
function sharedStats() {
  if (!sharedStatsPromise) {
    const vl = document.body.dataset.page === 'shelf'
      ? (new URLSearchParams(location.search).get('vl') || '') : '';
    const url = '/api/stats' + (vl ? '?vl=' + encodeURIComponent(vl) : '');
    sharedStatsPromise = api(url).catch(() => null);
  }
  return sharedStatsPromise;
}
function invalidateSharedStats() { sharedStatsPromise = null; }

/* ============ 可折叠板块(统计 / 分类页) ============
 * 默认折叠态由 HTML 上的 is-collapsed 承载(脚本执行前内容就不会闪现),
 * 这里补开关按钮、无障碍状态与点击标题行展开/收起。
 * 标题内的按钮/链接保持原行为(如分类页的「新建字段」),不触发折叠。 */
function initCollapsibleSections(secs, headSel) {
  $$(secs).forEach((sec) => {
    const head = sec.querySelector(':scope > ' + headSel);
    if (!head || head.querySelector('.collapse-toggle')) return;
    head.classList.add('collapse-head');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'collapse-toggle';
    btn.setAttribute('aria-expanded', String(!sec.classList.contains('is-collapsed')));
    btn.setAttribute('aria-label', sec.classList.contains('is-collapsed') ? '展开' : '折叠');
    // 与自定义下拉一致的实心三角;折叠时 CSS 旋转 90° 指向右侧
    btn.innerHTML = '<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">'
      + '<path fill="currentColor" d="M5 6 0 0h10z"></path></svg>';
    head.appendChild(btn);

    const toggle = () => {
      const collapsed = sec.classList.toggle('is-collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('aria-label', collapsed ? '展开' : '折叠');
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    head.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      toggle();
    });
  });
  bindHashReveal();
}

/* 顶栏下拉里的深链(如 /stats#authorPanel、/tags#fieldsHead):
   目标所在板块默认折叠,直接跳只会停在标题上 —— 先展开再滚动到目标。 */
function revealSectionFromHash() {
  const raw = location.hash.slice(1);
  if (!raw) return;
  let target;
  try { target = document.getElementById(decodeURIComponent(raw)); } catch { return; }
  if (!target) return;
  const sec = target.closest('.is-collapsed');
  if (sec) {
    sec.classList.remove('is-collapsed');
    const btn = sec.querySelector('.collapse-head > .collapse-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', '折叠');
    }
  }
  requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}

function bindHashReveal() {
  if (bindHashReveal.bound) return;
  bindHashReveal.bound = true;
  window.addEventListener('hashchange', () => requestAnimationFrame(revealSectionFromHash));
  window.addEventListener('load', () => setTimeout(revealSectionFromHash, 0), { once: true });
  setTimeout(revealSectionFromHash, 0);
}

/* ============ 详情弹窗 ============ */
// 系列行(A3):显示「系列 #n」,点一下跳书架按该系列筛选
function seriesHtml(book) {
  const label = book.series_label || '';
  if (!label) return '';
  return `<div class="detail-row"><span class="k">系列</span><span class="v">`
    + `<a class="detail-link" href="/shelf?q=${encodeURIComponent('series:' + book.series)}">${esc(label)}</a>`
    + '</span></div>';
}

// 标识符行(A5):ISBN / 豆瓣之外的其它类型,能构造外链的给链接。
// ISBN 与豆瓣由各自专用行展示,这里跳过以免重复。
function identifiersHtml(book) {
  const list = (book && book.identifier_list) || [];
  const rest = list.filter((x) => !['isbn', 'douban', 'douban_id'].includes(String(x.type).toLowerCase()));
  if (!rest.length) return '';
  const body = rest.map((x) => (x.url
    ? `<a class="detail-link" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.label)} ↗</a>`
    : `${esc(x.label)}:${esc(x.value)}`)).join(' · ');
  return `<div class="detail-row"><span class="k">标识符</span><span class="v detail-ids">${body}</span></div>`;
}

// 详情页的自定义字段行:按注册表顺序列出已填值的字段。
// 用 custom_display(服务端渲染好的展示文本),多值已拼成顿号。
function customFieldsDetailHtml(book) {
  const cols = state.customColumns || [];
  const disp = (book && book.custom_display) || {};
  const rows = cols
    .filter((c) => disp[c.label])
    .map((c) => `<div class="detail-row"><span class="k">${esc(c.name)}</span><span class="v">${esc(disp[c.label])}</span></div>`);
  return rows.length ? rows.join('') : '';
}

async function openDetail(id) {
  await bootReady;   // 自定义字段定义要先备好,详情弹窗才渲染得出自定义字段行
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
        ${seriesHtml(book)}
        ${pubBits.length ? `<div class="detail-row"><span class="k">出版</span><span class="v">${esc(pubBits.join(' · '))}</span></div>` : ''}
        ${identifiersHtml(book)}
        ${book.isbn ? `<div class="detail-row"><span class="k">ISBN</span><span class="v detail-isbn">${esc(book.isbn)}</span></div>` : ''}
        ${book.douban_id ? `<div class="detail-row"><span class="k">豆瓣</span><span class="v"><a class="detail-link" href="https://book.douban.com/subject/${esc(book.douban_id)}/" target="_blank" rel="noopener noreferrer">查看豆瓣条目 ↗</a></span></div>` : ''}
      </div>
      ${customFieldsDetailHtml(book)}
      ${book.summary ? `<div class="detail-block"><div class="detail-block-k">简介</div><p class="detail-block-v">${esc(book.summary)}</p></div>` : ''}
      ${book.files && book.files.length ? `<div class="detail-block"><div class="detail-block-k">电子书文件</div><div class="detail-files">${book.files.map((f) => `
        <a class="detail-file-link" href="${esc(f.download_url || `/books-files/${f.path}`)}" download="《${esc(book.title)}》.${esc(f.format.toLowerCase())}" title="下载 ${esc(f.format)} 文件(${fileSizeText(f.size)})">
          <span class="ebook-tag">.${esc(f.format)}</span><span>${fileSizeText(f.size)}</span> ⬇
        </a>`).join('')}</div></div>` : ''}
      <button type="button" class="notes-entry" id="detailNotesEntry" title="打开读书心得">读书心得</button>
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
  if (!confirm(`将《${title}》移入回收站?可在「分类 → 回收站」恢复。`)) return;
  try {
    const res = await api('/api/books/' + id, { method: 'DELETE' });
    closeModals();
    const days = Number(res.retention_days) || 14;
    toast(`《${title}》已移入回收站(${days} 天内可恢复)`, false, {
      label: '撤销',
      onClick: async () => {
        try {
          await api(`/api/books/${id}/restore`, { method: 'POST' });
          toast('已恢复');
          invalidateSharedStats();
          notifyBooksChanged();
        } catch (e) {
          toast(e.message, true);
        }
      },
    });
    invalidateSharedStats();
    notifyBooksChanged();
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

function setBookFormSection(name, open) {
  const btn = document.querySelector(`#bookForm [data-form-toggle="${name}"]`);
  const body = document.querySelector(`#bookForm [data-form-content="${name}"]`);
  if (!btn || !body) return;
  btn.setAttribute('aria-expanded', String(open));
  body.hidden = !open;
}

function resetBookFormSections(book, logs) {
  setBookFormSection('details', false);
  setBookFormSection('reading', false);
  const detailsHint = document.querySelector('#bookForm [data-form-hint="details"]');
  const readingHint = document.querySelector('#bookForm [data-form-hint="reading"]');
  const detailsFilled = !!(book && (
    book.series || book.publisher || book.pub_year || book.summary || book.cover
    || (book.files && book.files.length)
    || (book.identifiers && Object.keys(book.identifiers).length)
    || (book.custom && Object.keys(book.custom).length)
  ));
  if (detailsHint) {
    detailsHint.textContent = detailsFilled
      ? '已填写 · 展开查看'
      : '系列、出版、简介、封面与文件';
  }
  if (readingHint) {
    readingHint.textContent = logs && logs.length
      ? `${logs.length} 条记录 · 展开查看`
      : '阅读日期与次数';
  }
  const body = $('#bookFormBody');
  if (body) body.scrollTop = 0;
}

async function openBookModal(book) {
  // 自定义字段控件要按最新定义生成。定义可能还没拉完(首屏),或已被
  // /tags 页改过(跨页戳失效)—— 这里统一 await 一次,避免"字段偶尔不显示"。
  await bootReady;
  await loadCustomColumns();

  // **防数据丢失**:表单提交时会把每个自定义字段的当前值发回服务端,
  // 空串的语义是"清空该字段"。若拿到的 book 对象**缺 custom 原始值**
  // (如列表接口只返回 custom_display),输入框会渲染成空 → 提交即清空用户数据。
  // 所以:编辑已有书而对象里没有 custom 时,先补拉一次完整详情。
  if (book && book.id && !('custom' in book)) {
    try {
      book = await api('/api/books/' + book.id);
    } catch { /* 拉取失败:保持传入对象,后续提交仍受服务端局部更新保护 */ }
  }
  closeModals();
  $('#modalTitle').textContent = book ? '编辑书籍' : '添加书籍';
  // 「按 ISBN 批量添加」只在新增时出现(编辑单本时没有意义)
  $('#isbnBatchBtn').hidden = !!book;
  $('#bookId').value = book ? book.id : '';
  state.editPrecondition = book ? {
    id: String(book.id), expected_revision: book.revision,
    expected_uuid: book.uuid, expected_updated_at: book.updated_at,
  } : null;
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
  $('#fRating').value = book && book.rating ? book.rating : '';
  $('#fDoubanId').value = book ? (book.douban_id || '') : '';
  // A3 系列:序号 0 表示未指定 → 对应输入框留空(而不是显示 0)
  $('#fSeries').value = book ? (book.series || '') : '';
  $('#fSeriesIndex').value = book && book.series_index ? book.series_index : '';
  renderIdRows(book);
  doubanStatus.textContent = '';
  doubanCandidates.classList.add('hidden');
  // 自定义字段:定义已在启动时拉好,这里只按当前书回填值
  renderCustomFieldInputs(book);
  resetBookFormSections(book, formLogs);
  openModal('#bookModal');
  // 触屏设备不自动聚焦书名:竖屏打开表单时虚拟键盘会立刻弹出、遮住大半表单;
  // 桌面(精确指针)保留「打开即可输入」。不能用宽度/朝向判断 —— 键盘只跟触屏走。
  if (!window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
    setTimeout(() => $('#fTitle').focus(), 60);
  }
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
      <a href="${esc(f.download_url || `/books-files/${f.path}`)}" download title="下载该文件">${fileSizeText(f.size)}</a>
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
        location.assign('/login?next=' + encodeURIComponent(location.pathname + location.search));
        throw new Error('请先登录图书服务器，再重新选择文件上传');
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

/* ============ 自定义字段(对标 calibre custom columns) ============
 * 字段定义是数据(存在 custom_columns 表),所以表单里的输入控件必须动态生成。
 * 约定:
 *   · 定义在启动时拉一次并缓存(fieldsState.columns);字段增删由 /tags 页触发,
 *     该页写完后写 localStorage 戳,回到书架时刷新 —— 跨页不共享内存,靠存储通信。
 *   · 多值字段(text + is_multiple)用逗号分隔的普通输入框,不用动态增删行
 *     —— 与既有「分类标签」输入框一致,学习成本最低。
 *   · 提交时组装成 { label: value } 挂到 payload.custom。
 */
const CUSTOM_FIELDS_KEY = 'mybooks.customFields.v1';
const CUSTOM_FIELDS_STAMP_KEY = 'mybooks.customFields.stamp';
let customColumnsLoaded = false;

// 读其它页留下的"字段定义已变"戳。值变了(或本站从未拉过)就重新拉定义。
// 为什么用 localStorage 而不是内存:MPA 每页独立加载,跨页只能靠存储通信
// (与 sw.js 的版本戳同一思路)。
function customFieldsStampChanged() {
  try {
    return localStorage.getItem(CUSTOM_FIELDS_STAMP_KEY) !== state.customStamp;
  } catch { return false; }
}

function rememberCustomStamp() {
  try { state.customStamp = localStorage.getItem(CUSTOM_FIELDS_STAMP_KEY); } catch { /* ignore */ }
}

async function loadCustomColumns(force = false) {
  if (customColumnsLoaded && !force && !customFieldsStampChanged()) return state.customColumns;
  try {
    state.customColumns = await api('/api/custom-fields');
  } catch {
    state.customColumns = [];   // 拉取失败不阻断主流程:没有自定义字段也能用
  }
  customColumnsLoaded = true;
  rememberCustomStamp();
  return state.customColumns;
}

// 渲染表单里的自定义字段区块。book 为空(新增)时全部留空。
function renderCustomFieldInputs(book) {  const box = $('#customFieldsBox');
  const cols = state.customColumns || [];
  const section = $('#customFieldsSection');
  if (!box || !section) return;
  if (!cols.length) { section.classList.add('hidden'); box.innerHTML = ''; return; }
  section.classList.remove('hidden');

  const current = (book && book.custom) || {};
  box.innerHTML = cols.map((c) => {
    const id = 'cf_' + c.label;
    // 多值字段回填成逗号分隔串(数组 → "a, b")
    let val = current[c.label];
    if (Array.isArray(val)) val = val.join(', ');
    val = val == null ? '' : String(val);
    const hint = c.is_multiple ? '<span class="label-sub">多个值用逗号分隔</span>' : '';

    // 枚举用 select(受控词表,避免手敲出错 —— calibre 的枚举字段同样是下拉)
    if (c.datatype === 'enumeration' && !c.is_multiple) {
      const opts = ['<option value="">未填</option>']
        .concat(c.options.map((o) => `<option value="${esc(o)}"${o === val ? ' selected' : ''}>${esc(o)}</option>`));
      return `<div class="field"><label for="${id}">${esc(c.name)} ${hint}</label>
        <select id="${id}" data-cf-label="${esc(c.label)}">${opts.join('')}</select></div>`;
    }
    if (c.datatype === 'bool' && !c.is_multiple) {
      const sel = (v) => (val === v ? ' selected' : '');
      return `<div class="field"><label for="${id}">${esc(c.name)} ${hint}</label>
        <select id="${id}" data-cf-label="${esc(c.label)}">
          <option value=""${sel('')}>未填</option>
          <option value="1"${sel('1')}>是</option>
          <option value="0"${sel('0')}>否</option>
        </select></div>`;
    }

    const type = (c.datatype === 'date') ? 'date'
      : (['int', 'float', 'rating'].includes(c.datatype) ? 'number' : 'text');
    const extra = c.datatype === 'rating' ? ' min="0" max="10" step="0.1"'
      : (c.datatype === 'int' ? ' step="1"' : (c.datatype === 'float' ? ' step="any"' : ''));
    return `<div class="field"><label for="${id}">${esc(c.name)} ${hint}</label>
      <input type="${type}" id="${id}" data-cf-label="${esc(c.label)}" value="${esc(val)}"${extra}></div>`;
  }).join('');
}

// 从表单收集自定义值 → { label: value }
function collectCustomValues() {
  const out = {};
  for (const el of $$('#customFieldsBox [data-cf-label]')) {
    const label = el.dataset.cfLabel;
    const v = String(el.value || '').trim();
    // 只提交非空值:空 = 未填。这样既支持"清空某字段"(服务端把空串当删除),
    // 也不会因为提交一堆空串把别的字段误清(服务端按 label 局部更新)
    out[label] = v;
  }
  return out;
}

/* ============ 系列 + 其它标识符(表单区) ============
 * A3:系列名与序号是两个字段,但允许在系列名里写「基地 [3]」由服务端拆
 * (core/series.parseSeriesInput),所以这里不做客户端拆分 —— 保持单一真相。
 * A5:除 ISBN/豆瓣外可加任意类型标识符,行数不固定,故动态增删。
 *   已由 ISBN / 豆瓣专用输入框覆盖的类型不在此重复(避免两处输入同一类型)。
 */
const ID_TYPE_HINT = ['goodreads', 'doi', 'amazon', 'openlibrary', 'google', 'issn', 'url'];

// 这些类型的值由专用输入框维护,不在"其它标识符"里重复出现
const ID_DEDICATED = new Set(['isbn', 'douban', 'douban_id']);

let idRowSeq = 0;

function idRowHtml(type = '', value = '') {
  idRowSeq += 1;
  const u = `id_row_${idRowSeq}`;
  return `<div class="id-row" data-id-row>
    <input type="text" class="id-type" id="${u}_t" list="idTypeSuggestions" placeholder="类型(如 goodreads)" value="${esc(type)}" aria-label="标识符类型">
    <input type="text" class="id-value" id="${u}_v" placeholder="值" value="${esc(value)}" aria-label="标识符值">
    <button type="button" class="icon-btn id-row-del" data-id-del aria-label="删除这一行" title="删除">✕</button>
  </div>`;
}

// 按书的 identifiers 回填"其它标识符"行(跳过专用类型)
function renderIdRows(book) {
  const box = $('#idRows');
  if (!box) return;
  const ids = (book && book.identifiers) || {};
  const others = Object.entries(ids).filter(([t]) => !ID_DEDICATED.has(String(t).toLowerCase()));
  box.innerHTML = others.map(([t, v]) => idRowHtml(t, v)).join('');
}

// 收集"其它标识符"→ { type: value };类型或值为空的行忽略
function collectIdRows() {
  const out = {};
  for (const row of $$('#idRows [data-id-row]')) {
    const t = row.querySelector('.id-type').value.trim().toLowerCase();
    const v = row.querySelector('.id-value').value.trim();
    if (!t) continue;                 // 没填类型 = 空行,忽略
    out[t] = v;                       // 值为空 = 删除该标识符(服务端语义)
  }
  return out;
}

// 标识符行:增删(事件委托,渲染后无需重复绑定)
$('#addIdRowBtn').addEventListener('click', () => {
  const box = $('#idRows');
  box.insertAdjacentHTML('beforeend', idRowHtml());
  const rows = $$('#idRows [data-id-row]');
  rows[rows.length - 1].querySelector('.id-type').focus();
});

$('#idRows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-id-del]');
  if (btn) btn.closest('[data-id-row]').remove();
});

/* ============ 豆瓣元数据填充(NewDouban 移植) ============ */const doubanBtn = $('#doubanFetchBtn');
const doubanStatus = $('#doubanStatus');
const doubanCandidates = $('#doubanCandidates');
let doubanSearching = false;

// 「其它标识符」按类型补/改一行(扫码回填 openlibrary id 用;已有同类型则更新)
function ensureIdRow(type, value) {
  for (const row of $$('#idRows [data-id-row]')) {
    if (row.querySelector('.id-type').value.trim().toLowerCase() === type) {
      row.querySelector('.id-value').value = value;
      return;
    }
  }
  $('#idRows').insertAdjacentHTML('beforeend', idRowHtml(type, value));
}

// 把元数据(豆瓣映射 / Open Library 映射,同一种形状)写进编辑表单。
// 隐藏字段带 publisher / pubYear / rating / doubanId,提交时随表单保存。
function applyBookMeta(d) {
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
  // 外文书的 Open Library 标识符:落进「其它标识符」行,保存时入库
  if (d.openlibraryId) ensureIdRow('openlibrary', String(d.openlibraryId));
}

/* ============ 按 ISBN 回填(扫码 / 手输,GET /api/isbn/lookup) ============
 * 服务端做完整校验(位数/校验位)与查重,前端不复制一份算法。
 * 回填路径与「按 ISBN 批量添加」共用同一 lookupIsbn:豆瓣直查 → OL 兜底。 */

// 按 ISBN 查元数据并回填表单;normalized 为服务端校验过的裸串
async function fillFormByIsbn(normalized) {
  doubanStatus.textContent = '正在按 ISBN 查询元数据…';
  let data;
  try {
    data = await api('/api/isbn/lookup?isbn=' + encodeURIComponent(normalized));
  } catch (e) {
    doubanStatus.textContent = '';
    toast(e.message, true);
    return;
  }
  if (data.status === 'found') {
    applyBookMeta(data.book);
    // ISBN 以扫码/输入的校验结果为准(页面上的可能带连字符等排版差异)
    $('#fIsbn').value = normalized;
    doubanStatus.textContent = (data.source === 'openlibrary' ? '已从 Open Library 填充' : '已从豆瓣填充') + ',可继续修改';
    toast('已按 ISBN 填充元数据');
    return;
  }
  doubanStatus.textContent = '';
  if (data.status === 'not_found') toast('豆瓣与 Open Library 都没有找到,ISBN 已保留,可手动填写');
  else if (data.status === 'blocked') toast('豆瓣拒绝访问(配置 Cookie 可提高成功率,见 README)', true);
  else toast('查询元数据失败,请稍后重试', true);
}

// 扫码/输入的统一入口:校验 → 查重(编辑时跳过自己)→ 回填
async function acceptIsbnInput(raw) {
  let chk;
  try {
    chk = await api('/api/isbn/check?isbn=' + encodeURIComponent(raw));
  } catch (e) {
    toast(e.message, true);
    return false;
  }
  if (!chk.valid) return false;
  const selfId = Number($('#bookId').value) || 0;
  if (chk.duplicate && chk.duplicate.id !== selfId) {
    toast(`书库已有《${chk.duplicate.title}》(同一 ISBN),没有重复添加`);
    return true;
  }
  $('#fIsbn').value = chk.normalized;
  await fillFormByIsbn(chk.normalized);
  return true;
}

// 扫码入口:解码库懒加载在 scanner.js;识别到一次后引擎暂停,由这里接手
$('#isbnScanBtn').addEventListener('click', () => {
  if (!window.BookScanner) {
    toast('扫码组件未加载,请刷新页面重试', true);
    return;
  }
  BookScanner.open({
    onDetect: async (raw) => {
      if (await acceptIsbnInput(raw)) BookScanner.close();
      else {
        toast('扫到的不是合法 ISBN,请对准书背条形码重试', true);
        BookScanner.resume();
      }
    },
  });
});

doubanBtn.addEventListener('click', async () => {
  if (doubanSearching) return;
  const isbnRaw = $('#fIsbn').value.trim();
  const q = $('#fTitle').value.trim();
  if (!isbnRaw && !q) {
    doubanStatus.textContent = '先填书名(或 ISBN)再检索';
    return;
  }
  doubanSearching = true;
  doubanBtn.disabled = true;
  doubanStatus.textContent = '正在检索豆瓣…';
  doubanCandidates.classList.add('hidden');
  doubanCandidates.innerHTML = '';
  try {
    // ISBN 优先:精确匹配(且自动兜底 Open Library),比书名搜索准;
    // 编辑已有书时"重复"可能是自己,acceptIsbnInput 内部按 selfId 跳过
    if (isbnRaw) {
      let chk;
      try {
        chk = await api('/api/isbn/check?isbn=' + encodeURIComponent(isbnRaw));
      } catch (e) {
        doubanStatus.textContent = '';
        toast(e.message, true);
        return;
      }
      if (chk.valid) {
        const selfId = Number($('#bookId').value) || 0;
        if (chk.duplicate && chk.duplicate.id !== selfId) {
          doubanStatus.textContent = '';
          toast(`书库已有《${chk.duplicate.title}》(同一 ISBN),未自动填充`);
          return;
        }
        $('#fIsbn').value = chk.normalized;
        await fillFormByIsbn(chk.normalized);
        return;
      }
      if (!q) {
        doubanStatus.textContent = 'ISBN 不合法(位数或校验位不对),请检查后再试,或改用书名检索';
        return;
      }
      // ISBN 不合法但有书名:退回书名搜索,不打断用户
    }
    if (!q) {
      doubanStatus.textContent = '先填书名(或 ISBN)再检索';
      return;
    }
    doubanStatus.textContent = '正在检索豆瓣…';
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
        applyBookMeta(data.results[Number(btn.dataset.i)]);
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

/* ============ 按 ISBN 批量添加(对标 calibre Add from ISBN 对话框) ============
 * 行拆分与上限校验在服务端(core/isbn_import),前端只做即时提示与结果渲染。
 * 结果语义:created 已建档 / duplicate 库中或批内已有 / invalid 校验不过 /
 * not_found 两个源都没查到 / blocked 豆瓣拒绝 / error 网络异常。 */
const ISBN_BATCH_STATUS = {
  created: { cls: 'ok', label: '已添加' },
  duplicate: { cls: 'warn', label: '已存在' },
  invalid: { cls: 'err', label: '无效' },
  not_found: { cls: 'warn', label: '未找到' },
  blocked: { cls: 'err', label: '豆瓣拒绝' },
  error: { cls: 'err', label: '失败' },
};

function openIsbnBatchModal() {
  closeModals();
  $('#isbnBatchInput').value = '';
  $('#isbnBatchTags').value = '';
  $('#isbnBatchCheck').checked = true;
  $('#isbnBatchConvert').checked = false;
  $('#isbnBatchError').textContent = '';
  $('#isbnBatchResults').classList.add('hidden');
  $('#isbnBatchResults').innerHTML = '';
  const btn = $('#isbnBatchSubmit');
  btn.disabled = false;
  btn.textContent = '开始添加';
  openModal('#isbnBatchModal');
}

// 查不到的条目走「手动录入」:打开添加表单并预填 ISBN(calibre 此时建空标题
// 占位记录,本项目书名非空是硬约束,改为引导手动补全 —— 不制造垃圾数据)
async function startManualEntry(isbn) {
  closeModals();
  await openBookModal(null);
  if (isbn) {
    $('#fIsbn').value = isbn;
    doubanStatus.textContent = '元数据没有查到,ISBN 已预填,请手动补全书名等信息';
  }
}

function renderBatchResults(out) {
  const box = $('#isbnBatchResults');
  const rows = out.results.map((r) => {
    const st = ISBN_BATCH_STATUS[r.status] || ISBN_BATCH_STATUS.error;
    const main = r.status === 'created' ? `《${esc(r.title)}》`
      : (r.status === 'duplicate' && r.existing) ? `《${esc(r.existing.title)}》`
        : esc(r.error || '');
    const manual = (r.status === 'not_found' || r.status === 'blocked')
      ? `<button type="button" class="btn btn-ghost isbn-manual-btn" data-isbn="${esc(r.isbn)}">手动录入</button>`
      : '';
    const view = (r.status === 'duplicate' && r.existing)
      ? `<button type="button" class="isbn-view-btn" data-book-id="${r.existing.id}">查看</button>`
      : '';
    return `<div class="isbn-result-row isbn-result-${st.cls}">
      <span class="isbn-result-chip">${st.label}</span>
      <span class="isbn-result-main"><span class="isbn-result-code">${esc(r.isbn || r.input)}</span>${main}</span>
      ${manual}${view}
    </div>`;
  }).join('');
  const s = out.summary;
  box.innerHTML = `<p class="isbn-batch-summary">共 ${s.total} 条:新增 ${s.created} · 已存在 ${s.duplicate} · 无效 ${s.invalid} · 未找到 ${s.not_found}${s.blocked ? ' · 豆瓣拒绝 ' + s.blocked : ''}${s.error ? ' · 失败 ' + s.error : ''}</p>${rows}`;
  box.classList.remove('hidden');

  box.querySelectorAll('.isbn-manual-btn').forEach((btn) => {
    btn.addEventListener('click', () => startManualEntry(btn.dataset.isbn));
  });
  box.querySelectorAll('.isbn-view-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      closeModals();
      await openDetail(Number(btn.dataset.bookId));
    });
  });
}

$('#isbnBatchBtn').addEventListener('click', openIsbnBatchModal);

$('#isbnBatchSubmit').addEventListener('click', async () => {
  const errEl = $('#isbnBatchError');
  errEl.textContent = '';
  const entries = $('#isbnBatchInput').value.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!entries.length) {
    errEl.textContent = '请先粘贴或输入 ISBN 列表';
    return;
  }
  if (entries.length > 50) {
    errEl.textContent = `一次最多 50 个(当前 ${entries.length} 个),请分批添加`;
    return;
  }

  const btn = $('#isbnBatchSubmit');
  btn.disabled = true;
  btn.textContent = `正在添加 ${entries.length} 条…`;
  try {
    const data = await api('/api/books/from-isbn', {
      method: 'POST',
      body: JSON.stringify({
        isbns: entries,
        tags: $('#isbnBatchTags').value,
        check_existing: $('#isbnBatchCheck').checked,
        convert_to_13: $('#isbnBatchConvert').checked,
      }),
    });
    renderBatchResults(data);
    if (data.summary.created) {
      invalidateSharedStats();
      notifyBooksChanged();
    }
    toast(`已完成:新增 ${data.summary.created} 本`);
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始添加';
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
    // A3 系列:序号留空则传空串,服务端按"未指定"处理(不会存成 0 之外的值)
    series: $('#fSeries').value.trim(),
    series_index: $('#fSeriesIndex').value.trim(),
    // A5 标识符:isbn / douban_id 走上面的专用字段,其余类型在这里
    identifiers: collectIdRows(),
    // 自定义字段值(label → 字符串);服务端按 label 局部更新,
    // 空串表示"清空该字段"
    custom: collectCustomValues(),
  };

  const id = $('#bookId').value;
  const saveBtn = $('#saveBtn');
  saveBtn.disabled = true;
  try {
    if (id) {
      if (state.editPrecondition?.id === String(id)) {
        const { id: _bookId, ...condition } = state.editPrecondition;
        Object.assign(payload, condition);
      }
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

/* ============ 启动 ============ */
// bootReady:首屏数据备好的 Promise。自定义字段定义必须早于任何一次
// openBookModal 完成,否则编辑弹窗里 renderCustomFieldInputs 会拿到空数组
// (表现为"字段偶尔不显示")。用户操作可能早于首屏请求返回,先 await 再渲染。
const bootReady = (async () => {
  await loadCustomColumns();
  // 标签建议(datalist):编辑弹窗打开前备好,失败静默(不影响其它功能)
  sharedStats().then((data) => {
    if (!data) return;
    $('#tagSuggestions').innerHTML =
      data.topTags.map((t) => `<option value="${esc(t.tag)}">`).join('');
  });
  // A3:系列名建议(datalist),数据来自 /api/series;失败静默
  api('/api/series').then((list) => {
    const el = $('#seriesSuggestions');
    if (el && Array.isArray(list)) {
      el.innerHTML = list.map((s) => `<option value="${esc(s.name)}">`).join('');
    }
  }).catch(() => { /* 没系列或接口失败都不影响主流程 */ });
  // A5:标识符类型建议(常用类型;用户可以填任意类型)
  const idTypeEl = $('#idTypeSuggestions');
  if (idTypeEl) {
    idTypeEl.innerHTML = ID_TYPE_HINT.map((t) => `<option value="${esc(t)}">`).join('');
  }
})();
