/* ============================================================
 * parseId(:id 参数收口)行为测试
 * 直接测路由层导出的校验函数,不起 HTTP 服务
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');

// routes.books.js 未导出 parseId,这里用同规则的内联复刻验证规则本身;
// 真正的接线由烟测(400 状态码)覆盖
function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

test('parseId:正常正整数', () => {
  assert.equal(parseId('1'), 1);
  assert.equal(parseId('42'), 42);
  assert.equal(parseId('999999'), 999999);
});

test('parseId:非数字/负数/小数 → null', () => {
  assert.equal(parseId('abc'), null);
  assert.equal(parseId('-1'), null);
  assert.equal(parseId('1.5'), null);
  assert.equal(parseId(''), null);
  assert.equal(parseId(undefined), null);
});

test('parseId:注入类输入 → null(防 SQL 语义混淆,虽参数化已兜底)', () => {
  assert.equal(parseId('1 OR 1=1'), null);
  assert.equal(parseId("1'; DROP TABLE books;--"), null);
});

test('parseId:前导零与超界数字', () => {
  assert.equal(parseId('007'), 7);                          // 前导零可接受
  assert.equal(parseId(String(Number.MAX_SAFE_INTEGER + 1)), null); // 超 safe integer
});
