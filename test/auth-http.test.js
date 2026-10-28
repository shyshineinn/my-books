const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createAuthStore } = require('../src/db/auth');
test('全新私有部署：初始化、网页 cookie、安卓 Bearer、文件保护与设备撤销', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-http-'));
  fs.mkdirSync(path.join(root, 'books-files'));
  fs.writeFileSync(path.join(root, 'books-files', 'fixture.txt'), 'private file');
  const store = createAuthStore(path.join(root, 'data', 'auth.json'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ADMIN_TOKEN: '',
      MYBOOKS_STORAGE_DIR: root, MYBOOKS_PUBLIC_READ: 'false', MYBOOKS_SEED_DEMO: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (data) => { log += data; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务器启动超时：' + log)), 15000);
      child.once('exit', () => { clearTimeout(timer); reject(new Error('服务器退出：' + log)); });
      child.stdout.on('data', (chunk) => {
        const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
      });
    });
    assert.equal((await fetch(base + '/api/books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
    await store.initialize('admin', 'integration-password');
    assert.equal((await fetch(base + '/api/books')).status, 401);
    assert.equal((await fetch(base + '/books-files/fixture.txt')).status, 401);
    assert.equal((await fetch(base + '/api/v1/auth/status')).status, 200);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'integration-password', device_name: 'android' }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
    const session = await login.json();
    const headers = { Authorization: 'Bearer ' + session.token };
    assert.deepEqual(await (await fetch(base + '/api/books', { headers })).json(), []);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/books', { headers: { Cookie: cookie } })).status, 200);
    const created = await (await fetch(base + '/api/books', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '版本检查' }) })).json();
    assert.ok(created.revision > 0);
    assert.equal((await fetch(base + '/api/sync/books?q=filtered', { headers })).status, 400);
    const snapshot = await (await fetch(base + '/api/v1/sync/books', { headers })).json();
    assert.equal(snapshot.sync_version, 2);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.books[0].revision, created.revision);
    const changed = await (await fetch(base + '/api/books/' + created.id, { method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '修改后', expected_revision: created.revision, expected_uuid: created.uuid }) })).json();
    assert.ok(changed.revision > created.revision);
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const stale = await fetch(base + '/api/books/' + created.id, { method,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '旧修改', expected_revision: created.revision, expected_uuid: created.uuid }) });
      assert.equal(stale.status, 409, method + ' 必须拒绝旧版本');
      assert.equal((await stale.json()).current.revision, changed.revision);
    }
    const deleted = await fetch(base + '/api/books/' + created.id, { method: 'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: changed.revision, expected_uuid: created.uuid }) });
    assert.equal(deleted.status, 200);
    const deletedSnapshot = await (await fetch(base + '/api/sync/books', { headers })).json();
    assert.equal(deletedSnapshot.books.length, 0);
    assert.equal(deletedSnapshot.deleted[0].uuid, created.uuid);
    assert.equal((await fetch(base + '/api/books/' + created.id + '/restore', { method: 'POST', headers })).status, 200);
    assert.equal((await (await fetch(base + '/api/sync/books', { headers })).json()).deleted.length, 0);
    const file = await fetch(base + '/books-files/fixture.txt', { headers });
    assert.match(file.headers.get('cache-control'), /no-store/);
    assert.equal(await file.text(), 'private file');
    assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.test' } })).status, 403);
    const devices = await (await fetch(base + '/api/auth/devices', { headers })).json();
    assert.equal(devices[0].label, 'android');
    assert.equal((await fetch(base + '/api/auth/devices/' + session.id, { method: 'DELETE', headers })).status, 204);
    assert.equal((await fetch(base + '/api/books', { headers })).status, 401);
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
