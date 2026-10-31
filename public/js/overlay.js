/* ============================================================
 * 浮层原语(全站公共):移动端全屏菜单、全局搜索浮层、竖屏侧滑返回,
 * 以及 Escape 的分层关闭协调(弹窗 → 菜单 → 搜索 → 扫码)。
 * 依赖 base.js / api.js / cover.js / modal.js;加载顺序在 common.js 之前。
 * ============================================================ */

/* ============ 移动端全屏菜单 ============ */
const mobileMenu = $('#mobileMenu');
const menuBtn = $('#menuBtn');
const mmBackBtn = $('#mmBackBtn');
const mmSubPanels = $$('.mobile-menu-sub');
let menuClosingTimer = 0;
let mmSubTimer = 0;
let mmSubId = null;
let mmOpenDrop = null;   // { trigger, body }

/* 二级里的「按作者 / 按标签」是 apple.com 页脚式下拉按钮:
   点击后名单在按钮下方就地展开,不再压一层新面板。 */
const dropBodyFor = (trigger) => document.getElementById(trigger.getAttribute('aria-controls'));

function setMobileDrop(trigger, on) {
  const body = dropBodyFor(trigger);
  if (!body || (on && trigger.getAttribute('aria-expanded') === 'true')) return;
  if (on && mmOpenDrop && mmOpenDrop.trigger !== trigger) setMobileDrop(mmOpenDrop.trigger, false);
  const target = on ? body.scrollHeight : 0;
  trigger.setAttribute('aria-expanded', String(on));
  trigger.classList.toggle('is-open', on);
  body.classList.toggle('open', on);
  body.style.height = target + 'px';
  if (on) mmOpenDrop = { trigger, body };
  else if (mmOpenDrop && mmOpenDrop.trigger === trigger) mmOpenDrop = null;
  const anim = trigger.querySelector(on ? '[data-drop-expand]' : '[data-drop-collapse]');
  if (anim && anim.beginElement) anim.beginElement();
}

function closeMobileDrop(restoreFocus = false) {
  if (!mmOpenDrop) return false;
  const trigger = mmOpenDrop.trigger;
  setMobileDrop(trigger, false);
  if (restoreFocus) trigger.focus();
  return true;
}

/* 菜单整层关闭/切换二级时瞬时复位:内联高度清空、箭头动画归位。
   SMIL 的 fill="freeze" 会保留最后形状,endElement 才能退回向下箭头。 */
function resetMobileDrops() {
  document.querySelectorAll('.mm-drop-trigger').forEach((trigger) => {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('is-open');
    trigger.querySelectorAll('animate').forEach((a) => { if (a.endElement) a.endElement(); });
    const body = dropBodyFor(trigger);
    if (body) {
      body.classList.remove('open');
      body.style.height = '';
    }
  });
  mmOpenDrop = null;
}

// 名单异步到达时,展开中的名单按新内容重新定高
document.addEventListener('nav-flyout-refresh', () => {
  if (!mmOpenDrop) return;
  mmOpenDrop.body.style.height = mmOpenDrop.body.scrollHeight + 'px';
});

/* apple.com 移动端二级结构:一级列表保持不动,上层再压一层全屏面板。
   面板从 0 淡入 300ms;返回时淡出,主列表一直在下面,无需重播入场。 */
function openMobileSubmenu(id) {
  const pane = document.getElementById('mmSub-' + id);
  if (!pane || !mobileMenu.classList.contains('open')) return;
  resetMobileDrops();
  clearTimeout(mmSubTimer);
  mmSubPanels.forEach((p) => p.classList.toggle('open', p === pane));
  mmSubId = id;
  document.body.classList.add('mm-sub-open');
  // 二级面板盖住主列表时把它移出可访问树与 Tab 序;返回时恢复
  mobileMenu.setAttribute('aria-hidden', 'true');
  mobileMenu.inert = true;
  $$('#mobileMenu .mm-links button[data-sub]').forEach((b) => {
    b.setAttribute('aria-expanded', String(b.dataset.sub === id));
  });
  pane.focus();
}

