/* ============================================================
 * 封面渲染原语(全站公共)
 * 依赖 base.js 的 esc;不依赖 api.js / common.js。
 * 加载顺序:chrome.js → base.js → api.js → cover.js → common.js → page-*.js
 * ============================================================ */

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
    return `<img src="${esc(coverSrc(url))}" alt="${esc(book.title)} 封面" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-ph="${esc(book.title)}" data-ph-author="${esc(book.author || '')}">`;
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
