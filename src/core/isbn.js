/* ============================================================
 * ISBN 校验与归一化(纯函数,对标 calibre)
 *
 * 逐行移植 calibre ebooks/metadata/__init__.py:
 *   · check_isbn     (435-452):去非 [0-9X] 字符、长度必须 10/13、
 *                     拒绝全同数字、校验位算法验证
 *   · normalize_isbn (455-464):ISBN-10 → 978 前缀 + 重算校验位 → ISBN-13
 *   · check_digit_for_isbn10 (411-413):权重 1..9,mod 11,10 = 'X'
 *   · check_digit_for_isbn13 (416-420):交替权重 1/3,10 - sum%10,10→0
 *
 * 用途:「按 ISBN 添加」链路 —— 手输/扫码得到的是裸数字串,必须在
 * 建档前校验(扫错的条码、抄错的数字不能静默进库)并按需归一化,
 * 否则同一本书的 ISBN-10 / ISBN-13 两副面孔会绕过查重。
 *
 * 与 calibre 一致的取舍:非法输入不抛异常、不猜,明确返回 null
 * (normalizeIsbn 对非法输入原样返回,与 calibre 同语义)。
 * ============================================================ */

// ISBN-10 校验位:权重 1..9 加权和 mod 11(calibre check_digit_for_isbn10)
function checkDigitForIsbn10(isbn) {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (i + 1) * Number(isbn[i]);
  const check = sum % 11;
  return check === 10 ? 'X' : String(check);
}

// ISBN-13 校验位:交替权重 1/3,10 - sum%10(== 10 时进位成 0)(calibre check_digit_for_isbn13)
function checkDigitForIsbn13(isbn) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(isbn[i]);
  let check = 10 - (sum % 10);
  if (check === 10) check = 0;
  return String(check);
}

// 清理 + 校验。合法返回干净串(13 位或含 X 的 10 位),否则 null。
// 等价 calibre check_isbn 默认分支:re.sub(r'[^0-9X]', '', isbn.upper())
function checkIsbn(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const isbn = String(raw).toUpperCase().replace(/[^0-9X]/g, '');
  const len = isbn.length;
  if (len !== 10 && len !== 13) return null;
  if (/^(\d)\1{9,12}$/.test(isbn)) return null; // 9876543210123 这类"全同数字"不是合法条码
  // Number('X') = NaN 使加权和为 NaN,比较必然不等 → 等价 calibre 的 except → False
  if (len === 10) return checkDigitForIsbn10(isbn) === isbn[9] ? isbn : null;
  return checkDigitForIsbn13(isbn) === isbn[12] ? isbn : null;
}

// ISBN-10 → ISBN-13(978 + 前 9 位 + 重算校验位)。
// 非法输入原样返回(字符串化),与 calibre normalize_isbn 同语义 ——
// 调用方拿它做展示/存储前,应先用 checkIsbn 判断合法性
function normalizeIsbn(raw) {
  const isbn = checkIsbn(raw);
  if (!isbn) return raw === null || raw === undefined ? '' : String(raw);
  if (isbn.length === 10) {
    const base = '978' + isbn.slice(0, 9);
    return base + checkDigitForIsbn13(base);
  }
  return isbn;
}

// 查重比较键(本项目新增,calibre 用 normalize_isbn 两边归一后比对):
//   合法值 → 13 位;非法存量值 → 去分隔符大写兜底。
// 两边同规则计算,所以连字符/空格/大小写差异、ISBN-10 与对应 ISBN-13
// 都会归到同一个键 —— 「扫到 13 位,库里存的是 10 位」不会漏判重复。
// 兜底只去分隔符(空白/连字符等),**保留字母** —— 剥字母会让 abc-123
// 与 123 撞成同一个键(测试逮到过)。
function isbnKey(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  return normalizeIsbn(s).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

module.exports = { checkIsbn, normalizeIsbn, isbnKey, checkDigitForIsbn10, checkDigitForIsbn13 };