function closeMobileSubmenu(restoreFocus = false) {
  if (!mmSubId) return false;
  resetMobileDrops();
  const id = mmSubId;
  mmSubId = null;
  const pane = document.getElementById('mmSub-' + id);
  const row = mobileMenu.querySelector(`.mm-links button[data-sub="${id}"]`);
  if (pane) pane.classList.remove('open');
  mobileMenu.removeAttribute('aria-hidden');
  mobileMenu.inert = false;
  if (row) {
    row.setAttribute('aria-expanded', 'false');
    if (restoreFocus) row.focus();
  }
  // 返回键随面板一起淡出(apple.com 实测),300ms 后再撤掉展开态
  clearTimeout(mmSubTimer);
  mmSubTimer = setTimeout(() => {
    if (!mmSubId) document.body.classList.remove('mm-sub-open');
  }, 300);
  return true;
}

// 整层菜单关闭/重开时瞬间复位二级面板与名单下拉,不参与收起动画
function resetMobileSubmenu() {
  resetMobileDrops();
  clearTimeout(mmSubTimer);
  mmSubId = null;
  mmSubPanels.forEach((p) => p.classList.remove('open'));
  $$('#mobileMenu .mm-links button[data-sub]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  mobileMenu.removeAttribute('aria-hidden');
  mobileMenu.inert = false;
  document.body.classList.remove('mm-sub-open');
}

/* apple.com 同款触发器:两条 18×18 折线先在中线会合、再交叉成 ✕。
   搜索展开时它同时充当搜索的 ✕(apple.com 也是同一个 menu trigger)。
   不支持 SMIL 的内核没有 beginElement,静默跳过 —— 面板本身照常开合。 */
function syncMenuTrigger() {
  const searching = isSearchOpen();
  const open = searching || mobileMenu.classList.contains('open');
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.setAttribute('aria-controls', searching ? 'searchFlyout' : 'mobileMenu');
  menuBtn.setAttribute('aria-label', open ? (searching ? '关闭搜索' : '关闭菜单') : '打开菜单');
}

function playMenuTrigger(open) {
  (open ? ['mmAnimTopOpen', 'mmAnimBottomOpen'] : ['mmAnimTopClose', 'mmAnimBottomClose']).forEach((id) => {
    const anim = document.getElementById(id);
    if (anim && anim.beginElement) anim.beginElement();
  });
  syncMenuTrigger();
}

function closeMobileMenu() {
  if (!mobileMenu.classList.contains('open')) return;
  resetMobileSubmenu();
  mobileMenu.classList.remove('open');
  // 关闭时条目保持可见,由面板收起把它们带出屏幕(apple.com 同款);
  // 收起动画(0.422s + 0.12s 延迟)结束后再让它们回到隐藏态
  mobileMenu.classList.add('closing');
  clearTimeout(menuClosingTimer);
  menuClosingTimer = setTimeout(() => mobileMenu.classList.remove('closing'), 600);
  document.body.classList.remove('menu-open', 'modal-open');
  playMenuTrigger(false);
}

function openMobileMenu() {
  closeSearchOverlay(false);
  resetMobileSubmenu();
  clearTimeout(menuClosingTimer);
  mobileMenu.classList.remove('closing');
  mobileMenu.classList.add('open');
  document.body.classList.add('menu-open', 'modal-open');
  playMenuTrigger(true);
  // 展开时把焦点移进对话框本身(原来是落在搜索框上;搜索已独立到顶栏)。
  // 焦点给容器而非第一个导航项:Tab 一下即进入「首页」,且容器不画聚焦描边,
  // 不依赖 :focus-visible 的输入模态启发式 —— 避免每次开菜单都闪一圈蓝框
  setTimeout(() => mobileMenu.focus(), 300);
}

$('#menuBtn').addEventListener('click', () => {
  // 搜索展开时这颗按钮是搜索的 ✕(apple.com 同款)
  if (isSearchOpen()) { closeSearchOverlay(true); return; }
  if (mobileMenu.classList.contains('open')) closeMobileMenu();
  else openMobileMenu();
});

/* 平板/手机转横屏跨到桌面导航宽度时,apple.com 会自动收起全屏菜单并切到桌面导航。
   否则汉堡与返回键都随窄屏规则隐藏,菜单会卡在全屏且无法滚动页面。 */
const desktopNavMq = window.matchMedia('(min-width: 820px)');
const closeMenuOnDesktop = (e) => { if (e.matches) closeMobileMenu(); };
if (desktopNavMq.addEventListener) desktopNavMq.addEventListener('change', closeMenuOnDesktop);
else desktopNavMq.addListener(closeMenuOnDesktop);

// 一级项:有二级面板的展开面板,普通链接直接跳转
$$('#mobileMenu .mm-links button[data-sub]').forEach((btn) => {
  btn.addEventListener('click', () => openMobileSubmenu(btn.dataset.sub));
});

// 二级里的「按作者 / 按标签」就地展开名单
$$('.mobile-menu-sub .mm-drop-trigger').forEach((btn) => {
  btn.addEventListener('click', () => setMobileDrop(btn, btn.getAttribute('aria-expanded') !== 'true'));
});

// 一级直链与二级面板内的链接都是真实跳转,点按后收起整层菜单
$$('#mobileMenu .mm-links a').forEach((a) => {
  a.addEventListener('click', closeMobileMenu);
});
$$('.mobile-menu-sub a').forEach((a) => {
  a.addEventListener('click', closeMobileMenu);
});

mmBackBtn.addEventListener('click', () => {
  if (closeMobileDrop(true)) return;
  closeMobileSubmenu(true);
});

/* ============ 全局搜索浮层(跨页,apple.com search 同款) ============
 * 桌面:点顶栏放大镜,#fafafc 面板自 44px 导航下方展开(240ms),
 *       输入框自动聚焦,页面蒙 20px 毛玻璃幕布。
 * 竖屏:同一面板自 48px 长到满屏(422ms),顶栏汉堡变形成 ✕ 关闭,
 *       页面滚动锁定,幕布 320ms(+80ms 延迟)淡出。
 * Quick Links 的位置换成「保存的搜索」(原始查询串 + 排序):
 *   · 点行 → 书架页直接套用并刷新;其它页跳到 /shelf?q=…&sort=…
 *   · 标题右侧「保存当前」把输入框里的查询存成一条;
 *     「编辑」进入管理态,行尾出现 ✎ / ✕。
 * 回车在书架页派发 shelf-search,其它页跳书架。 */
const SEARCH_SORT_TEXT = {
  updated: '最近更新', finish: '读完日期', title: '书名',
  author: '作者', series: '系列', created: '添加时间',
};

// apple.com Quick Links 行首的细箭头(9×16)
const SEARCH_ARROW_SVG = '<svg width="9" height="16" viewBox="0 0 9 16" aria-hidden="true"><path d="m8.6124 8.1035-2.99 2.99a.5.5 0 0 1-.7071-.7071l2.1366-2.1364h-6.316a.5.5 0 0 1 0-1h6.316l-2.1368-2.1367a.5.5 0 0 1 .7071-.7071l2.99 2.99a.5.5 0 0 1 .0002.7073z" fill="currentColor"></path></svg>';

const searchFlyout = $('#searchFlyout');
const searchCurtain = $('#searchCurtain');
const searchForm = $('#searchForm');
const searchInput = $('#searchInput');
const searchBtn = $('#searchBtn');
const searchResetBtn = $('#searchResetBtn');
const searchSavedList = $('#searchSavedList');
const searchEmpty = $('#searchEmpty');
const searchSaveBtn = $('#searchSaveBtn');
const searchEditBtn = $('#searchEditBtn');
const searchMq = window.matchMedia('(min-width: 820px)');

let savedItems = [];
let savedEditMode = false;
let searchCloseTimer = null;
let searchBlurTimer = null;
let searchNavTimer = null;

const isSearchOpen = () => searchFlyout.classList.contains('open');
const searchQuery = () => searchInput.value.trim();
const findSaved = (id) => savedItems.find((x) => String(x.id) === String(id));

function searchPanelHeight() {
  const scroll = searchFlyout.querySelector('.search-flyout-scroll');
  return Math.min(scroll.scrollHeight, window.innerHeight - 44);
}

function syncSearchHeight() {
  if (!isSearchOpen() || !searchMq.matches) return;
  searchFlyout.style.height = searchPanelHeight() + 'px';
}

// 保存 / 编辑按钮与空态文案随输入变化,不整表重绘
function syncSearchTools() {
  const q = searchQuery();
  const hasText = !!searchInput.value;
  searchResetBtn.hidden = !hasText;
  searchForm.classList.toggle('has-query', hasText);
  searchSaveBtn.hidden = !q;
  if (savedEditMode && !savedItems.length) savedEditMode = false;
  searchEditBtn.hidden = !savedItems.length;
  searchEditBtn.textContent = savedEditMode ? '完成' : '编辑';
  searchEmpty.hidden = savedItems.length > 0;
  if (!savedItems.length) {
    searchEmpty.textContent = q ? '还没有保存的搜索,可把当前查询保存下来' : '还没有保存的搜索';
  }
}

function renderSaved() {
  searchSavedList.innerHTML = savedItems.map((item, i) => {
    const sortText = item.sort && item.sort !== 'updated'
      ? '按' + (SEARCH_SORT_TEXT[item.sort] || item.sort)
      : '';
    const meta = [item.query || '', sortText].filter(Boolean).join(' · ');
    const isVl = !!item.is_virtual;
    const chip = isVl ? '<span class="saved-chip">书库</span>' : '';
    const applyTitle = isVl
      ? `套用虚拟书库「${item.name}」(整个书架视图收进去)`
      : `套用搜索「${item.name}」`;
    return `<li class="search-results-item" style="--i:${Math.min(i, 8)}"><div class="search-result-row" data-id="${item.id}">`
      + `<button type="button" class="search-result-link" data-act="apply" title="${esc(isVl ? applyTitle : meta)}">`
      + `<span class="search-result-icon" aria-hidden="true">${SEARCH_ARROW_SVG}</span>`
      + `<span class="search-result-name">${esc(item.name)}${chip}</span>`
      + '</button>'
      + `<span class="search-result-actions"${savedEditMode ? '' : ' hidden'}>`
      + `<button type="button" class="search-result-act${isVl ? ' is-on' : ''}" data-act="virtual" title="${isVl ? '取消虚拟书库' : '设为虚拟书库'}" aria-label="${isVl ? '取消虚拟书库' : '设为虚拟书库'}「${esc(item.name)}」" aria-pressed="${isVl ? 'true' : 'false'}">▣</button>`
      + `<button type="button" class="search-result-act" data-act="rename" title="重命名" aria-label="重命名「${esc(item.name)}」">✎</button>`
      + `<button type="button" class="search-result-act is-danger" data-act="del" title="删除" aria-label="删除「${esc(item.name)}」">✕</button>`
      + '</span></div></li>';
  }).join('');
  syncSearchTools();
  syncSearchHeight();
}

async function loadSavedSearches() {
  try {
    const list = await api('/api/saved-searches');
    savedItems = Array.isArray(list) ? list : [];
  } catch { savedItems = []; } // 拉取失败静默:不影响普通检索
  renderSaved();
}

function openSearchOverlay() {
  if (isSearchOpen()) return;
  closeMobileMenu();
  document.dispatchEvent(new Event('nav-flyout-close'));
  renderSaved();
  // 取消上一次关闭留下的滚动锁/失焦定时器,避免重开后被旧定时器打断
  clearTimeout(searchCloseTimer);
  clearTimeout(searchBlurTimer);
  clearTimeout(searchNavTimer);
  document.body.classList.remove('search-closing');
  searchFlyout.classList.add('open');
  document.body.classList.add('search-open');
  // 顶栏汉堡 → ✕;它压在搜索面板之上,点击即收起(apple.com 同款)
  playMenuTrigger(true);
  searchFlyout.setAttribute('aria-hidden', 'false');
  searchBtn.setAttribute('aria-expanded', 'true');
  if (searchMq.matches) {
    // 从 0 量到内容高度,由 CSS 的 240ms 过渡揭开
    searchFlyout.style.height = '0px';
    requestAnimationFrame(() => {
      if (isSearchOpen() && searchMq.matches) searchFlyout.style.height = searchPanelHeight() + 'px';
    });
  } else {
    searchFlyout.style.height = '';
  }
  // 仅精确指针(桌面)自动聚焦输入框;触屏设备(含横屏平板)不聚焦,
  // 避免一开搜索就弹软键盘 —— 与编辑弹窗的触屏判断保持一致
  setTimeout(() => {
    if (isSearchOpen() && searchMq.matches
        && !window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
      searchInput.focus({ preventScroll: true });
    }
  }, 30);
}

function closeSearchOverlay(restoreFocus) {
  if (!isSearchOpen()) return;
  const desktop = searchMq.matches;
  // 桌面端先把当前实际高度写成 inline,再切到 0:
  // 同帧清空 inline height 时,浏览器可能直接跳到终值,240ms 收起动画就丢了。
  if (desktop) {
    searchFlyout.style.height = searchFlyout.getBoundingClientRect().height + 'px';
    void searchFlyout.offsetHeight;
  }
  searchFlyout.classList.remove('open');
  document.body.classList.remove('search-open');
  // 退场期间继续锁住页面滚动(仅窄屏生效),避免面板还在时背景先滚动
  document.body.classList.add('search-closing');
  clearTimeout(searchCloseTimer);
  searchCloseTimer = setTimeout(() => document.body.classList.remove('search-closing'), 450);
  // ✕ 变回两条横杠(240ms);面板约 100ms 后先消失,幕布继续淡出
  playMenuTrigger(false);
  searchFlyout.setAttribute('aria-hidden', 'true');
  searchBtn.setAttribute('aria-expanded', 'false');
  if (desktop) searchFlyout.style.height = '0px';
  else searchFlyout.style.height = '';
  if (savedEditMode) {
    savedEditMode = false;
    renderSaved();
  }
  if (restoreFocus) {
    searchBtn.focus();
    // searchBtn 不可聚焦时焦点仍可能留在输入框,兜底收键盘
    if (document.activeElement === searchInput) searchInput.blur();
  } else {
    // 触屏点幕布/回车关闭时输入框可能仍有焦点:等面板退场再收键盘,
    // 否则移动端视口先缩,100ms 的收起节奏会被打乱。
    clearTimeout(searchBlurTimer);
    searchBlurTimer = setTimeout(() => {
      if (!isSearchOpen()) searchInput.blur();
    }, 160);
  }
}

// 从其它页搜索要跳书架:等浮层退场再导航,否则关闭动画会被页面卸载直接吞掉
function navigateAfterSearchClose(url) {
  clearTimeout(searchNavTimer);
  searchNavTimer = setTimeout(() => { location.href = url; }, searchMq.matches ? 260 : 140);
}

function submitSearch() {
  const q = searchQuery();
  const onShelf = document.body.dataset.page === 'shelf';
  closeSearchOverlay(false);
  closeMobileMenu();
  if (onShelf) {
    document.dispatchEvent(new CustomEvent('shelf-search', { detail: { q } }));
  } else if (q) {
    navigateAfterSearchClose('/shelf?q=' + encodeURIComponent(q));
  }
}

function applySavedSearch(item) {
  // 虚拟书库:整个视图收进去(不带 q);普通保存搜索:套用查询串
  const isVl = !!item.is_virtual;
  const q = isVl ? '' : (item.query || '');
  const vl = isVl ? item.name : '';
  const sort = item.sort || 'updated';
  searchInput.value = q;
  syncSearchTools();
  closeSearchOverlay(false);
  if (document.body.dataset.page === 'shelf') {
    document.dispatchEvent(new CustomEvent('saved-search-apply', { detail: { q, sort, vl } }));
    return;
  }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (vl) params.set('vl', vl);
  if (sort && sort !== 'updated') params.set('sort', sort);
  navigateAfterSearchClose('/shelf' + (params.toString() ? '?' + params.toString() : ''));
}

searchBtn.addEventListener('click', () => {
  if (isSearchOpen()) closeSearchOverlay(true);
  else openSearchOverlay();
});
searchCurtain.addEventListener('click', () => closeSearchOverlay(false));
searchForm.addEventListener('submit', (e) => { e.preventDefault(); submitSearch(); });
searchInput.addEventListener('input', syncSearchTools);
searchInput.addEventListener('keydown', (e) => {
  // 显式提交:type=search 的原生隐式提交在部分输入法/虚拟键盘下不触发
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    submitSearch();
    return;
  }
  if (e.key !== 'ArrowDown' || !savedItems.length) return;
  e.preventDefault();
  const first = searchSavedList.querySelector('button[data-act="apply"]');
  if (first) first.focus();
});
searchResetBtn.addEventListener('click', () => {
  const hadText = !!searchInput.value;
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  // 叉号不仅清空草稿,也取消已经生效的检索(书架回到未检索状态)
  if (hadText) document.dispatchEvent(new Event('search-cancel'));
  searchInput.focus();
});
$('#searchSyntaxBtn').addEventListener('click', () => openModal('#syntaxModal'));
$$('#bookForm [data-form-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.formToggle;
    const body = document.querySelector(`#bookForm [data-form-content="${name}"]`);
    if (body) setBookFormSection(name, body.hidden);
  });
});

