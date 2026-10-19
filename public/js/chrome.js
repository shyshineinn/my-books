/* ============================================================
 * 全站外壳(Chrome):顶栏 / 移动端菜单 / 三个弹窗 / Toast / 页脚
 *
 * 为什么用 JS 注入,而不是每个页面各写一份 HTML:
 *   拆成多页后,首页 / 书架 / 榜单 / 统计 / 心得 五个文档共用同一套
 *   导航与弹窗(添加编辑、详情、设置)。写进 HTML 就是五份副本,
 *   改一处要同步五处 —— 本项目已被 ?v= 版本号这类"手工同步"坑过。
 *   单一来源的代价是"没有 JS 就没有导航",而页面内容本来就全靠 JS
 *   渲染(书架/榜单/统计都是接口数据),这个代价与现状一致。
 *
 * 加载约定(defer 保证顺序,均在 DOM 解析完成后执行):
 *   chrome.js → common.js → page-<name>.js
 *   本文件把外壳补进 body:header 插到最前(保持 Tab 顺序),
 *   弹窗/菜单/Toast/页脚追加到最后。页面 HTML 只写自己的 <main>。
 *
 * body 上的 data-page 决定导航高亮(aria-current="page")。
 * ============================================================ */

/* 旧版单页深链兼容:#/notes/<id>、#/rank 曾写在首页 URL 上,
 * 现在是一级页面 —— 用 replace 跳转,不留历史记录,老书签/分享链接照常可用。
 * 放在本文件最前:先于任何渲染,避免旧链接用户看到一闪而过的首页。 */
