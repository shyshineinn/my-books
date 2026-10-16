/* ============================================================
 * ISBN 路由:GET /api/isbn/check + GET /api/isbn/lookup
 *          + POST /api/books/from-isbn
 *
 * 对标 calibre 的「按 ISBN 添加」(gui2/actions/add_from_isbn.py):
 *   · check  → 单本校验 + 归一化 + 库内查重(扫码/手输回填前先问一句)
 *   · lookup → 按 ISBN 抓元数据但**不建档**(单本回填表单用;
 *              批量导入内部走同一份 lookupIsbn,取数行为一致)
 *   · from-isbn → 批量导入:校验/批内去重/库内查重/抓元数据/逐条建档,
 *                编排在 core/isbn_import.js,本文件只做 HTTP 适配。
 *
 * 为什么 check 是 GET:纯查询、无副作用(requireAdmin 对 GET 放行);
 * from-isbn 是写操作,走 /api 的 Bearer 鉴权(与 POST /api/books 同级)。
 *
 * 错误语义:参数/批量约束问题 → 400 VALIDATION(带中文原因);
 * 逐条失败(查不到/被拒/网络错)不是请求错误,体现在 results[].status,
 * 整批仍 200 —— 前端的"逐条结果清单"就靠它。lookup 同理:
 * not_found/blocked 是业务结论,200 返回。
 * ============================================================ */

const express = require('express');

const { checkIsbn, normalizeIsbn, isbnKey } = require('../core/isbn');
const { importIsbns, parseIsbnInput } = require('../core/isbn_import');
const { parseBook } = require('../core/book');
const { lookupIsbn } = require('./metadata-sources');
const identifiersRepo = require('../db/identifiers');
const books = require('../db/books');
const { db } = require('../db/index');

const router = express.Router();

// GET /api/isbn/check?isbn=xxx
// → { input, valid, normalized, duplicate: {id,title}|null }
// 非法 ISBN 也是 200(valid:false 是业务结论,不是请求错误);
// 缺参数才是 400 —— 那是调用方拼错了请求。
function handleIsbnCheck(req, res) {
  const input = String(req.query.isbn || '').trim();
  if (!input) return res.status(400).json({ error: '缺少 isbn 参数', code: 'VALIDATION' });

  const isbn = checkIsbn(input);
  if (!isbn) return res.json({ input, valid: false, normalized: '', duplicate: null });

  const normalized = normalizeIsbn(isbn);
  const hit = identifiersRepo.listIsbnIndex(db).get(isbnKey(normalized)) || null;
  res.json({
    input,
    valid: true,
    normalized,
    duplicate: hit ? { id: hit.id, title: hit.title } : null,
  });
}

// GET /api/isbn/lookup?isbn=xxx
// → { status: 'found', book, source } | { status: 'not_found'|'blocked'|'error' }
// 只查询、不建档:单本书扫码/手输后回填表单用。与批量导入共用
// metadata-sources.lookupIsbn(豆瓣直查 → Open Library 兜底),两条链路同源。
async function handleIsbnLookup(req, res) {
  const input = String(req.query.isbn || '').trim();
  if (!input) return res.status(400).json({ error: '缺少 isbn 参数', code: 'VALIDATION' });
  const isbn = checkIsbn(input);
  if (!isbn) return res.status(400).json({ error: '不是合法的 ISBN(位数或校验位不对)', code: 'VALIDATION' });

  try {
    res.json(await lookupIsbn(normalizeIsbn(isbn)));
  } catch (err) {
    // lookupIsbn 内部已把网络异常折叠成 status:'error';走到这里属于意外
    console.error('[isbn] lookup failed:', (err && (err.stack || err.message)) || err);
    res.status(500).json({ error: 'ISBN 查询失败,请稍后重试', code: 'INTERNAL' });
  }
}

// POST /api/books/from-isbn
// body: { isbns: string|string[], tags?, convert_to_13?, check_existing? }
// → { results: [{input,isbn,status,title,bookId,existing,error}], summary }
async function handleImportFromIsbn(req, res) {
  const body = req.body || {};
  try {
    const out = await importIsbns({
      lookupIsbn,
      // 查重索引与单本 check 共用同一来源(表 + 旧列双读,见 db/identifiers.js)
      isbnIndex: () => identifiersRepo.listIsbnIndex(db),
      createBook: (payload) => {
        const { errors, values } = parseBook(payload);
        // 映射结果理论上不会缺书名;真缺了是"这条数据有问题",
        // 抛给 importIsbns 的逐条 catch 记为 error,不拖垮整批
        if (errors.length) throw Object.assign(new Error(errors.join(';')), { code: 'VALIDATION' });
        return books.addBook(values);
      },
    }, {
      entries: parseIsbnInput(body.isbns),
      tags: body.tags,
      convertTo13: body.convert_to_13 === true,
      checkExisting: body.check_existing !== false, // 缺省开查重(与 calibre 对话框默认一致)
    });
    res.json(out);
  } catch (err) {
    if (err && err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message, code: 'VALIDATION' });
    }
    // importIsbns 已把逐条失败收进 results;走到这里的只有索引/建档层面的意外。
    // 同步记录堆栈(routes.metadata.js 同款:对外简洁、对内详尽)
    console.error('[isbn] batch import failed:', (err && (err.stack || err.message)) || err);
    res.status(500).json({ error: 'ISBN 批量添加失败,请稍后重试', code: 'INTERNAL' });
  }
}

router.get('/api/isbn/check', handleIsbnCheck);
router.get('/api/isbn/lookup', handleIsbnLookup);
router.post('/api/books/from-isbn', handleImportFromIsbn);

module.exports = router;
// 供测试直接驱动(与 routes.metadata.js 导出 handleMetadataSearch 同一思路)
module.exports.handleIsbnCheck = handleIsbnCheck;
module.exports.handleIsbnLookup = handleIsbnLookup;
module.exports.handleImportFromIsbn = handleImportFromIsbn;
