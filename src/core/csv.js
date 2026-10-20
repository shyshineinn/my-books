/* ============================================================
 * CSV 序列化与解析(纯函数,无 I/O)
 *
 * 对标 calibre 的 Catalog → CSV(library/catalogs/csv_xml.py)导出格式:
 *   · 文件头写 UTF-8 BOM,Excel 打开中文不乱码
 *   · 字段按 RFC 4180 转义:含逗号/引号/换行时加引号,内部引号翻倍
 *   · 行尾用 CRLF(Excel 在 Windows 上最稳)
 *   · 以 = + - @ 开头的单元格做公式注入防护(Excel/WPS 会执行公式)
 *
 * 解析侧(parseCsv)是**自己写的**,不用第三方库:
 *   本项目零新增依赖是既有约束;而且 RFC 4180 的状态机很小,
 *   自己写反而能精确处理本项目的两个特性(BOM 剥离、公式前缀还原)。
 *
 * **toCsv 与 parseCsv 必须互逆** —— 导出的文件必须能原样导回来。
 * 这一点由 test/csv.test.js 的往返用例钉死。
 * ============================================================ */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTE = /[",\r\n]/;
const EDGE_SPACE = /^\s|\s$/;

function escapeCell(value) {
  let s = value == null ? '' : String(value);
  // CSV 注入:前缀单引号让 Excel 当文本,而不是执行 =HYPERLINK(...) 之类
  if (FORMULA_PREFIX.test(s)) s = "'" + s;
  if (NEEDS_QUOTE.test(s) || EDGE_SPACE.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsv(headers, rows, { bom = true } = {}) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  return (bom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n';
}

/* ---------- 解析(RFC 4180 状态机) ---------- */

// 单元格反转义:去掉外层引号、内部 "" → ";
// 并还原 toCsv 的公式注入前缀(以 ' 开头且第二字符是 =+-@ 的情况)。
// 为什么要还原:'=HYPERLINK(...)' 导出时变成 "'=HYPERLINK(...)",
// 导回来若不去掉这个单引号,标题就会平白多一个 '。
function unescapeCell(raw) {
  let s = raw;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/""/g, '"');
  }
  // 只在"确实是当初加的前缀"时还原:单引号 + 公式字符
  if (s.length >= 2 && s[0] === "'" && FORMULA_PREFIX.test(s.slice(1))) {
    s = s.slice(1);
  }
  return s;
}

/**
 * 解析 CSV 文本 → { headers, rows }
 *   · 自动剥离 UTF-8 BOM
 *   · 支持 CRLF / LF / CR 三种行尾(Excel、WPS、Unix 各写各的)
 *   · 支持引号内的逗号与换行(简介字段会带换行)
 *   · 跳过完全空白的行(Excel 常在末尾留空行)
 * @param {string} text
 * @returns {{ headers: string[], rows: string[][] }}
 */
function parseCsv(text) {
  let src = String(text == null ? '' : text);
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);   // 剥 BOM

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let i = 0;

  const endField = () => { record.push(unescapeCell(field)); field = ''; };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }  // 转义的双引号
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }

    if (ch === '"') {
      // 引号只在字段开头有意义;字段中部的引号按字面量处理(宽容)
      if (field === '') { inQuotes = true; i += 1; continue; }
      field += ch; i += 1; continue;
    }
    if (ch === ',') { endField(); i += 1; continue; }
    if (ch === '\r') {
      // CRLF 或孤立 CR 都算一个换行
      endRecord();
      i += (src[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    if (ch === '\n') { endRecord(); i += 1; continue; }

    field += ch; i += 1;
  }
  // 收尾:最后一行没有换行符时仍要落一条
  if (field !== '' || record.length) endRecord();

  // 丢掉完全空白的行(全空字段)
  const cleaned = records.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!cleaned.length) return { headers: [], rows: [] };

  const headers = cleaned[0].map((h) => String(h).trim());
  const rows = cleaned.slice(1);
  return { headers, rows };
}

module.exports = { toCsv, parseCsv, escapeCell, unescapeCell };
