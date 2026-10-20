/* ============================================================
 * core/query.js 查询语法解析器:纯函数单测(无 db)
 * 覆盖:字段谓词 / 运算符 / 引号值 / 自由词 / 布尔 or·not·- / 未知字段降级
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuery } = require('../src/core/query.js');

const titles = (filters) => filters.map((f) => f.field);

test('纯自由词:整串进 free,无结构', () => {
  const r = parseQuery('三体');
  assert.deepEqual(r.free, ['三体']);
  assert.equal(r.filters.length, 0);
  assert.equal(r.or, false);
});

test('字段谓词:tag:/author:/status: 各自成 filter', () => {
  const r = parseQuery('tag:科幻 author:刘慈欣 status:done');
  assert.deepEqual(titles(r.filters), ['tag', 'author', 'status']);
  assert.deepEqual(r.filters.map((f) => f.value), ['科幻', '刘慈欣', 'done']);
  assert.equal(r.free.length, 0);
});

test('运算符映射:: 与 = 同为 eq,>=/<=/!=/</> 各归其位', () => {
  const r = parseQuery('rating>=8 pubyear<2010 isbn!=x');
  const byField = Object.fromEntries(r.filters.map((f) => [f.field, f.op]));
  assert.equal(byField.rating, 'ge');
  assert.equal(byField.pubyear, 'lt');
  assert.equal(byField.isbn, 'ne');
});

test('带引号的值可含空格', () => {
  const r = parseQuery('tag:"外国文学"');
  assert.equal(r.filters[0].value, '外国文学');
  assert.equal(r.filters[0].op, 'eq');
});

test('中文字段别名:标签/作者/评分 → 规范字段', () => {
  const r = parseQuery('标签:科幻 作者:余华 评分:9');
  assert.deepEqual(titles(r.filters), ['tag', 'author', 'rating']);
});

test('状态中文值归一化为 code', () => {
  assert.equal(parseQuery('status:已读').filters[0].value, 'done');
  assert.equal(parseQuery('状态:想读').filters[0].value, 'wish');
});

test('or 关键字置位,顶层 or 整体并联(向后兼容字段)', () => {
  const r = parseQuery('tag:科幻 or tag:历史');
  assert.equal(r.or, true);
  // 2026-10-20 有括号版:or 子树进 groups(带结构),不再平铺进 filters。
  // 无括号的 or 语义不变 —— search.js 见 or 且无 groups 时仍整体并联。
  assert.equal(r.filters.length, 0);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].op, 'or');
  assert.deepEqual(r.groups[0].children.map((c) => c.field), ['tag', 'tag']);
});

test('括号改变优先级:a or b and c → a OR (b AND c)', () => {
  const r = parseQuery('tag:科幻 or tag:历史 and status:done');
  // 顶层是 or 组;and 是它的右孩子
  assert.equal(r.or, true);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].op, 'or');
  assert.equal(r.groups[0].children.length, 2);
  assert.equal(r.groups[0].children[0].field, 'tag');
  assert.equal(r.groups[0].children[1].op, 'and');
  assert.deepEqual(r.groups[0].children[1].children.map((c) => c.field), ['tag', 'status']);
});

test('显式括号覆盖优先级:(a or b) and c', () => {
  const r = parseQuery('(tag:科幻 or tag:历史) and status:done');
  assert.equal(r.filters.length, 1);           // status 是顶层 and 的一条
  assert.deepEqual(titles(r.filters), ['status']);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].op, 'or');          // 括号里才是 or
});

test('not ( ... ) 否定整组', () => {
  const r = parseQuery('not (tag:科幻 or tag:历史)');
  assert.equal(r.filters.length, 0);
  assert.equal(r.notFilters.length, 0);
  // 顶层 not 一组:保留 NOT 结构,落在 groups(search.js 翻成 NOT (...))。
  // notGroups 只在"否定出现在子树里"时出现(如 a and not (...))。
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].op, 'not');
  assert.equal(r.groups[0].child.op, 'or');
  assert.deepEqual(r.groups[0].child.children.map((c) => c.field), ['tag', 'tag']);
});

test('括号内嵌 not:tag:科幻 and not (status:done or status:reading)', () => {
  const r = parseQuery('tag:科幻 and not (status:done or status:reading)');
  assert.deepEqual(titles(r.filters), ['tag']);
  // and 下沉后剩下 not 一组 → 走 groups(它仍是"正向"侧的一条,
  // 由 SQL 的 NOT (...) 表达,与 and 并列而不是进 notGroups)
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].op, 'not');
  assert.deepEqual(r.groups[0].child.children.map((c) => c.field), ['status', 'status']);
});

test('嵌套括号:a and (b or (c and d))', () => {
  const r = parseQuery('tag:科幻 and (tag:历史 or (status:done and rating>=8))');
  assert.deepEqual(titles(r.filters), ['tag']);
  assert.equal(r.groups[0].op, 'or');
  assert.equal(r.groups[0].children.length, 2);
  assert.equal(r.groups[0].children[1].op, 'and');
});

test('括号不配对时宽松降级,不抛错', () => {
  const a = parseQuery('tag:科幻 or (tag:历史 and status:done');   // 缺右括号
  assert.equal(a.or, true);
  assert.ok(a.groups.length >= 1);
  const b = parseQuery('tag:科幻) or tag:历史');                    // 多右括号
  assert.ok(b.free.length >= 0);                                    // 不抛错即可
  assert.equal(b.or, true);
});

test('检索类型前缀:= / ~ / ^ 归一成 kind', () => {
  assert.equal(parseQuery('tag:=科幻').filters[0].kind, 'eq');
  assert.equal(parseQuery('title:~^三体').filters[0].kind, 'regexp');
  assert.equal(parseQuery('title:~^三体').filters[0].value, '^三体');
  assert.equal(parseQuery('title:^er').filters[0].kind, 'charvariant');
  assert.equal(parseQuery('title:^er').filters[0].value, 'er');
  assert.equal(parseQuery('tag:科幻').filters[0].kind, 'contains');   // 无前缀 = 子串
  // 第二个前缀字符留给用户内容:== 不是 "eq 的 eq"
  assert.equal(parseQuery('tag:==科幻').filters[0].value, '=科幻');
});

test('not 否定紧随其后的一条,进 notFilters/notFree', () => {
  const r = parseQuery('tag:科幻 not author:刘慈欣');
  assert.equal(r.filters.length, 1);
  assert.deepEqual(r.notFilters.map((f) => f.field), ['author']);
  assert.equal(r.notFree.length, 0);
});

test('前导 - 等价 not(作用于下一条)', () => {
  const r = parseQuery('三体 -tag:草稿');
  assert.deepEqual(r.free, ['三体']);
  assert.deepEqual(r.notFilters.map((f) => f.field), ['tag']);
});

test('未知字段(foo:bar)整条降级为自由词,不误吞', () => {
  const r = parseQuery('foo:bar');
  assert.deepEqual(r.free, ['foo:bar']);
  assert.equal(r.filters.length, 0);
});

test('混合:字段谓词 + 自由词 + or + not 全解析', () => {
  const r = parseQuery('status:done rating>=8 三体 not tag:草稿');
  assert.deepEqual(titles(r.filters), ['status', 'rating']);
  assert.deepEqual(r.free, ['三体']);
  assert.deepEqual(r.notFilters.map((f) => f.field), ['tag']);
});

test('空输入 → 全空对象(无结构)', () => {
  const r = parseQuery('   ');
  assert.equal(r.free.length, 0);
  assert.equal(r.filters.length, 0);
  assert.equal(r.or, false);
});
