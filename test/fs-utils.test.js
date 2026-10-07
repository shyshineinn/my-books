/* ============================================================
 * src/core/fs-utils.js 的原子写测试
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { atomicWrite } = require('../src/core/fs-utils');

// 每个测试用独立临时目录:清理必须绑在测试里执行。
// 注意:不能把 rmSync 写在模块顶层 —— node:test 的 test() 是**先注册后执行**,
// 顶层代码会在所有测试跑之前就执行,等于「先删目录、再跑测试」,
// 结果是每次都往 os.tmpdir() 漏一个空目录(实测漏了 42 个)。
function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-fs-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('atomicWrite:写入后文件内容完整', () => withTmp((tmp) => {
  const p = path.join(tmp, 'a.txt');
  atomicWrite(p, 'hello atomic');
  assert.equal(fs.readFileSync(p, 'utf8'), 'hello atomic');
}));

test('atomicWrite:覆盖已有文件,内容原子替换', () => withTmp((tmp) => {
  const p = path.join(tmp, 'a.txt');
  atomicWrite(p, 'second version');
  atomicWrite(p, 'third version');
  assert.equal(fs.readFileSync(p, 'utf8'), 'third version');
}));

test('atomicWrite:支持 Buffer(封面上传场景)', () => withTmp((tmp) => {
  const p = path.join(tmp, 'img.png');
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  atomicWrite(p, buf);
  assert.deepEqual(fs.readFileSync(p), buf);
}));

test('atomicWrite:自动创建多级目录', () => withTmp((tmp) => {
  const p = path.join(tmp, 'sub', 'dir', 'b.txt');
  atomicWrite(p, 'nested');
  assert.equal(fs.readFileSync(p, 'utf8'), 'nested');
}));

test('atomicWrite:失败时清理临时文件,不留垃圾', () => withTmp((tmp) => {
  // 构造一个必然写入失败的场景:目标是已存在的目录
  const dirAsTarget = path.join(tmp, 'as-dir');
  fs.mkdirSync(dirAsTarget);
  assert.throws(() => atomicWrite(dirAsTarget, 'x'));
  const leftovers = fs.readdirSync(tmp).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '不应残留临时文件');
}));

test('atomicWrite:成功后目录里没有 .tmp- 残留', () => withTmp((tmp) => {
  atomicWrite(path.join(tmp, 'c.txt'), 'clean');
  const leftovers = fs.readdirSync(tmp).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
}));
