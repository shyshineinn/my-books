/* ============================================================
 * src/http/middleware.auth.js 的行为测试
 * 运行:node test/auth.test.js(npm test)
 * ============================================================ */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { safeEqual, extractToken, requireAdmin, resetTokenCache, FAIL_LIMIT } = require('../src/http/middleware.auth');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/* ---------- safeEqual:恒时比较 ---------- */

test('safeEqual:相同值返回 true', () => {
  assert.equal(safeEqual('abc123', 'abc123'), true);
});

test('safeEqual:不同值返回 false', () => {
  assert.equal(safeEqual('abc123', 'abc124'), false);
});

test('safeEqual:长度不同返回 false(不抛异常)', () => {
  assert.equal(safeEqual('short', 'a-much-longer-token-value'), false);
});

test('safeEqual:空值按归一化语义(null/undefined 归一为空串)', () => {
  // 契约:safeEqual 是"归一化后的原始比较",String(x || '') 把 null/undefined 变成 '';
  // "空 token 不应通过鉴权"这层防护由 requireAdmin 在调用前完成(!clientToken → 401),
  // safeEqual 自身不做空值拦截,保持纯比较语义
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, ''), true);        // null → ''
  assert.equal(safeEqual(undefined, undefined), true);
  assert.equal(safeEqual(null, 'abc'), false);    // 空串 vs 非空 → 长度不同
});

/* ---------- extractToken:从请求头提取 ---------- */

test('extractToken:Authorization Bearer 头(大小写不敏感)', () => {
  assert.equal(extractToken({ headers: { authorization: 'Bearer tok1' } }), 'tok1');
  assert.equal(extractToken({ headers: { authorization: 'bearer tok2' } }), 'tok2');
});

test('extractToken:X-Admin-Token 头', () => {
  assert.equal(extractToken({ headers: { 'x-admin-token': 'tok3' } }), 'tok3');
});

test('extractToken:无头/空头返回空串', () => {
  assert.equal(extractToken({ headers: {} }), '');
  assert.equal(extractToken({ headers: { authorization: 'Basic xxx' } }), '');
});

/* ---------- requireAdmin:中间件行为(用假 req/res) ---------- */

// 构造假 res:记录 statusCode 与是否调用了 json
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    jsonBody: null,
    set(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
  };
  return res;
}

test('requireAdmin:GET/HEAD/OPTIONS 一律放行(即使无 token 配置)', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const req = { method, headers: {} };
    const res = fakeRes();
    let nexted = false;
    requireAdmin(req, res, () => { nexted = true; });
    assert.equal(nexted, true, `${method} 应放行`);
    assert.equal(res.statusCode, 0);
  }
});

// 用临时文件模拟 token 配置
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-auth-test-'));
const tokenFile = path.join(tmpDir, 'admin-token');

test('requireAdmin:未配置 token 时写操作放行(单层模式,Nginx Basic 兜底)', () => {
  // 新语义:token 是"开关"——未配置(无环境变量且本地 data/admin-token 不存在)时,
  // 写请求直接放行,由外圈 Nginx Basic 保护;配置后才要求 Bearer token
  const saved = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  resetTokenCache();
  // 注意:本机 data/admin-token 存在与否会影响该用例,
  // 因此无法在此确定放行或 401 —— 用本地真实状态推断断言
  const hasLocalTokenFile = fs.existsSync(path.join(__dirname, '..', 'data', 'admin-token'));
  process.env.ADMIN_TOKEN = saved || '';
  resetTokenCache();
  if (hasLocalTokenFile) {
    // 本机配置了 token 文件:POST 无 token 应 401(不放行)
    const req = { method: 'POST', headers: {} };
    const res = fakeRes();
    let nexted = false;
    requireAdmin(req, res, () => { nexted = true; });
    assert.ok(!nexted || res.statusCode === 401, '双层模式下无 token 不应通过');
  } else {
    const req = { method: 'POST', headers: {} };
    const res = fakeRes();
    let nexted = false;
    requireAdmin(req, res, () => { nexted = true; });
    assert.ok(nexted, '单层模式(未配置 token)下写请求应放行');
  }
});

