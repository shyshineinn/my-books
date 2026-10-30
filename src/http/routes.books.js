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
const notesRepo = require('../db/notes');
const coreSeries = require('../core/series');
const coreIdent = require('../core/identifiers');
const { db } = require('../db/index');
const { getBookSnapshot } = require('../db/sync');
const { checkBookPrecondition } = require('../core/revision');

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
    id: f.id, format: f.format, path: f.path, size: f.size, sha256: f.sha256,
    download_url: `/api/books/${row.id}/files/${f.id}/content?uuid=${encodeURIComponent(row.uuid)}`,
  }));
  const ids = identifiersRepo.getIdentifiers(db, row.id);
  const note = notesRepo.statNote(row.id);
  return {
    ...row,
    files,
    file_formats: files.map((f) => f.format).join(', '),
    identifiers: ids,
    identifier_list: coreIdent.toDisplayList(ids),
    series_label: coreSeries.seriesLabel(row.series, row.series_index),
    has_notes: !!note,
    notes_size: note ? note.size : 0,
    notes_updated_at: note ? note.updated_at : null,
    // custom:自定义字段的**原始值**(label → 字符串/数组),供表单回填;
    // custom_display:展示文本,供列表与详情直接渲染。两者分开是因为
    // 表单要能继续编辑(多值字段得拿到数组),展示只要成品字符串。
    custom: customFields.getRawValues(db, row.id),
    custom_display: customFields.getValues(db, row.id),
  };
}

