/* ============================================================
 * ISBN 直查链路测试(http/metadata-sources.js,桩 fetch 不联网)
 * 覆盖:豆瓣 /isbn/ 直连命中、跳搜索页时按 ISBN 精确匹配回退、
 *       候选不匹配时宁可 not_found、豆瓣被拒时记录 BLOCKED、
 *       Open Library 兜底与 published_date 映射。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const { lookupIsbn, lookupIsbnDouban } = require('../src/http/metadata-sources.js');

const ISBN = '9787536692930';

// 豆瓣详情页最小 fixture(带 ISBN 字段,回退搜索时用于精确匹配)
const DETAIL_HTML = (isbn) => `
  <span property="v:itemreviewed">测试书</span>
  <a class="nbg" href="https://img3.doubanio.com/view/cover/t.jpg"></a>
  <strong property="v:average">8.5</strong>
  <div id="info"><span class="pl">ISBN</span>: ${isbn}</div>
  <div id="link-report"><div class="intro"><p>一段简介。</p></div></div>`;

const SEARCH_HTML = `
  <div class="item-root">
    <a class="nbg" href="https://book.douban.com/subject/10001/" title="测试书">
      <img alt="测试书" src="https://img3.doubanio.com/view/cover/t.jpg">
    </a>
  </div>`;

const OL_EDITION = {
  key: '/books/OL7353617M',
  title: 'The Pragmatic Programmer',
  authors: [{ key: '/authors/OL23919A' }],
  publishers: ['Addison-Wesley'],
  publish_date: 'August 1, 2005',
  covers: [12345],
  works: [{ key: '/works/OL45883W' }],
};

function installStubFetch(routes) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const route = routes.find((r) => r.match(u));
    if (!route) throw new Error('stub fetch 未覆盖的 URL: ' + u);
    return route.handle(u);
  };
  return () => { globalThis.fetch = saved; };
}

const jsonResp = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

test('lookupIsbn:豆瓣 /isbn/ 直连命中(302 后 URL 带 subject id)', async () => {
  const restore = installStubFetch([{
    match: (u) => u.includes('book.douban.com/isbn/'),
    handle: () => ({
      ok: true, status: 200, url: 'https://book.douban.com/subject/2567698/',
      text: async () => DETAIL_HTML(ISBN),
    }),
  }]);
  try {
    const r = await lookupIsbnDouban(ISBN);
    assert.equal(r.status, 'found');
    assert.equal(r.source, 'douban');
    assert.equal(r.book.title, '测试书');
    assert.equal(r.book.isbn, ISBN);
    assert.equal(r.book.doubanId, '2567698');
  } finally { restore(); }
});

test('lookupIsbn:豆瓣跳到搜索页时,回退搜索流程取 ISBN 精确匹配', async () => {
  const restore = installStubFetch([
    // /isbn/ 没有 302 到详情页(落到搜索页 HTML)
    { match: (u) => u.includes('book.douban.com/isbn/'), handle: () => ({
      ok: true, status: 200, url: 'https://book.douban.com/search?q=' + ISBN,
      text: async () => '<html><body>没有找到</body></html>',
    }) },
    { match: (u) => u.includes('www.douban.com/search'), handle: () => ({
      ok: true, status: 200, text: async () => SEARCH_HTML,
    }) },
    { match: (u) => u.includes('/subject/'), handle: () => ({
      ok: true, status: 200, text: async () => DETAIL_HTML(ISBN),
    }) },
  ]);
  try {
    const r = await lookupIsbnDouban(ISBN);
    assert.equal(r.status, 'found');
    assert.equal(r.book.isbn, ISBN, '回退搜索必须精确匹配 ISBN 才接受');
  } finally { restore(); }
});

test('lookupIsbn:候选 ISBN 不匹配 → not_found(不自动建档避免张冠李戴)', async () => {
  const restore = installStubFetch([
    { match: (u) => u.includes('book.douban.com/isbn/'), handle: () => ({
      ok: true, status: 200, url: 'https://book.douban.com/search?q=x',
      text: async () => '<html></html>',
    }) },
    { match: (u) => u.includes('www.douban.com/search'), handle: () => ({
      ok: true, status: 200, text: async () => SEARCH_HTML,
    }) },
    { match: (u) => u.includes('/subject/'), handle: () => ({
      ok: true, status: 200, text: async () => DETAIL_HTML('9780000000002'),
    }) },
    { match: (u) => u.includes('openlibrary.org'), handle: () => jsonResp({}, 404) },
  ]);
  try {
    const r = await lookupIsbn(ISBN);
    assert.equal(r.status, 'not_found');
  } finally { restore(); }
});

test('lookupIsbn:豆瓣被拒且 OL 没有 → 报 blocked(提示配 Cookie)', async () => {
  const restore = installStubFetch([
    { match: (u) => u.includes('book.douban.com/isbn/'), handle: () => ({
      ok: true, status: 200, url: 'https://book.douban.com/isbn/' + ISBN + '/',
      text: async () => '<html><head><title>禁止访问</title></head></html>',
    }) },
    { match: (u) => u.includes('openlibrary.org'), handle: () => jsonResp({}, 404) },
  ]);
  try {
    const r = await lookupIsbn(ISBN);
    assert.equal(r.status, 'blocked');
  } finally { restore(); }
});

test('lookupIsbn:豆瓣未命中 → Open Library 兜底成功(含作者名与来源标记)', async () => {
  const restore = installStubFetch([
    { match: (u) => u.includes('book.douban.com/isbn/'), handle: () => ({
      ok: true, status: 200, url: 'https://book.douban.com/search?q=x',
      text: async () => '<html></html>',
    }) },
    { match: (u) => u.includes('www.douban.com/search'), handle: () => ({
      ok: true, status: 200, text: async () => '<html><body>无候选</body></html>',
    }) },
    { match: (u) => u.includes('/authors/'), handle: () => jsonResp({ name: 'Andrew Hunt' }) },
    { match: (u) => u.includes('/works/'), handle: () => jsonResp({ description: { value: 'A classic.' } }) },
    { match: (u) => u.includes('openlibrary.org/isbn/'), handle: () => jsonResp(OL_EDITION) },
  ]);
  try {
    const r = await lookupIsbn(ISBN);
    assert.equal(r.status, 'found');
    assert.equal(r.source, 'openlibrary');
    assert.equal(r.book.title, 'The Pragmatic Programmer');
    assert.equal(r.book.author, 'Andrew Hunt');
    assert.equal(r.book.pubYear, '2005');
    assert.equal(r.book.openlibraryId, 'OL7353617M');
  } finally { restore(); }
});
