/* ============================================================
 * 读书心得页(/notes/:id) —— 独立页面(原 SPA 的 #/notes/<id> 视图)
 * 需要 marked + DOMPurify(仅本页加载)。
 * ============================================================ */

const NOTES_BOOK_ID = Number((location.pathname.match(/^\/notes\/(\d+)/) || [])[1] || 0);

async function openNotesPage(id) {
  let book;
  try {
    book = await api('/api/books/' + id);
  } catch (e) {
    toast(e.message, true);
    $('#notesTitle').textContent = '找不到这本书';
    $('#notesPageBody').innerHTML =
      '<div class="detail-notes notes-empty"><div class="notes-state">没有这本书的记录,可能已被删除。<a class="notes-retry" href="/shelf">回到书架</a></div></div>';
    return;
  }

  document.title = `《${book.title}》读书心得 · My books`;

  const autoNotes = !book.notes_url && !!state.settings.notesRepo;
  const src = book.notes_url || (autoNotes ? book.title + '.md' : '');

  $('#notesCover').innerHTML = coverHtml(book);
  $('#notesTitle').textContent = book.title;
  const dates = [book.start_date, book.finish_date].filter(Boolean);
  $('#notesMeta').innerHTML =
    (book.author ? `<span class="nm-author">${esc(book.author)}</span>` : '') +
    `<span class="status-inline ${book.status}">${STATUS_LABEL[book.status]}</span>` +
    (dates.length ? `<span class="nm-date">${esc(dates.join(' · '))}</span>` : '');

  const body = $('#notesPageBody');
  if (!src) {
    body.innerHTML = `
      <div class="detail-notes notes-empty">
        <div class="notes-state">这本书还没有读书心得。把心得文件按书名《${esc(book.title)}》.md 上传到心得仓库,
          或<button type="button" class="notes-retry" id="notesEditBtn">去编辑填写链接</button></div>
      </div>`;
    $('#notesEditBtn').addEventListener('click', () => openBookModal(book));
  } else {
    body.innerHTML = '<div class="detail-notes"><div class="notes-state">正在加载读书心得…</div></div>';
    loadNotes(body.querySelector('.detail-notes'), src, autoNotes, book.title);
  }
}

function loadNotes(box, url, auto = false, title = '') {
  const head = '<div class="notes-head"><span class="notes-orn">❖</span> 读书心得</div>';
  api('/api/notes?url=' + encodeURIComponent(url)).then((data) => {
    box.innerHTML = head +
      `<div class="markdown-body">${DOMPurify.sanitize(marked.parse(data.content))}</div>`;
  }).catch((e) => {
    const notFound = auto && /HTTP 404/.test(e.message);
    // 按书名自动匹配 404 属于"还没上传"的引导,不是错误,用中性色
    const msg = notFound
      ? `仓库里还没有《${esc(title)}》.md —— 把心得文件按书名命名后上传即可,或在编辑里填写心得链接`
      : `心得加载失败:${esc(e.message)}`;
    box.innerHTML = head +
      `<div class="notes-state${notFound ? '' : ' notes-error'}">${msg}
        <button type="button" class="notes-retry">重试</button></div>`;
    box.querySelector('.notes-retry').addEventListener('click', () => {
      box.innerHTML = '<div class="notes-state">正在加载读书心得…</div>';
      loadNotes(box, url, auto, title);
    });
  });
}

// 返回按钮:有历史回历史,直接输入 URL 进来的回书架(与侧滑返回同一语义)
$('#notesBack').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = '/shelf';
});

// 本页编辑保存后重渲染(心得文件名可能变了)
document.addEventListener('books-changed', () => openNotesPage(NOTES_BOOK_ID));

// 心得自动匹配依赖 settings.notesRepo,等首屏拉取完成再渲染
if (NOTES_BOOK_ID) settingsReady.then(() => openNotesPage(NOTES_BOOK_ID));
