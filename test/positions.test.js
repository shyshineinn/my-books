/* ============================================================
 * 阅读位置数据层(db/positions.js)+ v5 迁移行为测试
 *
 * 隔离方式:openDb(临时目录) 得到独立库,把该库的 db 句柄传给
 * positions.* 每个调用 —— 与 search.test.js 同策略。
 * 绝不触碰真实 data/books.db(数据层不持有单例,句柄由调用方传入)。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDb, migrations } = require('../src/db/index.js');
const positions = require('../src/db/positions.js');
const { pdfLocator } = require('../src/core/position.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-pos-test-'));
}

// 建临时库并返回第一本书的 id(种子数据已有 17 本)
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

const epubPos = (over = {}) => ({
  format: 'EPUB', device: 'desktop',
  locator: 'epubcfi(/6/4[chap01]!/4/2/2:0)', locator_kind: 'epubcfi', pos_frac: 0.42,
  ...over,
});

/* ---------- 迁移 ---------- */

test('v5 迁移:read_positions 表建好,user_version 到最新', () => {
  const { dir, db } = setup();
  // 断言「到最新」而不是写死版本号 —— 后续每加一条迁移(如 v6 注释表)都无需改这里
  assert.ok(migrations.length >= 5, '至少应包含到 v5');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
  const t = db.prepare("SELECT name FROM sqlite_master WHERE name='read_positions'").get();
  assert.ok(t, 'read_positions 表应存在');
  const cols = db.prepare('PRAGMA table_info(read_positions)').all().map((c) => c.name);
  for (const c of ['id', 'book', 'format', 'device', 'locator', 'locator_kind', 'pos_frac', 'epoch']) {
    assert.ok(cols.includes(c), `缺少列 ${c}`);
  }
  teardown(dir, db);
});

test('v5 迁移幂等:同目录再开一次不重复执行', () => {
  const { dir, db } = setup();
  db.close();
  const db2 = openDb(dir);
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, migrations.length);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM read_positions').get().n, 0);
  teardown(dir, db2);
});

/* ---------- 读写 ---------- */

test('savePosition:首次写入后可读回', () => {
  const { dir, db, bookId } = setup();
  const saved = positions.savePosition(db, bookId, epubPos());
  assert.equal(saved.locator, epubPos().locator);
  assert.equal(saved.pos_frac, 0.42);
  assert.ok(Number.isInteger(saved.epoch) && saved.epoch > 0, 'epoch 应为毫秒整数');

  const got = positions.getPosition(db, bookId, 'EPUB', 'desktop');
  assert.equal(got.locator, epubPos().locator);
  teardown(dir, db);
});

test('savePosition 幂等:同一(书,格式,设备)只保留一行,值被更新', () => {
  const { dir, db, bookId } = setup();
  positions.savePosition(db, bookId, epubPos({ pos_frac: 0.1 }));
  positions.savePosition(db, bookId, epubPos({ locator: 'epubcfi(/6/8!/4/2)', pos_frac: 0.9 }));
  const rows = db.prepare('SELECT * FROM read_positions WHERE book = ?').all(bookId);
  assert.equal(rows.length, 1, '不应产生第二行');
  assert.equal(rows[0].pos_frac, 0.9);
  assert.equal(rows[0].locator, 'epubcfi(/6/8!/4/2)');
  teardown(dir, db);
});

test('设备分区:同一本书不同设备各存各的,互不覆盖', () => {
  const { dir, db, bookId } = setup();
  positions.savePosition(db, bookId, epubPos({ device: 'desktop', pos_frac: 0.2 }));
  positions.savePosition(db, bookId, epubPos({ device: 'phone', pos_frac: 0.8 }));
  positions.savePosition(db, bookId, epubPos({ device: 'tablet', pos_frac: 0.5 }));

  assert.equal(positions.getPosition(db, bookId, 'EPUB', 'desktop').pos_frac, 0.2);
  assert.equal(positions.getPosition(db, bookId, 'EPUB', 'phone').pos_frac, 0.8);
  assert.equal(positions.getPosition(db, bookId, 'EPUB', 'tablet').pos_frac, 0.5);
  assert.equal(positions.listPositions(db, bookId, 'EPUB').length, 3);
  teardown(dir, db);
});

test('格式分区:同一本书 EPUB 与 PDF 各存各的', () => {
  const { dir, db, bookId } = setup();
  positions.savePosition(db, bookId, epubPos({ pos_frac: 0.3 }));
  positions.savePosition(db, bookId, {
    format: 'PDF', device: 'desktop', locator: pdfLocator(20, 0), locator_kind: 'pdfpage', pos_frac: 0.6,
  });
  assert.equal(positions.getPosition(db, bookId, 'EPUB', 'desktop').pos_frac, 0.3);
  assert.equal(positions.getPosition(db, bookId, 'PDF', 'desktop').pos_frac, 0.6);
  teardown(dir, db);
});

