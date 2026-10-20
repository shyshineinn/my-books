/* ============================================================
 * 分类管理页(/tags)—— 标签 / 作者 双列管理
 *
 * 真源是归一化后的 tags / authors 表(见 src/db/categories),
 * 每行显示「名称 + 引用本书数」;点名称跳书架按该分类筛选(?tag= / ?author=),
 * 行内三个操作:重命名(同步所有书)、合并(归并同义词)、删除(仅解除分类)。
 * 重命名撞已有同名 = 服务端自动等价合并;删除后服务端顺手清孤儿。
 *
 * 数据形状:GET /api/tags、/api/authors 返回 [{id, name, count}]。
 * 写操作(POST rename/merge、DELETE)成功后各返回该 kind 的最新列表,
 * 直接用它重渲染 —— 不再二次 GET,省一次往返也避免竞态。
 * ============================================================ */

const cats = { tags: [], authors: [] };
const KIND_LABEL = { tags: '标签', authors: '作者' };
let mergeCtx = null; // { kind, fromId, fromName }

// 自定义字段的三份视图:全部 / 生效中 / 已删除(可恢复)
const fieldsState = { all: [], active: [], deleted: [] };

function shelfHref(kind, name) {
  const key = kind === 'tags' ? 'tag' : 'author';
  return '/shelf?' + key + '=' + encodeURIComponent(name);
}

function renderList(kind, items) {
  const box = kind === 'tags' ? $('#tagsList') : $('#authorsList');
  if (!items.length) {
    box.innerHTML = `<p class="cat-empty-row">暂无${KIND_LABEL[kind]}</p>`;
    return;
  }
  box.innerHTML = items.map((it) => `
    <div class="cat-row" data-id="${it.id}">
      <a class="cat-name" href="${esc(shelfHref(kind, it.name))}" title="在书架中筛选「${esc(it.name)}」">${esc(it.name)}</a>
      <span class="cat-n">${it.count}</span>
      <div class="cat-ops">
        <button type="button" class="cat-op" data-act="rename" aria-label="重命名「${esc(it.name)}」" title="重命名">✎</button>
        <button type="button" class="cat-op" data-act="merge" aria-label="合并「${esc(it.name)}」" title="合并到…">⇄</button>
        <button type="button" class="cat-op" data-act="delete" aria-label="删除「${esc(it.name)}」" title="删除">✕</button>
      </div>
    </div>`).join('');
}

function renderAll() {
  $('#tagsCount').textContent = `${cats.tags.length} 个`;
  $('#authorsCount').textContent = `${cats.authors.length} 个`;
  renderList('tags', cats.tags);
  renderList('authors', cats.authors);
}

async function load() {
  try {
    const [tags, authors] = await Promise.all([api('/api/tags'), api('/api/authors')]);
    cats.tags = tags;
    cats.authors = authors;
  } catch (e) {
    toast(e.message, true);
    cats.tags = []; cats.authors = [];
  }
  renderAll();
}

// 服务端写操作后统一收尾:换列表、作废统计缓存、重渲染、提示
function afterMutation(kind, list, msg) {
  cats[kind] = list;
  invalidateSharedStats();   // topTags 影响书架下拉与编辑框标签建议
  renderAll();
  toast(msg);
}

