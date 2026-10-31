/* ============================================================
 * CSV 导入路由(HTTP 适配层)
 *
 *   POST /api/import.csv
 *   Content-Type: text/csv(或 application/json 里放 { csv: "..." })
 *   Query: ?duplicate=add|ignore|add_formats_to_existing
 *          &automerge=overwrite|ignore|new+record
 *          &dry_run=1
 *   → { results, summary, ignoredHeaders, mappedFields, customFields }
 *
 * **dry_run 是默认推荐的用法**:它跑完全部校验与查重、返回逐条结论,
 *   但一行都不写库。前端先 dry-run 给你看一眼"会新建几本、会跳过几本",
 *   确认后再真导。对标 calibre 导入前那个确认对话框。
 *
 * 错误语义(与 routes.isbn.js / routes.enrich.js 同构):
 *   参数/格式问题 → 400 VALIDATION;逐条失败体现在 results[].status,整批仍 200。
 * ============================================================ */

const express = require('express');

const { importCsv } = require('../core/import');
const dbImport = require('../db/import');
const dbCustom = require('../db/custom_fields');
const coreCustom = require('../core/custom_fields');
const { db } = require('../db/index');

const router = express.Router();

// 从请求里取 CSV 文本:支持三种来源
//   1. 裸 text/csv 请求体(前端 fetch 直接发文件内容)
//   2. JSON { csv: "..." }
//   3. JSON { base64: "..." }(前端用 FileReader 读成 base64 时)
function extractCsv(req) {
  const b = req.body;
  if (typeof b === 'string') return b;
  if (b && typeof b === 'object') {
    if (typeof b.csv === 'string') return b.csv;
    if (typeof b.text === 'string') return b.text;
    if (typeof b.base64 === 'string') {
      try { return Buffer.from(b.base64, 'base64').toString('utf8'); } catch { return ''; }
    }
  }
  return '';
}

async function handleImportCsv(req, res) {
  const text = extractCsv(req);
  if (!String(text).trim()) {
    return res.status(400).json({
      error: '没有收到 CSV 内容(用 text/csv 请求体,或 JSON 的 csv / base64 字段)',
      code: 'VALIDATION',
    });
  }

  const q = req.query || {};
  const dryRun = q.dry_run === '1' || q.dry_run === 'true';

  try {
    // 自定义字段:先在**表头层**校验一遍,再逐行校验值。
    //
    // 为什么表头层就要校验:CSV 里出现不存在的 #label 是"列名打错",
    // 属于结构性问题,应该整份拒绝(400),而不是等到某一行要写入时才炸 ——
    // 那时前面几行可能已经写进去了,用户看到的是"导了一半"。
    // 实测踩过:只在 createBook/mergeBook 里校验时,dry_run 与"全判重复"
    // 两种情况根本走不到那里,非法列名被静默忽略。
    const cols = dbCustom.listColumns(db);
    const byLabel = new Map(cols.map((c) => [c.label, c]));

    const head = dbImport.parseHeaders(text);
    const unknownCustom = head.custom.filter((label) => !byLabel.has(label));
    if (unknownCustom.length) {
      return res.status(400).json({
        error: `CSV 里的自定义字段不存在:${unknownCustom.join(', ')}(请先在 /tags 页创建)`,
        code: 'VALIDATION',
      });
    }

    const out = importCsv({
      listExisting: () => dbImport.listExisting(db),
      isbnOf: dbImport.makeIsbnOf(db),
      createBook: (body, custom, meta) => {
        const clean = validateCustom(byLabel, custom);
        return dbImport.createBook(body, clean, db, meta && meta.collections);
      },
      mergeBook: (id, body, custom, opts, meta) => {
        const clean = validateCustom(byLabel, custom);
        return dbImport.mergeBook(id, body, clean, opts, db, meta && meta.collections);
      },
    }, {
      text,
      duplicateAction: String(q.duplicate || 'add'),
      automergeAction: String(q.automerge || 'ignore'),
      dryRun,
    });

    res.json(out);
  } catch (err) {
    if (err && err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message, code: 'VALIDATION' });
    }
    console.error('[import] csv failed:', (err && (err.stack || err.message)) || err);
    res.status(500).json({ error: 'CSV 导入失败,请稍后重试', code: 'INTERNAL' });
  }
}

// 把 CSV 的 #label 原始值规范化成可入库的字符串。
// 未知 label 直接抛错(在事务外抛,整行不会写进去) ——
// 静默丢弃会让"列名打错"表现为"这个字段没导进来",很难排查。
function validateCustom(byLabel, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const labels = Object.keys(src);
  if (!labels.length) return null;

  const unknown = labels.filter((l) => !byLabel.has(l));
  if (unknown.length) {
    throw Object.assign(
      new Error(`CSV 里的自定义字段不存在:${unknown.join(', ')}(请先在 /tags 页创建)`),
      { code: 'VALIDATION' },
    );
  }

  const values = {};
  for (const label of labels) {
    const col = byLabel.get(label);
    const r = coreCustom.normalizeValue(col, src[label]);
    if (!r.ok) {
      throw Object.assign(new Error(r.error), { code: 'VALIDATION' });
    }
    if (r.value !== '') values[label] = r.value;
  }
  return Object.keys(values).length ? values : null;
}

router.post('/api/import.csv', handleImportCsv);

module.exports = router;
module.exports.handleImportCsv = handleImportCsv;
module.exports.validateCustom = validateCustom;
module.exports.extractCsv = extractCsv;
