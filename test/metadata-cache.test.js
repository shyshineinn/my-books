/* ============================================================
 * 豆瓣搜索缓存 TTL(修复问题 4)的回归测试:
 *   旧逻辑:注释写"LRU 20 条,10 分钟",代码却是"命中就返回"——
 *           条目在被 LRU 淘汰前永久有效,豆瓣改条目后一直拿旧数据。
 *   新逻辑:命中也要比时间戳;过期条目主动 delete 后回源。
 * 手法:routes.metadata.js 把处理函数抽成 handleMetadataSearch 导出,
 *       测试以假 req/res + 桩 fetch 驱动,不发真实网络请求。
 * 每个用例自带前置(先回源灌缓存),互不依赖执行顺序。
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');

const router = require('../src/http/routes.metadata.js');
const { handleMetadataSearch, searchCache, SEARCH_CACHE_TTL } = router;

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    jsonBody: null,
    set(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
  };
}

// 最小可用的豆瓣页面 fixture:搜索页 1 个候选 + 详情页最小元数据
const SEARCH_HTML = `
  <div class="item-root">
    <a class="nbg" href="https://book.douban.com/subject/10001/" title="测试书">
      <img alt="测试书" src="https://img3.doubanio.com/view/cover/t.jpg">
    </a>
  </div>`;
const DETAIL_HTML = `
  <span property="v:itemreviewed">测试书</span>
  <a class="nbg" href="https://img3.doubanio.com/view/cover/t.jpg"></a>
  <strong property="v:average">8.5</strong>
  <div id="info"><span class="pl">出版社:</span>某出版社</div>
  <div id="link-report"><div class="intro"><p>一段简介。</p></div></div>`;

let fetchCalls = 0;
function installStubFetch() {
  const saved = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    const u = String(url);
    const html = u.includes('/search') ? SEARCH_HTML : DETAIL_HTML;
    return { ok: true, status: 200, text: async () => html };
  };
  return () => { globalThis.fetch = saved; };
}

const reqFor = (q) => ({ query: { q } });
const EXPECTED_RESULT = {
  title: '测试书', author: '', summary: '一段简介。', publisher: '某出版社',
  pubYear: '', isbn: '', rating: 8.5, doubanId: '10001',
  doubanUrl: 'https://book.douban.com/subject/10001/', tags: [],
  cover: 'https://img3.doubanio.com/view/cover/t.jpg',
};

test('首次查询回源(X-Cache: miss),结果以 { t, results } 形状写入缓存', async () => {
  const restore = installStubFetch();
  try {
    searchCache.clear();
    const res = fakeRes();
    await handleMetadataSearch(reqFor('测试书A'), res);
    assert.equal(res.headers['X-Cache'], 'miss');
    assert.equal(res.statusCode, 0);
    assert.deepEqual(res.jsonBody.results, [EXPECTED_RESULT]);
    assert.ok(fetchCalls >= 2, '搜索页 + 详情页都该回源');

    const hit = searchCache.get('测试书A');
    assert.ok(hit && Number.isFinite(hit.t) && Array.isArray(hit.results), '条目必须带时间戳');
  } finally { restore(); }
});

test('TTL 内重复查询命中缓存:零网络请求', async () => {
  const restore = installStubFetch();
  try {
    searchCache.clear();
    await handleMetadataSearch(reqFor('测试书B'), fakeRes());   // 前置:回源灌缓存
    const callsAfterSeed = fetchCalls;

    const res = fakeRes();
    await handleMetadataSearch(reqFor('测试书B'), res);
    assert.equal(res.headers['X-Cache'], 'hit');
    assert.equal(fetchCalls, callsAfterSeed, '命中缓存不应发起任何请求');
    assert.deepEqual(res.jsonBody.results, [EXPECTED_RESULT]);
  } finally { restore(); }
});

test('条目过期后重新查询:主动清缓存并回源(修复核心)', async () => {
  const restore = installStubFetch();
  try {
    searchCache.clear();
    await handleMetadataSearch(reqFor('测试书C'), fakeRes());   // 前置:灌缓存

    // 把条目时间戳拨回 TTL 之前,模拟 10 分钟已过
    const hit = searchCache.get('测试书C');
    hit.t = Date.now() - SEARCH_CACHE_TTL - 1000;

    const res = fakeRes();
    await handleMetadataSearch(reqFor('测试书C'), res);
    assert.equal(res.headers['X-Cache'], 'miss', '过期命中必须回源,而不是返回旧数据');
    assert.ok(fetchCalls > 2, '过期后应重新抓取搜索页与详情页');

    // 回源后写回的条目是新鲜的:再查应命中且不再发请求
    const callsAfterRefetch = fetchCalls;
    const res2 = fakeRes();
    await handleMetadataSearch(reqFor('测试书C'), res2);
    assert.equal(res2.headers['X-Cache'], 'hit');
    assert.equal(fetchCalls, callsAfterRefetch, '新写入的条目不应再触发请求');
  } finally { restore(); }
});
