/* ============================================================
 * 标签 / 作者归一化(src/db/categories)行为测试
 *
 * 隔离:openDb(临时目录) 拿到迁移到位的库,清种子后自造数据。
 * 造书走与 books.addBook 相同的契约:插入 → sync 链接 → recompute 缓存 → index FTS,
 * 因此这里验证的就是真实写入路径留下的状态。
 *
 * 关注点:真源四表(链接)+ 派生缓存(books.tags/author/author_sort)+ FTS 三者一致。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { openDb } = require('../src/db/index.js');
const categories = require('../src/db/categories.js');
const search = require('../src/db/search.js');
const { splitAuthors } = require('../src/core/book.js');

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-cat-test-'));
  tmpDirs.push(dir);
  return dir;
}

function freshDb() {
  const db = openDb(tempDir());
  db.exec('DELETE FROM book_tags; DELETE FROM book_authors; DELETE FROM tags; DELETE FROM authors; DELETE FROM books;');
  search.reindexAll(db);
  return db;
}

// 与 books.addBook 一致的写入:插入 → 同步链接 → 重算缓存 → 索引(取重算后的行)
function addBook(db, { title, author = '', tags = [] }) {
  const now = new Date().toISOString();
  const names = splitAuthors(author);
  const r = db.prepare(`
    INSERT INTO books (title, author, author_sort, status, tags, read_logs, created_at, updated_at)
    VALUES (?, ?, ?, 'wish', ?, '[]', ?, ?)
  `).run(title, names.join('、'), names[0] || '', JSON.stringify(tags), now, now);
  const id = r.lastInsertRowid;
  const raw = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  categories.syncBookTags(db, id, categories.parseTagNames(raw.tags));
  categories.syncBookAuthors(db, id, splitAuthors(raw.author));
  categories.recomputeBookCaches(db, id);
  const final = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  search.indexBook(db, final);
  return final;
}

const tagByName = (db, name) => categories.listTags(db).find((t) => t.name === name);
const authorByName = (db, name) => categories.listAuthors(db).find((a) => a.name === name);
const cacheTags = (row) => JSON.parse(row.tags);

/* ---------- 多作者拆分 ---------- */

test('splitAuthors:多分隔符拆分、去重(大小写不敏感)、间隔号不拆', () => {
  assert.deepEqual(splitAuthors('余华、莫言/史铁生,贾平凹&苏童'), ['余华', '莫言', '史铁生', '贾平凹', '苏童']);
  assert.deepEqual(splitAuthors('加西亚·马尔克斯'), ['加西亚·马尔克斯'], '间隔号是译名的一部分,不拆');
  assert.deepEqual(splitAuthors([' 余华 ', '余华', '']), ['余华'], '数组入参去空白、去重');
});

/* ---------- 归一化真源 + 派生缓存 ---------- */

test('addBook:每位作者/每个标签各建一行,缓存为派生(、连接 + 首作者 sort)', () => {
  const db = freshDb();
  const a = addBook(db, { title: '书A', author: '余华、莫言', tags: ['获奖', '小说'] });
  addBook(db, { title: '书B', author: '余华', tags: ['小说'] });

  assert.equal(authorByName(db, '余华').count, 2);
  assert.equal(authorByName(db, '莫言').count, 1);
  assert.equal(tagByName(db, '小说').count, 2);
  assert.equal(tagByName(db, '获奖').count, 1);

  assert.equal(a.author, '余华、莫言');
  assert.equal(a.author_sort, '余华');
  assert.deepEqual(cacheTags(a), ['小说', '获奖'], '标签缓存按名排序');
  db.close();
});

/* ---------- 重命名 ---------- */

test('重命名标签:改真源、同步受影响书缓存、FTS 可搜新名', () => {
  const db = freshDb();
  addBook(db, { title: '甲', tags: ['旧标'] });
  addBook(db, { title: '乙', tags: ['旧标', '其它'] });

  const renamed = categories.renameTag(db, tagByName(db, '旧标').id, '新标');
  assert.ok(renamed);
  assert.equal(tagByName(db, '旧标'), undefined, '旧名不再是真源');
  assert.equal(tagByName(db, '新标').count, 2);

  assert.equal(search.searchBooks(db, { tag: '新标' }).length, 2);
  assert.equal(search.searchBooks(db, { tag: '旧标' }).length, 0);
  assert.equal(search.searchBooks(db, { q: '新标' }).length, 2, 'reindexAll 后 FTS 命中新名');
  db.close();
});

test('重命名撞已有同名 → 等价合并', () => {
  const db = freshDb();
  addBook(db, { title: '甲', tags: ['推理'] });
  addBook(db, { title: '乙', tags: ['悬疑'] });
  const 悬疑id = tagByName(db, '悬疑').id;

  categories.renameTag(db, 悬疑id, '推理');
  assert.equal(tagByName(db, '悬疑'), undefined);
  assert.equal(tagByName(db, '推理').count, 2, '两本书并到同名标签下');
  db.close();
});

/* ---------- 合并 ---------- */

test('合并标签:from 并入 to,同书重叠去重,from 消失', () => {
  const db = freshDb();
  addBook(db, { title: '甲', tags: ['甲'] });
  addBook(db, { title: '乙', tags: ['乙'] });
  const c = addBook(db, { title: '丙', tags: ['甲', '乙'] });

  categories.mergeTags(db, tagByName(db, '甲').id, tagByName(db, '乙').id);
  assert.equal(tagByName(db, '甲'), undefined);
  assert.equal(tagByName(db, '乙').count, 3);
  assert.deepEqual(cacheTags(db.prepare('SELECT * FROM books WHERE id = ?').get(c.id)), ['乙'], '丙不重复挂两个');
  db.close();
});

