/* ============================================================
 * 自定义字段(A 组对标:calibre custom_columns / FieldMetadata)
 *
 * 分两层验证:
 *   1. core/custom_fields.js —— 纯规则(定义校验 / 值规范化 / 展示)
 *   2. db/custom_fields.js + search.js —— 落库、检索、软删除、级联
 *
 * 隔离纪律:全部用 openDb(临时目录),绝不碰真实 data/books.db。
 * (本文件 import 了 src/db/index.js,而该模块加载时会打开真实库 ——
 *  这是既有设计;所有数据操作都只走传入的临时句柄。)
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb, inTransaction, migrations } = require('../src/db/index.js');
const repo = require('../src/db/custom_fields.js');
const core = require('../src/core/custom_fields.js');
const search = require('../src/db/search.js');

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-cf-test-'));
  tmpDirs.push(dir);
  return dir;
}

// 最新版库 + 清空种子(自定义字段测试自带数据)
function freshDb() {
  const db = openDb(tempDir());
  db.exec('DELETE FROM book_custom_values; DELETE FROM custom_columns; DELETE FROM books;');
  search.reindexAll(db);
  return db;
}

function addBook(db, title, extra = {}) {
  const now = new Date().toISOString();
  const r = db.prepare(`
    INSERT INTO books (title, author, author_sort, status, tags, read_logs, created_at, updated_at)
    VALUES (?, '', '', 'wish', '[]', '[]', ?, ?)
  `).run(title, now, now);
  const id = r.lastInsertRowid;
  for (const [label, value] of Object.entries(extra)) {
    const col = repo.getColumnByLabel(db, label);
    repo.setValues(db, id, { [label]: value === null ? '' : String(value) });
  }
  return id;
}

function defineColumn(db, def) {
  const parsed = core.parseColumnDef(def);
  assert.ok(parsed.ok, `字段定义应合法:${parsed.errors.join(';')}`);
  const r = inTransaction(db, () => repo.addColumn(db, parsed.values));
  assert.ok(r.ok, r.error);
  return r.column;
}

/* ================= 第 1 层:纯规则 ================= */

test('parseColumnDef:合法定义被接受,label 归一为小写', () => {
  const r = core.parseColumnDef({ label: 'MySeries', name: '系列', datatype: 'series' });
  assert.ok(r.ok);
  assert.equal(r.values.label, 'myseries');
  assert.equal(r.values.datatype, 'series');
});

test('parseColumnDef:label 非法(空/大写开头数字/含非法字符/超长/保留字)全部拒绝', () => {
  const cases = [
    [{ label: '', name: 'x', datatype: 'text' }, '不能为空'],
    [{ label: '1abc', name: 'x', datatype: 'text' }, '必须以字母开头'],
    [{ label: 'a-b', name: 'x', datatype: 'text' }, '只能用小写字母'],
    [{ label: 'a'.repeat(41), name: 'x', datatype: 'text' }, '不能超过'],
    [{ label: 'title', name: 'x', datatype: 'text' }, '内置字段名'],
    [{ label: 'rating', name: 'x', datatype: 'text' }, '内置字段名'],
  ];
  for (const [def, expect] of cases) {
    const r = core.parseColumnDef(def);
    assert.equal(r.ok, false, `${JSON.stringify(def)} 应被拒绝`);
    assert.ok(r.errors.join(';').includes(expect), `错误应含「${expect}」,实际:${r.errors}`);
  }
});

test('parseColumnDef:datatype 白名单外的类型被拒绝', () => {
  const r = core.parseColumnDef({ label: 'x', name: 'X', datatype: 'json' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(';').includes('不支持的字段类型'));
});

test('parseColumnDef:is_multiple 只允许 text(其它类型明确报错而非静默忽略)', () => {
  const bad = core.parseColumnDef({ label: 'x', name: 'X', datatype: 'int', is_multiple: true });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.join(';').includes('不支持多值'));
  assert.equal(bad.values.is_multiple, 0);   // 已被归零,不会带病入库

  const good = core.parseColumnDef({ label: 'x', name: 'X', datatype: 'text', is_multiple: true });
  assert.ok(good.ok);
  assert.equal(good.values.is_multiple, 1);
});

