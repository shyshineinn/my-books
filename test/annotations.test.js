/* ============================================================
 * 注释数据层(db/annotations.js)+ v6 迁移行为测试
 *
 * 隔离方式:openDb(临时目录) 得到独立库,把该库的 db 句柄传给
 * annotations.* 每个调用 —— 与 positions.test.js 同策略。
 *
 * ⚠ 隔离性自检为何比 positions.test.js 更强:
 *   仅比对 data/books.db 的 mtime **抓不住** WAL 模式下的写入 ——
 *   实测(2026-09-23)只 require src/db/index.js 就会把真实库从 v5 迁到 v6,
 *   而 books.db 主文件的 mtime 完全不变(数据写在 -wal 里)。
 *   因此这里额外比对 user_version、books 行数与 annotations 行数。
 *   本文件同时在测试内注释说明:index.js 在 require 时就打开真实库,
 *   这是"跑测试会顺带迁移真实库"的根因(见 P3 方案的风险记录)。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { openDb, migrations } = require('../src/db/index.js');
const annotations = require('../src/db/annotations.js');

const POINT_CFI = 'epubcfi(/6/4[chap01]!/4/2/2:0)';
const RANGE_CFI = 'epubcfi(/6/4[chap01]!/4/2,/1:0,/1:10)';
const PDF_LOC = '{"page":37,"offsetY":120}';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-annot-test-'));
}

function setup() {
  const dir = tempDir();
  const db = openDb(dir);
  const bookId = db.prepare('SELECT id FROM books ORDER BY id LIMIT 1').get().id;
  return { dir, db, bookId };
}

function teardown(dir, db) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const bm = (over = {}) => ({
  format: 'EPUB', annot_type: 'bookmark', annot_id: 'bm-1',
  locator_kind: 'epubcfi', start_locator: POINT_CFI, end_locator: '',
  text: '', note: '', color: 'yellow', chapter: '第一章',
  ...over,
});

const hl = (over = {}) => ({
  format: 'EPUB', annot_type: 'highlight', annot_id: 'hl-1',
  locator_kind: 'epubcfi', start_locator: RANGE_CFI, end_locator: '',
  text: '被高亮的原文', note: '', color: 'green', chapter: '第一章',
  ...over,
});

/* ---------- 迁移 ---------- */

test('v6 迁移:annotations 表建好,user_version 到最新', () => {
  const { dir, db } = setup();
  assert.equal(migrations.length, 6, '迁移总数应为 6(v6 = 注释表)');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);

  const t = db.prepare("SELECT name FROM sqlite_master WHERE name='annotations'").get();
  assert.ok(t, 'annotations 表应存在');
  const cols = db.prepare('PRAGMA table_info(annotations)').all().map((c) => c.name);
  for (const c of ['id', 'book', 'format', 'annot_type', 'annot_id', 'locator_kind',
    'start_locator', 'end_locator', 'text', 'note', 'color', 'chapter', 'created_at', 'updated_at']) {
    assert.ok(cols.includes(c), `缺少列 ${c}`);
  }
  // 索引与 read_positions 同款(按书查)
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='annotations_book_idx'").get(), '应有 book 索引');
  teardown(dir, db);
});

test('v6 迁移幂等:同目录再开一次不重复执行、不丢数据', () => {
  const { dir, db, bookId } = setup();
  annotations.upsertAnnotation(db, bookId, bm());
  db.close();

  const db2 = openDb(dir);
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, migrations.length);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM annotations').get().n, 1, '重开不应清掉注释');
  teardown(dir, db2);
});

/* ---------- 读写 ---------- */

test('upsertAnnotation:首次写入后可读回', () => {
  const { dir, db, bookId } = setup();
  const saved = annotations.upsertAnnotation(db, bookId, bm());
  assert.equal(saved.book, bookId);
  assert.equal(saved.start_locator, POINT_CFI);
  assert.equal(saved.locator_kind, 'epubcfi');
  assert.ok(saved.created_at && saved.updated_at, '应有创建/更新时间');
  assert.ok(saved.id > 0);

  const got = annotations.getAnnotation(db, saved.id);
  assert.equal(got.annot_id, 'bm-1');
  teardown(dir, db);
});

test('upsertAnnotation 幂等:同一唯一键只保留一行,值被更新', () => {
  const { dir, db, bookId } = setup();
  const first = annotations.upsertAnnotation(db, bookId, hl({ note: '旧批注', color: 'yellow' }));
  const second = annotations.upsertAnnotation(db, bookId, hl({ note: '新批注', color: 'blue' }));

  const rows = db.prepare('SELECT * FROM annotations WHERE book = ?').all(bookId);
  assert.equal(rows.length, 1, '不应产生第二行');
  assert.equal(second.id, first.id, '应更新同一行');
  assert.equal(rows[0].note, '新批注');
  assert.equal(rows[0].color, 'blue');
  assert.equal(rows[0].created_at, first.created_at, 'created_at 应保留首次创建时间');
  teardown(dir, db);
});

