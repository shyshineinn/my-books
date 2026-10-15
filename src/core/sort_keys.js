/* ============================================================
 * 排序键计算(对标 calibre ebooks/metadata/__init__.py)
 *
 * A8:此前 title 排序直接 `ORDER BY title COLLATE NOCASE`,
 * author_sort 只是"首位作者原文"。问题:
 *   · 英文书名 "The Hobbit" 会排在 T 组,而读者的直觉是 H 组
 *   · "John Smith" 按 J 排序,图书馆惯例是 S(Smith, John)
 * calibre 用 title_sort / author_to_author_sort 两个纯函数算好存库
 * (它甚至用 SQLite 触发器 + 自定义标量函数在写库时自动算,见
 *  db/backend.py:426-428 注册 title_sort/uuid4)。
 *
 * 本项目在 JS 侧算好再存列(与 tags/author 的"派生缓存"同一套路),
 * 好处是不必给 SQLite 注册自定义函数,且纯函数可独立测试。
 *
 * **对中文的影响:几乎为零,且这正是我们要的** ——
 *   · 中文书名不含英语冠词 → title_sort 原样返回
 *   · 中文人名不含空格,calibre 的算法在 tokens<2 时直接返回原文
 *     (见 metadata/__init__.py:88-90)→ 刘慈欣 保持 刘慈欣
 * 所以本模块主要修的是英文书名的排序,中文书的排序结果与改造前一致。
 * ============================================================ */

// 书名开头的引号对(calibre quote_pairs 的中文相关子集 + 常用西文引号)
// 书名的引号不参与排序:"《三体》" 应等价于 "三体"
const QUOTE_PAIRS = {
  '"': ['"'],
  "'": ["'"],
  '“': ['”', '“'],
  '”': ['”'],
  '《': ['》'],
  '「': ['」'],
  '『': ['』'],
  '〈': ['〉'],
  '«': ['»', '«'],
  '»': ['«', '»'],
};

// 英语冠词:calibre 的 eng 默认集(per_language_title_sort_articles)
// 只处理"冠词 + 空格"开头,且大小写不敏感
const ARTICLES_RE = /^(a|an|the)\s+/i;

// 去掉书名两端配对的引号(只去一层)。calibre title_sort:209-213。
function stripTitleQuotes(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  const open = t[0];
  const closers = QUOTE_PAIRS[open];
  if (!closers) return t;
  for (const close of closers) {
    if (t.length > 1 && t.endsWith(close)) return t.slice(1, -1).trim();
  }
  return t;
}

// 书名排序键:剥引号 → 把开头的英语冠词移到末尾(逗号分隔)。
//   "The Hobbit" → "Hobbit, The"
//   "《三体》"    → "三体"        (中文无冠词,原样)
//   "A Brief History of Time" → "Brief History of Time, A"
// 对标 calibre title_sort(metadata/__init__.py:203-228)。
function titleSort(title) {
  let t = stripTitleQuotes(title);
  if (!t) return '';
  const m = ARTICLES_RE.exec(t);
  if (!m) return t;
  const article = m[1];
  // 去掉冠词与紧随的空格,再拼到末尾
  let rest = t.slice(m[0].length).trim();
  if (!rest) return t;                       // 只有冠词本身(如书名就叫 "The"),保留原文
  rest = rest + ', ' + article;
  // 移位后如果又以引号开头,再剥一次(calibre 同款处理:222-227)
  return stripTitleQuotes(rest);
}

// 人名前缀/后缀(calibre tweaks 的常用子集)。
// 见到这些词就不做倒装 —— "Dr. Seuss" 不该变成 "Seuss, Dr." 吗?
// 其实 calibre 的语义是:若名字**全部**由前缀构成,或含 copyword,则放弃倒装。
const NAME_PREFIXES = new Set([
  'dr', 'dr.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'miss',
  'prof', 'prof.', 'sir', 'lord', 'lady', 'st', 'st.', 'rev', 'rev.',
]);

// copywords:出现即**完全放弃**倒装(calibre author_name_copywords)
const COPY_WORDS = new Set([
  'jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'phd', 'phd.', 'md', 'md.',
]);

// 单个人名的排序键:"John Smith" → "Smith, John";"刘慈欣" → "刘慈欣"。
// 对标 calibre author_to_author_sort(metadata/__init__.py:67-138),
// 默认 method='comma'(surname, given)。
//
// 关键早退分支(都必须保留,否则会算错):
//   · 无空格 / 单 token → 原样返回(中文名、笔名都走这条)
//   · 名字里出现 copyword → 原样返回
//   · 全部 token 都是前缀 → 原样返回
function authorToAuthorSort(name) {
  const s = String(name || '').trim();
  if (!s) return '';

  // 已有逗号 = 用户已按 "姓, 名" 写好,尊重原样
  if (s.includes(',')) return s;

  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return s;           // 中文名 / 单名:不倒装

  const lower = tokens.map((t) => t.toLowerCase());
  if (lower.some((t) => COPY_WORDS.has(t))) return s;

  // 找到第一个非前缀 token(名开始处)
  let first = 0;
  while (first < tokens.length && NAME_PREFIXES.has(lower[first])) first += 1;
  if (first >= tokens.length) return s;      // 全是前缀:放弃

  // 找到最后一个非后缀 token(calibre 只把前缀当"名"处理,
  // 后缀由 copywords 兜住;这里保持简单:取最后一个 token 作姓)
  let last = tokens.length - 1;
  while (last > first && NAME_PREFIXES.has(lower[last])) last -= 1;

  const surname = tokens[last];
  const given = tokens.slice(first, last);
  if (!surname || !given.length) return s;

  return surname + ', ' + given.join(' ');
}

// 多作者的排序串:calibre 用 ' & ' 连接(authors_to_sort_string:141-142)
function authorsToSortString(authors) {
  const list = Array.isArray(authors) ? authors : [authors];
  return list
    .map((a) => authorToAuthorSort(a))
    .filter(Boolean)
    .join(' & ');
}

module.exports = {
  QUOTE_PAIRS,
  stripTitleQuotes,
  titleSort,
  authorToAuthorSort,
  authorsToSortString,
};
