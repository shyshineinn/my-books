/* ============================================================
 * Open Library 元数据映射(纯函数,解析层)
 *
 * 定位与 core/douban.js 相同:只做"JSON → my-books 字段"的翻译,
 * 网络请求在 src/http/metadata-sources.js(与豆瓣同款分层)。
 *
 * 为什么需要它(对标 calibre 的多源 identify):
 *   豆瓣对中文书覆盖好,但外文原版书的 ISBN 常查不到 ——
 *   calibre 的 identify(ebooks/metadata/sources/identify.py)同时
 *   查询多个源并在 ISBN 上合并结果。本项目「按 ISBN 添加」在豆瓣
 *   未命中时回退 Open Library(免费 ISBN 接口,无需 key)。
 *
 * Open Library 接口形状(2026-10 实测):
 *   GET https://openlibrary.org/isbn/<isbn>.json  → edition JSON
 *     { title, authors:[{key:'/authors/OLxxxA'}], publishers:[..],
 *       publish_date:'August 1, 2005', covers:[12345 | -1], key:'/books/OLxxxM' }
 *   GET https://openlibrary.org/authors/OLxxxA.json → { name }
 *   GET https://openlibrary.org/works/OLxxxW.json   → { description: string | {value} }
 * ============================================================ */

// 出版日期 → 年份串:"2005" / "August 1, 2005" / "2005-03-01" → "2005";
// 取不到就是空串(不猜)
function parsePubYear(publishDate) {
  const m = /(\d{4})/.exec(String(publishDate || ''));
  return m ? m[1] : '';
}

// 封面:取 covers 里第一个有效 id(Open Library 用 -1 表示"无封面")。
// 与豆瓣封面同策略 —— 存外链地址,不下载到本站
function coverUrlFromEdition(edition) {
  const covers = Array.isArray(edition && edition.covers) ? edition.covers : [];
  const id = covers.find((c) => Number.isInteger(c) && c > 0);
  return id ? `https://covers.openlibrary.org/b/id/${id}-L.jpg` : '';
}

// 作者键列表(去重、上限 3 个 —— 再多对个人书库展示无意义,还多花请求)
function authorKeysFromEdition(edition) {
  const authors = Array.isArray(edition && edition.authors) ? edition.authors : [];
  const keys = [];
  for (const a of authors) {
    const key = a && typeof a.key === 'string' ? a.key : '';
    if (key.startsWith('/authors/') && !keys.includes(key)) keys.push(key);
    if (keys.length >= 3) break;
  }
  return keys;
}

// edition.key('/books/OL7353617M',部分接口带 '.json' 后缀) → 'OL7353617M';
// 取不到返回 ''
function editionId(edition) {
  const m = /^\/books\/(OL\w+?)(?:\.json)?$/.exec(String((edition && edition.key) || ''));
  return m ? m[1] : '';
}

// 简介:优先 edition.description,回退 work.description;
// 两种形态都见得到 —— 裸字符串 或 { type:'text', value }
function descriptionFrom(edition, work) {
  for (const src of [edition, work]) {
    const d = src && src.description;
    const text = typeof d === 'string' ? d : (d && typeof d.value === 'string' ? d.value : '');
    if (text.trim()) return cleanText(text);
  }
  return '';
}

// 轻量清洗:去标签、常见实体、连续空行;截断与 books.summary 约束一致(1000)
function cleanText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1000);
}

// edition + 已解决的作者名 + 可选 work → my-books 字段形状(与 douban mapToBook 对齐)
function mapOpenLibraryBook({ isbn, edition, authorNames, work }) {
  const names = Array.isArray(authorNames) ? authorNames.filter(Boolean) : [];
  const ed = edition || {};
  const id = editionId(ed);
  return {
    title: String(ed.title || ed.full_title || '').trim(),
    author: names.join(' / '),
    summary: descriptionFrom(ed, work),
    publisher: (Array.isArray(ed.publishers) && ed.publishers[0]) ? String(ed.publishers[0]).trim() : '',
    pubYear: parsePubYear(ed.publish_date),
    isbn: String(isbn || ''),
    rating: 0,
    tags: [],
    cover: coverUrlFromEdition(ed),
    openlibraryId: id,
    openlibraryUrl: id ? 'https://openlibrary.org/books/' + id : '',
  };
}

module.exports = {
  parsePubYear,
  coverUrlFromEdition,
  authorKeysFromEdition,
  editionId,
  descriptionFrom,
  mapOpenLibraryBook,
};
