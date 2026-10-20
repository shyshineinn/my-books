/* ============================================================
 * 书籍路由:解析请求参数 → 调 src/db → 组 HTTP 响应
 * 业务校验在 src/core/parseBook,数据操作在 src/db/books,
 * 本文件只做 HTTP 协议适配,不写业务规则与 SQL。
 *
 * 错误响应统一带 code 字段:中文消息给人类看,
 * code(AUTH_REQUIRED/NOT_FOUND/VALIDATION/CONFLICT)给多端程序判断
 * —— PWA / 小程序 / CLI 按 code 分支,不解析中文文案。
 * ============================================================ */

const express = require('express');

const { parseBook, mergeUpdate } = require('../core/book');
const { parseBulkRequest } = require('../core/bulk');
const { parseMergeRequest } = require('../core/merge');
const coreCustom = require('../core/custom_fields');
const { removeBookAssets } = require('../core/fs-utils');
const books = require('../db/books');
const duplicatesRepo = require('../db/duplicates');
const mergeRepo = require('../db/merge');
const bookFiles = require('../db/book_files');
const customFields = require('../db/custom_fields');
const identifiersRepo = require('../db/identifiers');
const coreSeries = require('../core/series');
const coreIdent = require('../core/identifiers');
const { db } = require('../db/index');

const router = express.Router();

// 给书籍行附加文件信息 + 标识符 + 系列展示串:
//   files          —— 该书全部文件 [{id, format, path, size}](详情弹窗下载区)
//   file_formats   —— 格式名逗号串(书架卡片角标,如 "EPUB, PDF")
//   identifiers    —— { type: value }(表为准,旧列兜底)
//   identifier_list—— [{type,label,value,url}],详情页直接渲染
//   series_label   —— 「基地 #3」这种展示串
function withFiles(row) {
  if (!row) return row;
  const files = bookFiles.listFiles(db, row.id).map((f) => ({
    id: f.id, format: f.format, path: f.path, size: f.size,
  }));
  const ids = identifiersRepo.getIdentifiers(db, row.id);
  return {
    ...row,
    files,
    file_formats: files.map((f) => f.format).join(', '),
    identifiers: ids,
    identifier_list: coreIdent.toDisplayList(ids),
    series_label: coreSeries.seriesLabel(row.series, row.series_index),
    // custom:自定义字段的**原始值**(label → 字符串/数组),供表单回填;
    // custom_display:展示文本,供列表与详情直接渲染。两者分开是因为
    // 表单要能继续编辑(多值字段得拿到数组),展示只要成品字符串。
    custom: customFields.getRawValues(db, row.id),
    custom_display: customFields.getValues(db, row.id),
  };
}

// 列表接口给每本书附 custom_display 与系列展示串(批量一次查完,避免 N+1)
function withCustomDisplay(rows) {
  if (!rows.length) return rows;
  const cols = customFields.listColumns(db);
  const map = cols.length
    ? customFields.getValuesForBooks(db, rows.map((r) => r.id), { columns: cols })
    : {};
  return rows.map((r) => ({
    ...r,
    custom_display: map[r.id] || {},
    series_label: coreSeries.seriesLabel(r.series, r.series_index),
  }));
}

// 解析并校验请求体里的自定义字段值(只有请求体真带了 custom 才校验)
function parseCustom(body) {
  if (!body || body.custom === undefined) return { ok: true, errors: [], values: null };
  const cols = customFields.listColumns(db);
  return coreCustom.normalizeBookValues(cols, body.custom);
}

// :id 参数类型收口(借鉴 calibre srv/ajax.py 对 ids 的显式校验):
// 必须是正整数字符串,否则 400 —— 保证进入数据层的 id 语义正确,
// 让"格式错"返回 400、"格式对但不存在"返回 404,二者不混淆
function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const badId = (res) => res.status(400).json({ error: '书籍 id 应为正整数', code: 'VALIDATION' });
const notFound = (res) => res.status(404).json({ error: '书籍不存在', code: 'NOT_FOUND' });
const badBody = (res, msg) => res.status(400).json({ error: msg, code: 'VALIDATION' });

router.get('/api/books', (req, res) => {
  try {
    // 作用域只由 ?vl= 中间件决定:请求体/查询串里的 scopeIds 一律忽略
    const { scopeIds: _ignored, ...filter } = req.query;
    res.json(withCustomDisplay(books.listBooks({ ...filter, scopeIds: req.vlScope }, db)));
  } catch (err) {
    // 检索语法错误(如未知的 #自定义字段、数值字段给非数字)是用户输入问题,回 400 并说明原因。
    // 不能让它掉进兜底 500 —— 那是"服务器坏了"的语义,会误导排查方向。
    if (err && err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message, code: 'VALIDATION' });
    }
    throw err;
  }
});

// A3:系列列表(带计数与序号范围)—— 等价于 calibre 的 tag browser 系列分类。
// 不建 series 值表,GROUP BY 即可(count / min / max 一次查出)。
router.get('/api/series', (req, res) => {
  res.json(books.listSeries(db, { scopeIds: req.vlScope }).map((r) => ({
    name: r.name,
    count: r.count,
    // 0 表示"未指定序号",对外统一成 null,前端据此不显示 #
    min_index: r.min_index || null,
    max_index: r.max_index || null,
    label: coreSeries.seriesLabel(r.name, r.max_index),
  })));
});