test('换 annot_id → 新增一行(幂等键含 annot_id)', () => {
  const { dir, db, bookId } = setup();
  annotations.upsertAnnotation(db, bookId, hl({ annot_id: 'a1' }));
  annotations.upsertAnnotation(db, bookId, hl({ annot_id: 'a2' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE book = ?').get(bookId).n, 2);
  teardown(dir, db);
});

test('同一 annot_id 但不同 annot_type / format 各自独立成行(唯一键是四列)', () => {
  const { dir, db, bookId } = setup();
  annotations.upsertAnnotation(db, bookId, bm({ annot_id: 'same' }));
  annotations.upsertAnnotation(db, bookId, hl({ annot_id: 'same' }));
  annotations.upsertAnnotation(db, bookId, hl({ annot_id: 'same', format: 'PDF', start_locator: PDF_LOC }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE book = ?').get(bookId).n, 3);
  teardown(dir, db);
});

test('格式分区:EPUB 的注释不出现在 PDF 查询里', () => {
  const { dir, db, bookId } = setup();
  annotations.upsertAnnotation(db, bookId, hl({ format: 'EPUB', annot_id: 'e1' }));
  annotations.upsertAnnotation(db, bookId, hl({ format: 'PDF', annot_id: 'p1', start_locator: PDF_LOC, locator_kind: 'pdfpage' }));

  assert.equal(annotations.listAnnotations(db, bookId, { format: 'EPUB' }).length, 1);
  assert.equal(annotations.listAnnotations(db, bookId, { format: 'PDF' }).length, 1);
  assert.equal(annotations.listAnnotations(db, bookId).length, 2, '不给 format 应返回全部');
  teardown(dir, db);
});

test('格式名大小写不敏感(COLLATE NOCASE)', () => {
  const { dir, db, bookId } = setup();
  annotations.upsertAnnotation(db, bookId, hl({ format: 'epub' }));   // 小写入
  assert.equal(annotations.listAnnotations(db, bookId, { format: 'EPUB' }).length, 1, '大写查应命中');
  annotations.upsertAnnotation(db, bookId, hl({ format: 'EPUB', note: '更新' })); // 大写再写
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE book = ?').get(bookId).n, 1, '不应因大小写产生第二行');
  teardown(dir, db);
});

test('listAnnotations:同章内按 start_locator 稳定排序', () => {
  const { dir, db, bookId } = setup();
  annotations.upsertAnnotation(db, bookId, hl({ annot_id: 'c', start_locator: 'epubcfi(/6/4!/4/2,/1:20,/1:30)' }));
  annotations.upsertAnnotation(db, bookId, hl({ annot_id: 'a', start_locator: 'epubcfi(/6/4!/4/2,/1:0,/1:5)' }));
  annotations.upsertAnnotation(db, bookId, hl({ annot_id: 'b', start_locator: 'epubcfi(/6/4!/4/2,/1:10,/1:15)' }));
  const ids = annotations.listAnnotations(db, bookId, { format: 'EPUB' }).map((r) => r.annot_id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  teardown(dir, db);
});

test('getByAnnotId / getByAnnotIdInBook:命中与未命中', () => {
  const { dir, db, bookId } = setup();
  annotations.upsertAnnotation(db, bookId, hl({ annot_id: 'x1' }));
  assert.ok(annotations.getByAnnotId(db, bookId, 'EPUB', 'highlight', 'x1'));
  assert.equal(annotations.getByAnnotId(db, bookId, 'PDF', 'highlight', 'x1'), null, '格式不符应为 null');
  assert.ok(annotations.getByAnnotIdInBook(db, bookId, 'x1'));
  assert.equal(annotations.getByAnnotIdInBook(db, bookId, 'nope'), null);
  teardown(dir, db);
});

/* ---------- 局部更新 ---------- */

test('updateAnnotation:只改传入字段,返回更新后的行', () => {
  const { dir, db, bookId } = setup();
  const row = annotations.upsertAnnotation(db, bookId, hl({ note: '旧', color: 'yellow' }));
  const updated = annotations.updateAnnotation(db, row.id, { ...row, note: '新批注', color: 'blue' });
  assert.equal(updated.note, '新批注');
  assert.equal(updated.color, 'blue');
  assert.equal(updated.start_locator, RANGE_CFI, '位置不应被动过');
  assert.equal(updated.created_at, row.created_at, 'created_at 不应变');
  teardown(dir, db);
});

test('updateAnnotation:不存在的 id 返回 null', () => {
  const { dir, db } = setup();
  assert.equal(annotations.updateAnnotation(db, 999999, { note: 'x', color: 'yellow', chapter: '' }), null);
  teardown(dir, db);
});

/* ---------- 删除与级联 ---------- */

test('deleteAnnotation:返回删除行数,删不存在的返回 0', () => {
  const { dir, db, bookId } = setup();
  const row = annotations.upsertAnnotation(db, bookId, bm());
  assert.equal(annotations.deleteAnnotation(db, row.id), 1);
  assert.equal(annotations.getAnnotation(db, row.id), null);
  assert.equal(annotations.deleteAnnotation(db, row.id), 0);
  teardown(dir, db);
});

test('删除书籍:注释随外键级联删除', () => {
  const { dir, db, bookId } = setup();
  annotations.upsertAnnotation(db, bookId, bm({ annot_id: 'a' }));
  annotations.upsertAnnotation(db, bookId, hl({ annot_id: 'b' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM annotations').get().n, 2);

  db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE book = ?').get(bookId).n, 0,
    '删书应自动清掉其注释(ON DELETE CASCADE)'
  );
  teardown(dir, db);
});

test('外键强制:不允许给不存在的书写入注释', () => {
  const { dir, db } = setup();
  assert.throws(() => annotations.upsertAnnotation(db, 999999, bm()), /FOREIGN KEY|constraint/i);
  teardown(dir, db);
});

test('CHECK 约束:非法 annot_type / locator_kind 进不去库里', () => {
  const { dir, db, bookId } = setup();
  assert.throws(() => annotations.upsertAnnotation(db, bookId, bm({ annot_type: 'note' })), /CHECK|constraint/i);
  assert.throws(() => annotations.upsertAnnotation(db, bookId, bm({ locator_kind: 'magic' })), /CHECK|constraint/i);
  teardown(dir, db);
});

test('多本书互不干扰', () => {
  const { dir, db } = setup();
  const ids = db.prepare('SELECT id FROM books ORDER BY id LIMIT 3').all().map((r) => r.id);
  annotations.upsertAnnotation(db, ids[0], hl({ annot_id: 'x', note: 'A' }));
  annotations.upsertAnnotation(db, ids[1], hl({ annot_id: 'x', note: 'B' }));
  annotations.upsertAnnotation(db, ids[2], hl({ annot_id: 'x', note: 'C' }));
  assert.equal(annotations.listAnnotations(db, ids[0]).length, 1, '只应看到自己的注释');
  assert.equal(annotations.listAnnotations(db, ids[0])[0].note, 'A');
  assert.equal(annotations.listAnnotations(db, ids[1])[0].note, 'B');
  teardown(dir, db);
});

/* ---------- 隔离性自检(强化版:抓得住 WAL 写入)---------- */

test('隔离性:所有操作都落在临时库,真实库的版本与行数不受影响', () => {
  const realPath = path.join(__dirname, '..', 'data', 'books.db');
  const snapshot = () => {
    if (!fs.existsSync(realPath)) return null;
    const d = new DatabaseSync(realPath, { readOnly: true });
    const out = { mtime: fs.statSync(realPath).mtimeMs };
    out.uv = d.prepare('PRAGMA user_version').get().user_version;
    out.books = d.prepare('SELECT COUNT(*) AS n FROM books').get().n;
    try { out.annots = d.prepare('SELECT COUNT(*) AS n FROM annotations').get().n; }
    catch { out.annots = 'no-table'; }
    d.close();
    return out;
  };

  const before = snapshot();
  const { dir, db, bookId } = setup();
  annotations.upsertAnnotation(db, bookId, hl());
  annotations.deleteAnnotation(db, annotations.listAnnotations(db, bookId)[0].id);
  teardown(dir, db);
  const after = snapshot();

  if (before === null) return;   // 无真实库时跳过
  // 注意:mtime 单独不足 —— WAL 模式下写入不进主文件(下一条断言就是证据)
  assert.equal(after.uv, before.uv, '真实库 user_version 不应变化(仅 mtime 检查会漏掉 WAL 写入)');
  assert.equal(after.books, before.books, '真实库 books 行数不应变化');
  assert.deepEqual(after.annots, before.annots, '真实库 annotations 行数不应变化');
});

test('隔离性自检的有效性:openDb(临时目录) 确实建在临时目录,不碰真实库', () => {
  const dir = tempDir();
  const db = openDb(dir);
  const files = fs.readdirSync(dir);
  assert.ok(files.includes('books.db'), '临时目录里应有独立的 books.db');
  assert.notEqual(path.resolve(dir), path.resolve(path.join(__dirname, '..', 'data')));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
