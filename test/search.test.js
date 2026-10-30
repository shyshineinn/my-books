/* ============================================================
 * 独立全文检索层(db/search.js)行为测试
 * 覆盖:trigram 中文子串匹配 / 短词 LIKE 兜底 / status·tag 联用 /
 *       增删改同步索引 / BM25 相关度排序 / 迁移建索引 / 重建索引
 *
 * 隔离方式:openDb(临时目录) 得到 books + books_fts 两张表后,
 * 用原始 SQL 写入可控样本,再逐行调用 search.indexBook(db, row)
 * —— 这一步与 books.addBook 内部同步索引的调用完全一致,
 * 因此等价于"新增即入索引"的契约测试,且不涉及模块级单例。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDb, migrations } = require('../src/db/index.js');
const search = require('../src/db/search.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-fts-test-'));
}

// 建临时库(迁移会建 books + books_fts 并写 17 本种子),
// 清空两者,再插入可控样本,逐行同步索引(同 books.addBook 契约)。
function setup(list) {
  const dir = tempDir();
  const db = openDb(dir, { seedDemo: true });
  db.exec('DELETE FROM books');
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  const ins = db.prepare(
    `INSERT INTO books (title, author, status, summary, tags, start_date, finish_date, cover, read_count, read_logs, created_at, updated_at)
     VALUES (@title, @author, @status, @summary, @tags, '', '', '', 0, '[]', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
  );
  for (const b of list) {
    ins.run({ ...b });
    const row = db.prepare('SELECT * FROM books WHERE title = ? ORDER BY id DESC LIMIT 1').get(b.title);
    search.indexBook(db, row);
  }
  return { dir, db };
}

test('trigram:中文子串(>=3字)命中标题与作者', () => {
  const { dir, db } = setup([
    { title: '三体', author: '刘慈欣', status: 'done', summary: '', tags: '["科幻"]' },
    { title: '平凡的世界', author: '路遥', status: 'done', summary: '', tags: '["现实主义"]' },
  ]);
  const r1 = search.searchBooks(db, { q: '刘慈欣' }).map((b) => b.title);
  assert.deepEqual(r1, ['三体']);
  const r2 = search.searchBooks(db, { q: '平凡的世界' }).map((b) => b.title);
  assert.deepEqual(r2, ['平凡的世界']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('trigram:简介与标签字段也参与匹配', () => {
  const { dir, db } = setup([
    { title: 'X', author: 'A', status: 'done', summary: '黑暗森林法则', tags: '["科普"]' },
    { title: 'Y', author: 'B', status: 'done', summary: '无关内容', tags: '["小说"]' },
  ]);
  const bySummary = search.searchBooks(db, { q: '黑暗森林' }).map((b) => b.title);
  assert.deepEqual(bySummary, ['X']);
  const byTag = search.searchBooks(db, { q: '科普' }).map((b) => b.title);
  assert.deepEqual(byTag, ['X']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('显式 sort 覆盖 BM25;省略 sort / sort=relevance 仍按相关度', () => {
  const { dir, db } = setup([
    { title: '量子力学导论', author: '甲', status: 'done', summary: '无关的很长简介占位符一', tags: '[]' },
    { title: '乙', author: '乙', status: 'done', summary: '量子力学相关的量子概念讲解量子', tags: '[]' },
  ]);
  const titles = (rows) => rows.map((b) => b.title);

  // 标题命中(BM25)排在仅简介命中之前;书名排序则相反(乙 < 量)
  assert.deepEqual(titles(search.searchBooks(db, { q: '量子力学' })), ['量子力学导论', '乙']);
  assert.deepEqual(titles(search.searchBooks(db, { q: '量子力学', sort: 'relevance' })), ['量子力学导论', '乙']);

  // 显式 sort=title 时按书名排,不再被 BM25 覆盖
  assert.deepEqual(titles(search.searchBooks(db, { q: '量子力学', sort: 'title' })), ['乙', '量子力学导论']);
  const p1 = search.searchBooksPage(db, { q: '量子力学', sort: 'title' }, { start: 0, size: 1 });
  const p2 = search.searchBooksPage(db, { q: '量子力学', sort: 'title' }, { start: 1, size: 1 });
  assert.equal(p1.total, 2);
  assert.deepEqual([...titles(p1.rows), ...titles(p2.rows)], ['乙', '量子力学导论']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('短词(1~2字)走 LIKE 兜底,仍能命中', () => {
  const { dir, db } = setup([
    { title: '三体', author: '刘慈欣', status: 'done', summary: '', tags: '["科幻"]' },
    { title: '活着', author: '余华', status: 'done', summary: '', tags: '["小说"]' },
  ]);
  assert.deepEqual(search.searchBooks(db, { q: '三' }).map((b) => b.title), ['三体']);
  assert.deepEqual(search.searchBooks(db, { q: '三体' }).map((b) => b.title), ['三体']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status / tag 与检索正交:结果只保留符合过滤的命中', () => {
  const { dir, db } = setup([
    { title: '三体', author: '刘慈欣', status: 'done', summary: '', tags: '["科幻","小说"]' },
    { title: '三体Ⅱ', author: '刘慈欣', status: 'wish', summary: '', tags: '["科幻"]' },
    { title: '三体外传', author: '某丙', status: 'done', summary: '', tags: '["历史"]' },
  ]);
  // 刘慈欣 命中 三体/三体Ⅱ;叠加 status=done 后只剩 三体(三体Ⅱ 是 wish)
  const onlyDone = search.searchBooks(db, { q: '刘慈欣', status: 'done' }).map((b) => b.title).sort();
  assert.deepEqual(onlyDone, ['三体']);
  // 叠加 tag=科幻:刘慈欣 且标签含科幻 → 三体 + 三体Ⅱ
  const onlySciFi = search.searchBooks(db, { q: '刘慈欣', tag: '科幻' }).map((b) => b.title).sort();
  assert.deepEqual(onlySciFi, ['三体', '三体Ⅱ'].sort());
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('删书同步索引:removeBook 后检索不再命中', () => {
  const { dir, db } = setup([
    { title: '测试书', author: '张三', status: 'done', summary: '', tags: '[]' },
  ]);
  assert.equal(search.searchBooks(db, { q: '测试书' }).length, 1);
  const id = db.prepare('SELECT id FROM books WHERE title=?').get('测试书').id;
  db.exec('DELETE FROM books WHERE id = ?', [id]);
  search.removeBook(db, id);
  assert.equal(search.searchBooks(db, { q: '测试书' }).length, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BM25:标题命中比仅简介命中相关度更高(需 >=3 字查询走 FTS)', () => {
  const { dir, db } = setup([
    { title: '量子力学导论', author: '甲', status: 'done', summary: '无关的很长简介占位符一', tags: '["科普"]' },
    { title: '量子物理', author: '乙', status: 'done', summary: '量子力学相关的量子概念讲解量子', tags: '["科普"]' },
  ]);
  // '量子力学' 是 3 字查询,走 FTS 路径;两本都在不同字段含该串,
  // 但"标题命中"比"仅简介命中" BM25 分更高,应排在前
  const titles = search.searchBooks(db, { q: '量子力学' }).map((b) => b.title);
  assert.equal(titles.length, 2);
  assert.equal(titles[0], '量子力学导论');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('无搜索词时退化为主表查询:status/tag/sort 照常生效', () => {
  const { dir, db } = setup([
    { title: 'A书', author: 'a', status: 'done', summary: '', tags: '["x"]' },
    { title: 'B书', author: 'b', status: 'wish', summary: '', tags: '["y"]' },
  ]);
  assert.deepEqual(search.searchBooks(db, { status: 'done' }).map((b) => b.title), ['A书']);
  assert.deepEqual(search.searchBooks(db, { sort: 'title' }).map((b) => b.title), ['A书', 'B书']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移:全新库建出 books_fts 虚表,并随种子数据全量索引', () => {
  const dir = tempDir();
  const db = openDb(dir, { seedDemo: true });
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='books_fts'").get(), 'books_fts 应存在');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
  const hit = search.searchBooks(db, { q: '三体' }).map((b) => b.title);
  assert.ok(hit.includes('三体'));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reindexAll:清空索引后重建,检索恢复', () => {
  const { dir, db } = setup([
    { title: '唯一书', author: '某', status: 'done', summary: '', tags: '[]' },
  ]);
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')"); // 破坏索引
  assert.equal(search.searchBooks(db, { q: '唯一书' }).length, 0);
  db.exec('BEGIN');
  try { search.reindexAll(db); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  assert.equal(search.searchBooks(db, { q: '唯一书' }).length, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
