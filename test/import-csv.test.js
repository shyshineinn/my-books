/* ============================================================
 * CSV 导入(core/csv.parseCsv + core/import + db/import)
 *
 * A. parseCsv —— RFC 4180 解析与 toCsv 的往返一致性
 * B. mapHeaders / rowToBook —— 表头宽松识别、中文别名、`#label`、未知列忽略
 * C. fuzzyTitle / findIdentical —— 照 calibre find_identical_books 的查重
 * D. importCsv —— duplicate_action × automerge_action 策略矩阵 + dry-run
 * E. db/import 集成 —— 真正写库(隔离临时库)
 *
 * 隔离:openDb(临时目录),不碰真实 data/books.db。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { toCsv, parseCsv, unescapeCell } = require('../src/core/csv.js');
const {
  fuzzyTitle, mapHeaders, rowToBook, findIdentical, buildDedupeIndex,
  splitTags, parseIdentifiersCell, importCsv, MAX_ROWS,
} = require('../src/core/import.js');
const { isbnKey } = require('../src/core/isbn.js');
const { openDb } = require('../src/db/index.js');
const dbImport = require('../src/db/import.js');
const books = require('../src/db/books.js');
const search = require('../src/db/search.js');
const categories = require('../src/db/categories.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-import-'));
}

/* ============================================================
 * A. parseCsv 与往返
 * ============================================================ */

test('A1 往返:导出再导入,内容逐字不变', () => {
  const headers = ['title', 'summary', 'tags'];
  const rows = [
    ['三体', '带,逗号的简介', '科幻, 硬科幻'],
    ['带"引号"的书', '带\n换行的简介', '小说'],
    ['=HYPERLINK("x")', '  前后空格  ', ''],
    ['-负数开头', '', ''],
  ];
  const back = parseCsv(toCsv(headers, rows));
  assert.deepEqual(back.headers, headers);
  assert.deepEqual(back.rows, rows);
});

test('A2 BOM 自动剥离', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\n1,2'), { headers: ['a', 'b'], rows: [['1', '2']] });
});

test('A3 三种行尾都认:CRLF / LF / CR', () => {
  for (const nl of ['\r\n', '\n', '\r']) {
    assert.deepEqual(parseCsv(`a,b${nl}1,2${nl}3,4`), {
      headers: ['a', 'b'], rows: [['1', '2'], ['3', '4']],
    }, `行尾 ${JSON.stringify(nl)}`);
  }
});

test('A4 引号内的逗号与换行不被切开', () => {
  const r = parseCsv('a,b\r\n"x,y","p\r\nq"');
  assert.deepEqual(r.rows, [['x,y', 'p\r\nq']]);
});

test('A5 转义双引号 "" → "', () => {
  assert.deepEqual(parseCsv('a\r\n"say ""hi"""').rows, [['say "hi"']]);
});

test('A6 空行被跳过;空文本/仅表头不出错', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n\n\n').rows, [['1', '2']]);
  assert.deepEqual(parseCsv(''), { headers: [], rows: [] });
  assert.deepEqual(parseCsv('a,b\n'), { headers: ['a', 'b'], rows: [] });
});

test('A7 公式注入前缀在导入时还原', () => {
  // 导出时 '=X' 变成 "'=X",导回来必须还原成 '=X'
  assert.equal(unescapeCell("'=SUM(A1)"), '=SUM(A1)');
  assert.equal(unescapeCell("'+123"), '+123');
  assert.equal(unescapeCell("'-123"), '-123');
  assert.equal(unescapeCell("'@x"), '@x');
  // 不是公式前缀的单引号不动(用户的真实内容)
  assert.equal(unescapeCell("'普通文本"), "'普通文本");
  // 只有单引号本身
  assert.equal(unescapeCell("'"), "'");
});

test('A8 单元格中部的引号按字面量处理(宽容)', () => {
  assert.deepEqual(parseCsv('a\nab"cd').rows, [['ab"cd']]);
});

/* ============================================================
 * B. 表头映射与行解析
 * ============================================================ */