/* ---------- 删除(仅解除分类) ---------- */

test('删除标签:从各书解除,书保留;清孤儿后真源不再有空引用', () => {
  const db = freshDb();
  const a = addBook(db, { title: '甲', tags: ['临时'] });
  addBook(db, { title: '乙', tags: ['永久'] });

  categories.removeTag(db, tagByName(db, '临时').id);
  categories.pruneOrphans(db);
  assert.equal(tagByName(db, '临时'), undefined);
  assert.ok(tagByName(db, '永久'), '无关标签不动');
  assert.deepEqual(cacheTags(db.prepare('SELECT * FROM books WHERE id = ?').get(a.id)), [], '甲标签清空但书还在');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM books').get().n, 2);
  db.close();
});

/* ---------- 作者重命名 / 合并 ---------- */

test('作者重命名同步缓存与筛选;合并两位作者', () => {
  const db = freshDb();
  addBook(db, { title: '春', author: '村上春树' });
  addBook(db, { title: '夏', author: '村上春樹' });

  categories.renameAuthor(db, authorByName(db, '村上春树').id, '村上春樹');
  assert.equal(authorByName(db, '村上春树'), undefined, '改名撞同名等价合并');
  assert.equal(authorByName(db, '村上春樹').count, 2);
  assert.equal(search.searchBooks(db, { author: '村上春樹' }).length, 2);
  db.close();
});

/* ---------- 删书级联 + 清孤儿 ---------- */

test('删书:外键级联删链接,pruneOrphans 清掉失去引用的标签/作者', () => {
  const db = freshDb();
  const a = addBook(db, { title: '独本', author: '独有作者', tags: ['独有标签'] });

  db.prepare('DELETE FROM books WHERE id = ?').run(a.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_tags').get().n, 0, 'book_tags 随书级联');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM book_authors').get().n, 0);

  categories.pruneOrphans(db);
  assert.equal(tagByName(db, '独有标签'), undefined, '零引用标签被清理');
  assert.equal(authorByName(db, '独有作者'), undefined, '零引用作者被清理');
  db.close();
});

/* ---------- 作者筛选与排序 ---------- */

test('按作者筛选命中多作者书;sort=author 用首位作者排序', () => {
  const db = freshDb();
  addBook(db, { title: 'Both', author: 'charlie、alpha' });   // author_sort = charlie
  addBook(db, { title: 'Alone', author: 'alpha' });
  addBook(db, { title: 'Mid', author: 'bravo' });

  assert.deepEqual(search.searchBooks(db, { author: 'alpha' }).map((b) => b.title).sort(), ['Alone', 'Both']);
  assert.deepEqual(search.searchBooks(db, { author: 'bravo' }).map((b) => b.title), ['Mid']);

  // NOCASE 对拉丁名即字母序:alpha < bravo < charlie
  const ordered = search.searchBooks(db, { sort: 'author' }).map((b) => b.title);
  assert.deepEqual(ordered, ['Alone', 'Mid', 'Both'], '按首位作者 sort 升序');
  db.close();
});

/* ---------- rebuildAll 幂等 + 回填裸行 ---------- */

test('rebuildAll:幂等,并把未经同步的裸插入行归一化', () => {
  const db = freshDb();
  addBook(db, { title: '规范书', author: '张三、李四', tags: ['历史'] });
  // 裸插入一行,绕过 addBook 的同步(模拟迁移前的旧数据)
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO books (title, author, author_sort, status, tags, read_logs, created_at, updated_at)
    VALUES ('裸书', '王五，赵六', '', 'wish', '[" 诗 ", "诗", "散文"]', '[]', ?, ?)`).run(now, now);

  categories.rebuildAll(db);   // 把裸书也归一化进来
  const after1 = categories.listAuthors(db).map((a) => `${a.name}:${a.count}`).sort();
  categories.rebuildAll(db);   // 再跑一次应完全一致(幂等)
  const after2 = categories.listAuthors(db).map((a) => `${a.name}:${a.count}`).sort();
  assert.deepEqual(after1, after2, '重复重建结果稳定');
  assert.deepEqual(after1, ['张三:1', '李四:1', '王五:1', '赵六:1'].sort(), '裸书作者已拆分建链');

  // 裸书的中文逗号作者被拆开,重复标签去重
  const 裸 = db.prepare("SELECT * FROM books WHERE title = '裸书'").get();
  assert.equal(裸.author, '王五、赵六');
  assert.equal(裸.author_sort, '王五');
  assert.deepEqual(cacheTags(裸), ['散文', '诗']);
  assert.equal(authorByName(db, '王五').count, 1);
  db.close();
});

/* ---------- 迁移 v9 在种子库上的回填(集成) ---------- */

test('v9 迁移:种子库自动归一化,缓存与链接一致', () => {
  const db = openDb(tempDir());   // 走完整迁移 + 种子 rebuild 路径
  const tags = categories.listTags(db);
  const authors = categories.listAuthors(db);
  assert.ok(tags.length > 0, '种子标签已建链');
  assert.ok(authors.length > 0, '种子作者已建链');

  for (const row of db.prepare('SELECT * FROM books').all()) {
    const cache = JSON.parse(row.tags);
    assert.ok(Array.isArray(cache), `${row.title} 标签缓存应为数组`);
    assert.deepEqual(cache, [...cache].sort(), `${row.title} 标签缓存应与真源同为 NOCASE 序`);
  }
  db.close();
});
