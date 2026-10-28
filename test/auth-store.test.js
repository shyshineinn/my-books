const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAuthStore } = require('../src/db/auth');
const { createAuthMiddleware, sameOrigin } = require('../src/http/middleware.auth');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-accounts-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
test('管理员密码只落哈希，初始化不能覆盖既有账号', async () => {
  const file = path.join(root, 'account.json');
  const store = createAuthStore(file);
  assert.equal(store.initialized(), false);
  await assert.rejects(store.initialize('admin', 'short'));
  await store.initialize('admin', 'long-test-password');
  assert.equal(await store.verifyPassword('admin', 'long-test-password'), true);
  assert.equal(await store.verifyPassword('other', 'long-test-password'), false);
  assert.equal(await store.verifyPassword('admin', 'incorrect'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('long-test-password'), false);
  await assert.rejects(store.initialize('other', 'another-password'), /已初始化/);
});
test('每台设备独立授权，重启后保留，撤销不影响另一设备', () => {
  const file = path.join(root, 'sessions.json');
  const store = createAuthStore(file);
  const a = store.issueSession('phone');
  const b = store.issueSession('browser');
  assert.notEqual(a.token, b.token);
  assert.equal(fs.readFileSync(file, 'utf8').includes(a.token), false);
  const reopened = createAuthStore(file);
  assert.equal(reopened.authenticate(a.token).label, 'phone');
  reopened.revoke(a.id);
  assert.equal(reopened.authenticate(a.token), null);
  assert.ok(reopened.authenticate(b.token));
  assert.equal(JSON.stringify(reopened.listSessions()).includes('tokenHash'), false);
});
test('旧令牌先签发设备会话后，仍能初始化账号并保留设备', async () => {
  const store = createAuthStore(path.join(root, 'legacy.json'));
  const session = store.issueSession('old device');
  await store.initialize('admin', 'long-test-password');
  assert.ok(store.authenticate(session.token));
});
test('损坏的授权文件不能变成可接管的未初始化状态', () => {
  const file = path.join(root, 'broken.json');
  fs.writeFileSync(file, '{}');
  assert.throws(() => createAuthStore(file).initialized());
});
test('cookie 写操作拒绝跨站来源，原生无 Origin 可用', () => {
  assert.equal(sameOrigin({ get: (key) => ({ Origin: 'https://evil.test', host: 'books.test' })[key] }), false);
  assert.equal(sameOrigin({ get: (key) => ({ Origin: 'https://books.test', host: 'books.test' })[key] }), true);
  assert.equal(sameOrigin({}), true);
});
test('新部署默认私有，公开浏览必须显式开启', () => {
  const middleware = createAuthMiddleware({ store: { initialized: () => false, authenticate: () => null }, legacyToken: () => '' });
  const res = { set() {}, status(code) { this.code = code; return this; }, json() {} };
  middleware.requireLibraryAccess({ method: 'GET', headers: {} }, res, () => assert.fail('不能放行'));
  assert.equal(res.code, 503);
});
