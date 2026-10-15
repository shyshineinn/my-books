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

test('or 关键字置位,正向条款整体改为 OR 语义', () => {
  const r = parseQuery('tag:科幻 or tag:历史');
  assert.equal(r.or, true);
  assert.equal(r.filters.length, 2);
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
