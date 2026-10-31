/* ============================================================
 * CSV 序列化测试:转义 / BOM / CRLF / 公式注入防护
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');

const { toCsv, parseCsv, escapeCell, joinList, splitList } = require('../src/core/csv');

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

/* ---------- 一个单元格里的多个值(标签 / 藏书集 / 作者) ---------- */

test('joinList/splitList:名字里带分隔符也能原样回来', () => {
  const names = ['科幻, 悬疑', '带、号', 'A & B', 'C:\\路径'];
  assert.deepEqual(splitList(joinList(names)), names);
  assert.deepEqual(splitList(joinList(names, '、')), names);
  assert.equal(joinList([]), '');
  assert.deepEqual(splitList(''), []);
});

test('joinList:没转义的旧 CSV 照旧按分隔符拆,不认得反斜杠也不吃亏', () => {
  assert.deepEqual(splitList('科幻, 历史、文学；图画'), ['科幻', '历史', '文学', '图画']);
  // 反斜杠后面不是分隔符 = 不是转义,原样保留(Windows 路径、正则串常见)
  assert.deepEqual(splitList('C:\\路径'), ['C:\\路径']);
  assert.deepEqual(splitList('a\\,b'), ['a,b']);
});

test('多值单元格整份往返:toCsv → parseCsv → splitList 结构不变', () => {
  const cell = joinList(['Herbert, Frank', 'Doe, Jane'], '、');
  const text = toCsv(['title', 'author'], [['沙丘', cell]]);
  const parsed = parseCsv(text);
  assert.equal(parsed.headers.indexOf('author'), 1);
  assert.deepEqual(splitList(parsed.rows[0][1]), ['Herbert, Frank', 'Doe, Jane']);
});
