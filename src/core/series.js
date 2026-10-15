/* ============================================================
 * 系列与系列序号规则(A3,对标 calibre)
 *
 * calibre 的模型:`series` 值表 + `books_series_link`(UNIQUE(book))
 * + `books.series_index REAL NOT NULL DEFAULT 1.0`
 * (resources/metadata_sqlite.sql:12,18-48)。
 * 序号是 REAL —— 因为中篇插队很常见(第 2.5 册)。
 *
 * 本项目的取舍:**不建 series 值表,只用 books 的两列**(series / series_index)。
 * 理由:一本书只属于一个系列(calibre 也是 UNIQUE(book)),而"系列改名 / 合并"
 * 用一条 `UPDATE books SET series=? WHERE series=?` 就能原子完成,
 * "带计数的系列列表"用 `GROUP BY series` 即可 —— 归一化带来的能力在这里
 * 用两列 + 直改语句等价实现,少一套链接表与缓存重算。
 * (tags / authors 之所以归一化,是因为它们一本书有多个值,必须用链接表。)
 *
 * 两个来自 calibre 的实用点:
 *   · 输入语法 `系列名 [序号]`(calibre db/__init__.py:51-65 的 _get_series_values)
 *   · 序号自动递增策略(同文件:18-48 的 _get_next_series_num_for_list)
 * ============================================================ */

// 序号上限:防止手滑输入天文数字把排序搞乱
const MAX_SERIES_INDEX = 9999;

// 输入 `系列名 [3]` → { series: '系列名', series_index: 3 }。
// 序号可带小数(如 `[2.5]`)。无方括号 → index 为 null(表示"未指定")。
// 对标 calibre _get_series_values 的正则 `(.*)\s+\[([.0-9]+)\]$`。
const SERIES_INDEX_RE = /^(.*?)\s*\[\s*([0-9]*\.?[0-9]+)\s*\]$/;

function parseSeriesInput(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { series: '', series_index: null };
  const m = SERIES_INDEX_RE.exec(s);
  if (!m) return { series: s, series_index: null };
  const name = m[1].trim();
  if (!name) return { series: '', series_index: null };   // 只有 "[3]" 视为无效
  const n = Number(m[2]);
  return {
    series: name,
    series_index: Number.isFinite(n) ? clampSeriesIndex(n) : null,
  };
}

// 序号规范化:非数字 / 空 / 负数 / 越界 → null(未指定);保留一位小数。
// 注意空串要单独判:`Number('') === 0` 会被误当成"第 0 册"通过检查。
function clampSeriesIndex(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  const r = Math.round(n * 10) / 10;
  return Math.min(MAX_SERIES_INDEX, r);
}

// 一组已有序号 → 下一个"空位"序号。
// 对标 calibre 的 series_index_auto_increment(本项目固定用 'first_free':
// 从 1 开始找第一个没被占用的整数 —— 个人书架最符合直觉的默认,
// calibre 的默认 'next' 会在删掉中间册后继续往后涨)。
//   existing = [1, 2, 4] → 3
//   空 → 1
function nextSeriesIndex(existingIndexes = []) {
  const used = new Set(
    (Array.isArray(existingIndexes) ? existingIndexes : [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n))
  );
  if (!used.size) return 1;
  for (let i = 1; i <= MAX_SERIES_INDEX; i += 1) {
    if (!used.has(i)) return i;
  }
  return used.size + 1;
}

// 序号展示:整数不带小数点(3 而不是 3.0),小数原样。
// **0 视为"未指定序号"**(与 books.series_index 的 0 默认值约定一致),
// 返回空串 —— 否则会显示成「基地 #0」。
function formatSeriesIndex(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

// 「系列 #3」这种展示串(书架 / 详情页用)
function seriesLabel(series, index) {
  const name = String(series || '').trim();
  if (!name) return '';
  const idx = formatSeriesIndex(index);
  return idx ? `${name} #${idx}` : name;
}

module.exports = {
  MAX_SERIES_INDEX,
  SERIES_INDEX_RE,
  parseSeriesInput,
  clampSeriesIndex,
  nextSeriesIndex,
  formatSeriesIndex,
  seriesLabel,
};