test('B1 英文表头与中文别名都能识别', () => {
  const m1 = mapHeaders(['title', 'author', 'rating']);
  assert.deepEqual(m1.fields.map((f) => f.field), ['title', 'author', 'rating']);
  const m2 = mapHeaders(['书名', '作者', '评分']);
  assert.deepEqual(m2.fields.map((f) => f.field), ['title', 'author', 'rating']);
});

test('B2 表头大小写不敏感', () => {
  assert.deepEqual(mapHeaders(['TITLE', 'Author']).fields.map((f) => f.field), ['title', 'author']);
});

test('B3 #label 列被识别为自定义字段', () => {
  const m = mapHeaders(['title', '#页数', '#心情']);
  assert.deepEqual(m.custom, [{ index: 1, label: '页数' }, { index: 2, label: '心情' }]);
});

test('B4 服务端生成列被忽略(id/uuid/title_sort/时间戳/file_formats)', () => {
  const m = mapHeaders(['id', 'title', 'uuid', 'title_sort', 'created_at', 'file_formats']);
  assert.deepEqual(m.fields.map((f) => f.field), ['title']);
  assert.deepEqual(m.ignored.sort(), ['created_at', 'file_formats', 'id', 'title_sort', 'uuid']);
});

test('B5 未知列静默忽略,不报错', () => {
  const m = mapHeaders(['title', '完全不认识的列']);
  assert.deepEqual(m.fields.map((f) => f.field), ['title']);
  assert.deepEqual(m.ignored, ['完全不认识的列']);
});

test('B6 同名列只认第一个(Excel 拼接常见)', () => {
  const m = mapHeaders(['title', 'author', 'title']);
  assert.equal(m.fields.filter((f) => f.field === 'title').length, 1);
});

test('B7 rowToBook:标签多分隔符、评分钳制、状态中文', () => {
  const m = mapHeaders(['title', 'tags', 'rating', 'status']);
  const { errors, body } = rowToBook(m.headers || ['title', 'tags', 'rating', 'status'],
    ['三体', '科幻，小说、硬科幻', '9.5', '已读'], m);
  assert.deepEqual(errors, []);
  assert.deepEqual(body.tags, ['科幻', '小说', '硬科幻']);
  assert.equal(body.rating, 9.5);
  assert.equal(body.status, 'done');
});

test('B8 rowToBook:评分超 10 被钳到 10,负数归 0', () => {
  const m = mapHeaders(['title', 'rating']);
  assert.equal(rowToBook(m.headers || ['title', 'rating'], ['x', '15'], m).body.rating, 10);
  assert.equal(rowToBook(m.headers || ['title', 'rating'], ['x', '-3'], m).body.rating, 0);
});

test('B9 rowToBook:日期格式错要报错', () => {
  const m = mapHeaders(['title', 'start_date']);
  const { errors } = rowToBook(['title', 'start_date'], ['x', '2024/1/1'], m);
  assert.ok(errors.some((e) => e.includes('YYYY-MM-DD')));
});

test('B10 rowToBook:缺书名要报错', () => {
  const m = mapHeaders(['title', 'author']);
  const { errors } = rowToBook(['title', 'author'], ['', '某人'], m);
  assert.ok(errors.some((e) => e.includes('书名')));
});

test('B11 rowToBook:未知状态值报错而不是静默丢弃', () => {
  const m = mapHeaders(['title', 'status']);
  const { errors } = rowToBook(['title', 'status'], ['x', '在读中'], m);
  assert.ok(errors.some((e) => e.includes('在读中')));
});

test('B12 parseIdentifiersCell:type:value; type2:value2', () => {
  assert.deepEqual(parseIdentifiersCell('isbn:9787536692930; goodreads:123'), {
    isbn: '9787536692930', goodreads: '123',
  });
  assert.deepEqual(parseIdentifiersCell(''), {});
  assert.deepEqual(parseIdentifiersCell('没有冒号'), {});   // 无效片段被丢
});