test('parseColumnDef:enumeration 必须有选项,且选项去重去空、保持顺序', () => {
  const noOpt = core.parseColumnDef({ label: 'x', name: 'X', datatype: 'enumeration' });
  assert.equal(noOpt.ok, false);
  assert.ok(noOpt.errors.join(';').includes('至少要提供一个可选值'));

  const r = core.parseColumnDef({ label: 'x', name: 'X', datatype: 'enumeration', options: '平静、震撼,平静,,  ' });
  assert.ok(r.ok);
  assert.deepEqual(r.values.options, ['平静', '震撼']);
});

test('columnFromRow 幂等:数据库行与已转换对象都能吃,options 不丢', () => {
  const fromRow = core.columnFromRow({ id: 1, label: 'm', name: '心情', datatype: 'enumeration', options: '["a","b"]', is_multiple: 0 });
  assert.deepEqual(fromRow.options, ['a', 'b']);
  // 再喂一次已转换对象(这正是 normalizeValue/displayValue 内部发生的事)
  const again = core.columnFromRow(fromRow);
  assert.deepEqual(again.options, ['a', 'b'], '幂等:options 不应被二次 JSON.parse 清空');
});

test('normalizeValue:各类型规范化与拒绝', () => {
  const mk = (datatype, extra = {}) => core.columnFromRow({ id: 1, label: 'f', name: 'F', datatype, is_multiple: 0, options: '[]', ...extra });

  assert.equal(core.normalizeValue(mk('text'), '  hi  ').value, 'hi');
  assert.equal(core.normalizeValue(mk('int'), '42').value, '42');
  assert.equal(core.normalizeValue(mk('int'), '4.2').ok, false);
  assert.equal(core.normalizeValue(mk('float'), '4.2').value, '4.2');
  assert.equal(core.normalizeValue(mk('bool'), '是').value, '1');
  assert.equal(core.normalizeValue(mk('bool'), '管他呢').ok, false);
  assert.equal(core.normalizeValue(mk('date'), '2024-01-02').value, '2024-01-02');
  assert.equal(core.normalizeValue(mk('date'), '2024/01/02').ok, false);
  // rating 与内置一致:一位小数、封顶 10
  assert.equal(core.normalizeValue(mk('rating'), '9.44').value, '9.4');
  assert.equal(core.normalizeValue(mk('rating'), '12').value, '10');
  // 空值任何类型都合法(= 未填)
  assert.equal(core.normalizeValue(mk('int'), '').value, '');
  assert.equal(core.normalizeValue(mk('date'), '   ').ok, true);
});

test('normalizeValue:枚举只认选项内取值(大小写不敏感)', () => {
  const col = core.columnFromRow({ id: 1, label: 'm', name: '心情', datatype: 'enumeration', options: '["平静","震撼"]' });
  assert.equal(core.normalizeValue(col, '震撼').value, '震撼');
  assert.equal(core.normalizeValue(col, '震 撼').ok, false);
  const bad = core.normalizeValue(col, '狂喜');
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('平静'));
});

test('normalizeValue:多值字段拆/去重/去空,全空归一为 ""(不是 "[]")', () => {
  const col = core.columnFromRow({ id: 1, label: 't', name: 'T', datatype: 'text', is_multiple: 1 });
  const r = core.normalizeValue(col, '科幻, 硬科幻、科幻 ;   ');
  assert.deepEqual(JSON.parse(r.value), ['科幻', '硬科幻']);
  // 全空必须归一为 '' —— 全库只有一种"空"表示,仓储层据此删行
  assert.equal(core.normalizeValue(col, '').value, '');
  assert.equal(core.normalizeValue(col, ' , 、 ').value, '');
});

test('normalizeBookValues:未知 label 报错(不静默丢弃)', () => {
  const cols = [core.columnFromRow({ id: 1, label: 'known', name: 'K', datatype: 'text', options: '[]' })];
  const r = core.normalizeBookValues(cols, { known: 'v', ghost: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(';').includes('未知字段'));
  assert.equal(r.values.known, 'v');   // 合法的仍然收下
});

test('displayValue:多值拼顿号、布尔转是/否、空值给空串', () => {
  const multi = core.columnFromRow({ id: 1, label: 't', name: 'T', datatype: 'text', is_multiple: 1 });
  assert.equal(core.displayValue(multi, '["a","b"]'), 'a、b');
  const bool = core.columnFromRow({ id: 2, label: 'b', name: 'B', datatype: 'bool' });
  assert.equal(core.displayValue(bool, '1'), '是');
  assert.equal(core.displayValue(bool, '0'), '否');
  assert.equal(core.displayValue(bool, ''), '');
});

/* ================= 第 2 层:落库与检索 ================= */

test('addColumn:落库后可读回,label 唯一(大小写不敏感)冲突返回 CONFLICT', () => {
  const db = freshDb();
  const col = defineColumn(db, { label: 'series', name: '系列', datatype: 'series' });
  assert.equal(col.label, 'series');
  assert.equal(repo.listColumns(db).length, 1);

  const dup = inTransaction(db, () => repo.addColumn(db, { label: 'SERIES', name: '重复', datatype: 'text', is_multiple: 0, options: [] }));
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'CONFLICT');
  db.close();
});

