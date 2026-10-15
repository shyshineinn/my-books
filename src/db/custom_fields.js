/* ============================================================
 * 自定义字段数据访问层(对标 calibre db/custom_columns.py + write.py 的值写入)
 *
 * 依赖方向纪律(必须遵守):与 categories.js / book_files.js / saved_searches.js
 * 同构 —— 只接收调用方传入的 db 句柄,绝不在模块顶层 require ./index。
 * 理由见 PROJECT_MEMORY §7 的教训:源文件 require 单例会让测试写进真实库。
 * 本模块只依赖 node: 内置与 core/custom_fields(纯规则)。
 *
 * 两类操作泾渭分明:
 *   · 注册表 CRUD(listColumns / addColumn / updateColumn / removeColumn)
 *   · 取值读写(getValues / setValues / getAllValues)
 *
 * 「软删除」语义(照搬 calibre backend.py:1538-1541 的 mark_for_delete):
 *   removeColumn 默认只置 mark_for_delete=1,字段定义与取值都留着 ——
 *   误删可救。purgeColumn 才真删(值随外键 CASCADE 一起走)。
 * ============================================================ */

const core = require('../core/custom_fields');

function now() {
  return new Date().toISOString();
}

/* ---------- 注册表读取 ---------- */

// 所有"活着"的字段,按 display_order、id 排序。
// 默认过滤掉软删除的 —— 调用方要含已删的(如回收站视图)显式传 includeDeleted。
function listColumns(handleDb, { includeDeleted = false } = {}) {
  const where = includeDeleted ? '' : 'WHERE mark_for_delete = 0';
  return handleDb
    .prepare(`SELECT * FROM custom_columns ${where} ORDER BY display_order, id`)
    .all()
    .map(core.columnFromRow);
}

function getColumnByLabel(handleDb, label) {
  const row = handleDb
    .prepare('SELECT * FROM custom_columns WHERE label = ? COLLATE NOCASE')
    .get(String(label || '').trim());
  return core.columnFromRow(row);
}

function getColumnById(handleDb, id) {
  const row = handleDb.prepare('SELECT * FROM custom_columns WHERE id = ?').get(id);
  return core.columnFromRow(row);
}

/* ---------- 注册表写入 ---------- */

// 新建字段:校验先在 core 层做完(调用方负责),这里只处理"落库 + 唯一性"。
// 与 calibre 一致:label 冲突是明确错误(它靠 UNIQUE(label) 报错,这里转成 code)。
// 返回 { ok, error, code, column }。
function addColumn(handleDb, def) {
  const ts = now();
  // display_order 取当前最大值 +1,保证新字段排在最后(用户可以改)
  const maxRow = handleDb.prepare('SELECT MAX(display_order) AS m FROM custom_columns').get();
  const order = (maxRow && maxRow.m != null ? maxRow.m : 0) + 1;
  try {
    const r = handleDb.prepare(`
      INSERT INTO custom_columns (label, name, datatype, is_multiple, options, display_order, mark_for_delete, created_at, updated_at)
      VALUES (@label, @name, @datatype, @is_multiple, @options, @display_order, 0, @ts, @ts)
    `).run({
      label: def.label,
      name: def.name,
      datatype: def.datatype,
      is_multiple: def.is_multiple ? 1 : 0,
      options: JSON.stringify(def.options || []),
      display_order: order,
      ts,
    });
    return { ok: true, error: '', column: getColumnById(handleDb, r.lastInsertRowid) };
  } catch (err) {
    if (/UNIQUE constraint failed: custom_columns\.label/i.test(err.message)) {
      return { ok: false, error: `字段「${def.label}」已存在`, code: 'CONFLICT', column: null };
    }
    // schema 级 CHECK(datatype 白名单)被触发:说明 core 的校验清单与迁移不同步
    if (/CHECK constraint failed/i.test(err.message)) {
      return { ok: false, error: '字段类型不被支持', code: 'VALIDATION', column: null };
    }
    throw err;
  }
}

