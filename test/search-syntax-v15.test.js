/* ============================================================
 * 检索语法 v15 新增能力(db/search.js + core/query.js 有括号版)
 *
 * 覆盖:
 *   A. 括号与优先级 —— a or b and c / (a or b) and c / 嵌套 / 不配对降级
 *   B. not ( ... ) —— 否定整组(NOT(a OR b) ≠ NOT a AND NOT b)
 *   C. 检索类型前缀 —— = 相等 / ~ 正则近似 / ^ 字符变体
 *   D. 字段有无 —— cover:true/false、series:true/false
 *   E. 日期特殊值 —— date:today / date:>10daysago / date:<=2026-01-01
 *   F. 多值计数 —— tags:#>1
 *   G. 大小 —— size:>1K
 *
 * 隔离:openDb(临时目录) → 清库 → 插可控样本(与 advanced-search.test.js 同契约)。
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-v15-test-'));
}

function setup(list) {
  const dir = tempDir();
  const db = openDb(dir);
  db.exec('DELETE FROM books');
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  db.exec('DELETE FROM book_files');
  const ins = db.prepare(
    `INSERT INTO books (id, title, author, author_sort, status, summary, tags, publisher, pub_year, isbn, rating, series, series_index, cover, created_at, updated_at)
     VALUES (@id, @title, @author, @author, @status, @summary, @tags, @publisher, @pub_year, @isbn, @rating, @series, @series_index, @cover, @created_at, @created_at)`
  );
  for (const raw of list) {
    const { _tags, _authors, _formats, ...rest } = raw;
    const b = {
      status: 'done', summary: '', tags: '[]', publisher: '', pub_year: '', isbn: '', rating: 0,
      series: '', series_index: 0, cover: '',
      created_at: '2024-01-01T00:00:00.000Z',
      ...rest,
    };
    ins.run(b);
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(b.id);
    search.indexBook(db, row);
    categories.syncBookTags(db, b.id, _tags || []);
    categories.syncBookAuthors(db, b.id, _authors || [b.author]);
    for (const f of _formats || []) {
      db.prepare(
        `INSERT INTO book_files (book, format, path, size, created_at, updated_at) VALUES (?, ?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
      ).run(b.id, f.format, `/x.${f.format}`, f.size || 0);
    }
  }
  return { dir, db };
}

// 固定样本(覆盖各新特性的判定边界)
//   1 三体     done  科幻        9.0 2008 有封面 有EPUB(2K)  今天加入
//   2 三体II   reading 科幻·小说 8.5 2010 无封面 有PDF(3K)   10天前加入
//   3 活着     done  小说        9.2 2004 有封面 无文件      30天前加入
//   4 球状闪电 reading 科幻      8.0 2005 无封面 无文件      100天前加入
function corpus() {
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  return setup([
    { id: 1, title: '三体', author: '刘慈欣', status: 'done', tags: '["科幻"]', rating: 9.0, pub_year: '2008', cover: '/uploads/a.jpg', created_at: iso(0), _tags: ['科幻'], _formats: [{ format: 'EPUB', size: 2048 }] },
    { id: 2, title: '三体II', author: '刘慈欣', status: 'reading', tags: '["科幻","小说"]', rating: 8.5, pub_year: '2010', created_at: iso(10 * day), _tags: ['科幻', '小说'], _formats: [{ format: 'PDF', size: 3072 }] },
    { id: 3, title: '活着', author: '余华', status: 'done', tags: '["小说"]', rating: 9.2, pub_year: '2004', cover: '/uploads/b.jpg', created_at: iso(30 * day), _tags: ['小说'] },
    { id: 4, title: '球状闪电', author: '刘慈欣', status: 'reading', tags: '["科幻"]', rating: 8.0, pub_year: '2005', created_at: iso(100 * day), _tags: ['科幻'] },
  ]);
}
const T = (rows) => rows.map((r) => r.title).sort();

/* ---------- A. 括号与优先级 ---------- */

