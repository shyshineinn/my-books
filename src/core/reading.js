/* ============================================================
 * 阅读记录规则(纯函数,不 import express / 数据库)
 *
 * 依赖方向纪律:本目录只允许被 db / http 层引用,自己不引用任何
 * 项目内模块 —— 保证"规则"可以脱离 I/O 独立测试(node --test)。
 *
 * 定位(路线 B / 双数据库架构):
 *   calibre 负责"书是什么"(书名/作者/标签/简介/封面/格式/文件),
 *   本模块负责"我读得怎么样"(想读/在读/已读、读过几遍、每次起止日期)。
 *   两者靠 calibre 的 books.uuid 关联 —— 不能用 id 或 path:
 *     · books.id   删了再加会变
 *     · books.path 改书名/作者会重算(calibre cache.py update_path)
 *     · books.uuid 稳定,且 calibre 插入时由触发器自动生成
 *
 * 「阅读记录是唯一日期来源」规则在 parseReading 中强制执行:
 *   有 read_logs 时,start_date / finish_date / read_count 全部由
 *   记录推导,忽略请求体里的旧值;无记录时保留请求体兜底值(API 兼容)。
 *   这条规则从原 core/book.js 完整继承 —— 它是本项目测试覆盖最厚的部分。
 * ============================================================ */

const STATUSES = ['wish', 'reading', 'done'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_READ_COUNT = 999;

/* 校验 calibre uuid 形状:标准 UUID v4 字符串(36 字符带连字符)。
   calibre 的 uuid 由 uuid4() 生成,形状稳定;这里只做宽松校验,
   防止把任意字符串写进主键。 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isValidUuid(v) {
  return UUID_RE.test(String(v || '').trim());
}

/* 校验并规范化请求体里的阅读记录字段(纯函数:不产生任何副作用) */
function parseReading(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};

  const status = String(b.status || 'wish');
  if (!STATUSES.includes(status)) errors.push('状态不合法');

  let readCount = b.read_count;
  if (readCount === '' || readCount === undefined || readCount === null) {
    readCount = 0;
  } else {
    readCount = Number(readCount);
    if (!Number.isInteger(readCount) || readCount < 0 || readCount > MAX_READ_COUNT) {
      errors.push(`读过次数应为 0~${MAX_READ_COUNT} 的整数`);
      readCount = 0;
    }
  }

  const start = String(b.start_date || '').trim();
  const finish = String(b.finish_date || '').trim();
  if (start && !DATE_RE.test(start)) errors.push('开始日期格式应为 YYYY-MM-DD');
  if (finish && !DATE_RE.test(finish)) errors.push('读完日期格式应为 YYYY-MM-DD');

  // 每次阅读的起止时间
  let readLogs = b.read_logs;
  if (typeof readLogs === 'string') {
    try { readLogs = JSON.parse(readLogs); } catch { readLogs = []; }
  }
  if (!Array.isArray(readLogs)) readLogs = [];
  readLogs = readLogs
    .map((l) => ({ start: String((l && l.start) || '').trim(), finish: String((l && l.finish) || '').trim() }))
    .filter((l) => l.start || l.finish);
  for (const l of readLogs) {
    if ((l.start && !DATE_RE.test(l.start)) || (l.finish && !DATE_RE.test(l.finish))) {
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
  const derived = deriveFromLogs(readLogs, { start, finish, readCount });

  return {
    errors,
    values: {
      status,
      read_count: derived.read_count,
      start_date: derived.start_date,
      finish_date: derived.finish_date,
      read_logs: JSON.stringify(readLogs),
      // 心得链接:属于"这本书我的阅读资产",随阅读记录一起存
      notes_url: String(b.notes_url || '').trim().slice(0, 1000),
    },
  };
}

/* 由阅读记录推导 起止日期 / 读过次数。
   有记录 → 完全推导;无记录 → 保留兜底值(兼容只传 finish_date 的旧客户端)。
   导出供 db 层迁移与测试复用,避免规则在多处重写。 */
function deriveFromLogs(readLogs, fallback = {}) {
  const logs = Array.isArray(readLogs) ? readLogs : [];
  if (!logs.length) {
    return {
      start_date: String(fallback.start || '').trim(),
      finish_date: String(fallback.finish || '').trim(),
      read_count: Number.isInteger(fallback.readCount) ? fallback.readCount : 0,
    };
  }
  const finished = logs.filter((l) => l.finish);
  const finishDate = finished.reduce((m, l) => (l.finish > m ? l.finish : m), '');
  let startDate = '';
  for (const l of logs) {
    if (l.start && l.start >= startDate) startDate = l.start; // 最近一次开读
  }
  return { start_date: startDate, finish_date: finishDate, read_count: finished.length };
}

/* PUT 局部更新语义:未提供的字段保留数据库旧值,
   前端局部提交 / 旧客户端脚本不会误清数据(纯函数:返回新对象) */
function mergeReadingUpdate(existing, values, body) {
  const b = body && typeof body === 'object' ? body : {};
  const merged = { ...values };
  if (!('notes_url' in b)) merged.notes_url = existing.notes_url;
  if (!('read_count' in b)) merged.read_count = existing.read_count;
  if (!('read_logs' in b)) merged.read_logs = existing.read_logs;
  if (!('start_date' in b)) merged.start_date = existing.start_date;
  if (!('finish_date' in b)) merged.finish_date = existing.finish_date;
  return merged;
}

/* 阅读记录行的对外形状:把 DB 行(JSON 字符串列)转成前端友好的对象 */
function readingToJson(row) {
  if (!row) return null;
  let readLogs = [];
  try { readLogs = JSON.parse(row.read_logs || '[]'); } catch { readLogs = []; }
  if (!Array.isArray(readLogs)) readLogs = [];
  return {
    calibre_uuid: row.calibre_uuid,
    status: row.status,
    read_count: row.read_count,
    read_logs: readLogs,
    start_date: row.start_date,
    finish_date: row.finish_date,
    notes_url: row.notes_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = {
  STATUSES,
  MAX_READ_COUNT,
  isValidUuid,
  parseReading,
  deriveFromLogs,
  mergeReadingUpdate,
  readingToJson,
};