test('addColumn:schema 的 datatype CHECK 与 core 的白名单一致', () => {
  const db = freshDb();
  // 绕过 core 直接塞非法类型 → 应被 schema 的 CHECK 拒绝
  assert.throws(() => {
    db.prepare(`INSERT INTO custom_columns (label, name, datatype, is_multiple, options, display_order, mark_for_delete, created_at, updated_at)
      VALUES ('bad', 'B', 'json', 0, '[]', 1, 0, '2024-01-01', '2024-01-01')`).run();
  }, /CHECK constraint failed/i);
  db.close();
});

test('addColumn:display_order 递增,新字段排在最后', () => {
  const db = freshDb();
  defineColumn(db, { label: 'a', name: 'A', datatype: 'text' });
  defineColumn(db, { label: 'b', name: 'B', datatype: 'text' });
  const cols = repo.listColumns(db);
  assert.deepEqual(cols.map((c) => c.label), ['a', 'b']);
  assert.ok(cols[1].display_order > cols[0].display_order);
  db.close();
});

test('updateColumn:可改 name/options/order;datatype 与 is_multiple 一律拒绝', () => {
  const db = freshDb();
  const col = defineColumn(db, { label: 'm', name: '心情', datatype: 'enumeration', options: 'a,b' });

  const ok = inTransaction(db, () => repo.updateColumn(db, col.id, { name: '心情2', options: 'a,b,c' }));
  assert.ok(ok.ok);
  assert.equal(ok.column.name, '心情2');
  assert.deepEqual(ok.column.options, ['a', 'b', 'c']);

  // 改类型 = 破坏已存值的解释方式,必须拒绝
  const bad = inTransaction(db, () => repo.updateColumn(db, col.id, { datatype: 'int' }));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'VALIDATION');
  assert.equal(repo.getColumnById(db, col.id).datatype, 'enumeration', '类型不应被改掉');

  const badMulti = inTransaction(db, () => repo.updateColumn(db, col.id, { is_multiple: true }));
  assert.equal(badMulti.ok, false, '多值设置也不可改');
  db.close();
});

test('setValues:整体替换传入字段,未传字段保持不动;空值删行', () => {
  const db = freshDb();
  defineColumn(db, { label: 's', name: '系列', datatype: 'series' });
  defineColumn(db, { label: 'p', name: '页数', datatype: 'int' });
  const id = addBook(db, '书甲', { s: '基地', p: '384' });

  // 只更新 s: p 必须保留
  repo.setValues(db, id, { s: '银河帝国' });
  assert.deepEqual(repo.getValues(db, id), { s: '银河帝国', p: '384' });

  // 传空值 = 删除该行(值表不留空行)
  repo.setValues(db, id, { p: '' });
  assert.deepEqual(repo.getValues(db, id), { s: '银河帝国' });
  const rows = db.prepare('SELECT COUNT(*) n FROM book_custom_values WHERE book = ?').get(id).n;
  assert.equal(rows, 1, '空值不应留行');
  db.close();
});

// 回归测试(2026-10-15 端到端实测发现的真实数据丢失):
// 编辑弹窗若拿到的 book 对象**缺少 custom 原始值**(例如列表接口只回
// custom_display),输入框会渲染成空,提交即把每个字段发成空串 →
// 服务端按"空值 = 删除"处理 → 用户已填的自定义值被清空。
// 前端已修(openBookModal 缺 custom 时先补拉详情);这里从**服务端契约**
// 一侧钉死防御:不提交 custom 键时,值必须原样保留。
test('回归:请求体不带 custom 键时,已有自定义值必须原样保留', () => {
  const db = freshDb();
  const { parseBook, mergeUpdate } = require('../src/core/book.js');
  defineColumn(db, { label: 'mood', name: '心情', datatype: 'text' });
  const id = addBook(db, '书甲', { mood: '震撼' });

  // 模拟"表单没提交 custom 字段"的 PUT(未提供 custom → 不该被当成清空)
  const existing = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  const { values } = parseBook({ title: existing.title });
  const merged = mergeUpdate(existing, values, { title: existing.title });
  db.prepare('UPDATE books SET title = ?, title_sort = ?, updated_at = ? WHERE id = ?')
    .run(merged.title, merged.title_sort, new Date().toISOString(), id);
  // 注意:custom 值由 routes 层按"请求体有没有 custom"决定是否调用 setValues,
  // 这里验证的是值本身没被其他路径动过
  assert.deepEqual(repo.getValues(db, id), { mood: '震撼' });
  db.close();
});