/* ---------- 重命名 ---------- */
async function renameItem(kind, id) {
  const item = cats[kind].find((x) => String(x.id) === String(id));
  if (!item) return;
  const input = prompt(`重命名${KIND_LABEL[kind]}「${item.name}」为:`, item.name);
  if (input === null) return;                 // 取消
  const name = input.trim();
  if (!name) { toast(`${KIND_LABEL[kind]}名不能为空`, true); return; }
  if (name === item.name) return;             // 未改动
  try {
    const res = await api(`/api/${kind}/rename`, { method: 'POST', body: JSON.stringify({ id: Number(id), name }) });
    afterMutation(kind, res[kind], '已重命名,相关书籍已同步');
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- 删除(仅解除分类) ---------- */
async function deleteItem(kind, id) {
  const item = cats[kind].find((x) => String(x.id) === String(id));
  if (!item) return;
  if (!confirm(`删除${KIND_LABEL[kind]}「${item.name}」?将从 ${item.count} 本书上解除它(书籍本身保留),此操作不可恢复。`)) return;
  try {
    const res = await api(`/api/${kind}/${id}`, { method: 'DELETE' });
    afterMutation(kind, res[kind], '已删除');
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- 合并:弹窗选目标 ---------- */
function openMerge(kind, id) {
  const from = cats[kind].find((x) => String(x.id) === String(id));
  if (!from) return;
  const targets = cats[kind].filter((x) => String(x.id) !== String(id));
  if (!targets.length) { toast(`没有其他${KIND_LABEL[kind]}可合并到`, true); return; }
  mergeCtx = { kind, fromId: from.id, fromName: from.name };
  $('#mergeTitle').textContent = `合并${KIND_LABEL[kind]}`;
  $('#mergeDesc').textContent = `把「${from.name}」下的 ${from.count} 本书并入所选${KIND_LABEL[kind]},合并后「${from.name}」自动删除。`;
  const sel = $('#mergeTarget');
  sel.innerHTML = targets.map((t) => `<option value="${t.id}">${esc(t.name)}(${t.count})</option>`).join('');
  sel.value = String(targets[0].id);
  syncCustomSelect(sel);
  $('#mergeError').textContent = '';
  openModal('#mergeModal');
}

async function confirmMerge() {
  if (!mergeCtx) return;
  const { kind, fromName } = mergeCtx;
  const to = Number($('#mergeTarget').value);
  if (!to) return;
  try {
    const res = await api(`/api/${kind}/merge`, {
      method: 'POST', body: JSON.stringify({ from: mergeCtx.fromId, to }),
    });
    mergeCtx = null;
    closeModals();
    afterMutation(kind, res[kind], `「${fromName}」已并入目标${KIND_LABEL[kind]}`);
  } catch (e) {
    $('#mergeError').textContent = e.message;
  }
}

/* ---------- 事件绑定 ---------- */
function bindList(kind, sel) {
  $(sel).addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-op');
    if (!btn) return;                  // 点名称(链接)让浏览器自然跳转
    const id = btn.closest('.cat-row').dataset.id;
    const act = btn.dataset.act;
    if (act === 'rename') renameItem(kind, id);
    else if (act === 'merge') openMerge(kind, id);
    else if (act === 'delete') deleteItem(kind, id);
  });
}

initCustomSelect($('#mergeTarget'));
bindList('tags', '#tagsList');
bindList('authors', '#authorsList');
$('#mergeConfirm').addEventListener('click', confirmMerge);

/* ============ 自定义字段管理(对标 calibre 自定义列) ============
 * 字段定义存在服务端(custom_columns 表),这里只做增删改的入口。
 * 删除是软删除(可恢复);「彻底删除」会连所有取值一起清掉,故二次确认。
 * 任何变更后必须让编辑弹窗里的定义缓存失效 —— 用 localStorage 戳跨页通信:
 * 书架页在启动时读 STAMP_KEY,发现戳变了就重新拉定义。 */

const FIELDS_STAMP_KEY = 'mybooks.customFields.stamp';
let fieldCtx = null;        // { id } 编辑态;null = 新建

const DATATYPE_LABEL = {
  text: '单行文本', comments: '长文本', int: '整数', float: '小数',
  rating: '评分', date: '日期', bool: '是/否', enumeration: '枚举', series: '系列',
};

// 通知其它页面:字段定义变了(下次加载书架时重新拉)
function bumpFieldsStamp() {
  try { localStorage.setItem(FIELDS_STAMP_KEY, String(Date.now())); } catch { /* 隐私模式等忽略 */ }
}

function renderFields() {
  const list = $('#fieldsList');
  const active = fieldsState.active;
  $('#fieldsCount').textContent = `${active.length} 个`;

  if (!active.length) {
    list.innerHTML = '<p class="cat-empty-row">还没有自定义字段。点右上「新建字段」加一个,比如「系列」或「页数」。</p>';
  } else {
    list.innerHTML = active.map((c) => `
      <div class="cat-row" data-field-id="${c.id}">
        <span class="field-name">${esc(c.name)}</span>
        <code class="field-label">#${esc(c.label)}</code>
        <span class="field-type">${esc(DATATYPE_LABEL[c.datatype] || c.datatype)}${c.is_multiple ? ' · 多值' : ''}</span>
        <span class="cat-n" title="已填写的书籍数">${c.usage}</span>
        <div class="cat-ops">
          <button type="button" class="cat-op" data-fact="edit" aria-label="编辑「${esc(c.name)}」" title="编辑">✎</button>
          <button type="button" class="cat-op" data-fact="delete" aria-label="删除「${esc(c.name)}」" title="删除(可恢复)">✕</button>
        </div>
      </div>`).join('');
  }

  // 已删除字段(可恢复)
  const deleted = fieldsState.deleted;
  const box = $('#fieldsDeletedBox');
  if (!deleted.length) {
    box.classList.add('hidden');
    $('#fieldsDeletedList').innerHTML = '';
  } else {
    box.classList.remove('hidden');
    $('#fieldsDeletedList').innerHTML = deleted.map((c) => `
      <div class="cat-row is-deleted" data-field-id="${c.id}">
        <span class="field-name">${esc(c.name)}</span>
        <code class="field-label">#${esc(c.label)}</code>
        <span class="field-type">${esc(DATATYPE_LABEL[c.datatype] || c.datatype)}</span>
        <span class="cat-n" title="仍保留的取值数">${c.usage}</span>
        <div class="cat-ops">
          <button type="button" class="cat-op" data-fact="restore" title="恢复该字段">↺</button>
          <button type="button" class="cat-op danger" data-fact="purge" title="彻底删除(连同取值,不可恢复)">🗑</button>
        </div>
      </div>`).join('');
  }
}

async function loadFields() {
  let all = [];
  try {
    all = await api('/api/custom-fields?includeDeleted=1');
  } catch (e) {
    toast(e.message, true);
  }
  fieldsState.all = all;
  fieldsState.active = all.filter((c) => !c.mark_for_delete);
  fieldsState.deleted = all.filter((c) => c.mark_for_delete);
  renderFields();
}

/* ---------- 新建 / 编辑弹窗 ---------- */
function syncFieldModalVisibility() {
  const dt = $('#cfDatatype').value;
  const editing = !!fieldCtx;
  // 枚举才显示选项输入
  $('#cfOptionsField').classList.toggle('hidden', dt !== 'enumeration');
  // 只有 text 能多值:其余类型把选择器禁掉(与后端同一条规则,前端先给出反馈)
  const canMultiple = dt === 'text';
  $('#cfMultiple').disabled = !canMultiple || editing;
  if (!canMultiple) $('#cfMultiple').value = '0';
  if (editing) $('#cfMultiple').disabled = true;
  // 编辑态锁定类型与多值
  $('#cfDatatype').disabled = editing;
  $('#cfLabel').disabled = editing;
  $('#cfTypeLockedHint').hidden = !editing;
}

function openFieldModal(col) {
  fieldCtx = col ? { id: col.id } : null;
  $('#fieldModalTitle').textContent = col ? `编辑字段「${col.name}」` : '新建字段';
  $('#cfName').value = col ? col.name : '';
  $('#cfLabel').value = col ? col.label : '';
  $('#cfDatatype').value = col ? col.datatype : 'text';
  $('#cfMultiple').value = col && col.is_multiple ? '1' : '0';
  $('#cfOptions').value = col && col.options ? col.options.join(', ') : '';
  $('#fieldError').textContent = '';
  syncFieldModalVisibility();
  openModal('#fieldModal');
  setTimeout(() => { (col ? $('#cfName') : $('#cfName')).focus(); }, 60);
}

async function saveField() {
  const errEl = $('#fieldError');
  errEl.textContent = '';
  const name = $('#cfName').value.trim();
  const label = $('#cfLabel').value.trim().toLowerCase();
  if (!name) { errEl.textContent = '请填写字段名称'; return; }
  if (!fieldCtx && !label) { errEl.textContent = '请填写字段标识(用于检索)'; return; }

  const body = {
    name,
    datatype: $('#cfDatatype').value,
    is_multiple: $('#cfMultiple').value === '1',
    options: $('#cfOptionsField').classList.contains('hidden') ? [] : $('#cfOptions').value,
  };
  if (!fieldCtx) body.label = label;

  const btn = $('#fieldSaveBtn');
  btn.disabled = true;
  try {
    if (fieldCtx) {
      const res = await api('/api/custom-fields/' + fieldCtx.id, { method: 'PUT', body: JSON.stringify(body) });
      fieldsState.all = res.columns;
      toast('字段已更新');
    } else {
      const res = await api('/api/custom-fields', { method: 'POST', body: JSON.stringify(body) });
      fieldsState.all = res.columns;
      toast('字段已创建,现在可以在书籍里填写了');
    }
    fieldCtx = null;
    bumpFieldsStamp();
    closeModals();
    await loadFields();
    // 字段增删会改变编辑弹窗的输入控件,让本站缓存的字段定义失效
    customColumnsLoaded = false;
    await loadCustomColumns(true);
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function deleteField(col) {
  const used = col.usage ? `它已被 ${col.usage} 本书填写` : '还没有书填写它';
  if (!confirm(`删除字段「${col.name}」?\n${used},${col.usage ? '取值会保留' : '可随时恢复'}。\n删除后该字段不再出现在书籍表单与检索里,但可以在下方「已删除的字段」中恢复。`)) return;
  try {
    const res = await api('/api/custom-fields/' + col.id, { method: 'DELETE' });
    fieldsState.all = res.columns;
    bumpFieldsStamp();
    await loadFields();
    customColumnsLoaded = false;
    await loadCustomColumns(true);
    toast('已删除(可恢复)');
  } catch (e) { toast(e.message, true); }
}

async function restoreField(col) {
  try {
    const res = await api(`/api/custom-fields/${col.id}/restore`, { method: 'POST' });
    fieldsState.all = res.columns;
    bumpFieldsStamp();
    await loadFields();
    customColumnsLoaded = false;
    await loadCustomColumns(true);
    toast('已恢复');
  } catch (e) { toast(e.message, true); }
}

async function purgeField(col) {
  const used = col.usage ? `,并永久删除 ${col.usage} 本书上填写的值` : '';
  if (!confirm(`彻底删除字段「${col.name}」?\n将移除字段定义${used}。\n此操作不可恢复(取值不会保留),确定继续?`)) return;
  try {
    const res = await api(`/api/custom-fields/${col.id}?purge=1`, { method: 'DELETE' });
    fieldsState.all = res.columns;
    bumpFieldsStamp();
    await loadFields();
    customColumnsLoaded = false;
    await loadCustomColumns(true);
    toast('已彻底删除');
  } catch (e) { toast(e.message, true); }
}

/* ---------- 事件绑定 ---------- */
$('#addFieldBtn').addEventListener('click', () => openFieldModal(null));
$('#fieldSaveBtn').addEventListener('click', saveField);
$('#cfDatatype').addEventListener('change', syncFieldModalVisibility);

$('#fieldsList').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-op');
  if (!btn) return;
  const col = fieldsState.active.find((c) => String(c.id) === btn.closest('.cat-row').dataset.fieldId);
  if (!col) return;
  if (btn.dataset.fact === 'edit') openFieldModal(col);
  else if (btn.dataset.fact === 'delete') deleteField(col);
});

$('#fieldsDeletedList').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-op');
  if (!btn) return;
  const col = fieldsState.deleted.find((c) => String(c.id) === btn.closest('.cat-row').dataset.fieldId);
  if (!col) return;
  if (btn.dataset.fact === 'restore') restoreField(col);
  else if (btn.dataset.fact === 'purge') purgeField(col);
});