(function legacyHashRedirect() {
  const notes = location.hash.match(/^#\/notes\/(\d+)/);
  if (notes && /^\/(index\.html)?$/.test(location.pathname)) {
    location.replace('/notes/' + notes[1]);
    return;
  }
  if (location.hash === '#/rank' && /^\/(index\.html)?$/.test(location.pathname)) {
    location.replace('/rank');
  }
})();

const NAV_ITEMS = [
  { id: 'home', label: '首页', href: '/' },
  { id: 'shelf', label: '书架', href: '/shelf' },
  { id: 'rank', label: '榜单', href: '/rank' },
  { id: 'stats', label: '统计', href: '/stats' },
  { id: 'tags', label: '分类', href: '/tags' },
];

/* 桌面端下拉菜单:apple.com 的 globalnav flyout。
 * 结构 = 一个「主列」(24px/600 大链接)+ 若干「次列」(12px/600 小链接),
 * 列内按内容宽度排布,主列右侧留 88px、次列留 44px。 */
const NAV_MENUS = {
  shelf: [
    { heading: '浏览书架', elevated: true, links: [
      { label: '全部书籍', href: '/shelf' },
      { label: '想读', href: '/shelf?status=wish' },
      { label: '在读', href: '/shelf?status=reading' },
      { label: '已读', href: '/shelf?status=done' },
    ] },
    { heading: '排序', links: [
      { label: '最近更新', href: '/shelf?sort=updated' },
      { label: '最近读完', href: '/shelf?status=done&amp;sort=finish' },
      { label: '最近添加', href: '/shelf?sort=created' },
    ] },
    // submenu = 桌面第三级浮层(按作者 / 按标签),名单与「分类」下拉共用同一份接口数据
    { heading: '筛选', links: [
      { label: '按作者', submenu: 'authors' },
      { label: '按标签', submenu: 'tags' },
    ] },
    { heading: '更多', links: [
      { label: '分类管理', href: '/tags' },
      { label: '阅读心得', href: '/notes' },
    ] },
  ],
  rank: [
    { heading: '榜单', elevated: true, links: [
      { label: '重读榜', href: '/rank' },
      { label: '最近读完', href: '/shelf?status=done&amp;sort=finish' },
      { label: '最近添加', href: '/shelf?sort=created' },
    ] },
    { heading: '书架', links: [
      { label: '全部书籍', href: '/shelf' },
      { label: '在读', href: '/shelf?status=reading' },
      { label: '想读', href: '/shelf?status=wish' },
    ] },
    { heading: '记录', links: [
      { label: '已读', href: '/shelf?status=done' },
      { label: '阅读心得', href: '/notes' },
    ] },
  ],
  stats: [
    { heading: '阅读统计', elevated: true, links: [
      { label: '阅读总览', href: '/stats' },
      { label: '每年读完', href: '/stats#yearPanel' },
      { label: '作者排行', href: '/stats#authorPanel' },
      { label: '出版社排行', href: '/stats#publisherPanel' },
    ] },
    { heading: '分布', links: [
      { label: '标签分布', href: '/stats#tagPanel' },
      { label: '分类管理', href: '/tags' },
    ] },
    { heading: '更多', links: [
      { label: '书架', href: '/shelf' },
      { label: '阅读心得', href: '/notes' },
    ] },
  ],
  tags: [
    { heading: '分类', elevated: true, links: [
      { label: '分类管理', href: '/tags' },
    ] },
    // 名单不直接铺在面板里:点二级的「作者 / 标签」再看三级名单
    { heading: '浏览', links: [
      { label: '作者', submenu: 'authors' },
      { label: '标签', submenu: 'tags' },
    ] },
    { heading: '更多', links: [
      { label: '自定义字段', href: '/tags#fieldsHead' },
      { label: '标签分布', href: '/stats#tagPanel' },
      { label: '作者排行', href: '/stats#authorPanel' },
    ] },
  ],
};

/* 书架筛选 / 分类浏览里的作者、标签名单来自真实书库,不能写死在 NAV_MENUS:
 * 三级浮层先渲染空名单,页面载入后各拉一次接口,桌面 flyout 与竖屏三级面板共用。
 * 名单按书籍数排序(接口已排好),点名字直接去书架按该分类筛选。 */
const NAV_LIST_SOURCES = {
  authors: { param: 'author', endpoint: '/api/authors', label: '作者' },
  tags: { param: 'tag', endpoint: '/api/tags', label: '标签' },
};

function navHtml(current) {
  return NAV_ITEMS.map((n) => {
    const on = n.id === current;
    const menu = n.id in NAV_MENUS;
    const attrs = [
      on ? 'class="active"' : '',
      on ? 'aria-current="page"' : '',
      menu ? `data-flyout="${n.id}"` : '',
      menu ? 'aria-expanded="false"' : '',
      menu ? `aria-controls="navFlyout-${n.id}"` : '',
    ].filter(Boolean).join(' ');
    return `<div class="nav-item"><a href="${n.href}"${attrs ? ' ' + attrs : ''}>${n.label}</a></div>`;
  }).join('');
}

/* 竖屏主导航:有下拉分组的一级项改为按钮,点开全屏二级面板(apple.com 同款,
 * 一级列表不带箭头 —— 实测 apple.com 移动端菜单也没有);没有分组的就是普通链接。 */
function mobileNavHtml(current) {
  return NAV_ITEMS.map((n, i) => {
    const on = n.id === current;
    const menu = n.id in NAV_MENUS;
    if (!menu) {
      return `<a href="${n.href}"${on ? ' class="active" aria-current="page"' : ''} style="--mm-i:${i}">${n.label}</a>`;
    }
    return `<button type="button"${on ? ' class="active"' : ''} data-sub="${n.id}" aria-expanded="false" aria-controls="mmSub-${n.id}" style="--mm-i:${i}">${n.label}</button>`;
  }).join('');
}

/* 竖屏二级面板:内容复用桌面 NAV_MENUS,版式按 apple.com 移动端子菜单实测
 * —— 首组大号链接无标题(28px/600),次组 17px 灰标题 + 17px/600 链接。 */
function mobileSubmenuHtml(n) {
  const groups = NAV_MENUS[n.id];
  if (!groups) return '';
  return `
    <section class="mobile-menu-sub" id="mmSub-${n.id}" role="dialog" aria-modal="true" aria-label="${n.label}" tabindex="-1">
      <div class="mm-sub-inner">
        ${groups.map((g) => g.elevated ? `
          <ul class="mm-sub-elevated">
            ${(g.links || []).map((l) => `<li><a href="${l.href}">${l.label}</a></li>`).join('')}
          </ul>` : `
          <div class="mm-sub-group">
            <h2 class="mm-sub-heading">${g.heading}</h2>
            <ul class="mm-sub-sec">
              ${(g.links || []).map((l) => l.submenu
                ? `<li><button type="button" class="mm-sub3-trigger" data-mm-sub3="mmSub3-${n.id}-${l.submenu}" aria-expanded="false" aria-controls="mmSub3-${n.id}-${l.submenu}">${l.label}<svg class="mm-sub3-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.4 1.6 6.8 5 3.4 8.4"></path></svg></button></li>`
                : `<li><a href="${l.href}">${l.label}</a></li>`).join('')}
            </ul>
          </div>`).join('')}
      </div>
    </section>`;
}

/* 竖屏三级面板:二级里「按作者 / 按标签」的名单。与桌面三级浮层、
 * 「分类」下拉共用同一份 data-nav-list 数据,点名字直接带筛选参数去书架。 */
function mobileSubLevel3Html(n) {
  const groups = NAV_MENUS[n.id];
  if (!groups) return '';
  const sources = [];
  groups.forEach((g) => (g.links || []).forEach((l) => {
    if (l.submenu && !sources.some((s) => s.source === l.submenu)) {
      sources.push({ source: l.submenu, label: l.label });
    }
  }));
  return sources.map(({ source, label }) => {
    const meta = NAV_LIST_SOURCES[source];
    if (!meta) return '';
    return `
    <section class="mobile-menu-sub mm-sub-level3" id="mmSub3-${n.id}-${source}" role="dialog" aria-modal="true" aria-label="${label}" tabindex="-1">
      <div class="mm-sub-inner">
        <div class="mm-sub-group" data-nav-group="${source}" hidden>
          <h2 class="mm-sub-heading">${label}</h2>
          <ul class="mm-sub-sec" data-nav-list="${source}" data-empty="暂无${meta.label}"></ul>
        </div>
      </div>
    </section>`;
  }).join('');
}

function mobileSubmenusHtml() {
  return NAV_ITEMS.filter((n) => NAV_MENUS[n.id]).map(mobileSubmenuHtml).join('')
    + NAV_ITEMS.filter((n) => NAV_MENUS[n.id]).map(mobileSubLevel3Html).join('');
}

function navFlyoutPanelHtml(n) {
  const groups = NAV_MENUS[n.id];
  if (!groups) return '';
  const subSources = [];
  groups.forEach((g) => (g.links || []).forEach((l) => {
    if (l.submenu && !subSources.some((s) => s.source === l.submenu)) {
      subSources.push({ source: l.submenu, label: l.label });
    }
  }));
  // 与 Apple 一致:标题占 item 1,链接从 2 起编号;
  // 退场时长按编号倒序递减(先入场的链接停留更久)。
  const total = Math.max(0, ...groups.map((g) => (g.links ? g.links.length : 0))) + 1;
  return `
    <div class="nav-flyout-panel" id="navFlyout-${n.id}" data-panel="${n.id}">
      <div class="nav-flyout-inner">
        ${groups.map((g, gi) => {
          const groupDelay = gi === 0 ? 0 : Math.min(80 + (gi - 1) * 40, gi * 80);
          return `
          <div class="nav-flyout-group${g.elevated ? ' is-elevated' : ''}" style="--nav-group-delay:${groupDelay}ms">
            <h2 class="nav-flyout-heading">${g.heading}</h2>
            <ul class="nav-flyout-list${g.elevated ? ' is-large' : ''}">
              ${(g.links || []).map((l, i) => {
                const body = l.submenu
                  ? `<button type="button" class="nav-sub-trigger" data-nav-sub="${l.submenu}" aria-haspopup="true" aria-expanded="false" aria-controls="navSub-${n.id}-${l.submenu}">${l.label}<svg class="nav-sub-caret" width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 1.4 6.1 4.5 3 7.6"></path></svg></button>`
                  : `<a href="${l.href}">${l.label}</a>`;
                return `<li style="--nav-item-i:${i + 2};--nav-exit-dur:${Math.min(160 + 20 * (total - (i + 2)), 240)}ms">${body}</li>`;
              }).join('')}
            </ul>
          </div>`;
        }).join('')}
      </div>
      ${subSources.map(({ source, label }) => {
        const meta = NAV_LIST_SOURCES[source];
        if (!meta) return '';
        return `
      <div class="nav-subpanel" id="navSub-${n.id}-${source}" data-nav-subpanel="${source}" aria-hidden="true">
        <h2 class="nav-subpanel-heading">${label}</h2>
        <ul class="nav-subpanel-list" data-nav-list="${source}" data-empty="暂无${meta.label}"></ul>
      </div>`;
      }).join('')}
    </div>`;
}

function navFlyoutHtml() {
  return `<div id="navFlyout" class="nav-flyout" aria-hidden="true">
    ${NAV_ITEMS.filter((n) => NAV_MENUS[n.id]).map(navFlyoutPanelHtml).join('')}
  </div>`;
}

function navEscape(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

/* 名单载入后,桌面面板的入场序号 / 退场时长要按新总数重算
 * (退场按编号倒序递减,名单可能比静态链接长很多)。 */
function syncFlyoutItemMeta() {
  document.querySelectorAll('.nav-flyout-panel').forEach((panel) => {
    const lists = [...panel.querySelectorAll('.nav-flyout-group:not([hidden]) .nav-flyout-list')];
    const total = Math.max(0, ...lists.map((list) => list.children.length)) + 1;
    lists.forEach((list) => {
      [...list.children].forEach((li, i) => {
        li.style.setProperty('--nav-item-i', i + 2);
        li.style.setProperty('--nav-exit-dur', Math.min(160 + 20 * (total - (i + 2)), 240) + 'ms');
      });
    });
  });
}

function fillNavList(source, items) {
  const meta = NAV_LIST_SOURCES[source];
  if (!meta) return;
  const html = items.map((item) => {
    const name = navEscape(item.name);
    const count = Number(item.count) || 0;
    return `<li><a href="/shelf?${meta.param}=${encodeURIComponent(item.name)}" title="在书架中筛选「${name}」(${count} 本)">${name}</a></li>`;
  }).join('');
  document.querySelectorAll(`[data-nav-list="${source}"]`).forEach((list) => { list.innerHTML = html; });
  document.querySelectorAll(`[data-nav-group="${source}"]`).forEach((group) => { group.hidden = items.length === 0; });
  syncFlyoutItemMeta();
  if (items.length) document.dispatchEvent(new Event('nav-flyout-refresh'));
}

function loadNavLists() {
  Object.entries(NAV_LIST_SOURCES).forEach(([source, meta]) => {
    fetch(meta.endpoint, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : []))
      .then((items) => { if (Array.isArray(items)) fillNavList(source, items); })
      .catch(() => {});
  });
}

function headerHtml(current) {
  return `
  <header class="topbar">
    <div class="topbar-inner">
      <button type="button" id="mmBackBtn" class="mm-back-btn" aria-label="返回上一级">
        <svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 2 2 10l8 8"></path>
        </svg>
      </button>
      <a class="brand" href="/" title="返回首页"><span class="logo"><img src="/logo-mark.png?v=4" alt=""></span><span>My books</span></a>
      <nav class="view-switch" aria-label="主导航">${navHtml(current)}</nav>
      <div class="topbar-actions">
        <button type="button" id="searchBtn" class="icon-btn" title="搜索" aria-label="搜索">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="10.3" cy="10.3" r="8.4"></circle>
            <path d="M16.3 16.3 22 22"></path>
          </svg>
        </button>
        <button type="button" id="settingsBtn" class="icon-btn" title="设置心得仓库" aria-label="设置">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0 1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
        <button type="button" id="addBtn" class="icon-btn" title="添加书籍" aria-label="添加书籍">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="1.75" y="1.75" width="20.5" height="20.5" rx="6.35"></rect>
            <path d="M12 8.1v7.8M8.1 12h7.8"></path>
          </svg>
        </button>
      </div>
      <button type="button" id="menuBtn" class="mobile-menu-btn" aria-label="打开菜单" aria-expanded="false" aria-controls="mobileMenu">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <polyline fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" points="2 12, 16 12">
            <animate id="mmAnimBottomOpen" attributeName="points" keyTimes="0;0.5;1" dur="0.24s" begin="indefinite" fill="freeze" calcMode="spline" keySplines="0.42, 0, 1, 1;0, 0, 0.58, 1" values=" 2 12, 16 12; 2 9, 16 9; 3.5 15, 15 3.5"></animate>
            <animate id="mmAnimBottomClose" attributeName="points" keyTimes="0;0.5;1" dur="0.24s" begin="indefinite" fill="freeze" calcMode="spline" keySplines="0.42, 0, 1, 1;0, 0, 0.58, 1" values=" 3.5 15, 15 3.5; 2 9, 16 9; 2 12, 16 12"></animate>
          </polyline>
          <polyline fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" points="2 5, 16 5">
            <animate id="mmAnimTopOpen" attributeName="points" keyTimes="0;0.5;1" dur="0.24s" begin="indefinite" fill="freeze" calcMode="spline" keySplines="0.42, 0, 1, 1;0, 0, 0.58, 1" values=" 2 5, 16 5; 2 9, 16 9; 3.5 3.5, 15 15"></animate>
            <animate id="mmAnimTopClose" attributeName="points" keyTimes="0;0.5;1" dur="0.24s" begin="indefinite" fill="freeze" calcMode="spline" keySplines="0.42, 0, 1, 1;0, 0, 0.58, 1" values=" 3.5 3.5, 15 15; 2 9, 16 9; 2 5, 16 5"></animate>
          </polyline>
        </svg>
      </button>
    </div>
  </header>`;
}

function overlaysHtml() {
  return `
  <!-- 桌面端导航下拉(apple.com globalnav flyout 同款):整幅纸白面板 + 页面毛玻璃幕布 -->
  <div id="navFlyoutCurtain" class="nav-flyout-curtain" aria-hidden="true"></div>
  ${navFlyoutHtml()}

  <!-- 全局搜索浮层(apple.com search 同款):桌面自 44px 导航下方展开,
       竖屏自 48px 长到满屏;Quick Links 位置换成「保存的搜索」。
       竖屏没有独立 ✕ —— 顶栏汉堡按钮(#menuBtn)压在面板之上,
       展开时由两条横杠变形成 ✕,再点一下收起搜索(apple.com 同款)。 -->
  <div id="searchCurtain" class="search-curtain" aria-hidden="true"></div>
  <div id="searchFlyout" class="search-flyout" role="search" aria-hidden="true">
    <div class="search-flyout-scroll">
      <div class="search-flyout-inner">
        <form id="searchForm" class="search-field" action="/shelf" method="get">
          <svg class="search-field-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <circle cx="10.3" cy="10.3" r="8.4"></circle>
            <path d="M16.3 16.3 22 22"></path>
          </svg>
          <input id="searchInput" name="q" type="search" placeholder="搜索书名 / 作者" aria-label="搜索书名或作者" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
          <button type="button" id="searchResetBtn" class="search-field-reset" aria-label="清空搜索" hidden>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="7" fill="currentColor"></circle>
              <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="#fafafc" stroke-width="1.3" stroke-linecap="round"></path>
            </svg>
          </button>
          <button type="button" id="searchSyntaxBtn" class="search-field-help" aria-label="高级搜索语法" title="高级搜索语法" aria-haspopup="dialog" aria-controls="syntaxModal">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
              <circle cx="10" cy="10" r="8.4"></circle>
              <path d="M7.8 7.8c0-1.35 1-2.3 2.25-2.3s2.2.85 2.2 2.05c0 1-.55 1.55-1.35 2.05-.65.4-.9.75-.9 1.45v.25"></path>
              <circle cx="10" cy="14.15" r="0.9" fill="currentColor" stroke="none"></circle>
            </svg>
          </button>
        </form>
        <section class="search-results" aria-labelledby="searchResultsTitle">
          <div class="search-results-head">
            <h2 id="searchResultsTitle" class="search-results-title">保存的搜索</h2>
            <div class="search-results-tools">
              <button type="button" id="searchSaveBtn" class="search-results-tool" hidden>保存当前</button>
              <button type="button" id="searchEditBtn" class="search-results-tool" hidden>编辑</button>
            </div>
          </div>
          <ul id="searchSavedList" class="search-results-list"></ul>
          <p id="searchEmpty" class="search-results-empty" hidden>还没有保存的搜索</p>
        </section>
      </div>
    </div>
  </div>

  <!-- 高级搜索语法说明(全局共享;入口是搜索浮层输入框右侧的 ? 按钮) -->
  <div id="syntaxModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box">
      <div class="modal-head">
        <h2>高级搜索语法</h2>
        <button type="button" class="icon-btn" data-close aria-label="关闭">✕</button>
      </div>
      <div class="syntax-body">
        <p>在搜索框把多条条件用空格连起来即「并且」,支持这些字段:</p>
        <table class="syntax-table">
          <tr><td><code>tag:科幻</code></td><td>标签(精确匹配归一化标签)</td></tr>
          <tr><td><code>author:刘慈欣</code></td><td>作者(精确匹配归一化作者)</td></tr>
          <tr><td><code>title:三体</code></td><td>书名(子串)</td></tr>
          <tr><td><code>status:done</code></td><td>状态:想读 wish / 在读 reading / 已读 done(或中文)</td></tr>
          <tr><td><code>rating&gt;=9</code></td><td>评分,支持 &gt; &lt; &gt;= &lt;= = !=</td></tr>
          <tr><td><code>pubyear:2008</code></td><td>出版年,可用 <code>pubyear&lt;2010</code> 这类范围</td></tr>
          <tr><td><code>publisher:译文</code></td><td>出版社(子串)</td></tr>
          <tr><td><code>isbn:978...</code></td><td>ISBN(子串)</td></tr>
          <tr><td><code>series:基地</code></td><td>系列(精确匹配)</td></tr>
          <tr><td><code>series_index:&gt;=2</code></td><td>系列序号,支持 &gt; &lt; &gt;= &lt;= = !=</td></tr>
          <tr><td><code>identifier:goodreads:5907</code></td><td>标识符(类型:值;只写类型表示"有该类标识符")</td></tr>
          <tr><td><code>format:epub</code></td><td>电子书格式(已上传)</td></tr>
          <tr><td><code>#页数:&gt;300</code></td><td>自定义字段(<code>#</code> 开头;数值可比较)</td></tr>
        </table>
        <p>其它写法:</p>
        <ul>
          <li><code>or</code> —— 把条件改成「或者」:<code>status:done or 活着</code></li>
          <li><code>not</code> / 前导 <code>-</code> —— 否定紧随其后的一条:<code>not tag:草稿</code></li>
          <li>值含空格加引号:<code>publisher:"上海译文"</code></li>
          <li>不写字段名的词按书名 / 作者 / 简介 / 标签全文检索</li>
        </ul>
        <p class="syntax-example">组合示例:<code>status:done rating&gt;=9 三体</code></p>
      </div>
      <div class="form-foot">
        <div class="form-foot-btns">
          <button type="button" class="btn btn-ghost" data-close>知道了</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 添加 / 编辑书籍弹窗 -->
  <div id="bookModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box">
      <div class="modal-head">
        <h2 id="modalTitle">添加书籍</h2>
        <button type="button" class="icon-btn" data-close aria-label="关闭">✕</button>
      </div>
      <form id="bookForm" novalidate>
        <input type="hidden" id="bookId">
        <input type="hidden" id="fPublisher">
        <input type="hidden" id="fPubYear">
        <input type="hidden" id="fRating">
        <input type="hidden" id="fDoubanId">
        <div class="douban-fetch-row">
          <button type="button" id="doubanFetchBtn" class="btn btn-ghost douban-btn">从豆瓣填充元数据</button>
          <button type="button" id="isbnBatchBtn" class="btn btn-ghost">按 ISBN 批量添加</button>
          <span id="doubanStatus" class="douban-status"></span>
        </div>
        <div id="doubanCandidates" class="douban-candidates hidden"></div>
        <div class="form-grid">
          <div class="field field-full">
            <label for="fTitle">书名 <i class="req">*</i></label>
            <input type="text" id="fTitle" maxlength="120" required>
          </div>
          <div class="field">
            <label for="fAuthor">作者</label>
            <input type="text" id="fAuthor" maxlength="80">
          </div>
          <div class="field">
            <label>状态</label>
            <div class="seg" id="fStatus">
              <button type="button" data-value="wish">想读</button>
              <button type="button" data-value="reading">在读</button>
              <button type="button" data-value="done">已读</button>
            </div>
          </div>
          <div class="field">
            <label for="fTags">分类标签</label>
            <input type="text" id="fTags" list="tagSuggestions">
            <datalist id="tagSuggestions"></datalist>
          </div>
          <div class="field">
            <label for="fSeries">系列 <span class="label-sub">可写「基地 [3]」直接带序号</span></label>
            <input type="text" id="fSeries" list="seriesSuggestions" maxlength="200" placeholder="如:基地 [3]">
            <datalist id="seriesSuggestions"></datalist>
          </div>
          <div class="field">
            <label for="fSeriesIndex">系列序号 <span class="label-sub">可留空;支持小数(2.5)</span></label>
            <input type="number" id="fSeriesIndex" step="0.1" min="0" placeholder="如:3">
          </div>
          <div class="field field-full">
            <label for="fIsbn">ISBN <span class="label-sub">书籍条形码上的 13 位数字,可扫码或手输</span></label>
            <div class="isbn-input-row">
              <input type="text" id="fIsbn" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="如 9787536692930">
              <button type="button" id="isbnScanBtn" class="btn btn-ghost" title="用摄像头扫描书籍条形码">扫码</button>
            </div>
            <p class="field-hint">填好 ISBN 后点「从豆瓣填充元数据」会按 ISBN 精确匹配,比书名更准</p>
          </div>
          <div class="field field-full">
            <label>阅读记录 <span class="label-sub">每次读的起止时间,开始/读完日期与读过次数据此自动生成</span></label>
            <div id="readLogs" class="read-logs"></div>
            <div id="readLogsSummary" class="read-logs-summary"></div>
            <button type="button" id="addLogBtn" class="btn btn-ghost add-log-btn">＋ 添加一次阅读</button>
          </div>
          <div class="field field-full">
            <label for="fSummary">图书简介 <span class="label-sub">这本书讲什么,可选</span></label>
            <textarea id="fSummary" rows="3" maxlength="1000"></textarea>
          </div>
          <div class="field field-full">
            <label for="fCoverUrl">封面图片</label>
            <p class="field-hint">可粘贴图片链接，或上传本地图片（支持 png/jpg/gif/webp，不超过 5MB），保存后生效</p>
            <div class="cover-editor">
              <div id="coverPreview" class="cover-preview">暂无封面</div>
              <div class="cover-actions">
                <input type="text" id="fCoverUrl">
                <div class="cover-btns">
                  <label class="btn btn-ghost">
                    <span class="cover-upload-text">上传本地图片</span>
                    <input type="file" id="fCoverFile" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
                  </label>
                  <button type="button" id="coverRemove" class="btn btn-ghost">移除</button>
                </div>
              </div>
            </div>
          </div>
          <div class="field field-full">
            <label>电子书文件 <span class="label-sub">epub / pdf / mobi / azw3 / txt,≤80MB;每种格式一份,重复上传同格式会替换旧文件</span></label>
            <div class="ebook-editor">
              <div class="ebook-actions">
                <div class="cover-btns">
                  <label class="btn btn-ghost">
                    <span id="ebookUploadText">选择文件上传</span>
                    <input type="file" id="fEbookFile" accept=".epub,.pdf,.mobi,.azw3,.txt" hidden>
                  </label>
                </div>
                <div id="ebookInfo" class="ebook-info"><span class="ebook-info-empty">未上传文件</span></div>
              </div>
            </div>
          </div>
          <div class="field field-full">
            <label>读书心得</label>
            <p class="field-hint">在右上角 ⚙ 配置 GitHub 仓库后,把 .md 文件按书名(如 三体.md)放入仓库即可自动关联,详情页点"读书心得"查看</p>
          </div>
          <!-- 其它标识符(A5):除 ISBN / 豆瓣 id 外可加任意类型。
               行由 common.js 动态增删;类型名自由填(如 goodreads / doi)。 -->
          <div class="field field-full">
            <label>其它标识符 <span class="label-sub">如 goodreads / doi / amazon;每类型一个值</span></label>
            <div id="idRows" class="id-rows"></div>
            <datalist id="idTypeSuggestions"></datalist>
            <button type="button" id="addIdRowBtn" class="btn btn-ghost add-log-btn">＋ 添加标识符</button>
          </div>
          <!-- 自定义字段:控件由 common.js 按 custom_columns 注册表动态生成。
               没有任何自定义字段时整块隐藏(不留空标题)。 -->
          <div class="field field-full" id="customFieldsSection" hidden>
            <label>自定义字段 <span class="label-sub">在「分类」页管理字段定义</span></label>
            <div class="form-grid" id="customFieldsBox"></div>
          </div>
        </div>
        <div class="form-foot">
          <span id="formError" class="form-error"></span>
          <div class="form-foot-btns">
            <button type="button" class="btn btn-ghost" data-close>取消</button>
            <button type="submit" class="btn btn-primary" id="saveBtn">保存</button>
          </div>
        </div>
      </form>
    </div>
  </div>

  <!-- 书籍详情弹窗 -->
  <div id="detailModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box detail-box">
      <button type="button" class="icon-btn detail-close" data-close aria-label="关闭">✕</button>
      <div class="detail-body" id="detailBody"></div>
    </div>
  </div>

  <!-- 设置弹窗 -->
  <div id="settingsModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box settings-box">
      <div class="modal-head">
        <h2>设置</h2>
        <button type="button" class="icon-btn" data-close aria-label="关闭">✕</button>
      </div>
      <div class="form-grid">
        <div class="field field-full">
          <label for="sRepo">心得仓库(GitHub)</label>
          <input type="text" id="sRepo" placeholder="例如:yourname/reading-notes">
          <p class="field-hint">把读书心得放进这个 GitHub 公开仓库：心得按书名命名（如 三体.md）放根目录。保存后详情页将按《书名》自动获取心得；留空则不获取。</p>
        </div>
        <div class="field">
          <label for="sBranch">分支</label>
          <input type="text" id="sBranch" placeholder="main">
        </div>
      </div>
      <div class="form-foot">
        <span id="settingsError" class="form-error"></span>
        <div class="form-foot-btns">
          <button type="button" class="btn btn-ghost" data-close>取消</button>
          <button type="button" class="btn btn-primary" id="settingsSave">保存</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 按 ISBN 批量添加弹窗(对标 calibre 的 Add from ISBN 对话框):
       多行 ISBN → 服务器逐条校验/查重/抓元数据/建档,结果按条列出。
       查不到的条目给「手动录入」入口,而不是像 calibre 那样建空标题占位记录。 -->
  <div id="isbnBatchModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box isbn-batch-box">
      <div class="modal-head">
        <h2>按 ISBN 批量添加</h2>
        <button type="button" class="icon-btn" data-close aria-label="关闭">✕</button>
      </div>
      <div class="form-grid">
        <div class="field field-full">
          <label for="isbnBatchInput">ISBN 列表 <span class="label-sub">一行一个;也支持从表格粘贴(逗号/分号分隔)</span></label>
          <textarea id="isbnBatchInput" rows="6" placeholder="9787536692930&#10;9787115428028&#10;…" spellcheck="false"></textarea>
          <p class="field-hint">一次最多 50 个。逐条查重,元数据优先豆瓣、其次 Open Library</p>
        </div>
        <div class="field">
          <label for="isbnBatchTags">统一标签 <span class="label-sub">可选,逗号分隔</span></label>
          <input type="text" id="isbnBatchTags" list="tagSuggestions" placeholder="如:科幻, 待读">
        </div>
        <div class="field">
          <label>选项</label>
          <label class="check-row"><input type="checkbox" id="isbnBatchCheck" checked> 跳过书库中已有的 ISBN</label>
          <label class="check-row"><input type="checkbox" id="isbnBatchConvert"> ISBN-10 统一转 13 位</label>
        </div>
      </div>
      <div id="isbnBatchResults" class="isbn-batch-results hidden" aria-live="polite"></div>
      <div class="form-foot">
        <span id="isbnBatchError" class="form-error"></span>
        <div class="form-foot-btns">
          <button type="button" class="btn btn-ghost" data-close>关闭</button>
          <button type="button" class="btn btn-primary" id="isbnBatchSubmit">开始添加</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 移动端全屏菜单(apple.com 风)——只承载导航;搜索已独立为顶栏一级入口 -->
  <div id="menuCurtain" class="menu-curtain"></div>
  <div id="mobileMenu" class="mobile-menu" role="dialog" aria-modal="true" tabindex="-1">
    <nav class="mm-links" aria-label="主导航">${mobileNavHtml(currentPage)}</nav>
    <div class="mm-foot">
      <button type="button" id="mmSettings">⚙ 设置心得仓库</button>
    </div>
  </div>
  ${mobileSubmenusHtml()}

  <div id="toast" class="toast hidden"></div>

  <footer>
    <p class="footer-tagline"><span class="orn">❖</span>My books<span class="orn">❖</span></p>
    <p class="footer-legal">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">豫ICP备2026045565号</a>
      <a class="beian-ps" href="https://beian.mps.gov.cn/#/query/webSearch?code=41090002411179" target="_blank" rel="noreferrer">
        <img src="/beian-ps.png" alt="公安备案图标" width="14" height="15">豫公网安备41090002411179号
      </a>
    </p>
  </footer>`;
}

const currentPage = document.body.dataset.page || 'home';

document.body.insertAdjacentHTML('afterbegin', headerHtml(currentPage));
document.body.insertAdjacentHTML('beforeend', overlaysHtml());
loadNavLists();

/* ============ 桌面导航下拉(apple.com globalnav flyout) ============
 * 悬停 100ms 打开(与 Apple 的 hover intent 一致);已展开时划过其它项即时切换。
 * 面板高度 254ms 展开;标题与链接按组错峰入场(标题 +80ms,链接再每项 +20ms),
 * 切换菜单为 120ms 交叉淡化 + 高度变形;关闭时内容倒序时长淡出,面板延迟 120ms 收起。
 * 键盘:聚焦导航项即展开,↓ 进入菜单,Esc 收起并回到触发项。 */
function initNavFlyouts() {
  const flyout = document.getElementById('navFlyout');
  const curtain = document.getElementById('navFlyoutCurtain');
  if (!flyout || !curtain) return;
  const triggers = [...document.querySelectorAll('.view-switch a[data-flyout]')];
  if (!triggers.length) return;
  const mq = window.matchMedia('(min-width: 820px)');
  let activeId = null;
  let openTimer = 0;
  let pendingId = null;
  let restoringFocus = false;
  let closeTimer = 0;
  let switchTimer = 0;

  const triggerFor = (id) => triggers.find((t) => t.dataset.flyout === id) || null;
  const panelFor = (id) => flyout.querySelector(`.nav-flyout-panel[data-panel="${id}"]`);
  // 同一个 source 在多个菜单里都有三级浮层(书架筛选 / 分类浏览),
  // 必须限定在触发按钮所在的面板里查,否则会拿到别的面板里的同名卡片
  const subpanelFor = (source, trigger) => trigger.closest('.nav-flyout-panel')?.querySelector(`.nav-subpanel[data-nav-subpanel="${source}"]`) || null;
  const currentHeight = () => {
    const panel = flyout.querySelector('.nav-flyout-panel.is-active');
    return panel ? panel.offsetHeight : 0;
  };

  /* 三级浮层(按作者 / 按标签):点击二级里的按钮才展开,名单在卡片内滚动。
   * 卡片 fixed 定位在触发按钮右侧,空间不足时翻到左侧;名单与「分类」下拉同源。 */
  let subSource = null;
  let subTrigger = null;
  let subPanel = null;

  function closeSub(restoreFocus) {
    if (!subSource) return false;
    const trigger = subTrigger;
    const panel = subPanel;
    subSource = null;
    subTrigger = null;
    subPanel = null;
    if (panel) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }
    return true;
  }

  function openSub(source, trigger) {
    const panel = subpanelFor(source, trigger);
    if (!panel || !mq.matches) return;
    if (subSource && subSource !== source) closeSub(false);
    const rect = trigger.getBoundingClientRect();
    const width = panel.offsetWidth || 248;
    const gap = 10;
    let left = rect.right + gap;
    if (left + width > window.innerWidth - 12) left = rect.left - gap - width;
    if (left < 12) left = 12;
    const top = Math.max(52, rect.top - 14);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.maxHeight = Math.min(430, window.innerHeight - top - 16) + 'px';
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    trigger.setAttribute('aria-expanded', 'true');
    subSource = source;
    subTrigger = trigger;
    subPanel = panel;
  }

  function syncTriggers(id) {
    triggers.forEach((t) => {
      const on = t.dataset.flyout === id;
      t.setAttribute('aria-expanded', String(on));
      t.classList.toggle('is-open', on);
    });
  }

  function clearSwitch() {
    clearTimeout(switchTimer);
    switchTimer = 0;
    flyout.classList.remove('is-switching');
    flyout.querySelectorAll('.nav-flyout-panel.is-entering, .nav-flyout-panel.is-leaving')
      .forEach((p) => p.classList.remove('is-entering', 'is-leaving'));
  }

  function setActive(id) {
    syncTriggers(id);
    flyout.querySelectorAll('.nav-flyout-panel.is-active').forEach((p) => p.classList.remove('is-active'));
    panelFor(id).classList.add('is-active');
    activeId = id;
    flyout.setAttribute('aria-hidden', 'false');
    curtain.setAttribute('aria-hidden', 'false');
  }

  function open(id) {
    if (!mq.matches || !panelFor(id)) return;
    clearTimeout(openTimer);
    openTimer = 0;
    pendingId = null;
    const isOpen = document.body.classList.contains('nav-flyout-open');
    if (activeId === id && isOpen) return;

    if (document.body.classList.contains('nav-flyout-closing')) {
      clearTimeout(closeTimer);
      closeTimer = 0;
      document.body.classList.remove('nav-flyout-closing');
      flyout.querySelectorAll('.nav-flyout-panel.is-active').forEach((p) => p.classList.remove('is-active'));
      activeId = null;
    }

    if (isOpen && activeId && activeId !== id) {
      // 已展开时切换:旧面板整体淡出、新面板整体淡入,高度 120ms 变形,
      // 新面板内容直接呈现,不重播逐项 stagger(与 Apple 一致)。
      closeSub(false);
      const oldPanel = panelFor(activeId);
      const newPanel = panelFor(id);
      const startHeight = parseFloat(getComputedStyle(flyout).height) || 0;
      clearSwitch();
      syncTriggers(id);
      oldPanel.classList.remove('is-active');
      oldPanel.classList.add('is-leaving');
      newPanel.classList.add('is-active', 'is-entering');
      activeId = id;
      flyout.classList.add('is-switching');
      flyout.style.height = startHeight + 'px';
      requestAnimationFrame(() => {
        if (activeId === id) flyout.style.height = newPanel.offsetHeight + 'px';
      });
      switchTimer = setTimeout(clearSwitch, 140);
      return;
    }

    const first = !isOpen || !activeId;
    setActive(id);
    if (first) {
      // 面板默认 display:none,浏览器没有关闭态的 computed style,
      // 直接加 open 类会跳过过渡。先以关闭态强制一次样式计算再展开。
      flyout.style.height = '0px';
      currentHeight();
      document.body.classList.add('nav-flyout-open');
      document.dispatchEvent(new Event('nav-flyout-open'));
      flyout.style.height = currentHeight() + 'px';
    } else {
      flyout.style.height = currentHeight() + 'px';
    }
  }

  function close(restoreFocus) {
    clearTimeout(openTimer);
    openTimer = 0;
    pendingId = null;
    closeSub(false);
    const trigger = activeId ? triggerFor(activeId) : null;
    if (activeId && document.body.classList.contains('nav-flyout-open')) {
      syncTriggers(null);
      clearSwitch();
      document.body.classList.remove('nav-flyout-open');
      document.body.classList.add('nav-flyout-closing');
      flyout.setAttribute('aria-hidden', 'true');
      curtain.setAttribute('aria-hidden', 'true');
      // 面板先留驻,内容按倒序时长淡出;120ms 后整幅收起,与 Apple 节奏一致。
      flyout.style.height = '0px';
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        closeTimer = 0;
        if (!document.body.classList.contains('nav-flyout-closing')) return;
        document.body.classList.remove('nav-flyout-closing');
        flyout.style.height = '';
        flyout.querySelectorAll('.nav-flyout-panel.is-active').forEach((p) => p.classList.remove('is-active'));
        activeId = null;
      }, 420);
    }
    if (restoreFocus && trigger) {
      // focus 事件同步触发,esc 回焦不能被它当成“键盘展开”而重新打开
      restoringFocus = true;
      trigger.focus();
      restoringFocus = false;
    }
  }

  function arm(id) {
    if (activeId) { open(id); return; }
    if (pendingId === id && openTimer) return;
    clearTimeout(openTimer);
    pendingId = id;
    openTimer = setTimeout(() => {
      openTimer = 0;
      pendingId = null;
      open(id);
    }, 100);
  }

  triggers.forEach((t) => {
    t.addEventListener('focus', () => { if (mq.matches && !restoringFocus) open(t.dataset.flyout); });
    t.addEventListener('click', () => close(false));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' || !mq.matches) return;
      e.preventDefault();
      open(t.dataset.flyout);
      const firstLink = panelFor(t.dataset.flyout)?.querySelector('a');
      if (firstLink) requestAnimationFrame(() => firstLink.focus());
    });
  });

  flyout.querySelectorAll('.nav-sub-trigger').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const source = trigger.dataset.navSub;
      if (subSource === source) closeSub(false);
      else openSub(source, trigger);
    });
    trigger.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const source = trigger.dataset.navSub;
      openSub(source, trigger);
      const first = subpanelFor(source, trigger)?.querySelector('a');
      if (first) requestAnimationFrame(() => first.focus());
    });
  });

  // 用 pointermove 而非 pointerover:键盘聚焦展开时幕布会出现在静止的
  // 指针下方,浏览器会补发一次 pointerover —— 那不是真实移动,不能据此关闭。
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || !mq.matches) return;
    if (e.target.closest('#navFlyout')) return;
    const trigger = e.target.closest('.view-switch a[data-flyout]');
    if (trigger) { arm(trigger.dataset.flyout); return; }
    if (activeId) close(false);
    else {
      clearTimeout(openTimer);
      openTimer = 0;
      pendingId = null;
    }
  }, { passive: true });

  flyout.addEventListener('click', (e) => {
    if (e.target.closest('a')) { close(false); return; }
    if (subSource && !e.target.closest('.nav-subpanel') && !e.target.closest('.nav-sub-trigger')) closeSub(false);
  });

  curtain.addEventListener('click', () => close(false));

  // 搜索浮层打开时通过该事件收起导航下拉(两者共用同一块顶栏空间)
  document.addEventListener('nav-flyout-close', () => close(false));

  // 名单异步到达时若面板已展开,按新高度重新展开,避免内容被裁切
  document.addEventListener('nav-flyout-refresh', () => {
    if (!activeId || !document.body.classList.contains('nav-flyout-open')) return;
    flyout.style.height = currentHeight() + 'px';
  });

  document.addEventListener('focusout', () => {
    if (!activeId) return;
    requestAnimationFrame(() => {
      if (!activeId) return;
      const el = document.activeElement;
      if (el && (el.closest('.view-switch a[data-flyout]') || el.closest('#navFlyout'))) return;
      // 悬停切换菜单时,旧面板 display:none 会把焦点丢回 body —— 这不是
      // 「焦点离开导航」,不能把刚展开的新面板一起关掉
      if (el === document.body) return;
      close(false);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (activeId || subSource)) {
      e.preventDefault();
      // 三级浮层先收,再按一次才收起整幅下拉
      if (closeSub(true)) return;
      close(true);
    }
  });

  window.addEventListener('resize', () => {
    closeSub(false);
    if (!mq.matches) { close(false); return; }
    if (activeId) flyout.style.height = currentHeight() + 'px';
  });

  window.addEventListener('scroll', () => { if (activeId) close(false); }, { passive: true });
}

initNavFlyouts();

/* PWA Service Worker 注册:仅 HTTPS(或 localhost)环境;
   失败静默 —— 不支持 SW 的老浏览器只是没有离线能力,功能一切照旧。
   从 index.html 的内联脚本挪到这里:多页后每个文档都要注册一次。 */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