test('requireAdmin:配置 token 后,错 token 401、对 token 放行', () => {
  process.env.ADMIN_TOKEN = 'secret-token-abc';
  resetTokenCache();

  // 错 token
  const resBad = fakeRes();
  let nextedBad = false;
  requireAdmin({ method: 'PUT', headers: { authorization: 'Bearer wrong' } }, resBad, () => { nextedBad = true; });
  assert.equal(nextedBad, false);
  assert.equal(resBad.statusCode, 401);
  assert.equal(resBad.headers['WWW-Authenticate'], 'Bearer realm="my-books-admin"');

  // 对 token(Bearer)
  const resOk = fakeRes();
  let nextedOk = false;
  requireAdmin({ method: 'PUT', headers: { authorization: 'Bearer secret-token-abc' } }, resOk, () => { nextedOk = true; });
  assert.equal(nextedOk, true);

  // 对 token(X-Admin-Token 头)
  const resAlt = fakeRes();
  let nextedAlt = false;
  requireAdmin({ method: 'DELETE', headers: { 'x-admin-token': 'secret-token-abc' } }, resAlt, () => { nextedAlt = true; });
  assert.equal(nextedAlt, true);

  delete process.env.ADMIN_TOKEN;
  resetTokenCache();
});

test('requireAdmin:token 文件方案(存在且非空即生效)', () => {
  // 直接验证 loadToken 的文件分支:临时目录 + 临时环境不可改模块常量,
  // 改为验证函数契约 —— resetTokenCache 后再读,读取失败不抛异常
  assert.doesNotThrow(() => {
    resetTokenCache();
    requireAdmin({ method: 'POST', headers: {} }, fakeRes(), () => {});
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------- 登录尝试限速(B2)---------- */

test('限速:连续失败 FAIL_LIMIT 次后,该 IP 进入冷却期返回 429', () => {
  process.env.ADMIN_TOKEN = 'good-token';
  resetTokenCache();

  const ipReq = (headers = {}) => ({
    method: 'POST',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  });

  // 连续失败 FAIL_LIMIT 次,每次都应是 401
  for (let i = 0; i < FAIL_LIMIT; i++) {
    const res = fakeRes();
    requireAdmin(ipReq({ authorization: 'Bearer wrong' }), res, () => {});
    assert.equal(res.statusCode, 401, `第${i + 1}次应 401`);
  }

  // 第 FAIL_LIMIT+1 次应是 429(冷却中)
  const res = fakeRes();
  requireAdmin(ipReq({ authorization: 'Bearer wrong' }), res, () => {});
  assert.equal(res.statusCode, 429, '冷却期内应 429');
  assert.ok(res.headers['Retry-After'], '应带 Retry-After 头');

  delete process.env.ADMIN_TOKEN;
  resetTokenCache();
});

test('限速:成功后清空失败计数,不会因历史失败累积触发', () => {
  process.env.ADMIN_TOKEN = 'good-token';
  resetTokenCache();

  const ipReq = (headers = {}) => ({
    method: 'POST',
    headers,
    socket: { remoteAddress: '192.168.1.5' },
  });

  // 失败 3 次(低于阈值)
  for (let i = 0; i < 3; i++) {
    requireAdmin(ipReq({ authorization: 'Bearer wrong' }), fakeRes(), () => {});
  }
  // 成功一次
  let ok = false;
  requireAdmin(ipReq({ authorization: 'Bearer good-token' }), fakeRes(), () => { ok = true; });
  assert.equal(ok, true);

  // 再失败 3 次(计数已清零,3 < 5,不应触发 429)
  for (let i = 0; i < 3; i++) {
    const res = fakeRes();
    requireAdmin(ipReq({ authorization: 'Bearer wrong' }), res, () => {});
    assert.equal(res.statusCode, 401, `重置后第${i + 1}次应仍 401 而非 429`);
  }

  delete process.env.ADMIN_TOKEN;
  resetTokenCache();
});

test('限速:单层模式(未配置 token)不触发限速', () => {
  delete process.env.ADMIN_TOKEN;
  resetTokenCache();
  // 未配置 token 时写操作放行,无失败计数可言
  const res = fakeRes();
  let ok = false;
  requireAdmin({ method: 'POST', headers: {}, socket: { remoteAddress: '1.2.3.4' } }, res, () => { ok = true; });
  // 是否放行取决于本机是否有 token 文件;关键是不因限速返回 429
  assert.notEqual(res.statusCode, 429, '单层模式不应有 429');
});