test('B13 splitTags 支持中英文分隔符', () => {
  assert.deepEqual(splitTags('a,b，c、d;e；f'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(splitTags(''), []);
});

test('B14 藏书集列:英文/中文表头与 100 字校验', () => {
  const m = mapHeaders(['title', 'collections']);
  assert.deepEqual(m.fields.map((f) => f.field), ['title', 'collections']);
  const parsed = rowToBook(['title', 'collections'], ['书', '待读、精读，待读'], m);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.collections, ['待读', '精读', '待读']);

  const cn = mapHeaders(['书名', '藏书集']);
  assert.equal(rowToBook(['书名', '藏书集'], ['书', '科幻'], cn).collections[0], '科幻');
  const bad = rowToBook(['title', 'collections'], ['书', 'x'.repeat(101)], m);
  assert.ok(bad.errors.some((e) => e.includes('100')));
});

/* ============================================================
 * C. 查重(照 calibre find_identical_books)
 * ============================================================ */

test('C1 fuzzyTitle:去标点、去冠词、分隔符规范化', () => {
  // calibre db/utils.py:60 的归一化链
  assert.equal(fuzzyTitle('The Hobbit'), 'hobbit');
  assert.equal(fuzzyTitle('《三体》'), '三体');
  assert.equal(fuzzyTitle('A Brief History of Time'), 'brief history of time');
  assert.equal(fuzzyTitle('三体 (第二版)'), '三体 第二版');
  assert.equal(fuzzyTitle('title-name_part'), 'title name part');
  assert.equal(fuzzyTitle('  Multiple   Spaces  '), 'multiple spaces');
});

test('C2 fuzzyTitle:标点差异不影响判定', () => {
  assert.equal(fuzzyTitle('三体：地球往事'), fuzzyTitle('三体 地球往事'));
  assert.equal(fuzzyTitle('Sapiens: A Brief History'), fuzzyTitle('Sapiens A Brief History'));
});

test('C3 findIdentical:ISBN 相同 → 同一本(最强证据)', () => {
  const index = buildDedupeIndex(
    [{ id: 1, title: '完全不同的书名', author: '甲', isbn: 'K1' }],
    (r) => r.isbn,
  );
  const hit = findIdentical({ title: '三体', author: '乙', isbn: 'K1' }, index);
  assert.equal(hit.book.id, 1);
  assert.equal(hit.reason, 'isbn');
});

test('C4 findIdentical:书名+作者都相同 → 同一本', () => {
  const index = buildDedupeIndex(
    [{ id: 1, title: '三体', author: '刘慈欣', isbn: '' }],
    () => '',
  );
  const hit = findIdentical({ title: '三体', author: '刘慈欣' }, index);
  assert.equal(hit.book.id, 1);
  assert.equal(hit.reason, 'title');
});

test('C5 findIdentical:书名相同但作者不同 → 不是同一本', () => {
  const index = buildDedupeIndex(
    [{ id: 1, title: '导论', author: '张三', isbn: '' }],
    () => '',
  );
  assert.equal(findIdentical({ title: '导论', author: '李四' }, index), null);
});

test('C6 findIdentical:多作者取交集(calibre 语义)', () => {
  // calibre db/utils.py:72-86 的算法:
  //   for a in mi.authors: 拿 a 查 id → 取该 id 的所有书 → 与已有候选集**取交集**
  // 也就是说:要求「新书的每个作者都出现在候选书里」,但候选书可以多出别的作者。
  // 所以导入「甲」能命中已有「甲、乙」(甲确实在这本书上);
  // 而导入「甲、丙」不命中「甲、乙」(丙不在这本书上)。
  const index = buildDedupeIndex(
    [{ id: 1, title: '合著', author: '甲、乙', isbn: '' }],
    () => '',
  );
  assert.equal(findIdentical({ title: '合著', author: '甲' }, index).book.id, 1);
  assert.equal(findIdentical({ title: '合著', author: '甲、乙' }, index).book.id, 1);
  assert.equal(findIdentical({ title: '合著', author: '乙、甲' }, index).book.id, 1);  // 顺序无关
  assert.equal(findIdentical({ title: '合著', author: '甲、丙' }, index), null);      // 丙对不上
});

test('C7 findIdentical:没有作者信息时,只有唯一候选才算同一本', () => {
  const one = buildDedupeIndex([{ id: 1, title: '同名', author: '', isbn: '' }], () => '');
  assert.equal(findIdentical({ title: '同名', author: '' }, one).book.id, 1);

  const two = buildDedupeIndex([
    { id: 1, title: '同名', author: '甲', isbn: '' },
    { id: 2, title: '同名', author: '乙', isbn: '' },
  ], () => '');
  // 两个候选且都没给作者对照 → 保守判不重复
  assert.equal(findIdentical({ title: '同名', author: '' }, two), null);
});

test('C8 findIdentical:候选没作者时不算匹配(保守)', () => {
  const index = buildDedupeIndex(
    [{ id: 1, title: '三体', author: '', isbn: '' }],
    () => '',
  );
  assert.equal(findIdentical({ title: '三体', author: '刘慈欣' }, index), null);
});

test('C9 findIdentical:书名标点差异仍能命中', () => {
  const index = buildDedupeIndex(
    [{ id: 1, title: '三体：地球往事', author: '刘慈欣', isbn: '' }],
    () => '',
  );
  assert.equal(findIdentical({ title: '三体 地球往事', author: '刘慈欣' }, index).book.id, 1);
});

/* ============================================================
 * D. importCsv 策略矩阵(deps 全注入)
 * ============================================================ */

// 假 deps:内存库,记录调用
function fakeImportDeps(existing = []) {
  const store = new Map(existing.map((r) => [r.id, { ...r }]));
  const calls = { create: [], merge: [] };
  let nextId = 100;
  return {
    store, calls,
    deps: {
      listExisting: () => [...store.values()],
      isbnOf: (r) => isbnKey(r.isbn || ''),
      createBook: (body, custom) => {
        const id = nextId++;
        const row = { id, title: body.title, author: body.author || '', isbn: body.isbn || '' };
        store.set(id, row);
        calls.create.push({ body, custom });
        return row;
      },
      mergeBook: (id, body, custom, opts) => {
        calls.merge.push({ id, body, custom, opts });
        return store.get(id) ? store.get(id) : null;
      },
    },
  };
}

const HEAD = 'title,author,isbn\n';
const csvOf = (...lines) => HEAD + lines.join('\n');

test('D1 duplicate=add:不查重,总是新建', () => {
  const { deps, calls } = fakeImportDeps([{ id: 1, title: '三体', author: '刘慈欣', isbn: '' }]);
  const out = importCsv(deps, { text: csvOf('三体,刘慈欣,'), duplicateAction: 'add' });
  assert.equal(out.summary.created, 1);
  assert.equal(calls.merge.length, 0);
});

test('D2 duplicate=ignore:命中就跳过,记 duplicate', () => {
  const { deps } = fakeImportDeps([{ id: 1, title: '三体', author: '刘慈欣', isbn: '' }]);
  const out = importCsv(deps, { text: csvOf('三体,刘慈欣,'), duplicateAction: 'ignore' });
  assert.equal(out.summary.duplicate, 1);
  assert.equal(out.results[0].existing.id, 1);
  assert.equal(out.results[0].reason, 'title');
});

test('D3 duplicate=add_formats_to_existing:合并进已有', () => {
  const { deps, calls } = fakeImportDeps([{ id: 1, title: '三体', author: '刘慈欣', isbn: '' }]);
  const out = importCsv(deps, { text: csvOf('三体,刘慈欣,'), duplicateAction: 'add_formats_to_existing' });
  assert.equal(out.summary.merged, 1);
  assert.equal(out.results[0].bookId, 1);
  assert.equal(calls.merge.length, 1);
});

test('D4 automerge=new record:本该合并时改成新建', () => {
  const { deps, calls } = fakeImportDeps([{ id: 1, title: '三体', author: '刘慈欣', isbn: '' }]);
  const out = importCsv(deps, {
    text: csvOf('三体,刘慈欣,'),
    duplicateAction: 'add_formats_to_existing',
    automergeAction: 'new record',
  });
  assert.equal(out.summary.created, 1);
  assert.equal(calls.merge.length, 0);
});

test('D5 automerge=overwrite 传给合并函数', () => {
  const { deps, calls } = fakeImportDeps([{ id: 1, title: '三体', author: '刘慈欣', isbn: '' }]);
  importCsv(deps, {
    text: csvOf('三体,刘慈欣,'),
    duplicateAction: 'add_formats_to_existing',
    automergeAction: 'overwrite',
  });
  assert.equal(calls.merge[0].opts.overwrite, true);
});

test('D6 automerge=ignore(默认)不覆盖', () => {
  const { deps, calls } = fakeImportDeps([{ id: 1, title: '三体', author: '刘慈欣', isbn: '' }]);
  importCsv(deps, { text: csvOf('三体,刘慈欣,'), duplicateAction: 'add_formats_to_existing' });
  assert.equal(calls.merge[0].opts.overwrite, false);
});

test('D7 dry_run 返回结论但一行不写', () => {
  const { deps, calls } = fakeImportDeps([{ id: 1, title: '三体', author: '刘慈欣', isbn: '' }]);
  const out = importCsv(deps, {
    text: csvOf('三体,刘慈欣,', '新书,某人,'),
    duplicateAction: 'add_formats_to_existing',
    dryRun: true,
  });
  assert.equal(out.summary.dry_run, true);
  assert.equal(out.summary.merged, 1);
  assert.equal(out.summary.created, 1);
  assert.equal(calls.create.length, 0);       // 没真建
  assert.equal(calls.merge.length, 0);        // 没真合
});

test('D8 逐行结果:invalid / created 混在一起,互不影响', () => {
  const { deps } = fakeImportDeps([]);
  const out = importCsv(deps, { text: csvOf('好书,甲,', ',没书名,', '另一本,乙,') });
  assert.equal(out.summary.created, 2);
  assert.equal(out.summary.invalid, 1);
  assert.equal(out.results[1].status, 'invalid');
  assert.equal(out.results[1].row, 3);        // 表头占 1,数据从 2 起
});

test('D9 缺书名列直接拒绝整份 CSV', () => {
  const { deps } = fakeImportDeps([]);
  assert.throws(
    () => importCsv(deps, { text: 'author,rating\n甲,9' }),
    (e) => e.code === 'VALIDATION' && /书名|title/.test(e.message),
  );
});

test('D10 空 CSV 拒绝', () => {
  const { deps } = fakeImportDeps([]);
  assert.throws(() => importCsv(deps, { text: '' }), (e) => e.code === 'VALIDATION');
});

test('D11 超过行数上限拒绝', () => {
  const { deps } = fakeImportDeps([]);
  const lines = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `书${i},甲,`);
  assert.throws(() => importCsv(deps, { text: HEAD + lines.join('\n') }), (e) => e.code === 'VALIDATION');
});