searchSavedList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.search-result-row');
  const item = row && findSaved(row.dataset.id);
  if (!item) return;
  if (btn.dataset.act === 'apply') {
    applySavedSearch(item);
    return;
  }
  try {
    if (btn.dataset.act === 'rename') {
      const name = prompt('重命名该保存的搜索:', item.name);
      if (name === null || !name.trim()) return;
      const res = await api('/api/saved-searches/' + item.id, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
      savedItems = Array.isArray(res.items) ? res.items : savedItems;
      renderSaved();
      toast('已重命名');
    } else if (btn.dataset.act === 'virtual') {
      const res = await api('/api/saved-searches/' + item.id, {
        method: 'PUT', body: JSON.stringify({ isVirtual: !item.is_virtual }),
      });
      savedItems = Array.isArray(res.items) ? res.items : savedItems;
      renderSaved();
      toast(item.is_virtual ? '已取消虚拟书库' : '已设为虚拟书库,在搜索面板点它即可切换书架视图');
    } else if (btn.dataset.act === 'del') {
      if (!confirm(`删除保存的搜索「${item.name}」?`)) return;
      const res = await api('/api/saved-searches/' + item.id, { method: 'DELETE' });
      savedItems = Array.isArray(res.items) ? res.items : savedItems;
      renderSaved();
      toast('已删除');
    }
    // 改名 / 取消 / 删除都可能让书架正在用的 ?vl= 失效,通知它重新对齐作用域
    document.dispatchEvent(new Event('virtual-libraries-changed'));
  } catch (err) { toast(err.message, true); }
});

