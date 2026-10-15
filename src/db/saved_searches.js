/* ============================================================
 * 保存的搜索 / 虚拟图书馆数据访问层(对标 calibre library_item)
 *
 * 一行 = 一条命名查询:query 存原始语法串(展示时原样回填搜索框,
 * 执行时交给 core/query + search.searchBooks 现解析),sort 存排序键。
 * name 大小写不敏感唯一(靠 migrateV10 的 UNIQUE COLLATE NOCASE)。
 *
 * 依赖方向纪律:与 categories.js 同构 —— 只接收调用方传入的 db 句柄,
 * 不 require ./index(避免循环引用),时间戳就地生成。便于用
 * openDb(临时目录) 隔离测试。
 * ============================================================ */

function now() {
  return new Date().toISOString();
}

function listSaved(handleDb) {
  return handleDb
    .prepare('SELECT * FROM saved_searches ORDER BY name COLLATE NOCASE')
    .all();
}

function getSaved(handleDb, id) {
  return handleDb.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id);
}

function getByName(handleDb, name) {
  const n = String(name || '').trim();
  if (!n) return undefined;
  return handleDb.prepare('SELECT * FROM saved_searches WHERE name = ?').get(n);
}

function addSaved(handleDb, { name, query, sort } = {}) {
  const n = String(name || '').trim();
  if (!n) throw Object.assign(new Error('名称不能为空'), { code: 'VALIDATION' });
  const ts = now();
  try {
    const r = handleDb
      .prepare(
        'INSERT INTO saved_searches (name, query, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(n, String(query || ''), String(sort || ''), ts, ts);
    return getSaved(handleDb, r.lastInsertRowid);
  } catch (err) {
    if (/UNIQUE constraint failed: saved_searches.name/i.test(err.message)) {
      throw Object.assign(new Error('该名称已存在'), { code: 'CONFLICT' });
    }
    throw err;
  }
}

function updateSaved(handleDb, id, { name, query, sort } = {}) {
  const existing = getSaved(handleDb, id);
  if (!existing) return null;
  const n = name !== undefined && String(name).trim() ? String(name).trim() : existing.name;
  const q = query !== undefined ? String(query) : existing.query;
  const s = sort !== undefined ? String(sort) : existing.sort;
  try {
    handleDb
      .prepare('UPDATE saved_searches SET name = ?, query = ?, sort = ?, updated_at = ? WHERE id = ?')
      .run(n, q, s, now(), id);
  } catch (err) {
    if (/UNIQUE constraint failed: saved_searches.name/i.test(err.message)) {
      throw Object.assign(new Error('该名称已存在'), { code: 'CONFLICT' });
    }
    throw err;
  }
  return getSaved(handleDb, id);
}

function removeSaved(handleDb, id) {
  const r = handleDb.prepare('DELETE FROM saved_searches WHERE id = ?').run(id);
  return r.changes > 0;
}

module.exports = { listSaved, getSaved, getByName, addSaved, updateSaved, removeSaved };
