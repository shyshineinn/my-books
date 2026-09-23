/* ============================================================
 * 阅读位置规则(core/position.js)行为测试
 * 纯函数,不碰数据库与网络
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parsePosition, parsePdfLocator, pdfLocator, normalizeDevice, normalizeFormat, formatPercent,
} = require('../src/core/position.js');

/* ---------- 正常路径 ---------- */

test('parsePosition:EPUB CFI 上报通过', () => {
  const r = parsePosition({
    format: 'EPUB', device: 'desktop',
    locator: 'epubcfi(/6/4[chap01]!/4/2/2:0)', locator_kind: 'epubcfi', pos_frac: 0.42,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, {
    format: 'EPUB', device: 'desktop',
    locator: 'epubcfi(/6/4[chap01]!/4/2/2:0)', locator_kind: 'epubcfi', pos_frac: 0.42,
  });
});

test('parsePosition:格式名统一大写、设备标识收窄', () => {
  const r = parsePosition({ format: 'epub', device: ' my phone! ', locator: 'epubcfi(/6/4!/4/2)', pos_frac: 0.1 });
  assert.equal(r.ok, true);
  assert.equal(r.values.format, 'EPUB');         // 大写(与 books.file_format 存法一致)
  assert.equal(r.values.device, 'myphone');      // 非法字符被剔除
});

test('parsePosition:PDF 位置 JSON 通过', () => {
  const loc = pdfLocator(37, 120.5);
  const r = parsePosition({ format: 'PDF', device: 'phone', locator: loc, locator_kind: 'pdfpage', pos_frac: 0.18 });
  assert.equal(r.ok, true);
  assert.deepEqual(parsePdfLocator(r.values.locator), { page: 37, offsetY: 120.5 });
});

test('parsePosition:locator_kind 缺省为 epubcfi', () => {
  const r = parsePosition({ format: 'EPUB', device: 'd', locator: 'epubcfi(/6/4!/4/2)', pos_frac: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.values.locator_kind, 'epubcfi');
});

/* ---------- 坐标与解释方式必须匹配 ---------- */

test('parsePosition:kind=epubcfi 但 locator 不是 CFI 串 → 拒绝', () => {
  const r = parsePosition({ format: 'EPUB', device: 'd', locator: '{"page":3}', locator_kind: 'epubcfi', pos_frac: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /epubcfi/);
});

test('parsePosition:kind=pdfpage 但 locator 不是合法 JSON → 拒绝', () => {
  const r = parsePosition({ format: 'PDF', device: 'd', locator: 'epubcfi(/6/4)', locator_kind: 'pdfpage', pos_frac: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON/);
});

test('parsePosition:pdfpage 的 page 必须是正整数', () => {
  for (const bad of ['{"page":0}', '{"page":-3}', '{"page":"x"}', '{"page":1.5}', '{"offsetY":10}']) {
    const r = parsePosition({ format: 'PDF', device: 'd', locator: bad, locator_kind: 'pdfpage', pos_frac: 0 });
    assert.equal(r.ok, false, `应拒绝 ${bad}`);
  }
});

/* ---------- 必填与边界 ---------- */

test('parsePosition:缺 format/device/locator 各自报错', () => {
  assert.equal(parsePosition({ device: 'd', locator: 'epubcfi(/6/4)' }).ok, false);
  assert.equal(parsePosition({ format: 'EPUB', locator: 'epubcfi(/6/4)' }).ok, false);
  assert.equal(parsePosition({ format: 'EPUB', device: 'd' }).ok, false);
  assert.equal(parsePosition({}).ok, false);
  assert.equal(parsePosition(null).ok, false);
});

test('parsePosition:非法 locator_kind 被拒', () => {
  const r = parsePosition({ format: 'EPUB', device: 'd', locator: 'epubcfi(/6/4)', locator_kind: 'magic' });
  assert.equal(r.ok, false);
  assert.match(r.error, /定位方式/);
});

test('parsePosition:locator 超长被拒(防滥用)', () => {
  const r = parsePosition({
    format: 'EPUB', device: 'd',
    locator: 'epubcfi(' + 'x'.repeat(2500) + ')', pos_frac: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /过长/);
});

test('parsePosition:pos_frac 越界被夹到 0~1,非法归 0 但不拒整次上报', () => {
  const g = (f) => parsePosition({ format: 'EPUB', device: 'd', locator: 'epubcfi(/6/4)', pos_frac: f });
  assert.equal(g(1.7).values.pos_frac, 1);
  assert.equal(g(-0.5).values.pos_frac, 0);
  assert.equal(g('abc').values.pos_frac, 0);
  assert.equal(g(undefined).values.pos_frac, 0);
  assert.equal(g(0.5).values.pos_frac, 0.5);
  // 即使 pos_frac 非法,整体仍应通过(进度提示是次要信息)
  assert.equal(g('abc').ok, true);
});

/* ---------- 辅助函数 ---------- */

test('pdfLocator:规范化页码与偏移', () => {
  assert.deepEqual(parsePdfLocator(pdfLocator(1)), { page: 1, offsetY: 0 });
  assert.deepEqual(parsePdfLocator(pdfLocator(3.7, -5)), { page: 3, offsetY: 0 });
  assert.deepEqual(parsePdfLocator(pdfLocator(0)), { page: 1, offsetY: 0 });
});

test('normalizeFormat / normalizeDevice:边界', () => {
  assert.equal(normalizeFormat('  pdf '), 'PDF');
  assert.equal(normalizeFormat(''), '');
  assert.equal(normalizeFormat(null), '');
  assert.equal(normalizeDevice('a b/c'), 'abc');
  assert.equal(normalizeDevice(''), '');
  assert.equal(normalizeDevice('x'.repeat(100)).length, 64);
});

test('formatPercent:进度文案', () => {
  assert.equal(formatPercent(0.4231), '42%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(1.5), '100%');
  assert.equal(formatPercent(-1), '0%');
  assert.equal(formatPercent(NaN), '0%');
  assert.equal(formatPercent(0.005), '1%');
});