searchEditBtn.addEventListener('click', () => {
  savedEditMode = !savedEditMode;
  renderSaved();
  if (savedEditMode) {
    const firstAct = searchSavedList.querySelector('.search-result-act');
    if (firstAct) firstAct.focus();
  }
});

searchSaveBtn.addEventListener('click', async () => {
  const q = searchQuery();
  if (!q) return;
  const name = prompt('为当前搜索命名(保存后可一键套用):', q.slice(0, 20));
  if (name === null || !name.trim()) return;
  // 旧页面用 #sortSelect,书架工作区用 #wbSort;保存时不能只认前者。
  const sortSel = $('#sortSelect') || $('#wbSort');
  const sort = sortSel && sortSel.value ? sortSel.value : 'updated';
  try {
    const res = await api('/api/saved-searches', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), query: q, sort }),
    });
    savedItems = Array.isArray(res.items) ? res.items : savedItems;
    renderSaved();
    toast('已保存该搜索');
  } catch (err) { toast(err.message, true); }
});

document.addEventListener('pointerdown', (e) => {
  if (!isSearchOpen()) return;
  // #menuBtn 在搜索展开时就是 ✕,由它的 click 负责关闭,不能当成"面板外点击";
  // 语法说明弹窗盖在搜索之上,点它也不能顺带收起搜索
  if (e.target.closest('#searchFlyout') || e.target.closest('#searchBtn') || e.target.closest('#menuBtn') || e.target.closest('.modal')) return;
  closeSearchOverlay(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isSearchOpen()) {
    e.preventDefault();
    closeSearchOverlay(true);
  }
});

