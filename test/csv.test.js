/* ============================================================
 * CSV 序列化测试:转义 / BOM / CRLF / 公式注入防护
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');

const { toCsv, escapeCell } = require('../src/core/csv');

test('toCsv:UTF-8 BOM + CRLF + 表头与数据行', () => {
  const out = toCsv(['title', 'author'], [['三体', '刘慈欣']]);
  assert.equal(out, '\uFEFFtitle,author\r\n三体,刘慈欣\r\n');
});

test('toCsv:可以关闭 BOM;空数据也保留表头', () => {
  assert.equal(toCsv(['a', 'b'], [], { bom: false }), 'a,b\r\n');
});

test('escapeCell:逗号 / 引号 / 换行按 RFC 4180 转义', () => {
  assert.equal(escapeCell('a,b'), '"a,b"');
  assert.equal(escapeCell('a"b'), '"a""b"');
  assert.equal(escapeCell('a\nb'), '"a\nb"');
  assert.equal(escapeCell('a\r\nb'), '"a\r\nb"');
});

test('escapeCell:只在必要时加引号,保留首尾空格语义', () => {
  assert.equal(escapeCell('三体'), '三体');
  assert.equal(escapeCell(' 三体'), '" 三体"');
  assert.equal(escapeCell('三体 '), '"三体 "');
  assert.equal(escapeCell(''), '');
  assert.equal(escapeCell(null), '');
  assert.equal(escapeCell(undefined), '');
});

test('escapeCell:公式注入前缀单引号,并转义引号', () => {
  assert.equal(escapeCell('=1+1'), "'=1+1");
  assert.equal(escapeCell('+SUM(A1)'), "'+SUM(A1)");
  assert.equal(escapeCell('-5'), "'-5");
  assert.equal(escapeCell('@cmd'), "'@cmd");
  assert.equal(escapeCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
});
