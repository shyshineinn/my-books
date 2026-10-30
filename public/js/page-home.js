/* ============================================================
 * 首页(/) —— Apple 式展示页
 * 逻辑自旧单页 app.js 拆出:英雄区 + 主推 + 书格 + Endless entertainment 画廊。
 * 封面取色管线(extractDominantColor/derivePalette)只有首页卡片用,随本页走。
 * ============================================================ */

/* ---------- 首页文案辅助 ---------- */
/* 首页展示框内不再出现「已读」标签:读完的书用"读过 N 次"等信息代替 */
function homeStatusLabel(b) {
  return b.status === 'done' ? '' : (STATUS_LABEL[b.status] || '');
}

/* ---------- 封面取色:卡片背景根据封面真实颜色渲染 ---------- */
// 外链封面经服务端代理转成同源图片(规避 Canvas 跨域限制与防盗链),本站 /uploads 直接用
// (与 coverSrc 同一策略,统一复用避免两处逻辑漂移)
const imgSampleUrl = coverSrc;

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

/* ---------- Endless entertainment 画廊常量与模板 ---------- */
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

/* ---------- 主推 / 书格卡片 ---------- */
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
        <a class="home-link" href="/notes/${b.id}">读书心得 ›</a>
        <button type="button" class="home-link" data-open-detail="${b.id}">查看详情 ›</button>
      </div>
      <div class="home-cover" data-open-detail="${b.id}" role="button" tabindex="0" aria-label="查看《${esc(b.title)}》详情">${coverHtml(b)}</div>
    </section>`;
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
        <a class="home-link" href="/notes/${b.id}">读书心得 ›</a>
        <button type="button" class="home-link" data-open-detail="${b.id}">详情 ›</button>
      </div>
      <div class="tile-cover" data-open-detail="${b.id}" role="button" tabindex="0" aria-label="查看《${esc(b.title)}》详情">${coverHtml(b)}</div>
    </div>`;
}

/* ---------- 渲染与数据 ---------- */
function renderHome(feed = {}) {
  const root = $('#homeContent');
  if (!root) return;

  // 选取规则已下推到 /api/home/feed:这里只负责把 featured/grid/gallery 画出来
  const featured = feed.featured || null;
  const gridBooks = Array.isArray(feed.grid) ? feed.grid : [];
  const gallery = Array.isArray(feed.gallery) ? feed.gallery : [];
  // 两排分配:按比例切分(见 splitBigCount)。小卡凑不满一排时整排不渲染,书全在大卡里
  const entPrimary = gallery.slice(0, splitBigCount(gallery.length));
  const entSecondary = gallery.slice(entPrimary.length);

  root.innerHTML = `
    <div class="home-hero">
      <div class="home-eyebrow">My books</div>
      <h1>每一本读过的书,<br>都值得被好好安放。</h1>
      <p class="home-sub">心得与收藏,从一个书架开始。</p>
      <div class="home-cta-row">
        <a class="btn btn-primary" href="/shelf">浏览书架</a>
        <a class="btn btn-ghost" href="/stats">查看统计</a>
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

        <!-- 第一排:大卡 / 第二排:小卡 —— 共用索引,一起轮播;dotnav 在两排之后(apple 顺序) -->
        <div class="media-gallery tv-media-gallery" role="group" aria-label="正在读与最近读完">
          <ul class="media-gallery-item-container" role="list" tabindex="0" aria-label="精选书,用左右方向键切换">
            ${entPrimary.map(entItemHtml).join('')}
          </ul>
        </div>
        ${entSecondary.length >= ENT_FAM_MIN ? `
        <div class="media-gallery fam-media-gallery" role="group" aria-label="书架上的其他书" aria-hidden="true">
          <ul class="media-gallery-item-container" role="list">
            ${entSecondary.map(entSmallHtml).join('')}
          </ul>
        </div>` : ''}
        ${entDotnavHtml(entPrimary.length)}
      </div>
    </section>` : ''}
  `;

  mountEndlessGallery();
  applyCoverTints();
}

async function fetchHome() {
  try {
    renderHome(await api(`/api/home/feed?grid=${GRID_MAX}&ent=${ENT_LIMIT}`));
  } catch { /* 静默:首页保持上次内容 */ }
}

// 首页交互:详情走弹窗(事件委托);心得/CTA 已是真实链接,交给浏览器导航
$('#homeContent').addEventListener('click', (e) => {
  const detail = e.target.closest('[data-open-detail]');
  if (detail) openDetail(Number(detail.dataset.openDetail));
});
$('#homeContent').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest('[data-open-detail]');
  if (t) { e.preventDefault(); openDetail(Number(t.dataset.openDetail)); }
});

// 本页数据变更(弹窗保存/删除)后刷新
document.addEventListener('books-changed', fetchHome);

fetchHome();
