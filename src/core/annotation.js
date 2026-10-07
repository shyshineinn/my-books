/* ============================================================
 * 注释规则(纯函数,不碰 I/O)
 *
 * 两类注释:
 *   bookmark  —— 书签,只有一个位置(start_locator),end_locator 必须为空
 *   highlight —— 高亮,必须是一个区间(start ≠ end);「批注」= note 非空的 highlight
 *
 * 为什么是两类而不是三类:
 *   calibre 的实际模型只有 bookmark / highlight 两种(其 field_map 见
 *   db/annotations.py 与 pyj/read_book/annotations.pyj),批注是挂在 highlight
 *   上的 notes 字段。拆成三类会产生「没有区间的高亮」这种含糊状态。
 *   要表达「不挂在任何文字上的独立批注」,用 start === end 的 highlight 即可。
 *
 * 与 read_positions 的关键差异:注释表**没有 device 维度**。
 *   位置是「这台设备读到哪」所以要按设备分区;注释是内容资产,应当跨设备共享
 *   (calibre 同样:annotations 同步,last-read 按 device 分行)。
 *
 * 依赖方向纪律:本目录不 import 任何项目内模块(与 position.js 同一规则,
 *   见 core/book.js 顶部注释)。因此 format 归一化与 locator 形状判断在这里
 *   各写了一份最小实现,并由 test/annotation.test.js 的
 *   「与 core/position.js 行为一致」用例钉死,防止两处实现漂移。
 * ============================================================ */

const ANNOT_TYPES = ['bookmark', 'highlight'];
// 5 种内置配色,对齐 calibre 的 yellow/green/blue/red/purple(见其 highlights 模块)
const ANNOT_COLORS = ['yellow', 'green', 'blue', 'red', 'purple'];
const DEFAULT_COLOR = 'yellow';

const MAX_LOCATOR_LEN = 2000;   // CFI 串可能很长;与 core/position.js 同值
const MAX_TEXT_LEN = 4000;      // 被高亮的原文
const MAX_NOTE_LEN = 8000;      // 批注正文
const MAX_CHAPTER_LEN = 200;
const MAX_ANNOT_ID_LEN = 64;

// 与 core/position.js 的 LOCATOR_KINDS 保持一致(有测试钉住)
const LOCATOR_KINDS = ['epubcfi', 'pdfpage'];

/* ---------- 与 core/position.js 重复的最小实现(见文件头说明)---------- */

// 规范化格式名:大写(与 books.file_format / read_positions.format 的存法一致)
function normalizeFormat(raw) {
  return String(raw ?? '').trim().toUpperCase().slice(0, 16);
}

