/* ============================================================
 * src/core/stats.js 的行为测试:统计聚合规则
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const { computeStats } = require('../src/core/stats');

const row = (status, tags, finish_date, author = '', publisher = '') =>
  ({ status, tags: JSON.stringify(tags), finish_date, author, publisher });

test('总数与状态分组', () => {
  const s = computeStats([
    row('done', [], '2025-01-01'),
    row('done', [], '2026-02-02'),
    row('reading', [], ''),
    row('wish', [], ''),
  ]);
  assert.equal(s.total, 4);
  assert.deepEqual(s.byStatus, { wish: 1, reading: 1, done: 2 });
});

test('byYear 只统计已读且 finish_date 非空,按年份分组', () => {
  const s = computeStats([
    row('done', [], '2025-01-01'),
    row('done', [], '2025-06-01'),
    row('done', [], '2026-02-02'),
    row('reading', [], ''),        // 不计
    row('done', [], ''),           // finish 为空不计
  ]);
  assert.deepEqual(s.byYear, { '2025': 2, '2026': 1 });
});

test('topTags 按次数降序,最多 12 个', () => {
  const books = [
    row('done', ['小说', '科幻'], '2025-01-01'),
    row('done', ['小说'], '2025-02-01'),
    row('wish', ['小说', '文学'], ''),
  ];
  // 12 个单次标签(t0..t11):与 小说(3)/科幻(1)/文学(1) 合计 15 个不同标签
  for (let i = 0; i < 12; i++) books.push(row('done', [`t${i}`], '2025-03-01'));

  const s = computeStats(books);
  assert.equal(s.topTags.length, 12);                 // 15 个不同标签,只留 12
  assert.deepEqual(s.topTags[0], { tag: '小说', count: 3 });  // 次数最多
  assert.equal(s.topTags[1].count, 1);                // 其余全是单次标签
});

test('坏 tags JSON 容错:不抛异常,按无标签计', () => {
  const s = computeStats([{ status: 'done', tags: 'not-json', finish_date: '2025-01-01' }]);
  assert.equal(s.total, 1);
  assert.deepEqual(s.topTags, []);
});

test('空书架:全零结构', () => {
  const s = computeStats([]);
  assert.deepEqual(s, {
    total: 0,
    byStatus: { wish: 0, reading: 0, done: 0 },
    byYear: {},
    topTags: [],
    authorTotal: 0,
    publisherTotal: 0,
    topAuthors: [],
    topPublishers: [],
  });
});

test('作者统计:按「、」拆多作者,去空白项,最长 12 个', () => {
  const books = [
    row('done', [], '2025-01-01', '刘慈欣'),
    row('reading', [], '', '刘慈欣、刘宇昆'),
    row('wish', [], '', '阿西莫夫'),
  ];
  for (let i = 0; i < 10; i++) books.push(row('done', [], '2025-02-01', `作者${i}`));

  const s = computeStats(books);
  assert.equal(s.authorTotal, 13);
  assert.equal(s.topAuthors.length, 12);
  assert.deepEqual(s.topAuthors[0], { name: '刘慈欣', count: 2 });
  assert.equal(s.topAuthors.filter((a) => a.count === 1).length, 11);
  // 多作者各记一次,不重复计入同一本书
  assert.equal(s.topAuthors.find((a) => a.name === '刘宇昆').count, 1);
});

test('出版社统计:去空白后分组,空值不计;并列按名称排序', () => {
  const s = computeStats([
    row('done', [], '2025-01-01', '', '译文出版社'),
    row('wish', [], '', '', ' 译文出版社 '),
    row('reading', [], '', '', '重庆出版社'),
    row('done', [], '2025-02-01', '', ''),
    row('done', [], '2025-03-01', '', '   '),
  ]);
  assert.equal(s.publisherTotal, 2);
  assert.deepEqual(s.topPublishers, [
    { name: '译文出版社', count: 2 },
    { name: '重庆出版社', count: 1 },
  ]);
});

test('作者/出版社缺失字段(旧行)容错', () => {
  const s = computeStats([{ status: 'done', tags: '[]', finish_date: '2025-01-01' }]);
  assert.deepEqual(s.topAuthors, []);
  assert.deepEqual(s.topPublishers, []);
  assert.equal(s.authorTotal, 0);
  assert.equal(s.publisherTotal, 0);
});
