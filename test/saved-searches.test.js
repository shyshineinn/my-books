/* ============================================================
 * 保存的搜索(db/saved_searches.js)+ migrateV10 行为测试
 * 覆盖:建表 · 新增/列表/按名取 · 更新 · 删除 · 名称大小写不敏感唯一 · 空名校验
 *
 * 隔离:openDb(临时目录) 触发全量迁移(v1..v10);saved_searches 用
 * 传入的临时 db 句柄操作,不碰生产库单例。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDb, migrations } = require('../src/db/index.js');
const saved = require('../src/db/saved_searches.js');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-saved-test-'));
  return { dir, db: openDb(dir, { seedDemo: true }) };
}
const cleanup = (dir, db) => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };

test('migrateV10:全新库建出 saved_searches 表,user_version 落到迁移总数', () => {
  const { dir, db } = tempDb();
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='saved_searches'").get(), 'saved_searches 应存在');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
  assert.equal(saved.listSaved(db).length, 0);
  cleanup(dir, db);
});

test('addSaved + listSaved:落库并按名排序返回', () => {
  const { dir, db } = tempDb();
  saved.addSaved(db, { name: '在读科幻', query: 'status:reading tag:科幻', sort: 'updated' });
  saved.addSaved(db, { name: '高分已读', query: 'status:done rating>=9', sort: 'finish' });
  const list = saved.listSaved(db);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((r) => r.name), ['在读科幻', '高分已读']); // NOCASE 序
  assert.equal(list.find((r) => r.name === '在读科幻').query, 'status:reading tag:科幻');
  cleanup(dir, db);
});

test('getByName:大小写不敏感命中(UNIQUE COLLATE NOCASE)', () => {
  const { dir, db } = tempDb();
  saved.addSaved(db, { name: 'MyShelf', query: 'tag:x' });
  assert.ok(saved.getByName(db, 'myshelf'), '大小写不同应命中同一行');
  assert.equal(saved.getByName(db, '不存在'), undefined);
  cleanup(dir, db);
});

test('重名新增抛 CONFLICT(含大小写变体)', () => {
  const { dir, db } = tempDb();
  saved.addSaved(db, { name: '草稿', query: 'a' });
  saved.addSaved(db, { name: 'Shelf', query: 'a' });
  assert.throws(() => saved.addSaved(db, { name: '草稿', query: 'b' }), (e) => e.code === 'CONFLICT');
  assert.throws(() => saved.addSaved(db, { name: 'SHELF', query: 'b' }), (e) => e.code === 'CONFLICT');
  assert.throws(() => saved.addSaved(db, { name: 'shelf', query: 'b' }), (e) => e.code === 'CONFLICT');
  cleanup(dir, db);
});

test('空名称抛 VALIDATION', () => {
  const { dir, db } = tempDb();
  assert.throws(() => saved.addSaved(db, { name: '   ', query: 'x' }), (e) => e.code === 'VALIDATION');
  cleanup(dir, db);
});

test('updateSaved:改查询与排序,省略字段保持原值', () => {
  const { dir, db } = tempDb();
  const created = saved.addSaved(db, { name: 's', query: 'status:done', sort: 'updated' });
  const updated = saved.updateSaved(db, created.id, { query: 'status:done rating>=9' });
  assert.equal(updated.query, 'status:done rating>=9');
  assert.equal(updated.sort, 'updated', '未传 sort 应保持原值');
  assert.equal(saved.updateSaved(db, 99999, { query: 'x' }), null, '不存在返回 null');
  cleanup(dir, db);
});

test('removeSaved:删除后计数归零,重复删除返回 false', () => {
  const { dir, db } = tempDb();
  const created = saved.addSaved(db, { name: 'tmp', query: 'x' });
  assert.equal(saved.removeSaved(db, created.id), true);
  assert.equal(saved.listSaved(db).length, 0);
  assert.equal(saved.removeSaved(db, created.id), false);
  cleanup(dir, db);
});

test('与检索层协作:取出的 query 直接喂给 searchBooks 可用', () => {
  const { dir, db } = tempDb();
  saved.addSaved(db, { name: '已读', query: 'status:done', sort: 'title' });
  const row = saved.getByName(db, '已读');
  const search = require('../src/db/search.js');
  const hits = search.searchBooks(db, { q: row.query, sort: row.sort });
  // 种子库有已读书 → 至少命中若干,且全部 status=done
  assert.ok(hits.length > 0);
  assert.ok(hits.every((b) => b.status === 'done'));
  cleanup(dir, db);
});
