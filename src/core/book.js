/* ============================================================
 * 核心业务规则层(纯函数,不 import express / 数据库)
 *
 * 依赖方向纪律:本目录只允许被 db / http 层引用,自己不引用任何
 * 项目内模块 —— 保证"规则"可以脱离 I/O 独立测试(node --test)。
 *
 * 「阅读记录是唯一日期来源」规则在 parseBook 中强制执行:
 *   有 read_logs 时,start_date / finish_date / read_count 全部由
 *   记录推导,忽略请求体里的旧值;无记录时保留请求体兜底值(API 兼容)。
 * ============================================================ */

const STATUSES = ['wish', 'reading', 'done'];

// 校验并规范化请求体里的书籍字段(纯函数:不产生任何副作用)
function parseBook(body) {
  const errors = [];
  const title = String(body.title || '').trim();
  if (!title) errors.push('书名不能为空');

  const status = String(body.status || 'wish');
  if (!STATUSES.includes(status)) errors.push('状态不合法');

  let tags = body.tags;
  if (typeof tags === 'string') {
    tags = tags.split(/[,，、\s]+/).filter(Boolean);
  }
  if (!Array.isArray(tags)) tags = [];
  tags = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const start = String(body.start_date || '').trim();
  const finish = String(body.finish_date || '').trim();
  if (start && !dateRe.test(start)) errors.push('开始日期格式应为 YYYY-MM-DD');
  if (finish && !dateRe.test(finish)) errors.push('读完日期格式应为 YYYY-MM-DD');

  let readCount = body.read_count;
  if (readCount === '' || readCount === undefined || readCount === null) {
    readCount = 0;
  } else {
    readCount = Number(readCount);
    if (!Number.isInteger(readCount) || readCount < 0 || readCount > 999) {
      errors.push('读过次数应为 0~999 的整数');
      readCount = 0;
    }
  }

  // 每次阅读的起止时间
  let readLogs = body.read_logs;
  if (typeof readLogs === 'string') {
    try { readLogs = JSON.parse(readLogs); } catch { readLogs = []; }
  }
  if (!Array.isArray(readLogs)) readLogs = [];
  readLogs = readLogs
    .map((l) => ({ start: String((l && l.start) || '').trim(), finish: String((l && l.finish) || '').trim() }))
    .filter((l) => l.start || l.finish);
  for (const l of readLogs) {
    if ((l.start && !dateRe.test(l.start)) || (l.finish && !dateRe.test(l.finish))) {
      errors.push('阅读记录的日期格式应为 YYYY-MM-DD');
      break;
    }
    if (l.start && l.finish && l.finish < l.start) {
      errors.push('阅读记录的读完日期不能早于开始日期');
      break;
    }
  }

  // 阅读记录是唯一数据源:有记录时,开始/读完日期与读过次数由记录自动推导,
  // 忽略请求体里可能残留的旧字段值;无记录时保留请求体的兜底值(API 兼容)
  let startDate = start;
  let finishDate = finish;
  if (readLogs.length) {
    const finished = readLogs.filter((l) => l.finish);
    readCount = finished.length;
    finishDate = finished.reduce((m, l) => (l.finish > m ? l.finish : m), '');
    startDate = '';
    for (const l of readLogs) {
      if (l.start && l.start >= startDate) startDate = l.start; // 最近一次开读
    }
  }

  return {
    errors,
    values: {
      title,
      author: String(body.author || '').trim(),
      status,
      summary: String(body.summary || '').trim().slice(0, 1000),
      tags: JSON.stringify(tags),
      start_date: startDate,
      finish_date: finishDate,
      cover: String(body.cover || '').trim(),
      notes_url: String(body.notes_url || '').trim(),
      read_count: readCount,
      read_logs: JSON.stringify(readLogs),
      // 豆瓣元数据字段(v4 列;可选,由前端"从豆瓣填充"或 API 传入)
      publisher: String(body.publisher || '').trim().slice(0, 200),
      pub_year: String(body.pub_year || body.pubYear || '').trim().slice(0, 20),
      isbn: String(body.isbn || '').trim().slice(0, 20),
      rating: clampRating(body.rating),
      douban_id: String(body.douban_id || body.doubanId || '').trim().slice(0, 32),
    },
  };
}

// 评分:0~5,一位小数;非法输入归 0(与豆瓣折算规则一致)
function clampRating(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(5, Math.round(n * 10) / 10);
}

// PUT 局部更新语义:表单未提供的字段保留数据库旧值,
// 前端局部提交 / 旧客户端脚本不会误清数据(纯函数:返回新对象)
function mergeUpdate(existing, values, body) {
  const merged = { ...values };
  if (!('summary' in body)) merged.summary = existing.summary;
  if (!('notes_url' in body)) merged.notes_url = existing.notes_url;
  if (!('cover' in body)) merged.cover = existing.cover;
  if (!('read_count' in body)) merged.read_count = existing.read_count;
  if (!('read_logs' in body)) merged.read_logs = existing.read_logs;
  if (!('publisher' in body)) merged.publisher = existing.publisher;
  if (!('pub_year' in body)) merged.pub_year = existing.pub_year;
  if (!('isbn' in body)) merged.isbn = existing.isbn;
  if (!('rating' in body)) merged.rating = existing.rating;
  if (!('douban_id' in body)) merged.douban_id = existing.douban_id;
  return merged;
}

module.exports = { STATUSES, parseBook, mergeUpdate };
