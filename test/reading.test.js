/* ============================================================
 * src/core/reading.js 的行为测试:校验规则 + 「阅读记录是唯一日期来源」
 * 运行:npm test(即 node --test test/)
 *
 * 这些用例从原 book.test.js 的对应部分继承而来 —— 那条规则是本项目
 * 测试覆盖最厚的部分,拆分到双数据库架构时不能有行为回归。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseReading, mergeReadingUpdate, readingToJson,
  deriveFromLogs, isValidUuid, STATUSES, MAX_READ_COUNT,
} = require('../src/core/reading');

/* ---------- uuid 校验 ---------- */

test('isValidUuid:接受标准 UUID,拒绝其它形状', () => {
  assert.ok(isValidUuid('123e4567-e89b-42d3-a456-426614174000'));
  assert.ok(isValidUuid('AABBCCDD-1122-3344-5566-778899AABBCC'));
  assert.ok(!isValidUuid(''));
  assert.ok(!isValidUuid('not-a-uuid'));
  assert.ok(!isValidUuid('123'));
  assert.ok(!isValidUuid('123e4567e89b42d3a456426614174000')); // 无连字符
  assert.ok(!isValidUuid(null));
  assert.ok(!isValidUuid(undefined));
});

/* ---------- 状态 ---------- */

test('状态白名单:非法状态返回错误', () => {
  const { errors } = parseReading({ status: 'reading2' });
  assert.ok(errors.includes('状态不合法'));
});

test('默认状态为 wish', () => {
  const { values } = parseReading({});
  assert.equal(values.status, 'wish');
});

test('三个合法状态都通过', () => {
  for (const s of STATUSES) {
    const { errors } = parseReading({ status: s });
    assert.equal(errors.length, 0, `${s} 不应报错`);
  }
});

/* ---------- 读过次数 ---------- */

test('读过次数:0~999 整数,越界返回错误并归零', () => {
  const a = parseReading({ read_count: 1000 });
  assert.ok(a.errors.includes(`读过次数应为 0~${MAX_READ_COUNT} 的整数`));
  assert.equal(a.values.read_count, 0);

  const b = parseReading({ read_count: '' });
  assert.equal(b.values.read_count, 0);

  const c = parseReading({ read_count: 2.5 });
  assert.ok(c.errors.length > 0);

  const d = parseReading({ read_count: -1 });
  assert.ok(d.errors.length > 0);
});

/* ---------- 日期格式 ---------- */

test('日期格式校验:非法格式返回错误', () => {
  const { errors } = parseReading({ start_date: '2026/01/01' });
  assert.ok(errors.includes('开始日期格式应为 YYYY-MM-DD'));

  const r2 = parseReading({ finish_date: '01-01-2026' });
  assert.ok(r2.errors.includes('读完日期格式应为 YYYY-MM-DD'));
});

/* ---------- 阅读记录是唯一日期来源 ---------- */

test('有阅读记录时:read_count/finish_date/start_date 全部由记录推导', () => {
  const { values, errors } = parseReading({
    // 请求体里给了错误的旧值,应被忽略
    read_count: 99,
    start_date: '1999-01-01',
    finish_date: '1999-01-02',
    read_logs: [
      { start: '2022-07-10', finish: '2022-08-20' },
      { start: '2019-01-05', finish: '2019-03-01' },
    ],
  });
  assert.equal(errors.length, 0);
  assert.equal(values.read_count, 2, '次数 = 有 finish 的记录条数');
  assert.equal(values.finish_date, '2022-08-20', '读完日 = 最晚的 finish');
  assert.equal(values.start_date, '2022-07-10', '开始日 = 最近一次开读');
});

test('进行中的记录(无 finish)不计入次数', () => {
  const { values } = parseReading({
    read_logs: [{ start: '2026-01-01', finish: '' }],
  });
  assert.equal(values.read_count, 0);
  assert.equal(values.finish_date, '');
  assert.equal(values.start_date, '2026-01-01');
});

test('无阅读记录时:保留请求体兜底值(API 兼容)', () => {
  const { values } = parseReading({
    read_count: 5, start_date: '2020-01-01', finish_date: '2020-02-02',
  });
  assert.equal(values.read_count, 5);
  assert.equal(values.start_date, '2020-01-01');
  assert.equal(values.finish_date, '2020-02-02');
});

test('阅读记录:读完日期早于开始日期 → 报错', () => {
  const { errors } = parseReading({
    read_logs: [{ start: '2026-05-01', finish: '2026-01-01' }],
  });
  assert.ok(errors.includes('阅读记录的读完日期不能早于开始日期'));
});

test('阅读记录:日期格式非法 → 报错', () => {
  const { errors } = parseReading({
    read_logs: [{ start: '2026/05/01', finish: '' }],
  });
  assert.ok(errors.includes('阅读记录的日期格式应为 YYYY-MM-DD'));
});

test('阅读记录:空记录被过滤,字符串输入可解析', () => {
  const a = parseReading({ read_logs: [{ start: '', finish: '' }] });
  assert.deepEqual(JSON.parse(a.values.read_logs), []);

  const b = parseReading({ read_logs: '[{"start":"2026-01-01","finish":"2026-02-01"}]' });
  assert.equal(JSON.parse(b.values.read_logs).length, 1);
  assert.equal(b.values.read_count, 1);

  const c = parseReading({ read_logs: 'not json' });
  assert.deepEqual(JSON.parse(c.values.read_logs), []);
});

/* ---------- deriveFromLogs ---------- */

test('deriveFromLogs:空记录回退到兜底值', () => {
  const r = deriveFromLogs([], { start: '2020-01-01', finish: '2020-02-01', readCount: 7 });
  assert.deepEqual(r, { start_date: '2020-01-01', finish_date: '2020-02-01', read_count: 7 });
});

test('deriveFromLogs:非数组输入按空处理', () => {
  const r = deriveFromLogs(null, { start: 'x', finish: 'y', readCount: 0 });
  assert.equal(r.start_date, 'x');
});

/* ---------- PUT 局部更新语义 ---------- */

test('mergeReadingUpdate:未提供的字段保留旧值', () => {
  const existing = {
    notes_url: '/old-notes', read_count: 3, read_logs: '[{"start":"a","finish":"b"}]',
    start_date: '2020-01-01', finish_date: '2020-02-01',
  };
  const values = parseReading({ status: 'done' }).values;
  // 只传 status:其余全部保留
  const merged = mergeReadingUpdate(existing, values, { status: 'done' });
  assert.equal(merged.notes_url, '/old-notes');
  assert.equal(merged.read_count, 3);
  assert.equal(merged.read_logs, '[{"start":"a","finish":"b"}]');
  assert.equal(merged.start_date, '2020-01-01');
  assert.equal(merged.finish_date, '2020-02-01');
  assert.equal(merged.status, 'done');
});

/* ---------- 输出形状 ---------- */

test('readingToJson:JSON 字符串列转成数组,坏 JSON 容错', () => {
  const j = readingToJson({
    calibre_uuid: 'x', status: 'done', read_count: 1,
    read_logs: '[{"start":"2026-01-01","finish":"2026-02-01"}]',
    start_date: '', finish_date: '', notes_url: '', created_at: null, updated_at: null,
  });
  assert.equal(j.read_logs.length, 1);

  const bad = readingToJson({
    calibre_uuid: 'x', status: 'wish', read_count: 0, read_logs: '{{bad',
    start_date: '', finish_date: '', notes_url: '', created_at: null, updated_at: null,
  });
  assert.deepEqual(bad.read_logs, []);

  assert.equal(readingToJson(null), null);
});
