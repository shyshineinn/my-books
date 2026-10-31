/* ============================================================
 * facets 列表的公共查询参数(q / limit / offset)
 * 作者、标签、系列共用;无参数路径保持全量兼容。
 * ============================================================ */

const FACET_LIMIT_MAX = 200;

function facetOptions(query = {}) {
  const invalid = (message) => Object.assign(new Error(message), { code: 'VALIDATION' });
  const first = (value) => (Array.isArray(value) ? value[0] : value);
  const rawQ = first(query.q);
  const rawLimit = first(query.limit);
  const rawOffset = first(query.offset);
  const q = rawQ === undefined ? '' : String(rawQ).trim().slice(0, 200);
  let limit = null;
  let offset = 0;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(String(rawLimit))) throw invalid('limit 应为正整数');
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FACET_LIMIT_MAX) {
      throw invalid(`limit 应在 1~${FACET_LIMIT_MAX} 之间`);
    }
  }
  if (rawOffset !== undefined) {
    if (!/^\d+$/.test(String(rawOffset))) throw invalid('offset 应为非负整数');
    offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset)) throw invalid('offset 超出范围');
  }
  const filtered = rawLimit !== undefined || rawOffset !== undefined || q !== '';
  if (filtered && limit === null) limit = FACET_LIMIT_MAX;
  return { filtered, q, limit, offset };
}

module.exports = { FACET_LIMIT_MAX, facetOptions };
