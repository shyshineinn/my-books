/* ============================================================
 * 自定义下拉原语(全站公共)
 * 接管原生 <select> 的展开面板,保持 select 为唯一数据源。
 * 依赖 base.js($/$$/esc);加载顺序在 common.js 之前。
 * ============================================================ */

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
  menu.dataset.glass = 'refract';
  trigger.dataset.glass = select.dataset.glassTrigger || 'frost';

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

  // 把浮层面板修正到视口内(窄屏必需)。
  // 面板是 `right:0` 且 min-width:100%,比触发按钮宽 —— 在 320px 上会向左
  // 溢出屏幕(实测:159px 的面板挂在 103px 按钮上,左边超出 38px,选项点不到)。
  // 做法:先清掉上次的位移,量出真实边界,再按需横向平移;仍放不下时交给
  // CSS 的 max-width 兜底换行/省略。
  function fitMenuToViewport() {
    menu.style.transform = '';
    const b = menu.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const pad = 12;                      // 与屏幕边缘留出的呼吸位
    let dx = 0;
    if (b.right > vw - pad) dx = (vw - pad) - b.right;   // 右边出去了:左移
    if (b.left + dx < pad) dx = pad - b.left;            // 左边仍出去了:右移
    if (dx) menu.style.transform = `translateX(${Math.round(dx)}px)`;
  }

  function open() {
    customSelects.forEach((r) => { if (r.wrap !== wrap) r.close(); });  // 同时只开一个
    build();
    markSelected();
    syncLabel();
    menu.hidden = false;
    wrap.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    fitMenuToViewport();                 // 显示后立刻校正(读取布局会强制回流)
    const list = opts();
    highlight(Math.max(0, list.findIndex((el) => el.classList.contains('on'))));
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDocDown, true);
  }

  function close() {
    if (!isOpen()) return;
    menu.hidden = true;
    menu.style.transform = '';           // 复位,避免下次在其他位置打开时带着旧位移
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
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      trigger.focus();
      return;
    }
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
