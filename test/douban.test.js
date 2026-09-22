/* ============================================================
 * 豆瓣元数据解析测试(core/douban.js 纯函数,不联网)
 * fixture 按豆瓣真实页面结构精简构造
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const { parseSearchPage, parseBookPage, mapToBook, cleanSummary } = require('../src/core/douban.js');

const SEARCH_HTML = `
<div class="result">
  <div class="result-op"><a class="nbg" data-href="https://book.douban.com/subject/2567698/" href="https://www.douban.com/link2/?url=https%3A%2F%2Fbook.douban.com%2Fsubject%2F2567698%2F"><img alt="三体" src="x.jpg"></a></div>
  <div class="result-op"><a class="nbg" data-href="https://book.douban.com/subject/5363767/"><img alt="三体Ⅱ·黑暗森林" src="y.jpg"></a></div>
  <a class="nbg" href="https://movie.douban.com/subject/1/"><img alt="电影,应被过滤"></a>
  <a class="other">非 nbg 条目</a>
</div>`;

const BOOK_HTML = `
<div id="wrapper">
  <h1><span property="v:itemreviewed">三体</span></h1>
  <div id="meta">
    <span class="pl">作者</span>:
    <a href="/author/123">刘慈欣</a>
    <span class="pl">出版社</span>: 重庆出版社
    <span class="pl">出版年</span>: 2008-1
    <span class="pl">ISBN</span>: 9787536692930
  </div>
  <div class="rating_wrap"><strong property="v:average" class="rating_num">9.3</strong></div>
  <a class="nbg" href="https://img.doubanio.com/view/subject/s/public/s29053580.jpg"></a>
  <div id="link-report">
    <div class="intro">简介第一段</div>
    <div class="intro">简介第二段<br>第二行</div>
  </div>
  <script>var __DATA__ = [{ criteria = '7:科幻|7:小说|2:其他' }];</script>
</div>`;

test('parseSearchPage:提取书籍候选,过滤非 book.douban.com 链接', () => {
  const out = parseSearchPage(SEARCH_HTML);
  assert.equal(out.length, 2);
  assert.equal(out[0].doubanId, '2567698');
  assert.equal(out[1].doubanId, '5363767');
});

test('parseBookPage:标题/作者/出版社/出版年/ISBN/评分/封面', () => {
  const m = parseBookPage(BOOK_HTML, '2567698');
  assert.equal(m.title, '三体');
  assert.deepEqual(m.authors, ['刘慈欣']);
  assert.equal(m.publisher, '重庆出版社');
  assert.equal(m.pubYear, '2008-1');
  assert.equal(m.isbn, '9787536692930');
  assert.equal(m.rating, 4.7, '豆瓣 9.3 折算 5 分制应为 4.7'); // 9.3/2=4.65 → round(46.5)/10=4.7
  assert.ok(m.cover.includes('s29053580.jpg'));
  assert.equal(m.doubanId, '2567698');
});

test('parseBookPage:简介取最后一个 intro 并清洗标签', () => {
  const m = parseBookPage(BOOK_HTML, '2567698');
  assert.ok(m.summary.startsWith('简介第二段'), '应取最后一个 intro');
  assert.ok(m.summary.includes('\n'), 'br 应转为换行');
  assert.ok(!m.summary.includes('<'), '不应残留 HTML 标签');
});

test('parseBookPage:标签从 criteria 提取,只取 7: 前缀,上限 8', () => {
  const m = parseBookPage(BOOK_HTML, '2567698');
  assert.deepEqual(m.tags, ['科幻', '小说']);
});

test('parseBookPage:无标题(反爬/异常页)返回 null', () => {
  assert.equal(parseBookPage('<html><body>禁止访问</body></html>', '1'), null);
});

test('mapToBook:映射到 my-books 字段形状', () => {
  const m = parseBookPage(BOOK_HTML, '2567698');
  const b = mapToBook(m);
  assert.equal(b.title, '三体');
  assert.equal(b.author, '刘慈欣');
  assert.equal(b.isbn, '9787536692930');
  assert.equal(b.rating, 4.7);
  assert.ok(b.doubanUrl.includes('/subject/2567698/'));
});

test('cleanSummary:HTML 实体与脚本清理', () => {
  const s = cleanSummary('<script>alert(1)</script><p>A &amp; B&nbsp;C<br>第二行</p>');
  assert.ok(!s.includes('script'));
  assert.ok(s.includes('A & B C'));
  assert.ok(s.includes('第二行'));
});
