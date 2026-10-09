/* ============================================================
 * 我的书房 · 前端(原生 ES module,零构建)
 *
 * 数据来源(双数据库):
 *   · 书是什么   → /api/calibre/books   (Node 转发 calibre)
 *   · 我读得怎样 → 同一响应里的 reading 字段(Node 查 reading.db 后 join)
 *
 * 设计取舍:
 *   · 零构建:与本项目既有前端一致(无打包器、无 node_modules 运行时依赖),
 *     部署就是静态文件,配合 ?v= 缓存戳即可。
 *   · 不用框架:页面规模小,原生够用;避免为一个书架引入构建链。
 *   · 状态集中在一个 store,渲染函数纯读 store —— 便于后续换框架时平移。
 * ============================================================ */

const API = '/api';

/* ---------- 极简状态 ---------- */
const store = {
  view: 'books',        // books | stats
  status: '',           // '' | wish | reading | done
  q: '',
  books: [],
  total: 0,
  loading: false,
  error: null,
};

/* ---------- 工具 ---------- */

// 所有插值都过 esc(),防 XSS(calibre 的 comments 是 HTML,展示时另行处理)
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const STATUS_LABEL = { wish: '想读', reading: '在读', done: '已读' };

async function api(path, opts) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

function fmtDate(s) {
  if (!s) return '';
  return String(s).slice(0, 10);
}

/* 阅读记录摘要:已读 → 读完日期;在读 → 开始日期;想读 → 空 */
function readingBadge(reading) {
  if (!reading) return '';
  const { status, finish_date, start_date, read_count } = reading;
  if (status === 'done') {
    const d = fmtDate(finish_date);
    const times = read_count > 1 ? ` · 读过 ${read_count} 遍` : '';
    return d ? `${d} 读完${times}` : `已读${times}`;
  }
  if (status === 'reading') {
    const d = fmtDate(start_date);
    return d ? `${d} 起在读` : '在读';
  }
  return '';
}

/* ---------- 渲染 ---------- */

const $view = document.getElementById('view');

function renderBookCard(b) {
  const r = b.reading || {};
  const status = r.status || 'wish';
  const badge = readingBadge(r);
  // 封面用缩略图接口;加载失败时退化为占位
  const cover = b.thumb_url
    ? `<img class="cover" src="${esc(b.thumb_url)}" alt="" loading="lazy"
             onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover cover-empty',textContent:'${esc((b.title || '?')[0])}'}))">`
    : `<div class="cover cover-empty">${esc((b.title || '?')[0])}</div>`;

  return `
    <article class="card" data-uuid="${esc(b.uuid || '')}" data-id="${esc(b.id)}" tabindex="0" role="button">
      <div class="card-cover">
        ${cover}
        <span class="pip pip-${esc(status)}" title="${esc(STATUS_LABEL[status] || '')}"></span>
      </div>
      <div class="card-body">
        <h3 class="card-title" title="${esc(b.title)}">${esc(b.title)}</h3>
        <p class="card-author">${esc(b.author || '佚名')}</p>
        ${badge ? `<p class="card-badge">${esc(badge)}</p>` : ''}
        ${b.formats && b.formats.length
          ? `<p class="card-formats">${b.formats.map((f) => `<span class="fmt">${esc(f)}</span>`).join('')}</p>`
          : ''}
      </div>
    </article>
  `;
}

function renderBooks() {
  if (store.loading) { $view.innerHTML = '<div class="loading">加载中…</div>'; return; }

  if (store.error) {
    $view.innerHTML = `
      <div class="error-box">
        <h2>读不到数据</h2>
        <p>${esc(store.error)}</p>
        <p class="hint">若提示 calibre 后端不可用,请在服务器上确认:
          <code>systemctl status calibre-server</code></p>
        <button class="btn" id="retry">重试</button>
      </div>`;
    document.getElementById('retry')?.addEventListener('click', () => loadBooks());
    return;
  }

  if (!store.books.length) {
    $view.innerHTML = `<div class="empty">
      <h2>还没有书</h2>
      <p>在 calibre 里添加书籍后,这里就会出现。</p>
      <p class="hint">命令行:<code>calibredb add 某本书.epub --library-path /root/calibre-library</code></p>
    </div>`;
    return;
  }

  $view.innerHTML = `
    <div class="shelf-head">
      <span class="count">共 ${store.total} 本${store.status ? ` · 筛选:${esc(STATUS_LABEL[store.status])}` : ''}</span>
    </div>
    <div class="grid">${store.books.map(renderBookCard).join('')}</div>
  `;
}