test('D12 未知策略值退回安全默认(add / ignore)', () => {
  const { deps, calls } = fakeImportDeps([{ id: 1, title: '三体', author: '刘慈欣', isbn: '' }]);
  const out = importCsv(deps, {
    text: csvOf('三体,刘慈欣,'),
    duplicateAction: '不存在的策略',
    automergeAction: '也不存在',
  });
  assert.equal(out.summary.created, 1);       // 退回 add
  assert.equal(calls.merge.length, 0);
});

test('D13 返回被忽略的表头与已映射字段(前端展示用)', () => {
  const { deps } = fakeImportDeps([]);
  const out = importCsv(deps, { text: 'title,id,未知列,#页数\n书,1,x,300' });
  assert.deepEqual(out.mappedFields, ['title']);
  assert.deepEqual(out.customFields, ['页数']);
  assert.ok(out.ignoredHeaders.includes('id'));
  assert.ok(out.ignoredHeaders.includes('未知列'));
});

test('D15 ISBN 归一化:带连字符的已有 ISBN 命中无连字符输入', () => {
  const { deps } = fakeImportDeps([
    { id: 1, title: '三体', author: '刘慈欣', isbn: '978-7-5366-9293-0' },
  ]);
  const out = importCsv(deps, {
    text: 'title,author,isbn\n完全不同的标题,某人,9787536692930',
    duplicateAction: 'ignore',
  });
  assert.equal(out.summary.duplicate, 1);
  assert.equal(out.results[0].reason, 'isbn');
});