/* ============ 重复书籍(查重 / 合并,对标 calibre Merge book records) ============ */

const dupState = { groups: [] };
const DUP_REASON = { isbn: 'ISBN 相同', title: '书名相同', title_fuzzy: '书名高度相似' };

function renderDuplicates() {
  $('#dupsCount').textContent = `${dupState.groups.length} 组`;
  const box = $('#dupsList');
  if (!dupState.groups.length) {
    box.innerHTML = '<p class="cat-empty-row">没有发现疑似重复书籍</p>';
    return;
  }
  box.innerHTML = dupState.groups.map((g, gi) => {
    const reason = DUP_REASON[g.reason] || '疑似重复';
    const score = g.reason === 'title_fuzzy' ? ` · 相似度 ${Math.round(g.score * 100)}%` : '';
    return `
      <div class="dup-group" data-group="${gi}">
        <div class="dup-head"><strong>${reason}</strong><span>${g.books.length} 本${score}</span></div>
        <div class="dup-books">
          ${g.books.map((b, bi) => `
            <label class="dup-book">
              <input type="radio" name="dupTarget${gi}" value="${b.id}" ${bi === 0 ? 'checked' : ''}>
              <span class="dup-info">
                <span class="dup-title">${esc(b.title)}</span>
                <span class="dup-meta">${esc(b.author || '未知作者')} · ${STATUS_LABEL[b.status] || b.status}${b.pub_year ? ' · ' + esc(b.pub_year) : ''}${b.isbn ? ' · ISBN ' + esc(b.isbn) : ''}${b.file_formats ? ' · ' + esc(b.file_formats) : ''}</span>
              </span>
            </label>`).join('')}
        </div>
        <div class="dup-actions">
          <button type="button" class="btn btn-danger-tint btn-sm" data-merge="${gi}">合并其余 ${g.books.length - 1} 本到所选</button>
        </div>
      </div>`;
  }).join('');
}