// A5:标识符冲突自检(同类型同值被多本书占用)—— 数据体检用,只读
router.get('/api/identifiers/duplicates', (req, res) => {
  res.json(identifiersRepo.findDuplicates(db));
});

// 疑似重复书籍(只读扫描)。同样必须在 /api/books/:id 之前。
router.get('/api/books/duplicates', (req, res) => {
  res.json({ groups: duplicatesRepo.listDuplicateGroups(db, { scopeIds: req.vlScope }) });
});

// 回收站列表。必须定义在 /api/books/:id 之前,否则 "trash" 会被当成 id 校验。
router.get('/api/books/trash', (req, res) => {
  res.json({
    retention_days: books.TRASH_RETENTION_DAYS,
    books: books.listTrash(db),
  });
});

// 恢复:清墓碑。ISBN 在回收期间被别的在架书占用时返回 409。
router.post('/api/books/:id/restore', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const result = books.restoreBook(db, id);
  if (!result.ok) {
    if (result.code === 'CONFLICT') {
      return res.status(409).json({ error: result.error, code: 'CONFLICT' });
    }
    return notFound(res);
  }
  res.json({ ok: true });
});

router.get('/api/books/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const row = books.getBook(id);
  if (!row) return notFound(res);
  res.json(withFiles(row));
});

router.post('/api/books', (req, res) => {
  const { errors, values } = parseBook(req.body);
  if (errors.length) return badBody(res, errors.join(';'));

  const custom = parseCustom(req.body);
  if (!custom.ok) return badBody(res, custom.errors.join(';'));

  res.status(201).json(withFiles(books.addBook(values, custom.values)));
});

// 批量编辑:body { ids: [...], patch: {...} }。只改 patch 里出现的字段;
// 所有书在一个事务内更新,任一 id 不存在则整体不做(404)。
router.post('/api/books/bulk', (req, res) => {
  const { errors, ids, patch } = parseBulkRequest(req.body || {});
  if (errors.length) return badBody(res, errors.join(';'));

  const result = books.bulkUpdateBooks(db, ids, patch);
  if (!result.ok) {
    return res.status(404).json({ error: result.error, code: 'NOT_FOUND' });
  }
  res.json(result);
});

// 合并书籍:目标书保留标题/作者,其余字段/格式/标识符/自定义值合并;
// 来源书永久删除(与 calibre Merge book records 同语义)。
router.post('/api/books/merge', (req, res) => {
  const parsed = parseMergeRequest(req.body || {});
  if (parsed.error) return badBody(res, parsed.error);

  const result = mergeRepo.mergeBooks(db, parsed.targetId, parsed.sourceIds);
  if (!result.ok) {
    const status = result.code === 'VALIDATION' ? 400 : 404;
    return res.status(status).json({ error: result.error, code: result.code || 'NOT_FOUND' });
  }

  let failed = 0;
  for (const item of result.assets) failed += removeBookAssets(item.assets);
  if (failed) {
    console.error(`[merge] 已合并到 id=${parsed.targetId},但有 ${failed} 个来源文件未能从磁盘移除`);
  }
  res.json({ ok: true, target: result.target, merged: result.merged });
});

router.put('/api/books/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const existing = books.getBook(id);
  if (!existing) return notFound(res);

  const { errors, values } = parseBook(req.body);
  if (errors.length) return badBody(res, errors.join(';'));

  const custom = parseCustom(req.body);
  if (!custom.ok) return badBody(res, custom.errors.join(';'));

  // 表单未提供的字段:保留数据库旧值(简介/读后感/心得链接/封面/读过次数/阅读记录)
  const merged = mergeUpdate(existing, values, req.body);
  res.json(withFiles(books.updateBook(existing.id, merged, custom.values)));
});

// 删除:默认移入回收站(墓碑,14 天可恢复);?purge=1 才是彻底删除。
// 彻底删除只允许回收站里的书,防止误把在架书直接抹掉。
router.delete('/api/books/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);

  if (req.query.purge === '1') {
    const result = books.purgeBook(db, id);
    if (!result.ok) {
      if (result.code === 'CONFLICT') {
        return res.status(409).json({ error: result.error, code: 'CONFLICT' });
      }
      return notFound(res);
    }

    const failed = removeBookAssets(result.assets);
    if (failed) {
      // 记录已删、文件没删净:数据一致性没破,只是磁盘留垃圾。
      // 不谎报失败,但要在日志里留痕,便于人工清理。
      console.error(`[purge] 书 id=${id} 已彻底删除,但有 ${failed} 个文件未能从磁盘移除`);
    }
    return res.json({ ok: true, purged: true });
  }

  const deleted = books.softDeleteBook(db, id);
  if (!deleted) return notFound(res);
  res.json({
    ok: true,
    deleted_at: deleted.deleted_at,
    retention_days: books.TRASH_RETENTION_DAYS,
  });
});

module.exports = router;
