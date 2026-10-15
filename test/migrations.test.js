/* ============================================================
 * 版本化迁移(user_version)行为测试
 * 覆盖:全新库一次到位 / 旧库(无 user_version)升级 / 幂等重跑 /
 *       失败回滚(版本号与半成品表都不残留)
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { openDb, runMigrations, migrations } = require('../src/db/index.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-mig-test-'));
}

test('全新库:迁移一次到位,schema 完整、user_version = 迁移总数', () => {
  const dir = tempDir();
  const db = openDb(dir);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  for (const col of ['id', 'title', 'author', 'status', 'summary', 'tags', 'start_date', 'finish_date', 'cover', 'notes_url', 'read_count', 'read_logs', 'created_at', 'updated_at']) {
    assert.ok(cols.includes(col), `缺少列 ${col}`);
  }
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='settings'").get(), 'settings 表应存在');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('全新库:书架为空时写入 17 本种子数据', () => {
  const dir = tempDir();
  const db = openDb(dir);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 17);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('幂等:已到最新版本的库重跑迁移 0 步', () => {
  const dir = tempDir();
  const db = openDb(dir);
  const r = runMigrations(db, dir);
  assert.deepEqual(r, { from: migrations.length, to: migrations.length, ran: 0 });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('旧库升级:user_version=0 的老库补齐列且数据保留', () => {
  const dir = tempDir();
  // 手工模拟一个"旧时代"库:有 books 表但缺新列、user_version=0、带 3 行数据
  const dbPath = path.join(dir, 'books.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'wish',
      tags TEXT NOT NULL DEFAULT '[]',
      start_date TEXT NOT NULL DEFAULT '',
      finish_date TEXT NOT NULL DEFAULT '',
      cover TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      review TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO books (title, status, tags, created_at, updated_at) VALUES
      ('旧书甲', 'done', '["小说"]', '2024-01-01', '2024-01-02'),
      ('旧书乙', 'reading', '[]', '2024-02-01', '2024-02-02'),
      ('旧书丙', 'wish', '[]', '2024-03-01', '2024-03-02');
  `);
  legacy.close();

  const db = openDb(dir);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
  const rows = db.prepare('SELECT title FROM books ORDER BY id').all();
  assert.equal(rows.length, 3);                       // 原有数据不丢
  assert.equal(rows[0].title, '旧书甲');
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  assert.ok(cols.includes('notes_url'));              // 缺的列补上了
  assert.ok(!cols.includes('review'));                // 下线列删掉了
  // 注意:书架非空,不应再写种子数据
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v8:存量 5 分制评分折算为 10 分制(×2,封顶 10;0 分不动)', () => {
  const dir = tempDir();
  const db = openDb(dir); // 一次到位到最新版
  const ins = db.prepare("INSERT INTO books (title, status, tags, rating, created_at, updated_at) VALUES (?, 'done', '[]', ?, '2024-01-01', '2024-01-01')");
  ins.run('旧五星书甲', 4.5);  // → 9.0
  ins.run('旧五星书乙', 5);    // → 10(封顶)
  ins.run('旧五星书丙', 0);    // 未评分,不动
  db.exec('PRAGMA user_version = 7'); // v8 位于索引 7(迁移只追加,永不重排);重放 v8 折算评分
  runMigrations(db, dir);

  const rows = db.prepare("SELECT title, rating FROM books WHERE title LIKE '旧五星书%' ORDER BY id").all();
  assert.equal(rows[0].rating, 9);
  assert.equal(rows[1].rating, 10);
  assert.equal(rows[2].rating, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('失败回滚:迁移抛异常时 user_version 与半成品变更全部回退', () => {
  const dir = tempDir();
  const db = openDb(dir);
  const before = db.prepare('PRAGMA user_version').get().user_version;

  migrations.push(function migrateVX_fail(db2) {
    db2.exec('CREATE TABLE IF NOT EXISTS __drill (id INTEGER)');
    throw new Error('模拟中途崩溃');
  });
  try {
    runMigrations(db, dir);
    assert.fail('应抛出异常');
  } catch (e) {
    assert.ok(/数据库迁移失败/.test(e.message), `错误信息应带上下文,实际:${e.message}`);
  } finally {
    migrations.pop();   // 移除演练迁移,恢复注册表
  }

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, before, '版本号应回退');
  const leftover = db.prepare("SELECT name FROM sqlite_master WHERE name='__drill'").get();
  assert.equal(leftover, undefined, '半成品表不应残留');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