async function loadDuplicates() {
  try {
    const res = await api('/api/books/duplicates');
    dupState.groups = res.groups || [];
  } catch (e) {
    toast(e.message, true);
    dupState.groups = [];
  }
  renderDuplicates();
}

async function mergeDuplicateGroup(index) {
  const group = dupState.groups[index];
  if (!group) return;
  const selected = document.querySelector(`input[name="dupTarget${index}"]:checked`);
  if (!selected) return;
  const targetId = Number(selected.value);
  const target = group.books.find((b) => b.id === targetId);
  const sourceIds = group.books.filter((b) => b.id !== targetId).map((b) => b.id);
  if (!target || !sourceIds.length) return;
  if (!confirm(`把其余 ${sourceIds.length} 本合并到《${target.title}》?\n来源记录会被永久删除,此操作不可恢复。`)) return;

  try {
    const res = await api('/api/books/merge', {
      method: 'POST',
      body: JSON.stringify({ targetId, sourceIds }),
    });
    toast(`已合并 ${res.merged} 本到《${target.title}》`);
    invalidateSharedStats();
    notifyBooksChanged();
    await Promise.all([load(), loadFields(), loadDuplicates()]);
  } catch (e) {
    toast(e.message, true);
  }
}

$('#dupsList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-merge]');
  if (!btn) return;
  mergeDuplicateGroup(Number(btn.dataset.merge));
});
$('#dupsRefresh').addEventListener('click', loadDuplicates);