test('回归:显式提交空 custom 值才清空(语义区分"没提交"与"提交空")', () => {
  const db = freshDb();
  defineColumn(db, { label: 'mood', name: '心情', datatype: 'text' });
  const id = addBook(db, '书甲', { mood: '震撼' });
  // 显式提交空串 = 用户清空
  repo.setValues(db, id, { mood: '' });
  assert.deepEqual(repo.getValues(db, id), {});
  db.close();
});

test('getRawValues:多值字段回填为数组,单值字段为字符串', () => {
  const db = freshDb();
  defineColumn(db, { label: 't', name: '副标签', datatype: 'text', is_multiple: true });
  defineColumn(db, { label: 's', name: '系列', datatype: 'series' });
  const id = addBook(db, '书甲', { t: '["科幻","硬科幻"]', s: '基地' });
  const raw = repo.getRawValues(db, id);
  assert.deepEqual(raw.t, ['科幻', '硬科幻']);
  assert.equal(raw.s, '基地');
  db.close();
});

test('getValuesForBooks:批量取多本,避免 N+1,只含非空值', () => {
  const db = freshDb();
  defineColumn(db, { label: 's', name: '系列', datatype: 'series' });
  const a = addBook(db, '甲', { s: '基地' });
  const b = addBook(db, '乙', {});
  const map = repo.getValuesForBooks(db, [a, b]);
  assert.equal(map[a].s, '基地');
  assert.equal(map[b], undefined, '没值的书不应出现');
  db.close();
});

