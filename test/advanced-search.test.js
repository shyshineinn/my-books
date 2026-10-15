/* ============================================================
 * 高级搜索(db/search.js + core/query.js)结构化行为测试
 * 覆盖:tag/author 走归一化链接表 EXISTS 精确匹配 · status/rating/pubyear/
 *       format 字段谓词 · 布尔 or · 否定 not · 自由词与字段 AND 组合 ·
 *       旧 ?status/?tag/?author 独立参数向后兼容 · 非法 MATCH 表达式降级
 *
 * 隔离:openDb(临时目录) → 清库 → 插可控样本 → 逐行 indexBook +
 *       categories.syncBookTags/syncBookAuthors(与 addBook 契约一致)。
 *       tag:/author: 谓词依赖链接表,故必须同步分类,而非只写 books 缓存。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDb } = require('../src/db/index.js');
const search = require('../src/db/search.js');
const categories = require('../src/db/categories.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-adv-test-'));
}

// 样本字段:_tags(链接表标签名)/_authors(链接表作者名)/_formats(book_files 大写格式)
function setup(list) {
  const dir = tempDir();
  const db = openDb(dir);
  db.exec('DELETE FROM books');
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  db.exec('DELETE FROM book_files');
  const ins = db.prepare(
    `INSERT INTO books (id, title, author, author_sort, status, summary, tags, publisher, pub_year, isbn, rating, created_at, updated_at)
     VALUES (@id, @title, @author, @author, @status, @summary, @tags, @publisher, @pub_year, @isbn, @rating, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
  );
  for (const raw of list) {
    const { _tags, _authors, _formats, ...rest } = raw;
    const b = { summary: '', publisher: '', pub_year: '', isbn: '', rating: 0, tags: '[]', ...rest };
    ins.run(b);
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(b.id);
    search.indexBook(db, row);
    categories.syncBookTags(db, b.id, _tags || []);
    categories.syncBookAuthors(db, b.id, _authors || [b.author]);
    for (const f of _formats || []) {
      db.prepare(
        `INSERT INTO book_files (book, format, path, size, created_at, updated_at) VALUES (?, ?, ?, 0, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
      ).run(b.id, f, `/x.${f}`);
    }
  }
  return { dir, db };
}

// 三体 done 科幻 9.0 2008 EPUB / 三体II reading 科幻·小说 8.5 2010 PDF / 活着 done 小说 余华 2004
function trio() {
  return setup([
    { id: 1, title: '三体', author: '刘慈欣', status: 'done', tags: '["科幻"]', rating: 9.0, pub_year: '2008', publisher: '重庆出版社', _tags: ['科幻'], _formats: ['EPUB'] },
    { id: 2, title: '三体II', author: '刘慈欣', status: 'reading', tags: '["科幻","小说"]', rating: 8.5, pub_year: '2010', _tags: ['科幻', '小说'], _formats: ['PDF'] },
    { id: 3, title: '活着', author: '余华', status: 'done', tags: '["小说"]', rating: 9.2, pub_year: '2004', publisher: '作家出版社', _tags: ['小说'] },
  ]);
}
const T = (rows) => rows.map((r) => r.title).sort();

test('tag: 走链接表精确匹配(科幻 → 三体 + 三体II)', () => {
  const { dir, db } = trio();
  assert.deepEqual(T(search.searchBooks(db, { q: 'tag:科幻' })), ['三体', '三体II']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('author: 走作者链接表(刘慈欣 → 三体 + 三体II)', () => {
  const { dir, db } = trio();
  assert.deepEqual(T(search.searchBooks(db, { q: 'author:刘慈欣' })), ['三体', '三体II']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('多字段 AND:author:刘慈欣 status:done → 仅三体', () => {
  const { dir, db } = trio();
  assert.deepEqual(T(search.searchBooks(db, { q: 'author:刘慈欣 status:done' })), ['三体']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('or:status:done or author:余华 → 三体 + 活着', () => {
  const { dir, db } = trio();
  assert.deepEqual(T(search.searchBooks(db, { q: 'status:done or author:余华' })), ['三体', '活着']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('rating 数值范围:rating>=8.6 → 三体(9.0)+ 活着(9.2),排除三体II(8.5)', () => {
  const { dir, db } = trio();
  assert.deepEqual(T(search.searchBooks(db, { q: 'rating>=8.6' })), ['三体', '活着']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('pubyear 数值比较:pubyear<2009 → 三体(2008)+ 活着(2004)', () => {
  const { dir, db } = trio();
  assert.deepEqual(T(search.searchBooks(db, { q: 'pubyear<2009' })), ['三体', '活着']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('format:epub 命中上传了 EPUB 的书(格式大小写不敏感)', () => {
  const { dir, db } = trio();
  assert.deepEqual(T(search.searchBooks(db, { q: 'format:epub' })), ['三体']);
  assert.deepEqual(T(search.searchBooks(db, { q: 'format:PDF' })), ['三体II']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('not 否定:status:done not author:刘慈欣 → 仅活着', () => {
  const { dir, db } = trio();
  assert.deepEqual(T(search.searchBooks(db, { q: 'status:done not author:刘慈欣' })), ['活着']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('自由词与字段 AND 组合:tag:科幻 三体 → 三体 + 三体II', () => {
  const { dir, db } = trio();
  // '三体' 是 2 字 → LIKE 子句;与 tag:科幻 EXISTS 子句 AND 组合
  assert.deepEqual(T(search.searchBooks(db, { q: 'tag:科幻 三体' })), ['三体', '三体II']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('向后兼容:?status/?tag 独立参数在无 q 时照常(不经过解析器)', () => {
  const { dir, db } = trio();
  assert.deepEqual(T(search.searchBooks(db, { status: 'done' })), ['三体', '活着']);
  assert.deepEqual(T(search.searchBooks(db, { tag: '小说' })), ['三体II', '活着']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('向后兼容:纯自由词长串仍走 BM25(标题命中优先)', () => {
  const { dir, db } = setup([
    { id: 1, title: '量子力学导论', author: '甲', status: 'done', _tags: [] },
    { id: 2, title: '量子物理', author: '乙', status: 'done', summary: '量子力学讲解', _tags: [] },
  ]);
  const titles = search.searchBooks(db, { q: '量子力学' }).map((b) => b.title);
  assert.equal(titles[0], '量子力学导论');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