// 改字段:只允许改 name / options / display_order。
// **datatype 与 is_multiple 一律不可改** —— 改类型会让已存的值失去解释方式
// (如 text 改 int,库里存的 "abc" 就永远解释不通了)。这是本项目的取舍:
// calibre 靠 GUI 不给入口,这里在数据层直接拒绝,front 与 API 都绕不过去。
// 需要换类型 = 删掉重建(用户的显式选择)。
function updateColumn(handleDb, id, patch) {
  const existing = getColumnById(handleDb, id);
  if (!existing) return { ok: false, error: '字段不存在', code: 'NOT_FOUND', column: null };

  const src = patch && typeof patch === 'object' ? patch : {};
  if ('datatype' in src && String(src.datatype).toLowerCase() !== existing.datatype) {
    return { ok: false, error: '字段类型不可修改;如需换类型请先删除该字段再新建', code: 'VALIDATION', column: null };
  }
  if ('is_multiple' in src) {
    const want = src.is_multiple === true || src.is_multiple === 1 || src.is_multiple === '1';
    if (want !== !!existing.is_multiple) {
      return { ok: false, error: '多值设置不可修改;如需变更请先删除该字段再新建', code: 'VALIDATION', column: null };
    }
  }

  const name = src.name !== undefined ? String(src.name).trim() : existing.name;
  if (!name) return { ok: false, error: '字段名称不能为空', code: 'VALIDATION', column: null };
  if (name.length > 60) return { ok: false, error: '字段名称不能超过 60 个字符', code: 'VALIDATION', column: null };

  let options = existing.options;
  if (existing.datatype === 'enumeration' && src.options !== undefined) {
    options = core.parseOptions(src.options);
    if (!options.length) return { ok: false, error: '枚举类型至少要提供一个可选值', code: 'VALIDATION', column: null };
  }

  const order = src.display_order !== undefined && Number.isFinite(Number(src.display_order))
    ? Number(src.display_order)
    : existing.display_order;

  handleDb.prepare(
    'UPDATE custom_columns SET name = ?, options = ?, display_order = ?, updated_at = ? WHERE id = ?'
  ).run(name, JSON.stringify(options), order, now(), id);

  return { ok: true, error: '', column: getColumnById(handleDb, id) };
}

// 软删除:置标记,定义与取值都保留(可被 restoreColumn 救回)
function removeColumn(handleDb, id) {
  const existing = getColumnById(handleDb, id);
  if (!existing) return { ok: false, error: '字段不存在', code: 'NOT_FOUND' };
  handleDb.prepare('UPDATE custom_columns SET mark_for_delete = 1, updated_at = ? WHERE id = ?').run(now(), id);
  return { ok: true, error: '' };
}

function restoreColumn(handleDb, id) {
  const existing = getColumnById(handleDb, id);
  if (!existing) return { ok: false, error: '字段不存在', code: 'NOT_FOUND' };
  handleDb.prepare('UPDATE custom_columns SET mark_for_delete = 0, updated_at = ? WHERE id = ?').run(now(), id);
  return { ok: true, error: '' };
}

// 物理删除:值随 book_custom_values 的外键 CASCADE 一起消失。
// 调用方负责事务边界(routes 层包一层)。
function purgeColumn(handleDb, id) {
  const existing = getColumnById(handleDb, id);
  if (!existing) return { ok: false, error: '字段不存在', code: 'NOT_FOUND' };
  handleDb.prepare('DELETE FROM custom_columns WHERE id = ?').run(id);
  return { ok: true, error: '' };
}

/* ---------- 取值读写 ---------- */

// 读某本书的全部自定义值 → { label: 展示文本, ... }(只含非空值)
function getValues(handleDb, bookId, { columns = null } = {}) {
  const cols = columns || listColumns(handleDb);
  if (!cols.length) return {};
  const byId = new Map(cols.map((c) => [c.id, c]));
  const rows = handleDb
    .prepare('SELECT column_id, value FROM book_custom_values WHERE book = ?')
    .all(bookId);
  const out = {};
  for (const r of rows) {
    const col = byId.get(r.column_id);
    if (!col) continue;                       // 字段已被软删/物理删,值忽略
    const text = core.displayValue(col, r.value);
    if (text) out[col.label] = text;
  }
  return out;
}

