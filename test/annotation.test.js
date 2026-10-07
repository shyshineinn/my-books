/* ============================================================
 * 注释规则(core/annotation.js)行为测试
 * 纯函数,不碰数据库与网络
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseAnnotation, mergeAnnotationUpdate, locatorKindOf, normalizeFormat,
  ANNOT_TYPES, ANNOT_COLORS, LOCATOR_KINDS, MAX_NOTE_LEN, MAX_TEXT_LEN,
  MAX_LOCATOR_LEN, MAX_ANNOT_ID_LEN,
} = require('../src/core/annotation.js');
const position = require('../src/core/position.js');

// 真实的 epub.js 形状:点 CFI 与区间 CFI
const POINT_CFI = 'epubcfi(/6/4[chap01]!/4/2/2:0)';
const RANGE_CFI = 'epubcfi(/6/4[chap01]!/4/2,/1:0,/1:10)';
const PDF_LOC = '{"page":37,"offsetY":120}';

const bookmark = (over = {}) => ({
  format: 'EPUB', annot_type: 'bookmark', annot_id: 'bm-1', start_locator: POINT_CFI, ...over,
});
const highlight = (over = {}) => ({
  format: 'EPUB', annot_type: 'highlight', annot_id: 'hl-1', start_locator: RANGE_CFI, color: 'green', ...over,
});

/* ---------- 正常路径 ---------- */

test('parseAnnotation:书签通过(点 CFI,无区间终点)', () => {
  const r = parseAnnotation(bookmark());
  assert.equal(r.ok, true);
  assert.equal(r.values.annot_type, 'bookmark');
  assert.equal(r.values.start_locator, POINT_CFI);
  assert.equal(r.values.end_locator, '');
  assert.equal(r.values.locator_kind, 'epubcfi');   // 由形状推断
  assert.equal(r.values.color, 'yellow');           // 缺省配色
});

test('parseAnnotation:高亮通过(epub.js 给的单个区间 CFI)', () => {
  const r = parseAnnotation(highlight());
  assert.equal(r.ok, true);
  assert.equal(r.values.start_locator, RANGE_CFI);
  assert.equal(r.values.end_locator, '', '区间信息在 start_locator 里,不强制拆成两列');
  assert.equal(r.values.color, 'green');
});

test('parseAnnotation:显式给出两个端点也接受(为后续 PDF 坐标区间留路)', () => {
  const r = parseAnnotation(highlight({ start_locator: POINT_CFI, end_locator: RANGE_CFI }));
  assert.equal(r.ok, true);
  assert.equal(r.values.end_locator, RANGE_CFI);
});

test('parseAnnotation:PDF 位置形状可识别', () => {
  const r = parseAnnotation(bookmark({ format: 'PDF', start_locator: PDF_LOC }));
  assert.equal(r.ok, true);
  assert.equal(r.values.locator_kind, 'pdfpage');
});

test('parseAnnotation:格式名统一大写、颜色小写归一', () => {
  const r = parseAnnotation(highlight({ format: ' epub ', color: ' RED ' }));
  assert.equal(r.ok, true);
  assert.equal(r.values.format, 'EPUB');
  assert.equal(r.values.color, 'red');
});

test('parseAnnotation:显式 locator_kind 与形状一致时通过', () => {
  const r = parseAnnotation(highlight({ locator_kind: 'epubcfi' }));
  assert.equal(r.ok, true);
  assert.equal(r.values.locator_kind, 'epubcfi');
});

test('parseAnnotation:chapter / text / note 被保留', () => {
  const r = parseAnnotation(highlight({ chapter: '第一章', text: '被高亮的原文', note: '我的批注' }));
  assert.equal(r.values.chapter, '第一章');
  assert.equal(r.values.text, '被高亮的原文');
  assert.equal(r.values.note, '我的批注');
});

/* ---------- 区间语义 ---------- */

test('parseAnnotation:书签带区间终点 → 拒绝(书签是一个位置)', () => {
  const r = parseAnnotation(bookmark({ end_locator: RANGE_CFI }));
  assert.equal(r.ok, false);
  assert.match(r.error, /书签不能带区间终点/);
});

test('parseAnnotation:区间终点等于起点 → 拒绝', () => {
  const r = parseAnnotation(highlight({ start_locator: POINT_CFI, end_locator: POINT_CFI }));
  assert.equal(r.ok, false);
  assert.match(r.error, /不能等于起点/);
});

/* ---------- 坐标与解释方式必须匹配(与 read_positions 同款收口)---------- */

