/* ============================================================
 * 虚拟书库(v14)行为测试
 *
 * 覆盖:is_virtual 迁移与读写、`vl:` 语法、嵌套/循环引用、
 *       scopeIds 作用域(列表 / 分类计数 / 统计)。
 * 全部用 openDb(临时目录) 隔离。
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb, migrations } = require('../src/db/index.js');
const saved = require('../src/db/saved_searches.js');
const search = require('../src/db/search.js');
const books = require('../src/db/books.js');
const categories = require('../src/db/categories.js');
const stats = require('../src/db/stats.js');

const tmpDirs = [];
function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-vl-'));
  tmpDirs.push(dir);
  return { dir, db: openDb(dir) };
}
after(() => {
  // Windows 上 SQLite 句柄可能晚几毫秒释放,清理失败不影响用例结论
  for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

function seedDb() {
  const { db } = tempDb();
  db.exec('DELETE FROM books');
  db.exec('DELETE FROM tags');
  db.exec('DELETE FROM authors');
  const ts = '2026-01-02T03:04:05.000Z';
  const ins = db.prepare(`
    INSERT INTO books (title, author, status, tags, read_logs, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', ?, ?)
  `);
  const mk = (title, author, status, tags) => {
    const r = ins.run(title, author, status, JSON.stringify(tags), ts, ts);
    const id = Number(r.lastInsertRowid);
    categories.syncBookTags(db, id, tags);
    categories.syncBookAuthors(db, id, [author]);
    categories.recomputeBookCaches(db, id);
    return id;
  };
  const sf = mk('三体', '刘慈欣', 'done', ['科幻']);
  const living = mk('活着', '余华', 'done', ['小说']);
  const draft = mk('草稿书', '某人', 'wish', ['科幻']);
  search.reindexAll(db); // 一次性灌索引,避免与 indexBook 重复登记同一 rowid
  return { db, ids: { sf, living, draft } };
}

/* ---------- 迁移与读写 ---------- */

test('v14 迁移:saved_searches.is_virtual 存在且默认为 0', () => {
  const { db } = tempDb();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
  const cols = db.prepare('PRAGMA table_info(saved_searches)').all().map((c) => c.name);
  assert.ok(cols.includes('is_virtual'));
  const created = saved.addSaved(db, { name: '普通搜索', query: 'status:done' });
  assert.equal(created.is_virtual, 0);
  db.close();
});

test('addSaved/updateSaved:is_virtual 可设可改,省略时保持原值', () => {
  const { db } = tempDb();
  const v = saved.addSaved(db, { name: '已读科幻', query: 'status:done tag:科幻', isVirtual: true });
  assert.equal(v.is_virtual, 1);
  assert.equal(saved.getVirtualByName(db, '已读科幻').id, v.id);
  assert.deepEqual(saved.listVirtual(db).map((r) => r.id), [v.id]);

  const plain = saved.addSaved(db, { name: '只想读', query: 'status:wish' });
  assert.equal(saved.getVirtualByName(db, '只想读'), undefined, '未标记的不能当虚拟书库用');

  const toggled = saved.updateSaved(db, plain.id, { isVirtual: true });
  assert.equal(toggled.is_virtual, 1);
  const kept = saved.updateSaved(db, plain.id, { query: 'status:reading' });
  assert.equal(kept.is_virtual, 1, '未传 isVirtual 不应把书库降回普通搜索');
  assert.equal(kept.query, 'status:reading');
  db.close();
});

/* ---------- vl: 语法 ---------- */

test('vl: 谓词把结果收进虚拟书库;not vl: 取补集', () => {
  const { db, ids } = seedDb();
  saved.addSaved(db, { name: '已读', query: 'status:done', isVirtual: true });

  const hits = search.searchBooks(db, { q: 'vl:已读' }).map((b) => b.id).sort();
  assert.deepEqual(hits, [ids.living, ids.sf].sort());

  const neg = search.searchBooks(db, { q: 'not vl:已读' }).map((b) => b.id);
  assert.deepEqual(neg, [ids.draft]);

  const alias = search.searchBooks(db, { q: '虚拟书库:已读 tag:科幻' }).map((b) => b.id);
  assert.deepEqual(alias, [ids.sf]);
  db.close();
});