// 由 locator 的形状推断解释方式;无法识别返回 ''
function locatorKindOf(locator) {
  const s = String(locator ?? '').trim();
  if (!s) return '';
  if (/^epubcfi\(/.test(s)) return 'epubcfi';
  try {
    const o = JSON.parse(s);
    if (o && typeof o === 'object') {
      const page = Number(o.page);
      if (Number.isInteger(page) && page >= 1) return 'pdfpage';
    }
  } catch { /* 不是 JSON */ }
  return '';
}

/* ---------- 校验 ---------- */

function bad(error) {
  return { ok: false, error, code: 'VALIDATION' };
}

// 校验单个 locator:非空、不超长、形状可识别,且与声明的 kind 一致
function checkLocator(locator, declaredKind, label) {
  const s = String(locator ?? '').trim();
  if (!s) return { error: `缺少${label}` };
  if (s.length > MAX_LOCATOR_LEN) return { error: `${label}过长(上限 ${MAX_LOCATOR_LEN} 字符)` };
  const inferred = locatorKindOf(s);
  if (!inferred) {
    return { error: `${label}格式无法识别(应为 epubcfi(...) 串或 {"page":n,...} 的 JSON)` };
  }
  if (declaredKind && declaredKind !== inferred) {
    return { error: `locator_kind=${declaredKind} 与${label}的实际形状(${inferred})不匹配` };
  }
  return { value: s, kind: inferred };
}

/*
 * 校验并规范化一条注释。
 * 返回 { ok:true, values } 或 { ok:false, error, code }(与 core/position.js 同形状)。
 *
 * 入参 body:
 *   format        必填
 *   annot_type    必填,bookmark | highlight
 *   annot_id      必填(幂等键;由客户端生成,服务端不代生成以保持本函数确定性)
 *   start_locator 必填
 *   end_locator   bookmark 必须为空;highlight 必填且 ≠ start
 *   locator_kind  可选;给出则必须与 locator 实际形状一致
 *   text / note / color / chapter 可选
 */
function parseAnnotation(body) {
  const b = body && typeof body === 'object' ? body : {};

  const format = normalizeFormat(b.format);
  if (!format) return bad('缺少格式(format)');

  const annotType = String(b.annot_type ?? '').trim().toLowerCase();
  if (!ANNOT_TYPES.includes(annotType)) {
    return bad(`注释类型不合法(支持:${ANNOT_TYPES.join(' / ')})`);
  }

  const annotId = String(b.annot_id ?? '').trim();
  if (!annotId) return bad('缺少注释标识(annot_id)');
  if (annotId.length > MAX_ANNOT_ID_LEN) return bad(`注释标识过长(上限 ${MAX_ANNOT_ID_LEN} 字符)`);
  if (!/^[A-Za-z0-9_-]+$/.test(annotId)) {
    return bad('注释标识只允许字母、数字、连字符与下划线');
  }

  // 声明了 kind 就先校验它本身合法,再逐字段比对形状
  const declaredKind = String(b.locator_kind ?? '').trim().toLowerCase();
  if (declaredKind && !LOCATOR_KINDS.includes(declaredKind)) {
    return bad(`定位方式不合法(支持:${LOCATOR_KINDS.join(' / ')})`);
  }

  const start = checkLocator(b.start_locator, declaredKind, '位置(start_locator)');
  if (start.error) return bad(start.error);
  const kind = start.kind;

  /*
   * 区间(end_locator)的语义 —— 有意保持宽松,原因如下:
   *
   * epub.js 的 'selected' 事件给出的是**一个区间 CFI 串**
   * (形如 epubcfi(/6/4!/4/2,/1:0,/1:10)),而 annotations.add() 也正是
   * 接受这一个串。也就是说「高亮」在 epub.js 侧只有一个 locator,
   * 不需要(也不应)由我们拆成两个点。
   *
   * 因此约定:start_locator 存「该怎样渲染就怎样渲染」的那个串 ——
   *   书签   = 点 CFI
   *   高亮   = 区间 CFI(或不带区间信息的点,取 epub.js 实际给的形状)
   * end_locator 保留给「显式给出两个端点」的场景(例如后续 PDF 的归一化坐标
   * 区间),非必填。
   *
   * 刻意不在本层强制「高亮必须有 end_locator」:那会把一个尚未实测确认的
   * 假设写进 schema 与校验规则。真实的 cfiRange 形状要在 3b 用 Chrome CDP
   * 抓样本确认后,再决定是否收紧(见 P3 方案 §5.5)。
   */
  const rawEnd = String(b.end_locator ?? '').trim();
  let endLocator = '';
  if (annotType === 'bookmark') {
    // 书签是「一个位置」,带上终点说明调用方语义搞错了
    if (rawEnd) return bad('书签不能带区间终点(end_locator 应为空)');
  } else if (rawEnd) {
    const end = checkLocator(rawEnd, declaredKind, '区间终点(end_locator)');
    if (end.error) return bad(end.error);
    if (end.value === start.value) return bad('区间终点不能等于起点');
    endLocator = end.value;
  }

  // text 是被高亮的原文(书籍内容的副本),超长按项目既有风格截断(同 core/book.js 的 summary)
  const text = String(b.text ?? '').slice(0, MAX_TEXT_LEN);
  // note 是用户自己写的字,超长**拒绝**而不是悄悄截断 —— 静默丢用户内容是数据丢失路径
  const note = String(b.note ?? '');
  if (note.length > MAX_NOTE_LEN) {
    return bad(`批注过长(上限 ${MAX_NOTE_LEN} 字符,当前 ${note.length})`);
  }
  const chapter = String(b.chapter ?? '').trim().slice(0, MAX_CHAPTER_LEN);

  // 配色:不在白名单则归默认,不因此拒掉整条注释(配色是次要信息)
  const rawColor = String(b.color ?? '').trim().toLowerCase();
  const color = ANNOT_COLORS.includes(rawColor) ? rawColor : DEFAULT_COLOR;

  return {
    ok: true,
    values: {
      format,
      annot_type: annotType,
      annot_id: annotId,
      locator_kind: kind,
      start_locator: start.value,
      end_locator: endLocator,
      text,
      note,
      color,
      chapter,
    },
  };
}

/*
 * 局部更新语义:只允许改 note / color / chapter。
 * 位置与区间不可改 —— 改了就是另一条注释,应当删旧建新(避免"高亮悄悄移位")。
 * 返回 { ok:true, values } 或 { ok:false, error, code },与 parseAnnotation 同形状
 * (同一条"批注过长要报错而非截断"的规则,必须在这里也生效)。
 */
function mergeAnnotationUpdate(existing, body) {
  const b = body && typeof body === 'object' ? body : {};
  const merged = { ...existing };
  if ('note' in b) {
    const n = String(b.note ?? '');
    if (n.length > MAX_NOTE_LEN) {
      return bad(`批注过长(上限 ${MAX_NOTE_LEN} 字符,当前 ${n.length})`);
    }
    merged.note = n;
  }
  if ('color' in b) {
    const c = String(b.color ?? '').trim().toLowerCase();
    merged.color = ANNOT_COLORS.includes(c) ? c : existing.color;
  }
  // 章名随正文改动一起更新是合理需求(例如手动归章),但仍不接受位置变更
  if ('chapter' in b) merged.chapter = String(b.chapter ?? '').trim().slice(0, MAX_CHAPTER_LEN);
  return { ok: true, values: merged };
}

module.exports = {
  ANNOT_TYPES,
  ANNOT_COLORS,
  DEFAULT_COLOR,
  LOCATOR_KINDS,
  MAX_LOCATOR_LEN,
  MAX_TEXT_LEN,
  MAX_NOTE_LEN,
  MAX_CHAPTER_LEN,
  MAX_ANNOT_ID_LEN,
  normalizeFormat,
  locatorKindOf,
  parseAnnotation,
  mergeAnnotationUpdate,
};
