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

const { titleSort, authorsToSortString } = require('./sort_keys');
const { parseSeriesInput, clampSeriesIndex } = require('./series');
const { parseIdentifiers } = require('./identifiers');

// 多作者分隔符:& , ， 、 / —— 有意不含间隔号 ·(马尔克斯、赫拉利等译名内含 ·)
const AUTHOR_SEP = /[&，、,/]+/;
const AUTHOR_JOIN = '、';

// 把作者串按分隔符拆成去重去空的数组(纯函数)。单作者原样返回单元素。
function splitAuthors(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(AUTHOR_SEP);
  const out = [];
  const seen = new Set();
  for (const a of raw) {
    const name = String(a == null ? '' : a).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

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

  // 作者:优先取 body.authors 数组,否则按分隔符拆 body.author 字符串;
  // 归一化后 author = 展示缓存(「、」连接)。
  // author_sort = A8 起改用图书馆惯例的倒装键(「Smith, John」),多作者用 ' & '
  // 连接 —— 对标 calibre authors_to_sort_string(metadata/__init__.py:141-142)。
  // 单 token(中文名/笔名)原样返回,所以中文书的排序结果与改造前一致。
  const authors = Array.isArray(body.authors) ? splitAuthors(body.authors) : splitAuthors(body.author);

  // 系列(A3):支持 `系列名 [序号]` 输入语法(对标 calibre _get_series_values)。
  // 显式传 series_index 时优先用它;并支持 body.series_index 独立更新。
  //
  // 注意"只改序号"这种局部提交:请求体里没有 series 时,**不能**擅自把序号
  // 归 0 —— 系列名要由 mergeUpdate 从数据库旧值补上,序号得一起留着,
  // 否则"只把序号从 3 改成 7"会退化成 0(实测踩过)。
  // 只在两种情况归 0:① 显式传了 series 且为空(真的移出系列)② 有系列名但没给序号。
  const seriesProvided = 'series' in (body || {});
  const seriesParsed = parseSeriesInput(body.series);
  let seriesName = seriesParsed.series;
  let seriesIndex = seriesParsed.series_index;
  if (body.series_index !== undefined && body.series_index !== '') {
    seriesIndex = clampSeriesIndex(body.series_index);
  }
  if (seriesProvided && !seriesName) {
    seriesIndex = 0;                 // 显式清空系列 → 序号一并清掉
  } else if (!seriesProvided && body.series_index === undefined) {
    seriesIndex = 0;                 // 请求体完全没提系列 → 交给 mergeUpdate 兜底
  }

  // 标识符(A5):任意 type → 值。isbn / douban_id 仍走专用列(双写在 db 层完成)
  const ids = parseIdentifiers({
    ...(body.identifiers && typeof body.identifiers === 'object' ? body.identifiers : {}),
    ...(body.isbn !== undefined ? { isbn: body.isbn } : {}),
    ...(body.douban_id !== undefined || body.doubanId !== undefined
      ? { douban: body.douban_id !== undefined ? body.douban_id : body.doubanId }
      : {}),
  });

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
      // title_sort:剥引号 + 英语冠词移位(「The Hobbit」→「Hobbit, The」)。
      // 中文书名不含冠词 → 原样,排序行为与改造前一致
      title_sort: titleSort(title),
      author: authors.join(AUTHOR_JOIN),
      author_sort: authorsToSortString(authors),
      status,
      summary: String(body.summary || '').trim().slice(0, 1000),
      tags: JSON.stringify(tags),
      start_date: startDate,
      finish_date: finishDate,
      cover: String(body.cover || '').trim(),
      read_count: readCount,
      read_logs: JSON.stringify(readLogs),
      // 豆瓣元数据字段(v4 列;可选,由前端"从豆瓣填充"或 API 传入)
      publisher: String(body.publisher || '').trim().slice(0, 200),
      pub_year: String(body.pub_year || body.pubYear || '').trim().slice(0, 20),
      isbn: String(body.isbn || '').trim().slice(0, 20),
      rating: clampRating(body.rating),
      douban_id: String(body.douban_id || body.doubanId || '').trim().slice(0, 32),
      // A3 系列 / A5 标识符(A12 起)
      series: seriesName.slice(0, 200),
      series_index: seriesIndex || 0,
      identifiers: ids.values,
    },
  };
}

// 评分:0~10(与豆瓣原始分同制,2026 年起本站不再折半),一位小数;
// 非法输入归 0。旧库存的 5 分制值由 migrateV8 ×2 迁移到 10 分制
function clampRating(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(10, Math.round(n * 10) / 10);
}

// PUT 局部更新语义:表单未提供的字段保留数据库旧值,
// 前端局部提交 / 旧客户端脚本不会误清数据(纯函数:返回新对象)
function mergeUpdate(existing, values, body) {
  const merged = { ...values };
  if (!('summary' in body)) merged.summary = existing.summary;
  if (!('author' in body) && !('authors' in body)) {
    merged.author = existing.author;
    merged.author_sort = existing.author_sort;
  }
  // 书名变了要重算排序键(前端正常会传 title,但脚本可能只改标题_sort 之外的东西)
  if (!('title' in body)) merged.title_sort = existing.title_sort;
  if (!('cover' in body)) merged.cover = existing.cover;
  if (!('read_count' in body)) merged.read_count = existing.read_count;
  if (!('read_logs' in body)) merged.read_logs = existing.read_logs;
  if (!('publisher' in body)) merged.publisher = existing.publisher;
  if (!('pub_year' in body)) merged.pub_year = existing.pub_year;
  if (!('isbn' in body)) merged.isbn = existing.isbn;
  if (!('rating' in body)) merged.rating = existing.rating;
  if (!('douban_id' in body) && !('doubanId' in body)) merged.douban_id = existing.douban_id;
  // A3/A5:未提供就保留旧值。
  // series 的四种组合都要照顾到(序号 0 = 未指定):
  //   · 都没提            → 系列名与序号全部保留
  //   · 只提 series_index → 系列名保留(parseBook 已给出新序号)
  //   · 只提 series       → 序号用新值(parseBook 已算),系列名用新值
  //   · 显式 series: ''   → 一起清空
  if (!('series' in body) && !('series_index' in body)) {
    merged.series = existing.series || '';
    merged.series_index = existing.series_index || 0;
  } else if (!('series' in body)) {
    merged.series = existing.series || '';        // 只改序号:系列名保留
  } else if (!('series_index' in body) && String(body.series || '').trim()) {
    // 只改系列名(没给序号):沿用旧序号,避免"改个名字序号就没了"
    merged.series_index = merged.series_index || existing.series_index || 0;
  }
  // identifiers:未提供就完全不动(由 db 层按"未出现的类型保持不动"处理)
  if (!('identifiers' in body)) merged.identifiers = null;
  return merged;
}

// 从封面字段取出"本站 uploads/ 里的文件名";外链封面返回空串。
// 删书时据此清理磁盘:只有 /uploads/<文件名> 这种本站自存的图才该删,
// 豆瓣等外链封面只是个地址,没有本地文件可删。
// 只认单层文件名(含 / 一律拒绝),越界路径在 fs-utils 的 removeUnderBase 还有第二道收口。
function coverUploadFile(cover) {
  const s = String(cover || '').trim();
  if (!s.startsWith('/uploads/')) return '';
  const rel = s.slice('/uploads/'.length);
  if (!rel || rel.includes('/') || rel.includes('\\')) return '';
  return rel;
}

module.exports = { STATUSES, parseBook, mergeUpdate, coverUploadFile, splitAuthors };