document.addEventListener('nav-flyout-open', () => closeSearchOverlay(false));

window.addEventListener('resize', () => {
  if (!isSearchOpen()) return;
  if (searchMq.matches) syncSearchHeight();
  else searchFlyout.style.height = '';
});

loadSavedSearches();

$('#addBtn').addEventListener('click', () => openBookModal(null));

/* ============ 竖屏侧滑返回 ============
 * 从左边缘向右滑 → 返回上一级。多页后层级更简单:
 * 先收浮层(弹窗 → 全屏菜单 → 搜索栏 → 自定义下拉),
 * 再走页面层级:心得页 → 历史回退,其它非首页 → 回首页。
 * 仅在竖屏/窄屏(≤819px,与全站断点一致)启用,横屏保持桌面行为。 */
function goBack() {
  // 0. 扫码浮层(scanner.js 自建 DOM,不是 .modal;相机在跑,优先关掉)
  if (window.BookScanner && BookScanner.isOpen()) { BookScanner.close(); return true; }
  // 1. 任何浮层弹窗
  if ($$('.modal').some((m) => !m.classList.contains('hidden'))) { closeModals(); return true; }
  // 2. 移动端全屏菜单(名单下拉 → 二级 → 主菜单逐级退出,再退一级才收起整层)
  if (closeMobileDrop(true)) return true;
  if (closeMobileSubmenu(true)) return true;
  if (mobileMenu.classList.contains('open')) { closeMobileMenu(); return true; }
  // 3. 全局搜索浮层
  if (isSearchOpen()) { closeSearchOverlay(true); return true; }
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // 扫码浮层开着时,Escape 只关它(scanner.js 自己处理);
    // 否则一次 Esc 会把下层表单一起关掉 —— 与 goBack 的逐层退出一致
    if (window.BookScanner && BookScanner.isOpen()) return;
    const hadModal = !!document.querySelector('.modal:not(.hidden)');
    // 栈顶弹窗吃掉这次 Esc,下层搜索浮层/菜单不能同时关闭
    if (hadModal) {
      closeModals();
      closeMobileMenu();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // 名单下拉 → 二级 → 主菜单逐级退出,最后才收起整层
    if (!closeMobileDrop(true) && !closeMobileSubmenu(true)) closeMobileMenu();
  }
});