test('D16 批次内新建的书立即进查重索引:同 CSV 的第二条相同行不重复建', () => {
  const { deps } = fakeImportDeps([]);
  const out = importCsv(deps, {
    text: csvOf('重复书,甲,', '重复书,甲,'),
    duplicateAction: 'ignore',
  });
  assert.equal(out.summary.created, 1);
  assert.equal(out.summary.duplicate, 1);
  assert.equal(out.results[1].reason, 'title');
});

test('D17 dry_run 也模拟批次内新建,预览能显示 duplicate', () => {
  const { deps } = fakeImportDeps([]);
  const out = importCsv(deps, {
    text: csvOf('重复书,甲,', '重复书,甲,'),
    duplicateAction: 'ignore',
    dryRun: true,
  });
  assert.equal(out.summary.created, 1);
  assert.equal(out.summary.duplicate, 1);
});

test('D14 parseHeaders:只解表头,不碰库', () => {
  const p = dbImport.parseHeaders('title,author,#页数,id\n');
  assert.deepEqual(p.fields.map((f) => f.field), ['title', 'author']);
  assert.deepEqual(p.custom, [{ index: 2, label: '页数' }]);
  assert.deepEqual(p.ignored, ['id']);
});

/* ============================================================
 * E. db/import 集成(真库,临时目录)
 *
 * ⚠️ **每个调用都必须显式传 db 句柄**。
 * db/import.js 的三个入口默认参数是模块单例(db/index.js 的 db),
 * 不传就会写进真实 data/books.db ——
 * 2026-10-20 实测踩过:漏传导致 20 本测试书进了生产库(id 68-87),
 * 已按备份精确清理。PROJECT_MEMORY §8 记的正是这个债务。
 * 这里用 bound() 把句柄预先绑定,避免每个断言点都手写一遍。
 * ============================================================ */

