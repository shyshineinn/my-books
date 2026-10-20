/* ============================================================
 * 疑似重复书籍检测(纯函数,无 I/O)
 *
 * 参考 calibre 的“重复书籍”思路,但核心库没有独立的查重引擎
 * (gui2/dialogs/duplicates.py 只在导入时按标题提示)。这里用三档证据:
 *   1. ISBN 归一化后相同(最强)
 *   2. 规范化书名完全相同(去掉大小写/标点/空白/英文冠词)
 *   3. 书名 bigram 相似度 + 作者相似度同时达标(处理错字/副标题差异)
 *
 * 分组用并查集,支持 A~B、B~C 传递成一组;同书名不同作者不会误合并。
 * ============================================================ */

const { isbnKey } = require('./isbn');
const { splitAuthors } = require('./book');

const DEFAULT_TITLE_THRESHOLD = 0.85;
const DEFAULT_AUTHOR_THRESHOLD = 0.8;
const REASON_PRIORITY = { isbn: 3, title: 2, title_fuzzy: 1 };

function normalizeToken(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeTitle(raw) {
  const lowered = String(raw == null ? '' : raw).normalize('NFKC').toLowerCase().trim();
  return normalizeToken(lowered.replace(/^(the|a|an)\s+/i, ''));
}

function normalizeAuthor(raw) {
  return splitAuthors(raw)
    .map(normalizeToken)
    .filter(Boolean)
    .sort()
    .join('');
}

function bigrams(value) {
  const s = String(value || '');
  if (!s) return new Set();
  if (s.length < 2) return new Set([s]);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

// Sørensen–Dice 系数:对中英文都适用,无需分词
function dice(a, b) {
  if (a === b) return a ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

function pairMatch(a, b, opts = {}) {
  const titleThreshold = opts.titleThreshold ?? DEFAULT_TITLE_THRESHOLD;
  const authorThreshold = opts.authorThreshold ?? DEFAULT_AUTHOR_THRESHOLD;

  if (a._isbn && b._isbn && a._isbn === b._isbn) {
    return { reason: 'isbn', score: 1 };
  }
  if (!a._normTitle || !b._normTitle) return null;

  const titleScore = a._normTitle === b._normTitle ? 1 : dice(a._normTitle, b._normTitle);
  const authorScore = a._normAuthor && b._normAuthor
    ? dice(a._normAuthor, b._normAuthor)
    : null;

  if (titleScore === 1) {
    if (authorScore !== null && authorScore < authorThreshold) return null;
    return { reason: 'title', score: 1 };
  }
  if (titleScore < titleThreshold) return null;
  // 模糊书名必须有作者佐证,避免《导论》这类通用标题被误合并
  if (authorScore === null || authorScore < authorThreshold) return null;
  return {
    reason: 'title_fuzzy',
    score: Math.round(((titleScore + authorScore) / 2) * 1000) / 1000,
  };
}

function findDuplicateGroups(rows, opts = {}) {
  const books = (rows || []).map((r) => ({
    ...r,
    _normTitle: normalizeTitle(r.title),
    _normAuthor: normalizeAuthor(r.author),
    _isbn: isbnKey(r.isbn || '') || '',
  }));

  const parent = books.map((_, i) => i);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== i) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (i, j) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  const matches = [];
  for (let i = 0; i < books.length; i += 1) {
    for (let j = i + 1; j < books.length; j += 1) {
      const m = pairMatch(books[i], books[j], opts);
      if (!m) continue;
      union(i, j);
      matches.push({ i, j, ...m });
    }
  }
  if (!matches.length) return [];

  const groupMap = new Map();
  books.forEach((_, i) => {
    const root = find(i);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root).push(i);
  });

  const best = new Map();
  for (const m of matches) {
    const root = find(m.i);
    const cur = best.get(root);
    if (
      !cur
      || REASON_PRIORITY[m.reason] > REASON_PRIORITY[cur.reason]
      || (REASON_PRIORITY[m.reason] === REASON_PRIORITY[cur.reason] && m.score > cur.score)
    ) {
      best.set(root, { reason: m.reason, score: m.score });
    }
  }

  const groups = [];
  for (const [root, idxs] of groupMap) {
    if (idxs.length < 2) continue;
    const info = best.get(root) || { reason: 'title_fuzzy', score: 0 };
    const groupBooks = idxs.map((i) => {
      const { _normTitle, _normAuthor, _isbn, ...book } = books[i];
      return book;
    }).sort((a, b) => a.id - b.id);
    groups.push({ reason: info.reason, score: info.score, books: groupBooks });
  }

  groups.sort((a, b) =>
    b.books.length - a.books.length
    || b.score - a.score
    || String(a.books[0].title).localeCompare(String(b.books[0].title), 'zh'));
  return groups;
}

module.exports = {
  DEFAULT_TITLE_THRESHOLD,
  DEFAULT_AUTHOR_THRESHOLD,
  normalizeTitle,
  normalizeAuthor,
  bigrams,
  dice,
  pairMatch,
  findDuplicateGroups,
};
