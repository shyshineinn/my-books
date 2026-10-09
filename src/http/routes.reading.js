/* ============================================================
 * 阅读记录路由(第二数据库的 HTTP 适配)
 *
 *   GET    /api/reading                 全部阅读记录(前端可一次拉全量做本地 join)
 *   GET    /api/reading/:uuid           单本阅读记录;不存在返回默认「想读」骨架
 *   PUT    /api/reading/:uuid           幂等写入(status/read_logs/read_count/...)
 *   PATCH  /api/reading/:uuid/status    只改状态(高频轻操作)
 *   DELETE /api/reading/:uuid           删除记录
 *   GET    /api/reading/stats           统计(总藏书/各状态/按年读完/标签 Top)
 *   POST   /api/reading/orphans         清理在 calibre 里已不存在的孤儿行
 *
 * 鉴权:当前为全网公开读写(用户明确要求,见 server.js 的说明)。
 *       JSON 响应的 code 字段保留 —— 前端/脚本按 code 分支,不解析中文文案。
 * ============================================================ */

const express = require('express');

const readingDb = require('../db/reading');
const { parseReading, mergeReadingUpdate, readingToJson, isValidUuid, STATUSES } = require('../core/reading');
const { computeReadingStats } = require('../core/stats');

const router = express.Router();

/* 默认骨架:从未记录过的书,前端也应拿到一个可渲染的「想读」对象,
   而不是 404 —— 否则列表页要给每本书写分支。 */
function defaultReading(uuid) {
  return {
    calibre_uuid: uuid,
    status: 'wish',
    read_count: 0,
    read_logs: [],
    start_date: '',
    finish_date: '',
    notes_url: '',
    created_at: null,
    updated_at: null,
    is_default: true, // 提示前端:这条尚未落库
  };
}

const badUuid = (res) => res.status(400).json({ error: 'calibre_uuid 形状不合法', code: 'VALIDATION' });

/* 注意:具体路径必须注册在 /:uuid 之前,否则 'stats' 会被当成 uuid */
router.get('/api/reading/stats', (req, res) => {
  res.json(computeReadingStats(readingDb.allReadings()));
});

router.get('/api/reading', (req, res) => {
  const rows = readingDb.db.prepare('SELECT * FROM reading ORDER BY updated_at DESC').all();
  res.json({ readings: rows.map(readingToJson) });
});

router.get('/api/reading/:uuid', (req, res) => {
  const uuid = String(req.params.uuid || '').trim();
  if (!isValidUuid(uuid)) return badUuid(res);
  const row = readingDb.getReading(uuid);
  res.json({ reading: row ? { ...readingToJson(row), is_default: false } : defaultReading(uuid) });
});

router.put('/api/reading/:uuid', (req, res) => {
  const uuid = String(req.params.uuid || '').trim();
  if (!isValidUuid(uuid)) return badUuid(res);

  const { errors, values } = parseReading(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(';'), code: 'VALIDATION' });

  // PUT 局部更新语义:未提供的字段保留旧值(与既有 /api/books 的 PUT 一致)
  const existing = readingDb.getReading(uuid);
  const merged = existing
    ? mergeReadingUpdate(readingToJson(existing), values, req.body)
    : values;

  // mergeReadingUpdate 返回的 read_logs 可能是 DB 里的 JSON 字符串,统一成字符串入库
  const toStore = {
    ...merged,
    read_logs: typeof merged.read_logs === 'string' ? merged.read_logs : JSON.stringify(merged.read_logs || []),
  };
  const saved = readingDb.upsertReading(uuid, toStore);
  res.json({ reading: { ...readingToJson(saved), is_default: false } });
});

router.patch('/api/reading/:uuid/status', (req, res) => {
  const uuid = String(req.params.uuid || '').trim();
  if (!isValidUuid(uuid)) return badUuid(res);

  const status = String((req.body && req.body.status) || '');
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `状态应为 ${STATUSES.join(' / ')}`, code: 'VALIDATION' });
  }

  const existing = readingDb.getReading(uuid);
  if (!existing) {
    // 尚未落库:建一行,其余字段用默认值
    const { values } = parseReading({ status });
    const saved = readingDb.upsertReading(uuid, values);
    return res.status(201).json({ reading: { ...readingToJson(saved), is_default: false } });
  }
  const saved = readingDb.setStatus(uuid, status);
  res.json({ reading: { ...readingToJson(saved), is_default: false } });
});

router.delete('/api/reading/:uuid', (req, res) => {
  const uuid = String(req.params.uuid || '').trim();
  if (!isValidUuid(uuid)) return badUuid(res);
  const ok = readingDb.deleteReading(uuid);
  if (!ok) return res.status(404).json({ error: '没有该书的阅读记录', code: 'NOT_FOUND' });
  res.json({ ok: true });
});

/* 清理孤儿:calibre 里已删掉的书,其阅读记录默认保留(历史不该被抹掉)。
   由调用方显式传入当前存在的 uuid 列表,明确要清才清。 */
router.post('/api/reading/orphans', (req, res) => {
  if (req.body && req.body.delete === true) {
    const uuids = Array.isArray(req.body.existing_uuids) ? req.body.existing_uuids : null;
    if (!uuids) return res.status(400).json({ error: '需要 existing_uuids', code: 'VALIDATION' });
    const orphans = readingDb.listOrphans(uuids);
    for (const u of orphans) readingDb.deleteReading(u);
    return res.json({ deleted: orphans.length, orphans });
  }
  const uuids = Array.isArray(req.body && req.body.existing_uuids) ? req.body.existing_uuids : [];
  const orphans = readingDb.listOrphans(uuids);
  res.json({ orphans });
});

module.exports = router;