function freshDb() {
  const dir = tempDir();
  const db = openDb(dir);
  db.exec('DELETE FROM books; DELETE FROM book_tags; DELETE FROM tags; DELETE FROM book_authors; DELETE FROM authors;');
  db.exec('DELETE FROM book_collections; DELETE FROM collections');
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  // 句柄预绑定的包装:任何漏传都会报错,而不是静默写进生产库
  const bound = {
    db,
    createBook: (body, custom, meta) => {
      assert.ok(db, 'db 句柄必须存在');
      return dbImport.createBook(body, custom, db, meta && meta.collections);
    },
    mergeBook: (id, body, custom, opts, meta) => dbImport.mergeBook(
      id, body, custom, opts || {}, db, meta && meta.collections,
    ),
    listExisting: () => dbImport.listExisting(db),
    isbnOf: dbImport.makeIsbnOf(db),
  };
  return { dir, ...bound };
}

function importDeps(db) {
  return {
    listExisting: () => dbImport.listExisting(db),
    isbnOf: dbImport.makeIsbnOf(db),
    createBook: (body, custom, meta) => dbImport.createBook(body, custom, db, meta && meta.collections),
    mergeBook: (id, body, custom, opts, meta) => dbImport.mergeBook(
      id, body, custom, opts || {}, db, meta && meta.collections,
    ),
  };
}