test('parseAnnotation:kind=epubcfi 但 locator 是 PDF JSON → 拒绝', () => {
  const r = parseAnnotation(bookmark({ start_locator: PDF_LOC, locator_kind: 'epubcfi' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /不匹配/);
});

test('parseAnnotation:kind=pdfpage 但 locator 是 CFI 串 → 拒绝', () => {
  const r = parseAnnotation(bookmark({ start_locator: POINT_CFI, locator_kind: 'pdfpage' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /不匹配/);
});

test('parseAnnotation:非法 locator_kind 被拒', () => {
  const r = parseAnnotation(bookmark({ locator_kind: 'magic' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /定位方式/);
});

test('parseAnnotation:无法识别的 locator 形状 → 拒绝', () => {
  for (const bad of ['', '   ', 'hello', '{"offsetY":10}', '{"page":0}', '{"page":1.5}']) {
    const r = parseAnnotation(bookmark({ start_locator: bad }));
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

/* ---------- 必填与边界 ---------- */

test('parseAnnotation:非法 annot_type 被拒', () => {
  for (const t of ['note', 'underline', '', null, 'BOOKMARKX']) {
    const r = parseAnnotation(bookmark({ annot_type: t }));
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(t)}`);
  }
  // 大小写不敏感:BOOKMARK 归一为 bookmark
  assert.equal(parseAnnotation(bookmark({ annot_type: 'BOOKMARK' })).values.annot_type, 'bookmark');
});

test('parseAnnotation:annot_id 缺失 / 非法字符 / 超长 → 拒绝', () => {
  assert.equal(parseAnnotation(bookmark({ annot_id: '' })).ok, false);
  assert.equal(parseAnnotation(bookmark({ annot_id: undefined })).ok, false);
  for (const bad of ['a b', 'a/b', '中文', 'a.b', 'x'.repeat(MAX_ANNOT_ID_LEN + 1)]) {
    assert.equal(parseAnnotation(bookmark({ annot_id: bad })).ok, false, `应拒绝 ${bad}`);
  }
  // 合法字符集
  assert.equal(parseAnnotation(bookmark({ annot_id: 'Abc-123_x' })).ok, true);
});

test('parseAnnotation:缺 format / start_locator → 拒绝;空 body 与 null 也不炸', () => {
  assert.equal(parseAnnotation({ annot_type: 'bookmark', annot_id: 'a', start_locator: POINT_CFI }).ok, false);
  assert.equal(parseAnnotation({ format: 'EPUB', annot_type: 'bookmark', annot_id: 'a' }).ok, false);
  assert.equal(parseAnnotation({}).ok, false);
  assert.equal(parseAnnotation(null).ok, false);
  assert.equal(parseAnnotation(undefined).ok, false);
});

test('parseAnnotation:locator 超长被拒(防滥用)', () => {
  const r = parseAnnotation(bookmark({ start_locator: 'epubcfi(' + 'x'.repeat(MAX_LOCATOR_LEN + 10) + ')' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /过长/);
});

test('parseAnnotation:非白名单颜色归默认且不拒整条;白名单原样保留', () => {
  const bad = parseAnnotation(highlight({ color: 'chartreuse' }));
  assert.equal(bad.ok, true, '配色是次要信息,不应因此拒掉整条注释');
  assert.equal(bad.values.color, 'yellow');
  for (const c of ANNOT_COLORS) {
    assert.equal(parseAnnotation(highlight({ color: c })).values.color, c);
  }
});

test('parseAnnotation:批注超长 → 拒绝(不静默截断用户写的内容)', () => {
  const r = parseAnnotation(highlight({ note: 'x'.repeat(MAX_NOTE_LEN + 1) }));
  assert.equal(r.ok, false);
  assert.match(r.error, /批注过长/);
  assert.equal(parseAnnotation(highlight({ note: 'x'.repeat(MAX_NOTE_LEN) })).ok, true);
});

test('parseAnnotation:text 超长 → 截断(原文是书籍内容副本,同 core/book.js 的 summary 风格)', () => {
  const r = parseAnnotation(highlight({ text: 'x'.repeat(MAX_TEXT_LEN + 500) }));
  assert.equal(r.ok, true);
  assert.equal(r.values.text.length, MAX_TEXT_LEN);
});

/* ---------- locatorKindOf ---------- */

test('locatorKindOf:点 CFI / 区间 CFI / PDF JSON / 垃圾输入', () => {
  assert.equal(locatorKindOf(POINT_CFI), 'epubcfi');
  assert.equal(locatorKindOf(RANGE_CFI), 'epubcfi');
  assert.equal(locatorKindOf(PDF_LOC), 'pdfpage');
  assert.equal(locatorKindOf('  epubcfi(/6/4)  '), 'epubcfi', '两侧空白应被容忍');
  for (const bad of ['', '   ', 'hello', '[]', 'null', '{"page":"x"}', '{"page":-1}']) {
    assert.equal(locatorKindOf(bad), '', `应识别不了 ${JSON.stringify(bad)}`);
  }
});

/* ---------- 局部更新语义 ---------- */

test('mergeAnnotationUpdate:只改 note/color/chapter,忽略位置与区间字段', () => {
  // existing 的形状与 db 行一致(annotations 表的列),mergeAnnotationUpdate 只在其上改可改字段
  const existing = { id: 7, annot_type: 'highlight', note: '旧', color: 'yellow', chapter: '第一章', start_locator: RANGE_CFI, end_locator: '', text: '原文' };
  const r = mergeAnnotationUpdate(existing, {
    note: '新批注', color: 'blue', chapter: '第二章',
    start_locator: POINT_CFI, end_locator: RANGE_CFI, text: '改原文', annot_type: 'bookmark',
  });
  assert.equal(r.ok, true);
  assert.equal(r.values.note, '新批注');
  assert.equal(r.values.color, 'blue');
  assert.equal(r.values.chapter, '第二章');
  assert.equal(r.values.start_locator, RANGE_CFI, '位置不可改 —— 改了就是另一条注释');
  assert.equal(r.values.text, '原文', '被高亮的原文不可改');
  assert.equal(r.values.annot_type, 'highlight');
  assert.equal(r.values.id, 7);
});

test('mergeAnnotationUpdate:未提供的字段保留旧值', () => {
  const existing = { note: '旧', color: 'green', chapter: '第一章' };
  const r = mergeAnnotationUpdate(existing, {});
  assert.equal(r.values.note, '旧');
  assert.equal(r.values.color, 'green');
  assert.equal(r.values.chapter, '第一章');
});

test('mergeAnnotationUpdate:非法颜色保留旧配色(不拒绝)', () => {
  const r = mergeAnnotationUpdate({ note: '', color: 'green', chapter: '' }, { color: 'chartreuse' });
  assert.equal(r.ok, true);
  assert.equal(r.values.color, 'green');
});

test('mergeAnnotationUpdate:批注超长 → 拒绝(与 parseAnnotation 同一规则)', () => {
  const r = mergeAnnotationUpdate({ note: '', color: 'yellow', chapter: '' }, { note: 'x'.repeat(MAX_NOTE_LEN + 1) });
  assert.equal(r.ok, false);
  assert.match(r.error, /批注过长/);
});

/* ---------- 与 core/position.js 的一致性(本模块有意各写一份最小实现,靠测试防漂移)---------- */

test('一致性:normalizeFormat 与 core/position.js 行为完全一致', () => {
  const samples = [undefined, null, '', '   ', 'epub', ' EPUB ', 'pdf', 'PdF', 'x'.repeat(40), 123, {}, []];
  for (const v of samples) {
    assert.equal(
      normalizeFormat(v), position.normalizeFormat(v),
      `normalizeFormat(${JSON.stringify(v)}) 两处实现应一致`
    );
  }
});

test('一致性:LOCATOR_KINDS 与 core/position.js 相同', () => {
  assert.deepEqual([...LOCATOR_KINDS].sort(), [...position.LOCATOR_KINDS].sort());
});

test('一致性:locatorKindOf 的判定与 position.parsePosition 的接受/拒绝一致', () => {
  // position.parsePosition 只认两种 kind;这里逐样本比对「能否识别」这一判断
  const samples = [POINT_CFI, RANGE_CFI, PDF_LOC, '', 'hello', '{"page":0}', '{"page":2,"offsetY":5}'];
  for (const loc of samples) {
    const kind = locatorKindOf(loc);
    const accepted = ['epubcfi', 'pdfpage'].includes(kind);
    const viaPosition = position.parsePosition({ format: 'EPUB', device: 'd', locator: loc, locator_kind: kind || 'epubcfi', pos_frac: 0 }).ok;
    if (kind) {
      assert.equal(accepted && viaPosition, true, `${loc} 在 position 侧也应被接受`);
    }
  }
});

test('常量:ANNOT_TYPES 恰为两类(批注 = 带 note 的 highlight,不单列类型)', () => {
  assert.deepEqual(ANNOT_TYPES, ['bookmark', 'highlight']);
  assert.ok(!ANNOT_TYPES.includes('note'), '「批注」不是独立类型,而是 highlight 上的 note 字段');
});
