/* ============================================================
 * 合并书籍(数据访问层)
 *
 * 目标书保留标题/作者,其余字段按 core/merge 的规则合并:
 *   标签并集、阅读记录合并、空字段回填、目标值优先。
 * 同时迁移来源书独有的电子书格式、自定义字段与标识符,
 * 最后永久删除来源书(与 calibre Merge book records 一致)。
 *
 * 所有数据库变更在一个事务内;磁盘文件在事务提交后由路由层删除。
 * ============================================================ */

const { inTransaction } = require('./index');
const books = require('./books');
const bookFiles = require('./book_files');
const customFields = require('./custom_fields');
const identifiers = require('./identifiers');
const categories = require('./categories');
const { mergeFields } = require('../core/merge');

function mergeBooks(handleDb, targetId, rawSourceIds) {
  const sourceIds = [...new Set(rawSourceIds || [])].filter((id) => id !== targetId);
  if (!sourceIds.length) {
    return { ok: false, code: 'VALIDATION', error: '至少选择一本要合并的书' };
  }

  const target = books.getBook(targetId, handleDb);
  if (!target) {
    return { ok: false, code: 'NOT_FOUND', error: `目标书不存在或已在回收站:${targetId}` };
  }
  const sources = sourceIds.map((id) => books.getBook(id, handleDb));
  const missing = sourceIds.filter((id, i) => !sources[i]);
  if (missing.length) {
    return { ok: false, code: 'NOT_FOUND', error: `来源书不存在或已在回收站:${missing.join(', ')}` };
  }

  let targetAfter;
  const assets = [];

  inTransaction(handleDb, () => {
    // 自定义字段:目标为空才用来源补
    customFields.fillMissingValues(handleDb, targetId, sourceIds);

    // 标识符:先放来源,再用目标覆盖 —— 冲突时目标优先
    const mergedIds = {};
    for (const source of sources) {
      Object.assign(mergedIds, identifiers.getIdentifiers(handleDb, source.id));
    }
    Object.assign(mergedIds, identifiers.getIdentifiers(handleDb, targetId));

    // 电子书格式:目标没有的格式迁到目标;重复格式随来源删除
    for (const source of sources) {
      bookFiles.moveFormatsToBook(handleDb, source.id, targetId);
    }

    const fields = mergeFields(target, sources);
    const merged = {
      title: target.title,
      title_sort: target.title_sort,
      author: target.author,
      author_sort: target.author_sort,
      status: fields.status,
      summary: fields.summary,
      tags: fields.tags,
      start_date: fields.start_date,
      finish_date: fields.finish_date,
      cover: fields.cover,
      read_count: fields.read_count,
      read_logs: fields.read_logs,
      publisher: fields.publisher,
      pub_year: fields.pub_year,
      isbn: mergedIds.isbn || '',
      rating: fields.rating,
      douban_id: mergedIds.douban || mergedIds.douban_id || '',
      series: fields.series,
      series_index: fields.series_index,
      identifiers: mergedIds,
    };

    targetAfter = books.updateBook(targetId, merged, null, handleDb);

    for (const source of sources) {
      assets.push({ id: source.id, assets: books.hardDeleteBook(handleDb, source.id) });
    }
    categories.pruneOrphans(handleDb);
  });

  return {
    ok: true,
    target: targetAfter,
    merged: sourceIds.length,
    assets,
  };
}

module.exports = { mergeBooks };