async function renderStats() {
  $view.innerHTML = '<div class="loading">统计中…</div>';
  try {
    const s = await api('/calibre/stats');
    const years = Object.entries(s.byYear || {}).sort((a, b) => a[0].localeCompare(b[0]));
    const maxYear = Math.max(1, ...years.map(([, n]) => n));

    // 重读榜要显示书名:用本地已加载的 books 做映射(已加载则直接可用)
    const titleOf = (uuid) => {
      const hit = store.books.find((b) => b.uuid === uuid);
      return hit ? hit.title : uuid.slice(0, 8) + '…';
    };

    $view.innerHTML = `
      <div class="stats">
        <h2 class="stats-title">阅读统计</h2>

        <div class="stat-row">
          <div class="stat"><b>${s.total}</b><span>总藏书</span></div>
          <div class="stat"><b>${s.byStatus.done || 0}</b><span>已读</span></div>
          <div class="stat"><b>${s.byStatus.reading || 0}</b><span>在读</span></div>
          <div class="stat"><b>${s.byStatus.wish || 0}</b><span>想读</span></div>
        </div>

        <section class="panel">
          <h3>每年读完</h3>
          ${years.length ? `<div class="bars">${years.map(([y, n]) => `
            <div class="bar-row">
              <span class="bar-label">${esc(y)}</span>
              <span class="bar" style="width:${(n / maxYear) * 100}%"></span>
              <span class="bar-num">${n}</span>
            </div>`).join('')}</div>`
          : '<p class="muted">还没有读完的书</p>'}
        </section>

        <section class="panel">
          <h3>重读榜</h3>
          ${(s.rereads || []).length ? `<ol class="rereads">${s.rereads.slice(0, 10).map((r) => `
            <li><span class="rr-title">${esc(titleOf(r.calibre_uuid))}</span>
                <span class="rr-count">${r.read_count} 遍</span></li>`).join('')}</ol>`
          : '<p class="muted">还没有读过两遍以上的书</p>'}
        </section>

        <section class="panel">
          <h3>标签分布</h3>
          ${(s.topTags || []).length ? `<div class="tagcloud">${s.topTags.map((t) => `
            <span class="tagchip">${esc(t.tag)}<i>${t.count}</i></span>`).join('')}</div>`
          : '<p class="muted">没有标签</p>'}
        </section>
      </div>`;
  } catch (err) {
    $view.innerHTML = `<div class="error-box"><h2>统计失败</h2><p>${esc(err.message)}</p></div>`;
  }
}

/* ---------- 详情抽屉(阅读记录的编辑入口) ---------- */

const $drawer = document.getElementById('drawer');
const $backdrop = document.getElementById('drawer-backdrop');

function closeDrawer() {
  $drawer.hidden = true;
  $backdrop.hidden = true;
}

