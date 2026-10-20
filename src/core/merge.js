/* ============================================================
 * 合并书籍规则(纯函数,无 I/O)
 *
 * 参考 calibre db/cache.py:merge_book_metadata 的“目标优先、空字段回填”:
 *   · 标题/作者/阅读记录来源保持不变;标签取并集
 *   · 目标为空的字段用来源补;两边都有值时保留目标
 *   · 状态取“最靠后”的阶段:done > reading > wish
 *   · 阅读记录合并去重,日期/次数仍由记录推导
 *   · 冲突标识符、评分、系列等一律目标优先
 * ============================================================ */

const { deriveLogFields, applyStatusTransition, todayStr } = require('./bulk');

function parseTags(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.map((t) => String(t).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function mergeTags(targetRaw, sourceRaws) {
  const out = [];
  const seen = new Set();
  for (const raw of [targetRaw, ...(sourceRaws || [])]) {
    for (const tag of parseTags(raw)) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

function parseLogs(raw) {
  let logs;
  try { logs = JSON.parse(raw || '[]'); } catch { logs = []; }
  if (!Array.isArray(logs)) return [];
  return logs
    .map((l) => ({
      start: String((l && l.start) || '').trim(),
      finish: String((l && l.finish) || '').trim(),
    }))
    .filter((l) => l.start || l.finish);
}

function mergeLogs(targetRaw, sourceRaws) {
  const out = [];
  const seen = new Set();
  for (const raw of [targetRaw, ...(sourceRaws || [])]) {
    for (const log of parseLogs(raw)) {
      const key = `${log.start}|${log.finish}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(log);
    }
  }
  out.sort((a, b) => {
    const ak = a.start || a.finish;
    const bk = b.start || b.finish;
    return ak.localeCompare(bk) || (a.finish || '').localeCompare(b.finish || '');
  });
  return out;
}

function mergeStatus(statuses) {
  if (statuses.includes('done')) return 'done';
  if (statuses.includes('reading')) return 'reading';
  return 'wish';
}

function firstNonEmpty(values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

// 返回要写回目标书的字段;标题/作者/标识符由数据层另行处理
function mergeFields(target, sources) {
  const status = mergeStatus([target.status, ...sources.map((s) => s.status)]);
  const logs = mergeLogs(target.read_logs, sources.map((s) => s.read_logs));
  applyStatusTransition(status, logs, todayStr());
  const derived = deriveLogFields(logs);

  const sourceWithSeries = sources.find((s) => String(s.series || '').trim());
  const sourceRating = Number(firstNonEmpty(sources.map((s) => s.rating))) || 0;

  return {
    status,
    tags: JSON.stringify(mergeTags(target.tags, sources.map((s) => s.tags))),
    read_logs: JSON.stringify(logs),
    start_date: derived.start_date,
    finish_date: derived.finish_date,
    read_count: derived.read_count,
    cover: target.cover || firstNonEmpty(sources.map((s) => s.cover)),
    summary: target.summary || firstNonEmpty(sources.map((s) => s.summary)),
    notes_url: target.notes_url || firstNonEmpty(sources.map((s) => s.notes_url)),
    publisher: target.publisher || firstNonEmpty(sources.map((s) => s.publisher)),
    pub_year: target.pub_year || firstNonEmpty(sources.map((s) => s.pub_year)),
    rating: Number(target.rating) || sourceRating,
    series: target.series || (sourceWithSeries ? sourceWithSeries.series : ''),
    series_index: target.series
      ? target.series_index
      : (sourceWithSeries ? sourceWithSeries.series_index : 0),
  };
}

function parseMergeRequest(body = {}) {
  const targetId = Number(body.targetId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return { error: 'targetId 应为正整数' };
  }
  if (!Array.isArray(body.sourceIds)) return { error: 'sourceIds 应为数组' };

  const sourceIds = [];
  for (const x of body.sourceIds) {
    const n = Number(x);
    if (!Number.isSafeInteger(n) || n <= 0) return { error: 'sourceIds 含非法书籍 id' };
    sourceIds.push(n);
  }
  if (sourceIds.includes(targetId)) return { error: '目标书不能同时是来源书' };

  const unique = [...new Set(sourceIds)];
  if (!unique.length) return { error: '至少选择一本要合并的书' };
  if (unique.length > 50) return { error: '一次最多合并 50 本' };
  return { targetId, sourceIds: unique };
}

module.exports = {
  mergeTags,
  parseLogs,
  mergeLogs,
  mergeStatus,
  mergeFields,
  parseMergeRequest,
};