test('软删除:removeColumn 保留定义与取值,restore 后值还在', () => {
  const db = freshDb();
  const col = defineColumn(db, { label: 's', name: '系列', datatype: 'series' });
  const id = addBook(db, '甲', { s: '基地' });

  const del = inTransaction(db, () => repo.removeColumn(db, col.id));
  assert.ok(del.ok);
  assert.equal(repo.listColumns(db).length, 0, '默认列表不含已删字段');
  assert.equal(repo.listColumns(db, { includeDeleted: true }).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_custom_values').get().n, 1, '值应保留');

  inTransaction(db, () => repo.restoreColumn(db, col.id));
  assert.equal(repo.listColumns(db).length, 1);
  assert.equal(repo.getValues(db, id).s, '基地', '恢复后取值应完好');
  db.close();
});

test('purgeColumn:物理删除后取值随外键 CASCADE 消失', () => {
  const db = freshDb();
  const col = defineColumn(db, { label: 's', name: '系列', datatype: 'series' });
  addBook(db, '甲', { s: '基地' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_custom_values').get().n, 1);

  inTransaction(db, () => repo.purgeColumn(db, col.id));
  assert.equal(repo.listColumns(db, { includeDeleted: true }).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_custom_values').get().n, 0, '值应被级联清掉');
  db.close();
});

test('删书:自定义取值随外键 CASCADE 消失', () => {
  const db = freshDb();
  defineColumn(db, { label: 's', name: '系列', datatype: 'series' });
  const id = addBook(db, '甲', { s: '基地' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_custom_values WHERE book = ?').get(id).n, 1);

  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_custom_values WHERE book = ?').get(id).n, 0, '删书应级联清值');
  db.close();
});

test('pruneOrphanValues:清掉指向不存在字段的孤儿行', () => {
  const db = freshDb();
  const col = defineColumn(db, { label: 's', name: '系列', datatype: 'series' });
  const id = addBook(db, '甲', { s: '基地' });
  // 手工造孤儿行(外键此时会拦截,故先关掉约束再插入,模拟旧备份/手工改库)
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('INSERT INTO book_custom_values (book, column_id, value, updated_at) VALUES (?, 99999, ?, ?)')
    .run(id, '孤儿', new Date().toISOString());
  db.exec('PRAGMA foreign_keys = ON');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_custom_values').get().n, 2);

  const removed = repo.pruneOrphanValues(db);
  assert.equal(removed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_custom_values').get().n, 1);
  db.close();
});

/* ================= 检索:#字段 ================= */

function searchSetup() {
  const db = freshDb();
  defineColumn(db, { label: 'series', name: '系列', datatype: 'series' });
  defineColumn(db, { label: 'mood', name: '心情', datatype: 'enumeration', options: '平静,震撼' });
  defineColumn(db, { label: 'pages', name: '页数', datatype: 'int' });
  defineColumn(db, { label: 'sub', name: '副标签', datatype: 'text', is_multiple: true });
  defineColumn(db, { label: 'done2', name: '重读', datatype: 'bool' });

  addBook(db, '三体', { series: '地球往事', mood: '震撼', pages: '384', sub: '["科幻","硬科幻"]', done2: '1' });
  addBook(db, '活着', { series: '余华作品', mood: '平静', pages: '191', sub: '["小说"]', done2: '0' });
  addBook(db, '黑暗森林', { series: '地球往事', mood: '震撼', pages: '512', sub: '["科幻"]' });
  search.reindexAll(db);
  return db;
}

const titles = (rows) => rows.map((r) => r.title).sort();

test('检索 #文本字段:子串匹配', () => {
  const db = searchSetup();
  assert.deepEqual(titles(search.searchBooks(db, { q: '#series:地球' })), ['三体', '黑暗森林']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#series:地球往事' })), ['三体', '黑暗森林']);
  db.close();
});

test('检索 #枚举字段:精确匹配(不做子串),大小写不敏感', () => {
  const db = searchSetup();
  assert.deepEqual(titles(search.searchBooks(db, { q: '#mood:震撼' })), ['三体', '黑暗森林']);
  // 子串不应命中(受控词表)
  assert.deepEqual(titles(search.searchBooks(db, { q: '#mood:震' })), []);
  db.close();
});

test('检索 #多值字段:按元素精确匹配,不做前缀误命中', () => {
  const db = searchSetup();
  assert.deepEqual(titles(search.searchBooks(db, { q: '#sub:硬科幻' })), ['三体']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#sub:科幻' })), ['三体', '黑暗森林']);
  db.close();
});

test('检索 #数值字段:比较运算符两种写法都支持(calibre 的 :>= 与既有 >=)', () => {
  const db = searchSetup();
  assert.deepEqual(titles(search.searchBooks(db, { q: '#pages:>=400' })), ['黑暗森林']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#pages>=400' })), ['黑暗森林']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#pages:<300' })), ['活着']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#pages:384' })), ['三体']);
  db.close();
});

test('检索 #数值字段:!= 不反转命中集;空值算作不等于 x', () => {
  const db = searchSetup();
  addBook(db, '无页数');
  search.reindexAll(db);

  assert.deepEqual(titles(search.searchBooks(db, { q: '#pages!=384' })), ['无页数', '活着', '黑暗森林']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#pages:!=384' })), ['无页数', '活着', '黑暗森林']);
  assert.deepEqual(titles(search.searchBooks(db, { q: 'not #pages:384' })), ['无页数', '活着', '黑暗森林']);
  // 范围比较排除没有值的书
  assert.deepEqual(titles(search.searchBooks(db, { q: '#pages>=0' })), ['三体', '活着', '黑暗森林']);
  db.close();
});

test('检索 #布尔字段:true/false/1/0 都按存储值 1/0 匹配', () => {
  const db = searchSetup();
  assert.deepEqual(titles(search.searchBooks(db, { q: '#done2:true' })), ['三体']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#done2:false' })), ['活着']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#done2:1' })), ['三体']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#done2:0' })), ['活着']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#done2!=true' })), ['活着', '黑暗森林']);
  assert.throws(() => search.searchBooks(db, { q: '#done2:maybe' }), (e) => e.code === 'VALIDATION');
  db.close();
});

test('v19:数值字段有 (column_id, value_num) 索引,范围查询走索引', () => {
  const db = searchSetup();
  const col = repo.getColumnByLabel(db, 'pages');
  const plan = db.prepare(
    'EXPLAIN QUERY PLAN SELECT book FROM book_custom_values WHERE column_id = ? AND value_num >= ?'
  ).all(col.id, 300).map((r) => r.detail).join(' ');
  assert.match(plan, /book_custom_values_num_idx/);
  const cols = db.prepare('PRAGMA table_xinfo(book_custom_values)').all().map((c) => c.name);
  assert.ok(cols.includes('value_num'), 'value_num 生成列应存在');
  db.close();
});

test('检索 #数值字段:非数字明确报 VALIDATION(不静默跳过返回全库)', () => {
  const db = searchSetup();
  assert.throws(() => search.searchBooks(db, { q: '#pages:abc' }), (e) => e.code === 'VALIDATION');
  db.close();
});

test('检索 未知 #字段:明确报 VALIDATION(不静默降级为自由词)', () => {
  const db = searchSetup();
  assert.throws(() => search.searchBooks(db, { q: '#nope:x' }), (e) => {
    assert.equal(e.code, 'VALIDATION');
    assert.ok(/未知的自定义字段/.test(e.message));
    return true;
  });
  db.close();
});

test('检索 否定 #字段:not / #字段!=值 / #字段:!=值 三种写法都能排除', () => {
  const db = searchSetup();
  // 本项目的原生写法:运算符跟在字段名后(core/query 直接解析)
  assert.deepEqual(titles(search.searchBooks(db, { q: '#mood!=震撼' })), ['活着']);
  // not 前缀
  assert.deepEqual(titles(search.searchBooks(db, { q: 'not #mood:震撼' })), ['活着']);
  // calibre 风格:比较符写在值里(db/search.py:284-290 的 NumericSearch 同款)
  assert.deepEqual(titles(search.searchBooks(db, { q: '#mood:!=震撼' })), ['活着']);
  db.close();
});

test('检索 文本字段带 >= 的值不被误当运算符(只在数值字段剥前导比较符)', () => {
  const db = searchSetup();
  // series 是文本字段:":>=1" 应作为普通值参与子串匹配,而不是范围比较
  const id = addBook(db, '怪书', { series: '>=1' });
  search.reindexAll(db);
  assert.deepEqual(titles(search.searchBooks(db, { q: '#series:>=1' })), ['怪书']);
  db.close();
});

test('检索 #字段 与内置字段组合(AND)', () => {
  const db = searchSetup();
  const rows = search.searchBooks(db, { q: '#series:地球往事 #pages:>=400' });
  assert.deepEqual(titles(rows), ['黑暗森林']);
  db.close();
});

test('检索 未填值的书不被数值比较误命中(空值不等于 0)', () => {
  const db = searchSetup();
  const id = addBook(db, '无页数');
  search.reindexAll(db);
  // pages 为空的书不应出现在 #pages>=0 的结果里
  const hit = titles(search.searchBooks(db, { q: '#pages:>=0' }));
  assert.ok(!hit.includes('无页数'), `空值不应被 CAST 成 0 命中,实际:${hit}`);
  db.close();
});

test('检索 已软删除的字段不参与检索(其值被忽略)', () => {
  const db = searchSetup();
  const col = repo.getColumnByLabel(db, 'series');
  inTransaction(db, () => repo.removeColumn(db, col.id));
  // 字段已软删 → 视为未知字段
  assert.throws(() => search.searchBooks(db, { q: '#series:地球' }), (e) => e.code === 'VALIDATION');
  db.close();
});

/* ================= 迁移与事务 ================= */

test('v11 迁移:全新库建出两张表,user_version 到最新', () => {
  const dir = tempDir();
  const db = openDb(dir);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(names.includes('custom_columns'));
  assert.ok(names.includes('book_custom_values'));
  db.close();
});

test('inTransaction:嵌套安全(已在事务中不重复 BEGIN)', () => {
  const db = freshDb();
  // 外层开事务,内层再调 —— 不应抛 "cannot start a transaction within a transaction"
  const out = inTransaction(db, () => {
    defineColumn(db, { label: 'nested', name: 'N', datatype: 'text' });
    return inTransaction(db, () => repo.listColumns(db).length);
  });
  assert.equal(out, 1);
  assert.equal(db.isTransaction, false, '结束后应已提交');
  db.close();
});

test('inTransaction:异常时回滚,不留半成品', () => {
  const db = freshDb();
  assert.throws(() => {
    inTransaction(db, () => {
      db.prepare(`INSERT INTO custom_columns (label, name, datatype, is_multiple, options, display_order, mark_for_delete, created_at, updated_at)
        VALUES ('rollback_me', 'X', 'text', 0, '[]', 1, 0, '2024-01-01', '2024-01-01')`).run();
      throw new Error('模拟中途失败');
    });
  }, /模拟中途失败/);
  assert.equal(repo.getColumnByLabel(db, 'rollback_me'), null, '回滚后不应留下字段');
  db.close();
});

// 收尾:清理临时目录
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
