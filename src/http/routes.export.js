/* ============================================================
 * CSV 导出路由(HTTP 适配层)
 *
 *   GET /api/export.csv?q=&status=&tag=&author=&sort=
 *
 * 查询参数与 /api/books 完全一致,所以"书架当前筛选"可以直接导出。
 * 响应带 UTF-8 BOM 与 Content-Disposition;序列化在 core/csv,
 * 字段组装在 db/catalog。
 * ============================================================ */

const express = require('express');

const { db } = require('../db/index');
const { buildCatalog } = require('../db/catalog');
const { toCsv } = require('../core/csv');

const router = express.Router();

router.get('/api/export.csv', (req, res) => {
  let catalog;
  try {
    const { scopeIds: _ignored, ...filter } = req.query;
    catalog = buildCatalog(db, { ...filter, scopeIds: req.vlScope });
  } catch (err) {
    // 检索语法错误是用户输入问题,保持与 /api/books 相同的 400 语义
    if (err && err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message, code: 'VALIDATION' });
    }
    throw err;
  }

  const csv = toCsv(catalog.headers, catalog.rows);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="my-books-${date}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
});

module.exports = router;
