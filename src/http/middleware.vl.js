/* ============================================================
 * 虚拟书库作用域中间件(HTTP 适配层)
 *
 *   ?vl=名称        单个虚拟书库
 *   ?vl=a&vl=b      多个 → 取交集(与 calibre 的 vl:A and vl:B 同语义)
 *
 * 解析出的查询片段 {sql, params} 挂在 req.vlScope:null = 不限定。
 * 不再先物化 id 数组:每个约束都是一段只取 id 的子查询,
 * 多个 vl 用 INTERSECT 取交集(与 calibre 的 vl:A and vl:B 同语义)。
 * 名称不存在 / 不是虚拟书库 / 循环引用都按用户输入错误回 400 VALIDATION,
 * 不能让它掉进兜底 500。
 * ============================================================ */

const { db } = require('../db/index');
const search = require('../db/search');

function vlNames(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((s) => String(s || '').trim()).filter(Boolean);
}

function attachVlScope(req, res, next) {
  const names = vlNames(req.query && req.query.vl);
  if (!names.length) {
    req.vlScope = null;
    return next();
  }
  try {
    let scope = null;
    for (const name of names) {
      const part = search.buildVirtualScope(db, name);
      scope = scope === null
        ? part
        : {
          sql: `SELECT id FROM (${scope.sql}) INTERSECT SELECT id FROM (${part.sql})`,
          params: [...scope.params, ...part.params],
        };
    }
    req.vlScope = scope;
    next();
  } catch (err) {
    if (err && err.code === 'VALIDATION') {
      return res.status(400).json({ error: err.message, code: 'VALIDATION' });
    }
    throw err;
  }
}

module.exports = { attachVlScope, vlNames };
