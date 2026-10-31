/* ============================================================
 * 基础 DOM / 格式化原语(全站公共)
 * 不依赖 api.js 或 common.js,供所有页面脚本直接使用。
 * 加载顺序:chrome.js → base.js → api.js → cover.js → common.js → page-*.js
 * ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STATUS_LABEL = { wish: '想读', reading: '在读', done: '已读' };

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

// 文件大小展示:字节 → KB / MB
function fileSizeText(bytes) {
  const kb = Math.max(1, Math.round((bytes || 0) / 1024));
  return kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
}
