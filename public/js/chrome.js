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

function navHtml(current) {
  return NAV_ITEMS.map((n) => {
    const on = n.id === current;
    return `<a href="${n.href}"${on ? ' class="active" aria-current="page"' : ''}>${n.label}</a>`;
  }).join('');
}

function headerHtml(current) {
  return `
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/" title="返回首页"><span class="logo"><img src="/logo-mark.png?v=4" alt=""></span><span>My books</span></a>
      <nav class="view-switch" aria-label="主导航">${navHtml(current)}</nav>
      <div class="topbar-actions">
        <button type="button" id="searchBtn" class="icon-btn" title="搜索" aria-label="搜索">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="10.3" cy="10.3" r="8.4"></circle>
            <path d="M16.3 16.3 22 22"></path>
          </svg>
        </button>
        <div class="search-box">
          <input type="search" id="searchInput" placeholder="搜索书名 / 作者" autocomplete="off">
          <button type="button" id="searchCancel" class="search-cancel">取消</button>
        </div>
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
      <button type="button" id="menuBtn" class="mobile-menu-btn" aria-label="打开菜单">
        <span></span><span></span>
      </button>
    </div>
  </header>`;
}

function overlaysHtml() {
  return `
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
        <input type="hidden" id="fIsbn">
        <input type="hidden" id="fRating">
        <input type="hidden" id="fDoubanId">
        <div class="douban-fetch-row">
          <button type="button" id="doubanFetchBtn" class="btn btn-ghost douban-btn">✨ 从豆瓣填充元数据</button>
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

  <!-- 移动端全屏菜单(apple.com 风)——只承载导航;搜索已独立为顶栏一级入口 -->
  <div id="mobileMenu" class="mobile-menu" role="dialog" aria-modal="true" tabindex="-1">
    <nav class="mm-links" aria-label="主导航">${navHtml(currentPage)}</nav>
    <div class="mm-foot">
      <button type="button" id="mmSettings">⚙ 设置心得仓库</button>
    </div>
  </div>

  <div id="toast" class="toast hidden"></div>

  <footer>
    <p class="footer-tagline"><span class="orn">❖</span>My books<span class="orn">❖</span>记录每一本读过的书</p>
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

/* PWA Service Worker 注册:仅 HTTPS(或 localhost)环境;
   失败静默 —— 不支持 SW 的老浏览器只是没有离线能力,功能一切照旧。
   从 index.html 的内联脚本挪到这里:多页后每个文档都要注册一次。 */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