test('vl: 支持带空格的名字(加引号);未知/非书库名报 VALIDATION', () => {
  const { dir, db } = seedDb();
  saved.addSaved(db, { name: '我的 书库', query: 'status:done', isVirtual: true });
  assert.equal(search.searchBooks(db, { q: 'vl:"我的 书库"' }).length, 2);
  assert.throws(() => search.searchBooks(db, { q: 'vl:不存在' }), (e) => e.code === 'VALIDATION');
  saved.addSaved(db, { name: '普通', query: 'status:done' });
  assert.throws(() => search.searchBooks(db, { q: 'vl:普通' }), (e) => e.code === 'VALIDATION');
  db.close();
});

test('虚拟书库可嵌套引用;循环引用报 VALIDATION 而不是栈溢出', () => {
  const { db, ids } = seedDb();
  saved.addSaved(db, { name: '科幻已读', query: 'vl:已读 tag:科幻', isVirtual: true });
  saved.addSaved(db, { name: '已读', query: 'status:done', isVirtual: true });
  assert.deepEqual(search.searchBooks(db, { q: 'vl:科幻已读' }).map((b) => b.id), [ids.sf]);

  saved.addSaved(db, { name: 'A', query: 'vl:B', isVirtual: true });
  saved.addSaved(db, { name: 'B', query: 'vl:A', isVirtual: true });
  assert.throws(() => search.resolveVirtualIds(db, 'A'), (e) => e.code === 'VALIDATION' && /循环/.test(e.message));
  db.close();
});

/* ---------- scopeIds 作用域 ---------- */

test('scopeIds:列表/搜索/分类计数/统计一起收窄(空数组 = 不命中)', () => {
  const { db, ids } = seedDb();
  const scope = [ids.sf, ids.draft];

  assert.deepEqual(books.listBooks({ scopeIds: scope }, db).map((b) => b.id).sort(), [ids.draft, ids.sf].sort());
  assert.deepEqual(books.listBooks({ q: '科幻', scopeIds: scope }, db).map((b) => b.id).sort(), [ids.draft, ids.sf].sort());
  assert.deepEqual(books.listBooks({ scopeIds: [] }, db), []);

  const tags = categories.listTags(db, { scopeIds: scope });
  assert.deepEqual(tags.map((t) => t.name), ['科幻']);
  assert.equal(tags[0].count, 2, '只统计作用域内的书');
  assert.deepEqual(categories.listAuthors(db, { scopeIds: [ids.living] }).map((a) => a.name), ['余华']);
  assert.equal(categories.listTags(db, { scopeIds: [] }).length, 0);

  const st = stats.getStats(db, [ids.sf]);
  assert.equal(st.total, 1);
  assert.equal(st.byStatus.done, 1);
  assert.deepEqual(st.topTags.map((t) => t.tag), ['科幻']);
  db.close();
});

test('listSeries 支持作用域;未受影响时与改造前一致', () => {
  const { db, ids } = seedDb();
  db.prepare('UPDATE books SET series = ?, series_index = 1 WHERE id = ?').run('地球往事', ids.sf);
  db.prepare('UPDATE books SET series = ?, series_index = 1 WHERE id = ?').run('其他系列', ids.draft);
  const all = books.listSeries(db).map((s) => s.name);
  assert.deepEqual(all, ['其他系列', '地球往事']);
  assert.deepEqual(books.listSeries(db, { scopeIds: [ids.sf] }).map((s) => s.name), ['地球往事']);
  assert.deepEqual(books.listSeries(db, { scopeIds: [] }), []);
  db.close();
});
