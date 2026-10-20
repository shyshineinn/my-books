/* ============================================================
 * CSV 序列化(纯函数,无 I/O)
 *
 * 对标 calibre 的 Catalog → CSV(library/catalogs/csv_xml.py):
 *   · 文件头写 UTF-8 BOM,Excel 打开中文不乱码
 *   · 字段按 RFC 4180 转义:含逗号/引号/换行时加引号,内部引号翻倍
 *   · 行尾用 CRLF(Excel 在 Windows 上最稳)
 *   · 以 = + - @ 开头的单元格做公式注入防护(Excel/WPS 会执行公式)
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

module.exports = { toCsv, escapeCell };
