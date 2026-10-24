/* ============================================================
 * 读书心得页(/notes/:id)
 *
 * 心得正文存在服务器上(notes-files/{id}.md),GET /api/books/:id/notes 读取,
 * 页面内可编辑并保存回服务器(带 expected_updated_at 防并发覆盖)。
 * ============================================================ */

const NOTES_BOOK_ID = Number((location.pathname.match(/^\/notes\/(\d+)/) || [])[1] || 0);

const notesState = {
  book: null,
  bookId: 0,
  content: '',
  serverUpdatedAt: null,
  hasServerNotes: false,
  editing: false,
};

let notesLoadToken = 0;

async function openNotesPage(id) {
  const token = ++notesLoadToken;
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
  if (token !== notesLoadToken) return;

  notesState.book = book;
  notesState.bookId = id;
  notesState.content = '';
  notesState.serverUpdatedAt = null;
  notesState.hasServerNotes = false;
  notesState.editing = false;

  document.title = `《${book.title}》读书心得 · My books`;
  $('#notesCover').innerHTML = coverHtml(book);
  $('#notesTitle').textContent = book.title;
  const dates = [book.start_date, book.finish_date].filter(Boolean);
  $('#notesMeta').innerHTML =
    (book.author ? `<span class="nm-author">${esc(book.author)}</span>` : '') +
    `<span class="status-inline ${book.status}">${STATUS_LABEL[book.status]}</span>` +
    (dates.length ? `<span class="nm-date">${esc(dates.join(' · '))}</span>` : '');

  setNotesEditButton(false);
  const body = $('#notesPageBody');
  body.innerHTML = '<div class="detail-notes"><div class="notes-state">正在加载读书心得…</div></div>';

  // 服务器心得(公开 GET,不依赖 admin token)
  let server = null;
  try {
    server = await api('/api/books/' + id + '/notes');
  } catch (e) {
    if (token !== notesLoadToken) return;
    renderNotesError(e.message, () => openNotesPage(id));
    setNotesEditButton(false);
    return;
  }
  if (token !== notesLoadToken) return;

  if (server && server.has_notes) {
    notesState.content = server.content || '';
    notesState.serverUpdatedAt = server.updated_at || null;
    notesState.hasServerNotes = true;
    renderNotes();
    setNotesEditButton(true, '编辑心得');
    return;
  }

  renderNotesEmpty('这本书还没有读书心得。');
  setNotesEditButton(true, '新建心得');
}

function renderNotes() {
  const body = $('#notesPageBody');
  body.innerHTML = `
    <div class="detail-notes">
      <div class="notes-head">
        <span class="notes-orn">❖</span> 读书心得
      </div>
      <div class="markdown-body">${DOMPurify.sanitize(marked.parse(notesState.content))}</div>
    </div>`;
}

function renderNotesEmpty(message) {
  const body = $('#notesPageBody');
  body.innerHTML = `<div class="detail-notes notes-empty"><div class="notes-state">${message}</div></div>`;
}

function renderNotesError(message, onRetry) {
  const body = $('#notesPageBody');
  body.innerHTML = `<div class="detail-notes"><div class="notes-state notes-error">心得加载失败:${esc(message)}
    <button type="button" class="notes-retry">重试</button></div></div>`;
  body.querySelector('.notes-retry')?.addEventListener('click', onRetry);
}

function setNotesEditButton(visible, label) {
  const btn = $('#notesEditBtn');
  if (!btn) return;
  btn.hidden = !visible;
  btn.textContent = label || '编辑心得';
  btn.onclick = () => startNotesEditor();
}

function startNotesEditor() {
  if (notesState.editing) return;
  notesState.editing = true;
  setNotesEditButton(false);
  const body = $('#notesPageBody');
  body.innerHTML = `
    <div class="detail-notes">
      <div class="notes-head"><span class="notes-orn">❖</span> 编辑读书心得</div>
      <textarea id="notesEditor" class="notes-editor" spellcheck="false"></textarea>
      <div class="notes-editor-actions">
        <button type="button" id="notesCancel" class="btn btn-ghost">取消</button>
        <button type="button" id="notesSave" class="btn">保存</button>
      </div>
      <div id="notesEditorError" class="notes-state notes-error notes-editor-error" hidden></div>
    </div>`;
  const editor = $('#notesEditor');
  editor.value = notesState.content;
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  $('#notesCancel').addEventListener('click', cancelNotesEditor);
  $('#notesSave').addEventListener('click', saveNotesEditor);
}

function cancelNotesEditor() {
  notesState.editing = false;
  if (notesState.content) {
    renderNotes();
    setNotesEditButton(true, '编辑心得');
  } else {
    renderNotesEmpty('这本书还没有读书心得。');
    setNotesEditButton(true, '新建心得');
  }
}

function showEditorError(message) {
  const box = $('#notesEditorError');
  if (!box) return;
  box.hidden = !message;
  box.textContent = message || '';
}

async function saveNotesEditor() {
  const saveBtn = $('#notesSave');
  const editor = $('#notesEditor');
  if (!saveBtn || !editor) return;
  const content = editor.value;
  saveBtn.disabled = true;
  saveBtn.textContent = '保存中…';
  showEditorError('');

  const putNotes = (expected) => api('/api/books/' + notesState.bookId + '/notes', {
    method: 'PUT',
    body: JSON.stringify({ content, expected_updated_at: expected }),
  });

  try {
    let saved;
    try {
      saved = await putNotes(notesState.serverUpdatedAt);
    } catch (e) {
      // 409:服务器已有新版本。用户确认后用最新 updated_at 覆盖重试。
      if (/已更新/.test(e.message) && confirm('服务器心得已更新,是否用当前编辑内容覆盖?')) {
        const current = await api('/api/books/' + notesState.bookId + '/notes');
        notesState.serverUpdatedAt = current.updated_at || null;
        saved = await putNotes(notesState.serverUpdatedAt);
      } else {
        throw e;
      }
    }

    notesState.content = content;
    notesState.serverUpdatedAt = saved.updated_at || null;
    notesState.hasServerNotes = true;
    notesState.editing = false;
    renderNotes();
    setNotesEditButton(true, '编辑心得');
    toast('心得已保存');
    notifyBooksChanged();
  } catch (e) {
    showEditorError(e.message || '保存失败');
    saveBtn.disabled = false;
    saveBtn.textContent = '保存';
  }
}

// 返回按钮:有历史回历史,直接输入 URL 进来的回书架(与侧滑返回同一语义)
$('#notesBack').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = '/shelf';
});

// 其它编辑弹窗保存后重渲染(笔记文件可能变化)
document.addEventListener('books-changed', () => openNotesPage(NOTES_BOOK_ID));

if (NOTES_BOOK_ID) openNotesPage(NOTES_BOOK_ID);
