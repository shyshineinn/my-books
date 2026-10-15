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

/* ============ 启动 ============ */
load();