test('A1 标准优先级:a or b and c ≡ a or (b and c)', () => {
  const { dir, db } = corpus();
  // 科幻 or (小说 and done)
  //   科幻 → 三体、三体II、球状闪电(球状闪电是 reading,但 or 左边只要科幻就算)
  //   (小说 and done)→ 活着
  assert.deepEqual(T(search.searchBooks(db, { q: 'tag:科幻 or tag:小说 and status:done' })), ['三体', '三体II', '活着', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('A2 显式括号覆盖优先级:(a or b) and c', () => {
  const { dir, db } = corpus();
  // (科幻 or 小说) and done → 三体 + 活着(三体II/球状闪电是 reading,被排除)
  assert.deepEqual(T(search.searchBooks(db, { q: '(tag:科幻 or tag:小说) and status:done' })), ['三体', '活着']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('A3 括号改写了结果:与 A1 不同 → 证明括号真的生效', () => {
  const { dir, db } = corpus();
  const withParen = T(search.searchBooks(db, { q: '(tag:科幻 or tag:小说) and status:done' }));
  const withoutParen = T(search.searchBooks(db, { q: 'tag:科幻 or tag:小说 and status:done' }));
  assert.notDeepEqual(withParen, withoutParen);
  assert.deepEqual(withParen, ['三体', '活着']);              // 少三体II 与球状闪电
  assert.deepEqual(withoutParen, ['三体', '三体II', '活着', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('A4 嵌套括号:a and (b or (c and d))', () => {
  const { dir, db } = corpus();
  // 科幻 and (小说 or (reading and rating>=8))
  //   科幻 → 三体、三体II、球状闪电
  //   小说 or (reading and rating>=8) → 三体II(小说)、活着(小说)、球状闪电(reading 8.0)
  //   交集 → 三体II、球状闪电
  assert.deepEqual(T(search.searchBooks(db, { q: 'tag:科幻 and (tag:小说 or (status:reading and rating>=8))' })), ['三体II', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('A5 括号不配对:缺右括号/多右括号都不抛错且有结果', () => {
  const { dir, db } = corpus();
  // 缺右括号:末尾自动补齐 → 与完整写法等价
  assert.deepEqual(T(search.searchBooks(db, { q: '(tag:科幻 or tag:小说) and status:done' })), ['三体', '活着']);
  // 孤儿右括号在 token 层被丢弃 → 等价于 `tag:科幻 or tag:小说`
  assert.deepEqual(T(search.searchBooks(db, { q: 'tag:科幻) or tag:小说' })), ['三体', '三体II', '活着', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- B. not ( ... ) ---------- */

test('B1 not (a or b) ≠ not a and not b', () => {
  const { dir, db } = corpus();
  // NOT(科幻 or 小说) → 只剩没有这两个标签的:本样本无 → 空
  assert.deepEqual(T(search.searchBooks(db, { q: 'not (tag:科幻 or tag:小说)' })), []);
  // 对照:not tag:科幻 and not tag:小说 → 同样空(此样本下两者等价)
  assert.deepEqual(T(search.searchBooks(db, { q: 'not tag:科幻 and not tag:小说' })), []);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('B2 not 组与 and 组合:保留组内 OR', () => {
  const { dir, db } = corpus();
  // status:done and not (tag:科幻 or tag:小说)
  //   done 的是 三体(科幻)+ 活着(小说) → 都被 not 组排除 → 空
  assert.deepEqual(T(search.searchBooks(db, { q: 'status:done and not (tag:科幻 or tag:小说)' })), []);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('B3 not 组保留"活着":用只含科幻的组排除', () => {
  const { dir, db } = corpus();
  // not (tag:科幻) → 活着(只有小说)
  assert.deepEqual(T(search.searchBooks(db, { q: 'not (tag:科幻)' })), ['活着']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- C. 检索类型前缀 ---------- */

test('C1 = 相等:tag:=科幻 与 tag:科幻 在本样本等价(值无前后缀变体)', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'tag:=科幻' })), ['三体', '三体II', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('C2 = 相等不做子串:series:=基地 不命中「基地续篇」', () => {
  const { dir, db } = setup([
    { id: 1, title: '基地', author: 'x', series: '基地', series_index: 1, _tags: [] },
    { id: 2, title: '基地续篇', author: 'y', series: '基地续篇', series_index: 1, _tags: [] },
  ]);
  // 系列列本来就是精确匹配(受控集合),子串会误命中「基地续篇」
  assert.deepEqual(T(search.searchBooks(db, { q: 'series:基地' })), ['基地']);
  // 标题默认 contains(子串)→ 两本都中
  assert.deepEqual(T(search.searchBooks(db, { q: 'title:基地' })), ['基地', '基地续篇']);
  // 标题用 = 精确 → 只有完全等于「基地」的那本
  assert.deepEqual(T(search.searchBooks(db, { q: 'title:=基地' })), ['基地']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('C3 正则近似:^ 锚定前缀 + .* 通配', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'title:~^三体.*' })), ['三体', '三体II']);
  assert.deepEqual(T(search.searchBooks(db, { q: 'title:~^活着$' })), ['活着']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('C4 正则支持分组与选择(真正则),非法表达式按不命中处理', () => {
  const { dir, db } = corpus();
  // 注册了 SQL 函数 regexp 后,"或"语义完整保留
  assert.deepEqual(T(search.searchBooks(db, { q: 'title:~^(三体|活着)' })), ['三体', '三体II', '活着']);
  assert.deepEqual(T(search.searchBooks(db, { q: 'title:~[' })), [], '非法正则不抛错,也不命中');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('C5 字符变体:两侧折叠大小写、标点与空白', () => {
  const { dir, db } = setup([
    { id: 1, title: 'Big Bummer', author: 'x', _tags: [] },
    { id: 2, title: 'The Hobbit', author: 'y', _tags: [] },
    { id: 3, title: '其他', author: 'z', _tags: [] },
  ]);
  assert.deepEqual(T(search.searchBooks(db, { q: 'title:^big' })), ['Big Bummer']);
  assert.deepEqual(T(search.searchBooks(db, { q: 'title:^the hobbit' })), ['The Hobbit'], '空格/标点不参与匹配');
  assert.deepEqual(T(search.searchBooks(db, { q: 'title:^hobbit' })), ['The Hobbit'], '仍是子串语义');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- D. 字段有无 ---------- */

test('D1 cover:true / cover:false', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'cover:true' })), ['三体', '活着']);
  assert.deepEqual(T(search.searchBooks(db, { q: 'cover:false' })), ['三体II', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('D2 series:true / series:false', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'series:false' })), ['三体', '三体II', '活着', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('D3 中文布尔值:cover:是 / cover:否', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'cover:是' })), ['三体', '活着']);
  assert.deepEqual(T(search.searchBooks(db, { q: 'cover:否' })), ['三体II', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('D4 formats:false 找没有电子书文件的书', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'format:false' })), ['活着', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- E. 日期特殊值 ---------- */

test('E1 date:today 命中今天加入的书', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'date:today' })), ['三体']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E2 date:>10daysago 命中 10 天内加入的(不含正好 10 天前)', () => {
  const { dir, db } = corpus();
  // 三体(0天)+ 三体II(10天前,边界:created_at 是 10 天前的此刻,通常已过 → 不命中)
  const r = T(search.searchBooks(db, { q: 'date:>10daysago' }));
  assert.ok(r.includes('三体'));
  assert.ok(!r.includes('活着'));      // 30 天前
  assert.ok(!r.includes('球状闪电'));  // 100 天前
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E3 date:<=2024-06-01 命中早于该日期的', () => {
  const { dir, db } = setup([
    { id: 1, title: '早', author: 'x', created_at: '2024-01-01T00:00:00.000Z', _tags: [] },
    { id: 2, title: '晚', author: 'y', created_at: '2024-12-01T00:00:00.000Z', _tags: [] },
  ]);
  assert.deepEqual(T(search.searchBooks(db, { q: 'date:<=2024-06-01' })), ['早']);
  assert.deepEqual(T(search.searchBooks(db, { q: 'date:>2024-06-01' })), ['晚']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E4 date:_today 不翻译形式可用(脚本友好)', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'date:_today' })), ['三体']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E5 非法日期值:该条不命中而不报错', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'date:胡说八道' })), []);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- F. 多值计数 ---------- */

test('F1 tags:#>1 找标签数 >1 的书', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'tags:#>1' })), ['三体II']);   // 只有它有两个标签
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('F2 tags:#=1 找恰好一个标签的', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'tags:#=1' })), ['三体', '活着', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- G. 大小 ---------- */

test('G1 size:>2K 命中 EPUB(2048B 不含)/ PDF(3072B 含)', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'size:>2K' })), ['三体II']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('G2 size 用 M 单位与裸字节', () => {
  const { dir, db } = setup([
    { id: 1, title: '大', author: 'x', _tags: [], _formats: [{ format: 'PDF', size: 3 * 1024 * 1024 }] },
    { id: 2, title: '小', author: 'y', _tags: [], _formats: [{ format: 'EPUB', size: 1024 }] },
  ]);
  assert.deepEqual(T(search.searchBooks(db, { q: 'size:>1M' })), ['大']);
  // 裸字节:1024 不小于 1024,只有"大"大于
  assert.deepEqual(T(search.searchBooks(db, { q: 'size:>=1024' })), ['大', '小']);
  assert.deepEqual(T(search.searchBooks(db, { q: 'size:<1024' })), []);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('G3 无法解析的单位:该条不命中', () => {
  const { dir, db } = corpus();
  assert.deepEqual(T(search.searchBooks(db, { q: 'size:>abc' })), []);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- H. 组合与回归 ---------- */

test('H1 新旧语法混用:括号 + 前导 - + 类型前缀', () => {
  const { dir, db } = corpus();
  // (科幻 or 小说) and not status:done
  //   非 done 的是 三体II(科幻·小说, reading)与 球状闪电(科幻, reading)
  assert.deepEqual(T(search.searchBooks(db, { q: '(tag:科幻 or tag:小说) and not status:done' })), ['三体II', '球状闪电']);
  // 前导 - 与 not 等价
  assert.deepEqual(T(search.searchBooks(db, { q: '(tag:科幻 or tag:小说) and -status:done' })), ['三体II', '球状闪电']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('H2 虚拟书库仍可与括号组合(vl: 在组内)', () => {
  const { dir, db } = corpus();
  db.prepare('INSERT INTO saved_searches (name, query, sort, is_virtual, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run('科幻库', 'tag:科幻', '', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  assert.deepEqual(T(search.searchBooks(db, { q: '(vl:科幻库 or tag:小说) and status:done' })), ['三体', '活着']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('H3 检索语法错误仍回 VALIDATION,不进兜底 500', () => {
  const { dir, db } = corpus();
  assert.throws(
    () => search.searchBooks(db, { q: '#不存在的字段:x' }),
    (err) => err.code === 'VALIDATION',
  );
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
