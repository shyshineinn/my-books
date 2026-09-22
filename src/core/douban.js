/* ============================================================
 * 豆瓣元数据抓取(纯函数解析 + 网络层分离)
 * 移植自 calibre 插件 NewDouban(Gary Fu, GPL)- 解析选择器与
 * 反爬策略(随机延迟/登录 Cookie/禁止访问检测)按其实现翻译。
 *
 * 分层:
 *   · fetchDoubanSearch / fetchDoubanBook —— 网络层(http 适配,带缓存)
 *   · parseSearchPage / parseBookPage     —— 解析层(纯函数,可独立测试)
 *   · mapToBook —— 字段映射到 books 表结构(纯函数)
 *
 * 反爬要点(照搬插件经验):
 *   · 需要登录 Cookie(环境变量 DOUBAN_COOKIE 或 data/douban-cookie 文件),
 *     否则豆瓣大概率返回"禁止访问"
 *   · 请求前随机延迟 0~100ms(插件同款),并发数压到 3
 *   · 检测 '<title>禁止访问</title>' 明确报错,不静默返回空
 * ============================================================ */

const cheerio = require('cheerio');

const DOUBAN_SEARCH_URL = 'https://www.douban.com/search?cat=1001&q=';
const DOUBAN_BOOK_URL = 'https://book.douban.com/subject/';
const DOUBAN_SUBJECT_RE = /book\.douban\.com\/subject\/(\d+)/;

/* ---------- 解析层(纯函数) ---------- */

// 搜索页 → [{ doubanId, title }]
function parseSearchPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  // 豆瓣的统一搜索页里书籍条目在 a.nbg(data-href 指向真实 subject 链接)
  $('a.nbg').each((_, el) => {
    const href = $(el).attr('data-href') || $(el).attr('href') || '';
    const m = DOUBAN_SUBJECT_RE.exec(href);
    if (m) {
      const title = $(el).attr('title') || $(el).find('img').attr('alt') || '';
      out.push({ doubanId: m[1], title });
    }
  });
  return out.slice(0, 5); // 最多 5 个候选,与插件并发数一致
}

// 详情页 → 规范化书籍元数据(字段名与 my-books 对齐)
function parseBookPage(html, doubanId) {
  const $ = cheerio.load(html);

  const title = $('span[property="v:itemreviewed"]').first().text().trim();
  if (!title) return null;

  const out = {
    doubanId: String(doubanId || ''),
    title,
    authors: [],
    translators: [],
    publisher: '',
    pubYear: '',
    isbn: '',
    rating: 0,
    summary: '',
    tags: [],
    cover: '',
    doubanUrl: DOUBAN_BOOK_URL + (doubanId || '') + '/',
  };

  // 封面(a.nbg href;豆瓣占位图过滤,与插件一致)
  const coverHref = $('a.nbg').first().attr('href') || '';
  if (coverHref && !coverHref.endsWith('update_image')) out.cover = coverHref;

  // 评分(strong[property=v:average] 满分 10 → 折算 5 分制,与插件一致)
  const rating = parseFloat($('strong[property="v:average"]').first().text());
  if (!Number.isNaN(rating) && rating > 0) out.rating = Math.round((rating / 2) * 10) / 10;

  // 信息栏:作者/译者/出版社/出版年/ISBN/丛书
  $('span.pl').each((_, el) => {
    const text = $(el).text().trim();
    const parent = $(el).parent();
    if (text.startsWith('作者')) {
      parent.find('a').each((__, a) => {
        const href = $(a).attr('href') || '';
        if (href.includes('/author') || href.includes('/search')) {
          out.authors.push($(a).text().trim());
        }
      });
    } else if (text.startsWith('译者')) {
      parent.find('a').each((__, a) => {
        const href = $(a).attr('href') || '';
        if (href.includes('/author') || href.includes('/search')) {
          out.translators.push($(a).text().trim());
        }
      });
    } else if (text.startsWith('出版社')) {
      out.publisher = tailText($, el);
    } else if (text.startsWith('出版年')) {
      out.pubYear = tailText($, el);
    } else if (text.startsWith('ISBN')) {
      out.isbn = tailText($, el);
    } else if (text.startsWith('副标题')) {
      const sub = tailText($, el);
      if (sub) out.title = out.title + ':' + sub;
    }
  });

  // 简介:取最后一个 div.intro(与插件一致,通常是完整版)
  const intros = $('div#link-report div.intro');
  if (intros.length) out.summary = cleanSummary($(intros[intros.length - 1]).html() || '');

  // 标签:页面内嵌的 criteria 数据(与插件同款正则:criteria = '...')
  const tagMatch = /criteria = '(.+)'/.exec(html);
  if (tagMatch) {
    out.tags = tagMatch[1]
      .split('|')
      .filter((t) => t.startsWith('7:'))
      .map((t) => t.replace('7:', ''))
      .filter(Boolean)
      .slice(0, 8);
  }

  return out;
}

// span.pl 后面的兄弟文本(豆瓣信息栏的值在标签外,常见 ": 值" 形式 → 去冒号空格)
function tailText($, el) {
  let text = '';
  const parent = $(el).parent();
  const contents = parent.contents().toArray();
  const raw = el.length ? el[0] : el;
  const idx = contents.indexOf(raw);
  for (let i = idx + 1; i < contents.length; i++) {
    const node = contents[i];
    if (node.type === 'text') text += $(node).text().trim();
    else if (node.type === 'tag') { if (!text) text = $(node).text().trim(); break; }
    if (text) break;
  }
  return text ? text.replace(/^[:：\s]+/, '').trim() : '';
}

// 简介清洗:去脚本/样式,保留换行
function cleanSummary(html) {
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
    .slice(0, 1000); // 与 books.summary 截断一致
}

/* ---------- 字段映射:豆瓣 → my-books(供前端回填的形状) ---------- */
function mapToBook(meta) {
  const authors = meta.translators.length && meta.authors.length
    ? meta.authors // 译者是否并入作者由前端/用户决定,这里保持作者独立
    : meta.authors;
  return {
    title: meta.title,
    author: authors.join(' / ') || meta.translators.join(' / ') || '',
    summary: meta.summary,
    publisher: meta.publisher,
    pubYear: meta.pubYear,
    isbn: meta.isbn,
    rating: meta.rating,
    doubanId: meta.doubanId,
    doubanUrl: meta.doubanUrl,
    tags: meta.tags,
    cover: meta.cover,
  };
}

module.exports = {
  DOUBAN_SEARCH_URL,
  DOUBAN_BOOK_URL,
  parseSearchPage,
  parseBookPage,
  mapToBook,
  cleanSummary,
};
