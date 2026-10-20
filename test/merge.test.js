/* ============================================================
 * 合并书籍规则:标签并集 / 阅读记录 / 状态 / 字段回填 / 请求校验
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  mergeTags, mergeLogs, mergeStatus, mergeFields, parseMergeRequest,
} = require('../src/core/merge');

test('mergeTags:并集 + 大小写不敏感去重,目标顺序优先', () => {
  assert.deepEqual(
    mergeTags('["科幻","小说"]', ['["小说","精选"]', '["SciFi"]']),
    ['科幻', '小说', '精选', 'SciFi'],
  );
});

test('mergeLogs:合并、去重、按开始日期排序', () => {
  const logs = mergeLogs(
    '[{"start":"2025-02-01","finish":"2025-02-10"}]',
    ['[{"start":"2024-01-01","finish":"2024-01-05"},{"start":"2025-02-01","finish":"2025-02-10"}]'],
  );
  assert.deepEqual(logs, [
    { start: '2024-01-01', finish: '2024-01-05' },
    { start: '2025-02-01', finish: '2025-02-10' },
  ]);
});

test('mergeStatus:done > reading > wish', () => {
  assert.equal(mergeStatus(['wish', 'reading']), 'reading');
  assert.equal(mergeStatus(['reading', 'done']), 'done');
  assert.equal(mergeStatus(['wish', 'wish']), 'wish');
});

test('mergeFields:标签/记录合并,空字段由来源补,目标已有值优先', () => {
  const target = {
    status: 'reading', tags: '["科幻"]', read_logs: '[]',
    cover: '/uploads/t.png', summary: '目标简介', notes_url: '/notes/t',
    publisher: '目标社', pub_year: '2001', rating: 8,
    series: '', series_index: 0,
  };
  const source = {
    status: 'done', tags: '["小说"]',
    read_logs: '[{"start":"2025-01-01","finish":"2025-01-05"}]',
    cover: '/uploads/s.png', summary: '来源简介', notes_url: '/notes/s',
    publisher: '来源社', pub_year: '2002', rating: 9,
    series: '基地', series_index: 2,
  };
  const merged = mergeFields(target, [source]);

  assert.equal(merged.status, 'done');
  assert.deepEqual(JSON.parse(merged.tags), ['科幻', '小说']);
  assert.equal(merged.read_count, 1);
  assert.equal(merged.finish_date, '2025-01-05');
  assert.equal(merged.cover, '/uploads/t.png', '目标封面优先');
  assert.equal(merged.summary, '目标简介', '目标简介优先');
  assert.equal(merged.notes_url, '/notes/t');
  assert.equal(merged.publisher, '目标社');
  assert.equal(merged.pub_year, '2001');
  assert.equal(merged.rating, 8, '目标评分优先');
  assert.equal(merged.series, '基地', '目标无系列时用来源');
  assert.equal(merged.series_index, 2);
});

test('mergeFields:目标为空时用来源补;目标 done 无记录时补今天读完', () => {
  const target = {
    status: 'wish', tags: '[]', read_logs: '[]', cover: '', summary: '', notes_url: '',
    publisher: '', pub_year: '', rating: 0, series: '', series_index: 0,
  };
  const source = {
    status: 'done', tags: '["小说"]', read_logs: '[]', cover: '/uploads/s.png',
    summary: '来源简介', notes_url: '', publisher: '来源社', pub_year: '2002',
    rating: 9, series: '', series_index: 0,
  };
  const merged = mergeFields(target, [source]);
  assert.equal(merged.cover, '/uploads/s.png');
  assert.equal(merged.summary, '来源简介');
  assert.equal(merged.publisher, '来源社');
  assert.equal(merged.rating, 9);
  assert.equal(merged.status, 'done');
  assert.equal(merged.read_count, 1);
  assert.match(merged.finish_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('parseMergeRequest:目标/来源校验', () => {
  assert.deepEqual(parseMergeRequest({ targetId: 1, sourceIds: [2, 2, 3] }), {
    targetId: 1, sourceIds: [2, 3],
  });
  assert.ok(parseMergeRequest({ targetId: 1, sourceIds: [1] }).error);
  assert.ok(parseMergeRequest({ targetId: 1, sourceIds: [] }).error);
  assert.ok(parseMergeRequest({ targetId: 0, sourceIds: [2] }).error);
  assert.ok(parseMergeRequest({ targetId: 1, sourceIds: ['x'] }).error);
  assert.ok(parseMergeRequest({ targetId: 1, sourceIds: Array.from({ length: 51 }, (_, i) => i + 2) }).error);
});
