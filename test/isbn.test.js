/* ============================================================
 * ISBN 校验 / 归一化测试(src/core/isbn.js,纯函数)
 * 用例对照 calibre check_isbn / normalize_isbn 的边界:
 * 合法 10/13、X 结尾、带连字符空格、校验位错、全同数字、长度错。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const { checkIsbn, normalizeIsbn, isbnKey } = require('../src/core/isbn.js');

test('checkIsbn:合法 ISBN-13 原样返回', () => {
  assert.equal(checkIsbn('9787536692930'), '9787536692930');
  assert.equal(checkIsbn('9787115428028'), '9787115428028');
  assert.equal(checkIsbn('9791090636071'), '9791090636071', '979 前缀也合法');
});

test('checkIsbn:合法 ISBN-10(含 X 结尾)', () => {
  assert.equal(checkIsbn('7536692935'), '7536692935');
  assert.equal(checkIsbn('080442957X'), '080442957X', 'X 是合法校验位');
});

test('checkIsbn:去连字符 / 空格 / 小写 x', () => {
  assert.equal(checkIsbn('7-5366-9293-5'), '7536692935');
  assert.equal(checkIsbn('978 7536 69293 0'), '9787536692930');
  assert.equal(checkIsbn('080442957x'), '080442957X', '小写 x 应转大写');
});

test('checkIsbn:校验位错误返回 null(不静默放行)', () => {
  assert.equal(checkIsbn('9787536692931'), null);
  assert.equal(checkIsbn('7536692934'), null);
});

test('checkIsbn:全同数字 / 长度错 / 空值一律 null', () => {
  assert.equal(checkIsbn('1111111111'), null);
  assert.equal(checkIsbn('1111111111111'), null);
  assert.equal(checkIsbn('123456789'), null, '9 位不是 ISBN');
  assert.equal(checkIsbn('12345678901234'), null, '14 位不是 ISBN');
  assert.equal(checkIsbn(''), null);
  assert.equal(checkIsbn(null), null);
  assert.equal(checkIsbn(undefined), null);
});

test('checkIsbn:X 出现在非校验位 → null(不抛异常)', () => {
  assert.equal(checkIsbn('X806442957'), null);
  assert.equal(checkIsbn('978X53669293X'), null);
});

test('normalizeIsbn:ISBN-10 转 ISBN-13(重算校验位)', () => {
  assert.equal(normalizeIsbn('7536692935'), '9787536692930');
  assert.equal(normalizeIsbn('0-8044-2957-X'), '9780804429573', 'X 结尾的 10 位可转 13 位');
});

test('normalizeIsbn:ISBN-13 与非法输入', () => {
  assert.equal(normalizeIsbn('9787536692930'), '9787536692930');
  assert.equal(normalizeIsbn('abc'), 'abc', '非法输入原样返回(calibre 同语义)');
});

test('isbnKey:ISBN-10 与其 ISBN-13 归到同一个键(查重不漏)', () => {
  assert.equal(isbnKey('7536692935'), isbnKey('9787536692930'));
  assert.equal(isbnKey('978-7536-69293-0'), isbnKey('9787536692930'));
});

test('isbnKey:非法存量值退化为去分隔符大写,两边同规则仍可比较', () => {
  assert.equal(isbnKey('abc-123'), 'ABC123');
  assert.equal(isbnKey(''), '');
  assert.equal(isbnKey(null), '');
});
