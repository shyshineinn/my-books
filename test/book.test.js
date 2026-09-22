/* ============================================================
 * src/core/book.js 的行为测试:校验规则 + 「阅读记录是唯一日期来源」
 * 运行:npm test(即 node --test test/)
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const { parseBook, mergeUpdate, STATUSES } = require('../src/core/book');

/* ---------- 基础校验 ---------- */

test('书名必填:空白返回错误', () => {
  const { errors } = parseBook({ title: '   ' });
  assert.ok(errors.includes('书名不能为空'));
});

test('状态白名单:非法状态返回错误', () => {
  const { errors } = parseBook({ title: 'x', status: 'reading2' });
  assert.ok(errors.includes('状态不合法'));
});

test('默认状态为 wish', () => {
  const { values } = parseBook({ title: 'x' });
  assert.equal(values.status, 'wish');
});

test('标签:字符串拆分 + 去重 + 去空;数组输入同样规范化', () => {
  const a = parseBook({ title: 'x', tags: '小说, 科幻、小说 科幻' });
  assert.deepEqual(JSON.parse(a.values.tags), ['小说', '科幻']);

  const b = parseBook({ title: 'x', tags: [' 科幻 ', '', '科幻'] });
  assert.deepEqual(JSON.parse(b.values.tags), ['科幻']);
});

test('日期格式校验:非法格式返回错误', () => {
  const { errors } = parseBook({ title: 'x', start_date: '2026/01/01' });
  assert.ok(errors.includes('开始日期格式应为 YYYY-MM-DD'));

  const r2 = parseBook({ title: 'x', finish_date: '01-01-2026' });
  assert.ok(r2.errors.includes('读完日期格式应为 YYYY-MM-DD'));
});

test('读过次数:0~999 整数,越界返回错误并归零', () => {
  const a = parseBook({ title: 'x', read_count: 1000 });
  assert.ok(a.errors.includes('读过次数应为 0~999 的整数'));
  assert.equal(a.values.read_count, 0);

  const b = parseBook({ title: 'x', read_count: '' });
  assert.equal(b.values.read_count, 0);
});

test('简介截断到 1000 字', () => {
  const { values } = parseBook({ title: 'x', summary: '长'.repeat(1200) });
  assert.equal(values.summary.length, 1000);
});

/* ---------- 阅读记录是唯一日期来源(核心规则) ---------- */

test('有阅读记录时:读过次数 = 已读完的记录条数,请求体旧值被忽略', () => {
  const { values } = parseBook({
    title: '三体',
    status: 'done',
    read_count: 99,               // 旧值,应被推导值覆盖
    read_logs: [
      { start: '2022-07-10', finish: '2022-08-20' },
      { start: '2019-01-05', finish: '2019-03-01' },
      { start: '2025-12-10', finish: '2026-01-20' },
    ],
  });
  assert.equal(values.read_count, 3);
});

test('有阅读记录时:读完日期取最晚的 finish,开始日期取最近一次开读', () => {
  const { values } = parseBook({
    title: 'x',
    read_logs: [
      { start: '2019-01-05', finish: '2019-03-01' },
      { start: '2025-12-10', finish: '2026-01-20' },
      { start: '2022-07-10', finish: '2022-08-20' },
    ],
  });
  assert.equal(values.finish_date, '2026-01-20');
  assert.equal(values.start_date, '2025-12-10');
});

test('进行中的记录(无 finish)计入开读但不算读过次数', () => {
  const { values } = parseBook({
    title: '人类简史',
    read_logs: [
      { start: '2024-06-01', finish: '2024-06-10' },
      { start: '2026-08-01', finish: '' },
    ],
  });
  assert.equal(values.read_count, 1);
  assert.equal(values.start_date, '2026-08-01');
  assert.equal(values.finish_date, '2024-06-10');
});

test('无阅读记录时:保留请求体的兜底日期(API 兼容旧客户端)', () => {
  const { values } = parseBook({
    title: 'x',
    start_date: '2020-01-01',
    finish_date: '2020-02-01',
    read_count: 2,
  });
  assert.equal(values.start_date, '2020-01-01');
  assert.equal(values.finish_date, '2020-02-01');
  assert.equal(values.read_count, 2);
});

test('记录内部校验:finish 早于 start 返回错误', () => {
  const { errors } = parseBook({
    title: 'x',
    read_logs: [{ start: '2026-05-10', finish: '2026-05-01' }],
  });
  assert.ok(errors.includes('阅读记录的读完日期不能早于开始日期'));
});

test('记录字符串容错:JSON 字符串可解析,纯垃圾当空数组', () => {
  const a = parseBook({ title: 'x', read_logs: '[{"start":"2026-01-01","finish":""}]' });
  assert.equal(JSON.parse(a.values.read_logs).length, 1);

  const b = parseBook({ title: 'x', read_logs: 'not-json' });
  assert.deepEqual(JSON.parse(b.values.read_logs), []);
});

test('空起止的记录条目被过滤', () => {
  const { values } = parseBook({
    title: 'x',
    read_logs: [{ start: '', finish: '' }, { start: '2026-01-01', finish: '' }],
  });
  assert.equal(JSON.parse(values.read_logs).length, 1);
});

/* ---------- mergeUpdate:PUT 局部更新语义 ---------- */

test('mergeUpdate:未提供的字段保留数据库旧值', () => {
  const existing = {
    summary: '旧简介', notes_url: 'https://old/x.md', cover: '/uploads/a.png',
    read_count: 3, read_logs: '[{"start":"2020-01-01","finish":"2020-02-01"}]',
  };
  const { values } = parseBook({ title: '新书名', author: '新作者', status: 'reading' });
  const merged = mergeUpdate(existing, values, { title: '新书名', author: '新作者', status: 'reading' });

  assert.equal(merged.summary, '旧简介');
  assert.equal(merged.notes_url, 'https://old/x.md');
  assert.equal(merged.cover, '/uploads/a.png');
  assert.equal(merged.read_count, 3);
  assert.equal(merged.read_logs, existing.read_logs);
  assert.equal(merged.title, '新书名');
});

test('mergeUpdate:显式提供空值也会覆盖(保证删光记录能同步清空)', () => {
  const existing = { summary: '旧简介', cover: '/uploads/a.png' };
  const { values } = parseBook({ title: 'x', summary: '', cover: '' });
  const merged = mergeUpdate(existing, values, { title: 'x', summary: '', cover: '' });

  assert.equal(merged.summary, '');
  assert.equal(merged.cover, '');
});

test('STATUSES 常量完整', () => {
  assert.deepEqual(STATUSES, ['wish', 'reading', 'done']);
});
