/* ============================================================
 * 标识符(identifiers)规则(A5,对标 calibre)
 *
 * calibre 的模型:identifiers(id, book, type, val, UNIQUE(book,type))
 * —— **类型无上限,每类型一个值**(resources/metadata_sqlite.sql:105-110)。
 * isbn 只是其中一个 type,不再是 books 表的列
 * (upgrade 26 把 isbn/lccn 列 drops 掉,schema_upgrades.py:893-894)。
 *
 * 本项目的现状与改造:
 *   改造前 `books` 有固定的 isbn / douban_id 两列 —— 想再加一个标识符
 *   (如 goodreads、豆瓣电影)就得改表结构。本模块把标识符变成
 *   "任意 type + 值"的键值对,要加新类型只需在**数据**里加一行。
 *
 * 归一化规则照抄 calibre db/write.py:118-132 的 clean_identifier:
 *   · type:转小写、去空白、去掉 ':' 与 ','
 *   · val :去空白、',' 换成 '|'
 *
 * 设计取舍:isbn / douban_id **两列保留**。
 *   理由:① 豆瓣抓取与前端表单已经在用,FTS 索引也覆盖它们,
 *        迁移掉会牵动搜索与展示多处(收益低、风险高);
 *   ② 新表 book_identifiers 作为"扩展位",承接任意新类型。
 *   两处并存期间由本模块保证同步:写 isbn/douban_id 时同时写
 *   identifiers 表,读的时候合并输出 —— 这样"加类型"的能力有了,
 *   既有链路零改动(与 v9 归一化 tags/author 时的"派生缓存"同一思路)。
 * ============================================================ */

// 常用标识符类型 → 展示名(未知类型原样显示)
const TYPE_LABELS = {
  isbn: 'ISBN',
  douban: '豆瓣',
  douban_id: '豆瓣',
  amazon: 'Amazon',
  goodreads: 'Goodreads',
  google: 'Google Books',
  openlibrary: 'Open Library',
  doi: 'DOI',
  urn: 'URN',
  issn: 'ISSN',
  asin: 'ASIN',
  url: '网址',
};

// type 归一化:小写、去空白、去 ':' 与 ','(calibre clean_identifier 同款)
const TYPE_RE = /^[a-z0-9_\-.]{1,32}$/;

function cleanType(type) {
  return String(type == null ? '' : type)
    .toLowerCase()
    .trim()
    .replace(/[:,\s]/g, '');
}

// val 归一化:去空白 + ',' → '|'(calibre 同款)
function cleanVal(val) {
  return String(val == null ? '' : val).trim().replace(/,/g, '|');
}

// 校验单个标识符。返回 { ok, type, value, error }。
// 非法 type(空 / 含怪字符)明确报错,不静默丢弃 —— 静默丢弃会让
// "填了却没存上"难以察觉。
function parseIdentifier(type, val) {
  const t = cleanType(type);
  const v = cleanVal(val);
  if (!t && !v) return { ok: true, type: '', value: '', error: '' };  // 全空 = 未填
  if (!t) return { ok: false, type: '', value: '', error: '标识符类型不能为空' };
  if (!TYPE_RE.test(t)) {
    return { ok: false, type: '', value: '', error: `标识符类型「${type}」不合法(只能用小写字母、数字、_ - .)` };
  }
  if (v.length > 200) return { ok: false, type: '', value: '', error: '标识符值过长(≤200 字符)' };
  if (!v) return { ok: true, type: t, value: '', error: '' };         // 类型有、值空 = 删除该标识符
  return { ok: true, type: t, value: v, error: '' };
}

// 把一个 identifiers 对象整体规范化 → { ok, errors, values }
// 入参形如 { isbn: '978...', goodreads: '123' };也接受 "isbn:978" 字符串数组。
function parseIdentifiers(input) {
  const errors = [];
  const values = {};

  let entries = [];
  if (input == null) {
    entries = [];
  } else if (Array.isArray(input)) {
    // ['isbn:978', 'goodreads:123'] 或 [{type,value}]
    entries = input.map((x) => {
      if (x && typeof x === 'object') return [x.type, x.value];
      const s = String(x || '');
      const i = s.indexOf(':');
      return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
    });
  } else if (typeof input === 'object') {
    entries = Object.entries(input);
  } else if (typeof input === 'string') {
    // "isbn:978,goodreads:123"
    entries = String(input).split(/[,;]+/).map((s) => {
      const i = s.indexOf(':');
      return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
    });
  }

  for (const [type, val] of entries) {
    const r = parseIdentifier(type, val);
    if (!r.ok) { errors.push(r.error); continue; }
    if (!r.type) continue;
    // 同类型后者覆盖前者(与 calibre dict 语义一致)。
    // **空值要保留**(写成 '')而不是删掉键 —— 它是"删除该标识符"的信号,
    // 由 db/identifiers.js 的 setIdentifiers 翻成 DELETE。若在这里丢掉键,
    // "把 isbn 清空"就会变成"什么都不做",表里的旧值残留(实测踩过)。
    values[r.type] = r.value;
  }

  return { ok: errors.length === 0, errors, values };
}

// type → 展示名
function typeLabel(type) {
  const t = cleanType(type);
  return TYPE_LABELS[t] || t.toUpperCase();
}

// 标识符 → 可点击的外链(能构造的才给;否则返回 null)
// 对标 calibre Source.get_book_url 的思路:每个源知道自己条目的 URL 形态。
function identifierUrl(type, value) {
  const t = cleanType(type);
  const v = String(value || '').trim();
  if (!v) return null;
  switch (t) {
    case 'isbn':
      // 去掉连字符后拼豆瓣搜索(比 isbnsearch 更贴近中文用户习惯)
      return 'https://book.douban.com/isbn/' + v.replace(/[-\s]/g, '') + '/';
    case 'douban':
    case 'douban_id':
      return /^\d+$/.test(v) ? 'https://book.douban.com/subject/' + v + '/' : null;
    case 'goodreads':
      return 'https://www.goodreads.com/book/show/' + encodeURIComponent(v);
    case 'amazon':
    case 'asin':
      return 'https://www.amazon.com/dp/' + encodeURIComponent(v);
    case 'openlibrary':
      return 'https://openlibrary.org/isbn/' + encodeURIComponent(v);
    case 'google':
      return 'https://books.google.com/books?vid=' + encodeURIComponent(v);
    case 'doi':
      return 'https://doi.org/' + encodeURIComponent(v);
    case 'issn':
      return 'https://portal.issn.org/resource/ISSN/' + encodeURIComponent(v.replace(/[-\s]/g, ''));
    case 'url':
      return /^https?:\/\//i.test(v) ? v : null;
    default:
      return null;
  }
}

// 把 identifiers 摊平成展示数组:[{ type, label, value, url }]
function toDisplayList(map) {
  const src = map && typeof map === 'object' ? map : {};
  return Object.entries(src)
    .filter(([, v]) => String(v || '').trim())
    .map(([type, value]) => ({
      type,
      label: typeLabel(type),
      value: String(value),
      url: identifierUrl(type, value),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
}

module.exports = {
  TYPE_LABELS,
  cleanType,
  cleanVal,
  parseIdentifier,
  parseIdentifiers,
  typeLabel,
  identifierUrl,
  toDisplayList,
};
