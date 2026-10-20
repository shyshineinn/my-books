/* ============================================================
 * 批量编辑规则(纯函数,无 I/O)
 *
 * 对标 calibre “Edit metadata in bulk”的常用子集:
 *   · 状态(与单本编辑相同的阅读记录联动)
 *   · 标签添加 / 移除(不清空其它标签)
 *   · 系列 / 系列序号
 *   · 出版社 / 出版年 / 评分
 *
 * 只做“填了才改”的语义:UI 留空 = 不修改,避免批量误清数据。
 * ============================================================ */

const { STATUSES } = require('./book');
const { clampSeriesIndex } = require('./series');

const MAX_BULK_BOOKS = 500;

function parseIds(raw) {
  if (!Array.isArray(raw)) return { error: 'ids 应为数组' };
  const ids = [];
  for (const x of raw) {
    const n = Number(x);
    if (!Number.isSafeInteger(n) || n <= 0) return { error: 'ids 含非法书籍 id' };
    ids.push(n);
  }
  const unique = [...new Set(ids)];
  if (!unique.length) return { error: '至少选择一本书' };
  if (unique.length > MAX_BULK_BOOKS) return { error: `一次最多批量编辑 ${MAX_BULK_BOOKS} 本` };
  return { ids: unique };
}

function parseTags(raw) {
  let arr = raw;
  if (typeof arr === 'string') arr = arr.split(/[,，、\s]+/);
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))];
}

function parseBulkPatch(body = {}) {
  const errors = [];
  const patch = {};

  if (body.status !== undefined && body.status !== '') {
    if (!STATUSES.includes(body.status)) errors.push('状态不合法');
    else patch.status = body.status;
  }

  const add = parseTags(body.tags_add);
  const remove = parseTags(body.tags_remove);
  if (add.length && remove.length) {
    const addKeys = new Set(add.map((t) => t.toLowerCase()));
    const overlap = remove.filter((t) => addKeys.has(t.toLowerCase()));
    if (overlap.length) errors.push(`同一标签不能同时添加和移除:${overlap.join('、')}`);
  }
  if (add.length) patch.tags_add = add;
  if (remove.length) patch.tags_remove = remove;

  if (body.series !== undefined && String(body.series).trim()) {
    patch.series = String(body.series).trim().slice(0, 200);
  }
  if (body.series_index !== undefined && body.series_index !== '') {
    const idx = clampSeriesIndex(body.series_index);
    if (idx === null) errors.push('系列序号应为 0~9999 的数字');
    else patch.series_index = idx;
  }
  if (body.publisher !== undefined && String(body.publisher).trim()) {
    patch.publisher = String(body.publisher).trim().slice(0, 200);
  }
  if (body.pub_year !== undefined && String(body.pub_year).trim()) {
    patch.pub_year = String(body.pub_year).trim().slice(0, 20);
  }
  if (body.rating !== undefined && body.rating !== '') {
    const n = Number(body.rating);
    if (!Number.isFinite(n) || n < 0 || n > 10) errors.push('评分应为 0~10');
    else patch.rating = Math.round(n * 10) / 10;
  }

  if (!Object.keys(patch).length && !errors.length) errors.push('至少选择一个要修改的字段');
  return { errors, patch };
}

// 本地日期:与前端 todayStr 一致(用户看到的是本地“今天”)
function todayStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 与单本编辑弹窗同款状态联动:
//   已读 → 没有“读完”记录时,补完最近一条或新增一条今天读完的记录
//   在读 → 没有“进行中”记录时,新增一条今天开读的记录
function applyStatusTransition(status, logs, today = todayStr()) {
  if (status === 'done' && !logs.some((l) => l.finish)) {
    if (logs.length) logs[logs.length - 1].finish = today;
    else logs.push({ start: '', finish: today });
  } else if (status === 'reading' && !logs.some((l) => !l.finish)) {
    logs.push({ start: today, finish: '' });
  }
  return logs;
}

// 阅读记录是日期与次数的唯一来源(与 core/book.parseBook 同一规则)
function deriveLogFields(logs) {
  if (!logs.length) return { start_date: '', finish_date: '', read_count: 0 };
  const finished = logs.filter((l) => l.finish);
  const finish_date = finished.reduce((m, l) => (l.finish > m ? l.finish : m), '');
  let start_date = '';
  for (const l of logs) {
    if (l.start && l.start >= start_date) start_date = l.start;
  }
  return { start_date, finish_date, read_count: finished.length };
}

// API 请求体形状:{ ids, patch }。单独收口,避免路由把整个 body 当成 patch
// (2026-10-20 UI 烟测踩过:服务端误判“空 patch”,返回 400)。
function parseBulkRequest(body = {}) {
  const idParse = parseIds(body.ids);
  if (idParse.error) return { errors: [idParse.error], ids: [], patch: {} };
  const { errors, patch } = parseBulkPatch(body.patch || {});
  return { errors, ids: idParse.ids, patch };
}

module.exports = {
  MAX_BULK_BOOKS,
  parseIds,
  parseTags,
  parseBulkPatch,
  parseBulkRequest,
  todayStr,
  applyStatusTransition,
  deriveLogFields,
};