test('E1 createBook:走 parseBook,日期由阅读记录推导', () => {
  const { dir, db } = freshDb();
  const row = dbImport.createBook({
    title: '三体', author: '刘慈欣', status: 'done',
    read_logs: JSON.stringify([{ start: '2024-01-01', finish: '2024-01-10' }]),
    read_count: 99,                       // 应被记录推导覆盖
  }, null, db);
  assert.equal(row.title, '三体');
  assert.equal(row.read_count, 1);
  assert.equal(row.finish_date, '2024-01-10');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E2 createBook:标签/作者/FTS 自动同步', () => {
  const { dir, db } = freshDb();
  const row = dbImport.createBook({ title: '三体', author: '刘慈欣', tags: ['科幻', '小说'] }, null, db);
  const tags = db.prepare('SELECT t.name FROM book_tags bt JOIN tags t ON t.id=bt.tag WHERE bt.book=? ORDER BY t.name')
    .all(row.id).map((r) => r.name);
  assert.deepEqual(tags, ['小说', '科幻']);
  assert.equal(search.searchBooks(db, { q: 'tag:科幻' }).length, 1);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E3 createBook:标识符落库并可检索', () => {
  const { dir, db } = freshDb();
  const row = dbImport.createBook({ title: '三体', identifiers: { isbn: '9787536692930', goodreads: '123' } }, null, db);
  const ids = db.prepare('SELECT type,value FROM book_identifiers WHERE book=? ORDER BY type').all(row.id);
  assert.deepEqual(ids.map((r) => `${r.type}:${r.value}`), ['goodreads:123', 'isbn:9787536692930']);
  assert.equal(search.searchBooks(db, { q: 'identifier:goodreads:123' }).length, 1);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E4 mergeBook:只补空,不动 title/author,标签并集', () => {
  const { dir, db } = freshDb();
  const row = dbImport.createBook({ title: '原名', author: '原作者', tags: ['已有'], summary: '' }, null, db);
  const merged = dbImport.mergeBook(row.id, {
    title: 'CSV里的新名', author: 'CSV新作者',
    summary: '导入的简介', publisher: '导入社', tags: ['新标签'],
  }, null, {}, db);
  assert.equal(merged.title, '原名');            // 身份字段不动
  assert.equal(merged.author, '原作者');
  assert.equal(merged.summary, '导入的简介');     // 空 → 补上
  assert.equal(merged.publisher, '导入社');
  assert.deepEqual(JSON.parse(merged.tags), ['已有', '新标签']);  // 并集
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E5 mergeBook:overwrite 时覆盖已有字段', () => {
  const { dir, db } = freshDb();
  const row = dbImport.createBook({ title: '书', summary: '旧简介' }, null, db);
  const merged = dbImport.mergeBook(row.id, { summary: '新简介' }, null, { overwrite: true }, db);
  assert.equal(merged.summary, '新简介');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E6 mergeBook:series 单独更新且遵守只补空', () => {
  const { dir, db } = freshDb();
  const row = dbImport.createBook({ title: '书' }, null, db);
  const m1 = dbImport.mergeBook(row.id, { series: '基地', series_index: '3' }, null, {}, db);
  assert.equal(m1.series, '基地');
  assert.equal(m1.series_index, 3);

  // 已有系列时,再导一次不覆盖
  const m2 = dbImport.mergeBook(row.id, { series: '别的系列', series_index: '9' }, null, {}, db);
  assert.equal(m2.series, '基地');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E7 mergeBook:不碰阅读记录(status/read_logs)', () => {
  const { dir, db } = freshDb();
  const row = dbImport.createBook({
    title: '书', status: 'done',
    read_logs: JSON.stringify([{ start: '2024-01-01', finish: '2024-01-10' }]),
  }, null, db);
  const merged = dbImport.mergeBook(row.id, { status: 'wish', read_count: 0 }, null, { overwrite: true }, db);
  assert.equal(merged.status, 'done');           // 不被导入改掉
  assert.equal(merged.read_count, 1);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E8 mergeBook:目标不存在返回 null', () => {
  const { dir, db } = freshDb();
  assert.equal(dbImport.mergeBook(99999, { summary: 'x' }, null, {}, db), null);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E8b 导入 collections 列:自动建集、去重、多集成员', () => {
  const { dir, db } = freshDb();
  const out = importCsv(importDeps(db), {
    text: 'title,author,collections\n甲,作者A,"待读, 精读, 待读"\n乙,作者B,待读\n',
  });
  assert.equal(out.summary.created, 2, JSON.stringify(out.results));
  const sets = db.prepare(`
    SELECT c.name, COUNT(bc.book_id) AS n
    FROM collections c LEFT JOIN book_collections bc ON bc.collection_id = c.id
    GROUP BY c.id ORDER BY c.name
  `).all();
  assert.deepEqual(sets.map((r) => `${r.name}:${r.n}`), ['待读:2', '精读:1']);
  const bookId = db.prepare('SELECT id FROM books WHERE title = ?').get('甲').id;
  const names = db.prepare(`
    SELECT c.name FROM book_collections bc JOIN collections c ON c.id = bc.collection_id
    WHERE bc.book_id = ? ORDER BY c.name
  `).all(bookId).map((r) => r.name);
  assert.deepEqual(names, ['待读', '精读']);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E8c 合并导入也加入藏书集;ignore 跳过时不改成员', () => {
  const { dir, db } = freshDb();
  const row = dbImport.createBook({ title: '书', author: '某人' }, null, db);
  const deps = importDeps(db);
  const csv = 'title,author,collections\n书,某人,新集\n';

  const merged = importCsv(deps, { text: csv, duplicateAction: 'add_formats_to_existing' });
  assert.equal(merged.summary.merged, 1, JSON.stringify(merged.results));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_collections WHERE book_id = ?').get(row.id).n, 1);

  const ignored = importCsv(deps, { text: csv, duplicateAction: 'ignore' });
  assert.equal(ignored.summary.duplicate, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collections').get().n, 1);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E8d 非法藏书集名让整本新建回滚', () => {
  const { dir, db } = freshDb();
  assert.throws(
    () => dbImport.createBook({ title: '回滚测试' }, null, db, ['x'.repeat(101)]),
    (err) => err.code === 'VALIDATION',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collections').get().n, 0);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E9 端到端:导出 → 导入到空库 → 内容一致', () => {
  const { dir, db } = freshDb();
  // 造两本
  dbImport.createBook({ title: '三体', author: '刘慈欣', rating: 9.5, tags: ['科幻'], summary: '简介 A', series: '地球往事', series_index: 1 }, null, db);
  dbImport.createBook({ title: '活着', author: '余华', rating: 9.2, tags: ['小说'], summary: '简介 B' }, null, db);

  // 用真实的 catalog 导出
  const { buildCatalog } = require('../src/db/catalog.js');
  const { toCsv: t2 } = require('../src/core/csv.js');
  const cat = buildCatalog(db, {});
  const csv = t2(cat.headers, cat.rows);

  // 导入到同一库:全部应判重复(add_formats_to_existing → 全 merged)
  const out = importCsv({
    listExisting: () => dbImport.listExisting(db),
    isbnOf: dbImport.makeIsbnOf(db),
    createBook: (b, c, meta) => dbImport.createBook(b, c, db, meta && meta.collections),
    mergeBook: (id, b, c, o, meta) => dbImport.mergeBook(
      id, b, c, o, db, meta && meta.collections,
    ),
  }, { text: csv, duplicateAction: 'add_formats_to_existing', dryRun: true });

  assert.equal(out.summary.merged, 2, JSON.stringify(out.summary));
  assert.equal(out.summary.created, 0);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E10 端到端:导入到空库能建出新书', () => {
  const { dir, db } = freshDb();
  const csv = 'title,author,rating,tags,summary\n新书,某人,8.5,"科幻, 小说",导入的简介\n';
  const out = importCsv({
    listExisting: () => dbImport.listExisting(db),
    isbnOf: dbImport.makeIsbnOf(db),
    createBook: (b, c, meta) => dbImport.createBook(b, c, db, meta && meta.collections),
    mergeBook: (id, b, c, o, meta) => dbImport.mergeBook(
      id, b, c, o, db, meta && meta.collections,
    ),
  }, { text: csv, duplicateAction: 'add' });

  assert.equal(out.summary.created, 1, JSON.stringify(out.results));
  const row = db.prepare('SELECT * FROM books WHERE title=?').get('新书');
  assert.ok(row, '书应已建出');
  assert.equal(row.rating, 8.5);
  assert.equal(row.summary, '导入的简介');
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('E11 守卫:临时库的写入绝不落到真实库', () => {
  // 2026-10-20 实测踩过:db/books.addBook 当时把句柄硬编码成模块单例,
  // 传进去的 handleDb 被忽略 —— 跑一遍测试就往生产库写了 20 本书(id 68-87),
  // 事后按备份精确清理。这条用例守着它不再复发。
  const realPath = path.join(__dirname, '..', 'data', 'books.db');
  const exists = fs.existsSync(realPath);
  if (!exists) return;                       // 新克隆的仓库没有 data/books.db,跳过

  const { DatabaseSync } = require('node:sqlite');
  const countReal = () => {
    const d = new DatabaseSync(realPath, { readOnly: true });
    try { return d.prepare('SELECT COUNT(*) n FROM books').get().n; } finally { d.close(); }
  };

  const before = countReal();
  const { dir, db } = freshDb();
  dbImport.createBook({ title: 'E11 守卫书', author: '守卫' }, null, db);
  dbImport.mergeBook(1, { summary: 'x' }, null, {}, db);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(countReal(), before, '临时库的写入不应改变真实库行数');
});