test('格式名大小写不敏感(COLLATE NOCASE)', () => {
  const { dir, db, bookId } = setup();
  positions.savePosition(db, bookId, epubPos({ format: 'EPUB' }));
  assert.ok(positions.getPosition(db, bookId, 'epub', 'desktop'), '小写格式应能读到');
  positions.savePosition(db, bookId, epubPos({ format: 'epub', pos_frac: 0.77 }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM read_positions WHERE book = ?').get(bookId).n, 1);
  assert.equal(positions.getPosition(db, bookId, 'EPUB', 'desktop').pos_frac, 0.77);
  teardown(dir, db);
});

test('getPosition:不存在返回 null', () => {
  const { dir, db, bookId } = setup();
  assert.equal(positions.getPosition(db, bookId, 'EPUB', 'nobody'), null);
  assert.equal(positions.getPosition(db, bookId, 'MOBI', 'desktop'), null);
  teardown(dir, db);
});

/* ---------- 清除与级联 ---------- */

test('clearPosition:按设备清、按格式清、全清', () => {
  const { dir, db, bookId } = setup();
  positions.savePosition(db, bookId, epubPos({ device: 'desktop' }));
  positions.savePosition(db, bookId, epubPos({ device: 'phone' }));
  positions.savePosition(db, bookId, {
    format: 'PDF', device: 'desktop', locator: pdfLocator(1), locator_kind: 'pdfpage', pos_frac: 0,
  });

  assert.equal(positions.clearPosition(db, bookId, { format: 'EPUB', device: 'phone' }), 1);
  assert.equal(positions.getPosition(db, bookId, 'EPUB', 'phone'), null);
  assert.ok(positions.getPosition(db, bookId, 'EPUB', 'desktop'), '其它设备不受影响');

  assert.equal(positions.clearPosition(db, bookId, { format: 'EPUB' }), 1, '按格式清掉剩余的 EPUB');
  assert.ok(positions.getPosition(db, bookId, 'PDF', 'desktop'), 'PDF 不受影响');

  assert.equal(positions.clearPosition(db, bookId), 1, '全清');
  assert.equal(positions.listPositions(db, bookId, 'PDF').length, 0);
  teardown(dir, db);
});

test('删除书籍:进度行随外键级联删除', () => {
  const { dir, db, bookId } = setup();
  positions.savePosition(db, bookId, epubPos({ device: 'desktop' }));
  positions.savePosition(db, bookId, epubPos({ device: 'phone' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM read_positions').get().n, 2);

  db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM read_positions WHERE book = ?').get(bookId).n, 0,
    '删书应自动清掉其进度行(ON DELETE CASCADE)'
  );
  teardown(dir, db);
});

test('外键强制:不允许给不存在的书写入进度', () => {
  const { dir, db } = setup();
  assert.throws(
    () => positions.savePosition(db, 999999, epubPos()),
    /FOREIGN KEY|constraint/i,
    '应被外键约束拒绝'
  );
  teardown(dir, db);
});

test('locator_kind 的 CHECK 约束:非法值进不去库里', () => {
  const { dir, db, bookId } = setup();
  assert.throws(
    () => positions.savePosition(db, bookId, epubPos({ locator_kind: 'magic' })),
    /CHECK|constraint/i
  );
  teardown(dir, db);
});

test('多本书互不干扰', () => {
  const { dir, db } = setup();
  const ids = db.prepare('SELECT id FROM books ORDER BY id LIMIT 3').all().map((r) => r.id);
  positions.savePosition(db, ids[0], epubPos({ pos_frac: 0.1 }));
  positions.savePosition(db, ids[1], epubPos({ pos_frac: 0.5 }));
  positions.savePosition(db, ids[2], epubPos({ pos_frac: 0.9 }));
  assert.equal(positions.getPosition(db, ids[0], 'EPUB', 'desktop').pos_frac, 0.1);
  assert.equal(positions.getPosition(db, ids[1], 'EPUB', 'desktop').pos_frac, 0.5);
  assert.equal(positions.getPosition(db, ids[2], 'EPUB', 'desktop').pos_frac, 0.9);
  assert.equal(positions.listPositions(db, ids[0], 'EPUB').length, 1, '只应看到自己的位置');
  teardown(dir, db);
});

/* ---------- 隔离性自检:确保没有误用真实库 ---------- */

test('隔离性:所有操作都落在临时库,真实库不受影响', () => {
  const realPath = path.join(__dirname, '..', 'data', 'books.db');
  const before = fs.existsSync(realPath) ? fs.statSync(realPath).mtimeMs : null;
  const beforeRows = fs.existsSync(realPath)
    ? (() => {
        const { DatabaseSync } = require('node:sqlite');
        const d = new DatabaseSync(realPath, { readOnly: true });
        let n = null;
        try { n = d.prepare('SELECT COUNT(*) AS n FROM read_positions').get().n; } catch { n = 'no-table'; }
        d.close();
        return n;
      })()
    : null;

  const { dir, db, bookId } = setup();
  positions.savePosition(db, bookId, epubPos());
  teardown(dir, db);

  const after = fs.existsSync(realPath) ? fs.statSync(realPath).mtimeMs : null;
  assert.equal(after, before, '真实库 mtime 不应变化');

  if (beforeRows !== null && beforeRows !== 'no-table') {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(realPath, { readOnly: true });
    const n = d.prepare('SELECT COUNT(*) AS n FROM read_positions').get().n;
    d.close();
    assert.equal(n, beforeRows, '真实库 read_positions 行数不应变化');
  }
});