// 列表接口给每本书附 custom_display、系列展示串与"有没有心得"(批量一次查完,避免 N+1)
function withCustomDisplay(rows) {
  if (!rows.length) return rows;
  const cols = customFields.listColumns(db);
  const map = cols.length
    ? customFields.getValuesForBooks(db, rows.map((r) => r.id), { columns: cols })
    : {};
  // 心得存在磁盘上(notes-files/{id}.md):一次 readdir 拿到全部有心得的 id
  const noteIds = new Set(notesRepo.listNoteIds());
  return rows.map((r) => ({
    ...r,
    custom_display: map[r.id] || {},
    series_label: coreSeries.seriesLabel(r.series, r.series_index),
    has_notes: noteIds.has(r.id),
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

// 列表分页参数:size 缺省 = 旧行为(全量数组);带 size 才分页并回 X-Total-Count。
// start 缺省 0;两者都必须是十进制整数,避免 Number('')=0、Number('1e3') 之类的宽松转换。
function parsePage(query) {
  if (query.size === undefined) return { page: null, error: '' };
  const rawSize = Array.isArray(query.size) ? query.size[0] : query.size;
  const rawStart = query.start === undefined
    ? 0
    : (Array.isArray(query.start) ? query.start[0] : query.start);
  const size = Number(rawSize);
  const start = Number(rawStart);
  if (!/^\d+$/.test(String(rawSize)) || !Number.isInteger(size) || size < 1 || size > 200) {
    return { page: null, error: 'size 应为 1~200 的整数' };
  }
  if (!/^\d+$/.test(String(rawStart)) || !Number.isInteger(start)) {
    return { page: null, error: 'start 应为非负整数' };
  }
  return { page: { start, size }, error: '' };
}

router.get('/api/sync/books', (req, res) => {
  if (Object.keys(req.query).length) return badBody(res, '同步接口不接受筛选或分页参数');
  res.set('Cache-Control', 'private, no-store');
  const snapshot = getBookSnapshot(db);
  res.json({ ...snapshot, books: withCustomDisplay(snapshot.books) });
});

router.get('/api/books', (req, res) => {
  try {
    // 作用域只由 ?vl= 中间件决定:请求体/查询串里的 scopeIds 一律忽略
    const { scopeIds: _ignored, start: _start, size: _size, ...filter } = req.query;
    const { page, error } = parsePage(req.query);
    if (error) return badBody(res, error);
    if (page) {
      const { rows, total } = books.listBooksPage({ ...filter, scopeIds: req.vlScope }, page, db);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Total-Count', String(total));
      return res.json(withCustomDisplay(rows));
    }
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

// 合并书籍时先把心得合并到目标(在 DB 合并前落盘,失败可恢复),
// 否则来源书删除后心得文件会永久消失。
function planBookNotes(target, sources) {
  const targetStat = notesRepo.statNote(target.id);
  const targetNote = targetStat ? notesRepo.readNote(target.id) : null;
  if (targetStat && !targetNote) {
    return { error: '目标书的心得读取失败,已中止合并', status: 500, code: 'INTERNAL' };
  }
  const items = [];
  for (const source of sources) {
    const stat = notesRepo.statNote(source.id);
    const note = stat ? notesRepo.readNote(source.id) : null;
    if (stat && !note) {
      return { error: `《${source.title}》的心得读取失败,已中止合并`, status: 500, code: 'INTERNAL' };
    }
    items.push({ id: source.id, title: source.title, content: note ? note.content : '' });
  }
  const oldContent = targetNote ? targetNote.content : null;
  const merged = notesRepo.mergeContents(oldContent || '', items);
  if (Buffer.byteLength(merged, 'utf8') > notesRepo.MAX_NOTE_BYTES) {
    return { error: '合并后的心得超过 5MB,已中止合并;请先拆分或清理来源心得', status: 400, code: 'VALIDATION' };
  }
  return {
    targetId: target.id,
    oldContent,
    content: merged,
    write: oldContent === null ? merged.trim().length > 0 : merged !== oldContent,
    sourceIds: items.map((item) => item.id),
  };
}

function restoreTargetNote(plan) {
  if (!plan || !plan.write) return;
  try {
    if (plan.oldContent === null) notesRepo.removeNote(plan.targetId);
    else notesRepo.writeNote(plan.targetId, plan.oldContent);
  } catch (err) {
    console.error(`[merge] 合并失败后恢复目标心得失败(id=${plan.targetId}):`, err);
  }
}

// 合并书籍:目标书保留标题/作者,其余字段/格式/标识符/自定义值合并;
// 来源书永久删除(与 calibre Merge book records 同语义)。
router.post('/api/books/merge', (req, res) => {
  const parsed = parseMergeRequest(req.body || {});
  if (parsed.error) return badBody(res, parsed.error);

  const sourceIds = [...new Set(parsed.sourceIds)].filter((id) => id !== parsed.targetId);
  const targetBook = books.getBook(parsed.targetId);
  const sourceBooks = sourceIds.map((id) => books.getBook(id));
  const canPlanNotes = !!targetBook && sourceIds.length > 0 && sourceBooks.every(Boolean);
  let notePlan = null;
  if (canPlanNotes) {
    notePlan = planBookNotes(targetBook, sourceBooks);
    if (notePlan.error) return res.status(notePlan.status).json({ error: notePlan.error, code: notePlan.code });
    if (notePlan.write) {
      try {
        notesRepo.writeNote(notePlan.targetId, notePlan.content);
      } catch (err) {
        const status = err && err.code === 'VALIDATION' ? 400 : 500;
        return res.status(status).json({ error: (err && err.message) || '心得写入失败', code: status === 400 ? 'VALIDATION' : 'INTERNAL' });
      }
    }
  }

  let result;
  try {
    result = mergeRepo.mergeBooks(db, parsed.targetId, parsed.sourceIds);
  } catch (err) {
    restoreTargetNote(notePlan);
    throw err;
  }
  if (!result.ok) {
    restoreTargetNote(notePlan);
    const status = result.code === 'VALIDATION' ? 400 : 404;
    return res.status(status).json({ error: result.error, code: result.code || 'NOT_FOUND' });
  }

  let failed = 0;
  for (const item of result.assets) failed += removeBookAssets(item.assets);
  for (const sourceId of sourceIds) {
    if (!notesRepo.removeNote(sourceId)) failed += 1;
  }
  if (failed) {
    console.error(`[merge] 已合并到 id=${parsed.targetId},但有 ${failed} 个来源文件/心得未能从磁盘移除`);
  }
  res.json({ ok: true, target: result.target, merged: result.merged });
});

// 局部更新:只改请求体出现的字段。PUT 是整书语义(省略 status/tags 会被默认值重置),
// PATCH 必须先拼出完整 body 再走 parseBook,未提供的字段保留旧值。
// expected_updated_at / If-Match 用于防止 App 用旧快照覆盖网页端刚做的修改。
router.patch('/api/books/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const existing = books.getBook(id);
  if (!existing) return notFound(res);

  const { expected_updated_at, expected_revision, expected_uuid, ...patch } = req.body || {};
  const condition = checkBookPrecondition(existing, req.body || {}, req.get('If-Match'));
  if (!condition.ok) return res.status(condition.code === 'VALIDATION' ? 400 : 409)
    .json({ ...condition, current: withFiles(existing) });

  let existingTags = [];
  try { existingTags = JSON.parse(existing.tags || '[]'); } catch { existingTags = []; }
  let existingLogs = [];
  try { existingLogs = JSON.parse(existing.read_logs || '[]'); } catch { existingLogs = []; }

  const fullBody = {
    ...existing,
    tags: Array.isArray(existingTags) ? existingTags : [],
    read_logs: Array.isArray(existingLogs) ? existingLogs : [],
    identifiers: identifiersRepo.getIdentifiers(db, id),
    ...patch,
  };
  const { errors, values } = parseBook(fullBody);
  if (errors.length) return badBody(res, errors.join(';'));

  const custom = parseCustom(req.body);
  if (!custom.ok) return badBody(res, custom.errors.join(';'));

  const updated = books.updateBook(id, values, custom.values);
  if (!updated) return notFound(res);
  res.json(withFiles(updated));
});

router.put('/api/books/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badId(res);
  const existing = books.getBook(id);
  if (!existing) return notFound(res);
  const condition = checkBookPrecondition(existing, req.body || {}, req.get('If-Match'));
  if (!condition.ok) return res.status(condition.code === 'VALIDATION' ? 400 : 409)
    .json({ ...condition, current: withFiles(existing) });

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
  const existing = books.getBook(id, db, { includeDeleted: true });
  if (!existing) return notFound(res);
  const condition = checkBookPrecondition(existing, req.body || {}, req.get('If-Match'));
  if (!condition.ok) return res.status(condition.code === 'VALIDATION' ? 400 : 409)
    .json({ ...condition, current: withFiles(existing) });

  if (req.query.purge === '1') {
    const result = books.purgeBook(db, id);
    if (!result.ok) {
      if (result.code === 'CONFLICT') {
        return res.status(409).json({ error: result.error, code: 'CONFLICT' });
      }
      return notFound(res);
    }

    let failed = removeBookAssets(result.assets);
    if (!notesRepo.removeNote(id)) failed += 1;
    if (failed) {
      // 记录已删、文件没删净:数据一致性没破,只是磁盘留垃圾。
      // 不谎报失败,但要在日志里留痕,便于人工清理。
      console.error(`[purge] 书 id=${id} 已彻底删除,但有 ${failed} 个文件/心得未能从磁盘移除`);
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