async function openDrawer(uuid) {
  $backdrop.hidden = false;
  $drawer.hidden = false;
  $drawer.innerHTML = '<div class="loading">加载中…</div>';

  try {
    const { book } = await api(`/calibre/books/${encodeURIComponent(uuid)}`);
    const r = book.reading || {};
    const logs = Array.isArray(r.read_logs) ? r.read_logs : [];

    $drawer.innerHTML = `
      <button class="drawer-close" id="drawer-close" aria-label="关闭">×</button>
      <div class="detail-head">
        <img class="detail-cover" src="${esc(book.thumb_url)}" alt=""
             onerror="this.style.visibility='hidden'">
        <div class="detail-meta">
          <h2>${esc(book.title)}</h2>
          <p class="muted">${esc(book.author || '佚名')}</p>
          ${book.publisher ? `<p class="muted small">${esc(book.publisher)}</p>` : ''}
          ${book.formats.length ? `<p class="formats">${book.formats.map((f) => `<span class="fmt">${esc(f)}</span>`).join('')}</p>` : ''}
          ${book.id ? `<a class="btn btn-primary" href="/calibre/#book_id=${esc(book.id)}&fmt=${esc((book.formats[0] || 'EPUB').toLowerCase())}&mode=read_book" target="_blank" rel="noopener">在 calibre 中阅读 ↗</a>` : ''}
        </div>
      </div>

      <section class="edit-block">
        <h3>阅读状态</h3>
        <div class="seg" id="seg-status" role="group">
          ${['wish', 'reading', 'done'].map((s) => `
            <button class="seg-btn ${(r.status || 'wish') === s ? 'is-on' : ''}" data-status="${s}">
              ${STATUS_LABEL[s]}
            </button>`).join('')}
        </div>
      </section>

      <section class="edit-block">
        <h3>阅读记录 <small class="muted">(日期与次数由记录自动推导)</small></h3>
        <div id="logs">${logs.map(logRow).join('') || '<p class="muted">暂无记录</p>'}</div>
        <button class="btn btn-ghost" id="add-log">+ 添加一次阅读</button>
      </section>

      <section class="edit-block">
        <h3>心得链接</h3>
        <input class="input" id="notes-url" type="text" value="${esc(r.notes_url || '')}"
               placeholder="GitHub 上的 markdown 链接,留空则按书名自动匹配">
      </section>

      <div class="drawer-actions">
        <button class="btn btn-primary" id="save-reading">保存</button>
        <span class="save-hint" id="save-hint"></span>
      </div>

      ${book.comments ? `<section class="edit-block"><h3>简介</h3>
        <div class="comments">${book.comments}</div></section>` : ''}
    `;

    // —— 交互 ——
    document.getElementById('drawer-close').addEventListener('click', closeDrawer);

    $drawer.querySelectorAll('#seg-status .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $drawer.querySelectorAll('#seg-status .seg-btn').forEach((b) => b.classList.remove('is-on'));
        btn.classList.add('is-on');
      });
    });

    document.getElementById('add-log').addEventListener('click', () => {
      const wrap = document.getElementById('logs');
      if (wrap.querySelector('.muted')) wrap.innerHTML = '';
      wrap.insertAdjacentHTML('beforeend', logRow({ start: '', finish: '' }));
    });

    $drawer.addEventListener('click', (e) => {
      const del = e.target.closest('.log-del');
      if (del) del.closest('.log-row').remove();
    });

    document.getElementById('save-reading').addEventListener('click', async () => {
      const hint = document.getElementById('save-hint');
      const status = $drawer.querySelector('#seg-status .seg-btn.is-on').dataset.status;
      const readLogs = [...$drawer.querySelectorAll('.log-row')].map((row) => ({
        start: row.querySelector('.log-start').value.trim(),
        finish: row.querySelector('.log-finish').value.trim(),
      })).filter((l) => l.start || l.finish);
      const notes_url = document.getElementById('notes-url').value.trim();

      hint.textContent = '保存中…';
      try {
        await api(`/reading/${encodeURIComponent(uuid)}`, {
          method: 'PUT',
          body: JSON.stringify({ status, read_logs: readLogs, notes_url }),
        });
        hint.textContent = '已保存 ✓';
        setTimeout(() => { hint.textContent = ''; }, 2000);
        // 同步列表上的状态点与徽标
        const idx = store.books.findIndex((b) => b.uuid === uuid);
        if (idx >= 0) {
          const saved = await api(`/reading/${encodeURIComponent(uuid)}`);
          store.books[idx].reading = saved.reading;
          renderBooks();
        }
      } catch (err) {
        hint.textContent = '保存失败:' + err.message;
      }
    });
  } catch (err) {
    $drawer.innerHTML = `<div class="error-box"><h2>加载失败</h2><p>${esc(err.message)}</p></div>`;
  }
}

function logRow(log = {}) {
  return `
    <div class="log-row">
      <input class="input log-start" type="date" value="${esc(fmtDate(log.start))}" aria-label="开始日期">
      <span class="log-arrow">→</span>
      <input class="input log-finish" type="date" value="${esc(fmtDate(log.finish))}" aria-label="读完日期">
      <button class="log-del" type="button" title="删除这条记录" aria-label="删除">×</button>
    </div>`;
}

/* ---------- 数据加载 ---------- */

async function loadBooks() {
  store.loading = true;
  store.error = null;
  renderBooks();

  const params = new URLSearchParams({ num: '100', sort: 'title' });
  if (store.q) params.set('q', store.q);
  if (store.status) params.set('status', store.status);

  try {
    const data = await api('/calibre/books?' + params);
    store.books = data.books || [];
    store.total = data.total || store.books.length;
  } catch (err) {
    store.error = err.message;
  } finally {
    store.loading = false;
    renderBooks();
  }
}

/* ---------- 路由(hash) ---------- */

function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/stats')) {
    store.view = 'stats';
    document.getElementById('tabs').style.visibility = 'hidden';
    renderStats();
    return;
  }
  store.view = 'books';
  document.getElementById('tabs').style.visibility = '';
  loadBooks();
}

/* ---------- 事件绑定 ---------- */

document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
  store.status = tab.dataset.status || '';
  loadBooks();
});

let searchTimer = null;
document.getElementById('search-form').addEventListener('submit', (e) => e.preventDefault());
document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value.trim();
  searchTimer = setTimeout(() => { store.q = v; loadBooks(); }, 300);
});

$view.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card && card.dataset.uuid) openDrawer(card.dataset.uuid);
});
$view.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const card = e.target.closest('.card');
  if (card && card.dataset.uuid) openDrawer(card.dataset.uuid);
});

$backdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

window.addEventListener('hashchange', route);
route();