// 读某本书的原始值(label → 存储串),前端表单回填用
function getRawValues(handleDb, bookId, { columns = null } = {}) {
  const cols = columns || listColumns(handleDb);
  if (!cols.length) return {};
  const byId = new Map(cols.map((c) => [c.id, c]));
  const rows = handleDb
    .prepare('SELECT column_id, value FROM book_custom_values WHERE book = ?')
    .all(bookId);
  const out = {};
  for (const r of rows) {
    const col = byId.get(r.column_id);
    if (!col) continue;
    if (r.value === '') continue;
    // 多值字段回填成数组,前端好渲染输入框(单值字段给字符串)
    if (col.is_multiple) {
      try {
        const arr = JSON.parse(r.value);
        out[col.label] = Array.isArray(arr) ? arr : r.value;
      } catch { out[col.label] = r.value; }
    } else {
      out[col.label] = r.value;
    }
  }
  return out;
}

// 写入一本书的自定义值。
// values 的键是 label、值已是 core.normalizeBookValues 规范化后的字符串。
// 语义:**整体替换传入的字段**,未出现在 values 里的字段保持不动
// (与 put 的局部更新语义一致,避免前端只提交部分字段时清空其它字段)。
// 空值('')等于删除该行 —— 不在值表里留空行,列表查询更干净。
//
// 调用方负责事务边界(与 categories.js 同纪律:routes 层单次操作包一次)。
function setValues(handleDb, bookId, values) {
  const src = values && typeof values === 'object' ? values : {};
  const labels = Object.keys(src);
  if (!labels.length) return 0;

  const cols = listColumns(handleDb);
  const byLabel = new Map(cols.map((c) => [c.label, c]));
  const del = handleDb.prepare('DELETE FROM book_custom_values WHERE book = ? AND column_id = ?');
  const upsert = handleDb.prepare(`
    INSERT INTO book_custom_values (book, column_id, value, updated_at)
    VALUES (@book, @column_id, @value, @ts)
    ON CONFLICT(book, column_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const ts = now();
  let touched = 0;
  for (const label of labels) {
    const col = byLabel.get(label);
    if (!col) continue;                       // 未知 label:上层已校验,这里再兜一层
    const value = String(src[label] == null ? '' : src[label]);
    if (value === '') {
      del.run(bookId, col.id);
    } else {
      upsert.run({ book: bookId, column_id: col.id, value, ts });
    }
    touched += 1;
  }
  return touched;
}

// 批量取多本书的值,返回 { bookId: { label: 展示文本 } }。
// 列表页要给每本书渲染自定义字段时,避免 N+1 查询 —— 一次查完内存分组。
function getValuesForBooks(handleDb, bookIds, { columns = null } = {}) {
  const ids = [...new Set((bookIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return {};
  const cols = columns || listColumns(handleDb);
  if (!cols.length) return {};
  const byId = new Map(cols.map((c) => [c.id, c]));
  const placeholders = ids.map(() => '?').join(',');
  const rows = handleDb
    .prepare(`SELECT book, column_id, value FROM book_custom_values WHERE book IN (${placeholders})`)
    .all(...ids);
  const out = {};
  for (const r of rows) {
    const col = byId.get(r.column_id);
    if (!col) continue;
    const text = core.displayValue(col, r.value);
    if (!text) continue;
    if (!out[r.book]) out[r.book] = {};
    out[r.book][col.label] = text;
  }
  return out;
}

// 清理"字段已物理删除后"的孤儿值行。外键 CASCADE 已能自动处理,
// 这里作为兜底(例如从旧备份恢复、或有人手工改过库) —— 与 categories.pruneOrphans 同思路。
function pruneOrphanValues(handleDb) {
  const r = handleDb.prepare(
    'DELETE FROM book_custom_values WHERE column_id NOT IN (SELECT id FROM custom_columns)'
  ).run();
  return r.changes || 0;
}

module.exports = {
  listColumns,
  getColumnByLabel,
  getColumnById,
  addColumn,
  updateColumn,
  removeColumn,
  restoreColumn,
  purgeColumn,
  getValues,
  getRawValues,
  setValues,
  getValuesForBooks,
  pruneOrphanValues,
};
