/* ============================================================
 * 种子数据触发条件(修复问题 3)的回归测试:
 *   旧逻辑:每次启动发现 books 表为空就重新播种 —— 用户删光所有书后,
 *           下次 pm2 restart 会把 17 本示例书整批塞回来。
 *   新逻辑:播种只看**打开之前库文件是否存在**(全新库才种);
 *           老库哪怕被清空也保持空着。
 * ============================================================ */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDb } = require('../src/db/index.js');

const tmpDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-seed-test-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const countBooks = (db) => db.prepare('SELECT COUNT(*) AS n FROM books').get().n;

test('全新库:首次打开播种 17 本', () => {
  const dir = tempDir();
  const db = openDb(dir, { seedDemo: true });
  assert.equal(countBooks(db), 17);
  db.close();
});

test('删光所有书后重开(模拟重启):种子不再复活', () => {
  const dir = tempDir();
  const db1 = openDb(dir, { seedDemo: true });
  db1.prepare('DELETE FROM books').run();
  assert.equal(countBooks(db1), 0);
  db1.close();

  // 库文件已存在 → 不是全新库 → 即使表为空也不播种
  const db2 = openDb(dir, { seedDemo: true });
  assert.equal(countBooks(db2), 0, '老库被清空后重启,不应重新播种');
  db2.close();
});

test('正常重开(有数据):数据原样保留', () => {
  const dir = tempDir();
  const db1 = openDb(dir, { seedDemo: true });
  db1.prepare('DELETE FROM books WHERE title != ?').run('三体');
  db1.close();

  const db2 = openDb(dir, { seedDemo: true });
  assert.equal(countBooks(db2), 1, '只保留的书不受重启影响');
  db2.close();
});

test('空库文件(0 字节占位)也视为已存在:不播种', () => {
  // 边界:库文件存在但从未写过数据(例如上次启动在迁移前崩溃)。
  // 迁移照常建表;播种条件是"文件此前不存在",所以这里不种 ——
  // 宁可空书架,也不在残缺现场凭空造数据。
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'books.db'), '');
  const db = openDb(dir, { seedDemo: true });
  assert.equal(countBooks(db), 0);
  db.close();
});