/* ============ 回收站(软删除的书籍,对标 calibre 最近删除) ============
 * 数据仍在 books 表里,恢复 = 清墓碑;彻底删除才清磁盘文件与关联数据。
 * 列表由 GET /api/books/trash 提供,days_left 由服务端按 14 天保留期计算。 */

const trashState = { books: [], retentionDays: 14 };

function renderTrash() {
  $('#trashCount').textContent = `${trashState.books.length} 本`;
  const box = $('#trashList');
  if (!trashState.books.length) {
    box.innerHTML = '<p class="cat-empty-row">回收站是空的</p>';
    return;
  }
  box.innerHTML = trashState.books.map((b) => {
    const deleted = String(b.deleted_at || '').slice(0, 10);
    const left = b.days_left > 0 ? `剩余 ${b.days_left} 天` : '即将清理';
    return `
      <div class="cat-row trash-row" data-id="${b.id}">
        <span class="trash-main">
          <span class="cat-name">${esc(b.title)}</span>
          ${b.author ? `<span class="trash-author">${esc(b.author)}</span>` : ''}
        </span>
        <span class="trash-meta">${deleted ? `删除于 ${esc(deleted)} · ` : ''}${left}</span>
        <div class="cat-ops">
          <button type="button" class="cat-op" data-tact="restore" aria-label="恢复《${esc(b.title)}》" title="恢复">↺</button>
          <button type="button" class="cat-op danger" data-tact="purge" aria-label="彻底删除《${esc(b.title)}》" title="彻底删除(不可恢复)">🗑</button>
        </div>
      </div>`;
  }).join('');
}

async function loadTrash() {
  try {
    const res = await api('/api/books/trash');
    trashState.books = res.books || [];
    trashState.retentionDays = Number(res.retention_days) || 14;
  } catch (e) {
    toast(e.message, true);
    trashState.books = [];
  }
  renderTrash();
}

async function restoreTrashBook(id) {
  try {
    await api(`/api/books/${id}/restore`, { method: 'POST' });
    toast('已恢复');
    invalidateSharedStats();
    notifyBooksChanged();
    await loadTrash();
  } catch (e) {
    toast(e.message, true);
  }
}

async function purgeTrashBook(id) {
  const book = trashState.books.find((b) => String(b.id) === String(id));
  if (!book) return;
  if (!confirm(`彻底删除《${book.title}》?\n封面与电子书文件会一并删除,此操作不可恢复。`)) return;
  try {
    await api(`/api/books/${id}?purge=1`, { method: 'DELETE' });
    toast('已彻底删除');
    await loadTrash();
  } catch (e) {
    toast(e.message, true);
  }
}

$('#trashList').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-op');
  if (!btn) return;
  const id = btn.closest('.cat-row').dataset.id;
  if (btn.dataset.tact === 'restore') restoreTrashBook(id);
  else if (btn.dataset.tact === 'purge') purgeTrashBook(id);
});

/* ---------- 启动 ---------- */
initCollapsibleSections('.cat-col', '.cat-head');
load();
loadFields();
loadDuplicates();
loadTrash();
