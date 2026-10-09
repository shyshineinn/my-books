/* ============================================================
 * calibre 转发层集成测试(用本地 mock server 冒充 calibre)
 *
 * 为什么需要它:开发机上通常没装 calibre,而"双库 join"这段逻辑
 * (calibre 元数据 + reading.db 阅读状态)恰恰是最容易出错的地方。
 * 这里起一个假的 calibre HTTP 服务,真实走一遍:
 *   /api/calibre/books  → mock /ajax/search → mock /ajax/books → reading 表 join
 *
 * 覆盖:
 *   · 两次往返(search 拿 id → books 拿元数据)是否正确拼接
 *   · uuid 关联是否用对(不能用 id)
 *   · reading 表缺失时是否补默认「想读」
 *   · status 过滤(calibre 不认识 status,必须在 Node 侧过滤)
 *   · calibre 挂掉时是否回 502 + CALIBRE_UNAVAILABLE
 *   · 封面是否流式转发且 Content-Type 正确
 * ============================================================ */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/* ---------- mock calibre ---------- */

const BOOKS = {
  1: {
    uuid: '11111111-1111-4111-8111-111111111111',
    title: '三体', authors: ['刘慈欣'], author_sort: 'Liu, Cixin',
    tags: ['科幻', '小说'], series: '地球往事', series_index: 1.0,
    publisher: '重庆出版社', comments: '<p>文革背景的科幻</p>',
    languages: ['zho'], identifiers: { isbn: '9787536692930' },
    pubdate: '2008-01-01T00:00:00+00:00', timestamp: '2020-01-01T00:00:00+00:00',
    last_modified: '2020-01-02T00:00:00+00:00', rating: 5,
    formats: ['EPUB', 'MOBI'], format_metadata: { EPUB: { size: 1024, mtime: '2020-01-01T00:00:00+00:00' } },
  },
  2: {
    uuid: '22222222-2222-4222-8222-222222222222',
    title: '活着', authors: ['余华'], tags: ['小说'],
    formats: ['EPUB'], format_metadata: {},
    identifiers: {}, languages: [], rating: 0,
    pubdate: 'None', timestamp: '2021-01-01T00:00:00+00:00', last_modified: '2021-01-02T00:00:00+00:00',
  },
};

// 1 像素 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function startMockCalibre() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/calibre/, '');

    if (p === '/ajax/library-info') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ library_map: { lib1: '主库' }, default_library: 'lib1' }));
    }

    if (p === '/ajax/search') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        total_num: 2, offset: 0, num: 2, sort: 'title', sort_order: 'asc',
        query: '', library_id: 'lib1', book_ids: [1, 2],
      }));
    }

    if (p === '/ajax/books') {
      const ids = url.searchParams.get('ids');
      const idIsUuid = url.searchParams.get('id_is_uuid') === 'true';
      let want;
      if (ids === 'all') {
        want = Object.keys(BOOKS);
      } else if (idIsUuid) {
        // 真实 calibre 会用 lookup_by_uuid 解析(ajax.py:205),返回
        // {数字id: {...}} 字典 —— 这里照做,否则测不出 id 是否能拿到
        want = String(ids).split(',').map((u) => Object.keys(BOOKS).find((k) => BOOKS[k].uuid === u)).filter(Boolean);
      } else {
        want = String(ids).split(',');
      }
      const out = {};
      for (const id of want) if (BOOKS[id]) out[id] = BOOKS[id];
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(out));
    }

    if (p.startsWith('/ajax/book/')) {
      const raw = decodeURIComponent(p.split('/').pop());
      const idIsUuid = url.searchParams.get('id_is_uuid') === 'true';
      // 真实 calibre 支持 id_is_uuid=true(ajax.py:156),mock 也照做,
      // 否则测不出"关联键用 uuid"这件事
      const id = idIsUuid
        ? Object.keys(BOOKS).find((k) => BOOKS[k].uuid === raw)
        : raw;
      if (!id || !BOOKS[id]) {
        res.statusCode = 404;
        return res.end('<html>not found</html>');
      }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(BOOKS[id]));
    }

    if (p.startsWith('/get/')) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('ETag', '"mock-etag"');
      return res.end(PNG);
    }

    if (p === '/fts/search') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        indexing_status: { left: 0, total: 2 },
        results: [{ book_id: 1, text: '三体' }],
        metadata: { 1: { title: '三体', authors: '刘慈欣', uuid: BOOKS[1].uuid } },
      }));
    }

    res.statusCode = 404;
    res.end('nope');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------- 测试装配 ----------
   关键:必须在 require 业务模块**之前**设好环境变量,因为
   src/db/calibre.js 在模块加载时读取 CALIBRE_URL。
   同时用临时目录隔离 reading.db,绝不碰真实 data/。 */

let mock;
let appServer;
let baseUrl;
let readingDb;
let tmpDir;

before(async () => {
  mock = await startMockCalibre();
  process.env.CALIBRE_URL = `http://127.0.0.1:${mock.port}/calibre`;

  // 隔离 reading 库:READING_DATA_DIR 由测试注入
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-test-'));
  process.env.READING_DATA_DIR = tmpDir;

  const express = require('express');
  const routesCalibre = require('../src/http/routes.calibre');
  const routesReading = require('../src/http/routes.reading');
  readingDb = require('../src/db/reading');

  const app = express();
  app.use(express.json());
  app.use(routesCalibre);
  app.use(routesReading);

  await new Promise((resolve) => {
    appServer = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${appServer.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (appServer) await new Promise((r) => appServer.close(r));
  if (mock) await new Promise((r) => mock.server.close(r));
  // 必须先释放 SQLite 句柄,否则 Windows 上临时目录会因文件占用而删不掉(EPERM)
  try { readingDb.closeReadingDb(); } catch { /* 忽略 */ }
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 残留无害 */ }
  }
});

const U1 = BOOKS[1].uuid;
const U2 = BOOKS[2].uuid;

async function getJson(p, init) {
  const res = await fetch(baseUrl + p, init);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { res, data, text };
}

/* ---------- 用例 ---------- */

test('书单:两次往返拼接正确,并补上默认「想读」', async () => {
  const { res, data } = await getJson('/api/calibre/books');
  assert.equal(res.status, 200);
  assert.equal(data.books.length, 2);

  const san = data.books.find((b) => b.title === '三体');
  assert.ok(san, '应包含《三体》');
  // 关联键必须是 uuid,不是 id
  assert.equal(san.uuid, U1);
  assert.equal(san.id, 1);
  // calibre 的 authors 是数组 → 同时给出数组与拼接串
  assert.deepEqual(san.authors, ['刘慈欣']);
  assert.equal(san.author, '刘慈欣');
  assert.equal(san.publisher, '重庆出版社');
  // isbn 从 identifiers 里提出来
  assert.equal(san.isbn, '9787536692930');
  assert.deepEqual(san.tags, ['科幻', '小说']);
  // 封面走 Node 代理,前端不直连 calibre
  assert.match(san.cover_url, /^\/api\/calibre\/cover\/1$/);
  // 未记录过的书 → 默认「想读」且标记 is_default
  assert.equal(san.reading.status, 'wish');
  assert.equal(san.reading.is_default, true);
});

test('pubdate 为 "None" 时归一化成空串', async () => {
  const { data } = await getJson('/api/calibre/books');
  const huo = data.books.find((b) => b.title === '活着');
  assert.equal(huo.pubdate, '');
});

test('UUID 关联:写入阅读记录后,书单能带出真实状态', async () => {
  const put = await getJson(`/api/reading/${U1}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'done',
      read_logs: [{ start: '2022-07-10', finish: '2022-08-20' }],
    }),
  });
  assert.equal(put.res.status, 200);
  // 规则:次数与日期由记录推导
  assert.equal(put.data.reading.read_count, 1);
  assert.equal(put.data.reading.finish_date, '2022-08-20');

  const { data } = await getJson('/api/calibre/books');
  const san = data.books.find((b) => b.uuid === U1);
  assert.equal(san.reading.status, 'done');
  assert.equal(san.reading.is_default, false);
  assert.equal(san.reading.read_count, 1);

  // 另一本仍是默认值 —— 证明关联是按 uuid 精确匹配的
  const huo = data.books.find((b) => b.uuid === U2);
  assert.equal(huo.reading.status, 'wish');
  assert.equal(huo.reading.is_default, true);
});

test('status 过滤在 Node 侧生效(calibre 不认识 status)', async () => {
  const done = await getJson('/api/calibre/books?status=done');
  assert.equal(done.data.books.length, 1);
  assert.equal(done.data.books[0].uuid, U1);

  const wish = await getJson('/api/calibre/books?status=wish');
  assert.equal(wish.data.books.length, 1);
  assert.equal(wish.data.books[0].uuid, U2);
});

test('单本按 uuid 查询:关联键确实以 uuid 发出(id_is_uuid=true)', async () => {
  const { res, data } = await getJson(`/api/calibre/books/${U1}`);
  assert.equal(res.status, 200);
  assert.equal(data.book.uuid, U1);
  assert.equal(data.book.title, '三体');
  assert.equal(data.book.id, 1);
  // 前面已把 U1 标成 done,这里应带出真实阅读状态
  assert.equal(data.book.reading.status, 'done');
  assert.equal(data.book.reading.is_default, false);
});

test('单本:uuid 不存在 → 404 NOT_FOUND', async () => {
  const { res, data } = await getJson('/api/calibre/books/99999999-9999-4999-8999-999999999999');
  assert.equal(res.status, 404);
  assert.equal(data.code, 'NOT_FOUND');
});

test('封面流式转发:Content-Type 与 ETag 原样透传', async () => {
  const res = await fetch(`${baseUrl}/api/calibre/cover/1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('etag'), '"mock-etag"');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 0);
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
});

test('缩略图转发带 sz 参数', async () => {
  const res = await fetch(`${baseUrl}/api/calibre/thumb/1?sz=300x400`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('库信息透传', async () => {
  const { data } = await getJson('/api/calibre/library');
  assert.equal(data.default_library, 'lib1');
  assert.equal(data.library_map.lib1, '主库');
});

test('全文检索:合并 calibre 命中与本地阅读状态', async () => {
  const { data } = await getJson('/api/calibre/search?q=三体');
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].title, '三体');
  assert.equal(data.results[0].uuid, U1);
  // 前面已把 U1 标成 done
  assert.equal(data.results[0].reading.status, 'done');
});

test('统计:合并阅读状态(本地)与标签分布(calibre)', async () => {
  const { data } = await getJson('/api/calibre/stats?with_tags=true');
  assert.equal(data.total, 2);          // calibre 总藏书
  assert.equal(data.recorded, 1);       // 已有阅读记录
  assert.equal(data.byStatus.done, 1);
  assert.deepEqual(data.byYear, { 2022: 1 });
  // 标签来自 calibre:科幻 + 小说×2
  const tags = Object.fromEntries(data.topTags.map((t) => [t.tag, t.count]));
  assert.equal(tags['科幻'], 1);
  assert.equal(tags['小说'], 2);
  // 格式统计
  assert.equal(data.byFormat.EPUB, 2);
  assert.equal(data.byFormat.MOBI, 1);
});

test('统计可跳过标签扫描(with_tags=false)', async () => {
  const { data } = await getJson('/api/calibre/stats?with_tags=false');
  assert.equal(data.recorded, 1);
  assert.deepEqual(data.topTags, []);
});

test('calibre 不可用时回 502 + CALIBRE_UNAVAILABLE(且不抛 500)', async () => {
  const saved = process.env.CALIBRE_URL;
  // 指向一个必然连不上的端口
  process.env.CALIBRE_URL = 'http://127.0.0.1:1/calibre';
  // calibre.js 在模块加载时读 BASE,故需清缓存重新加载
  delete require.cache[require.resolve('../src/db/calibre')];
  delete require.cache[require.resolve('../src/http/routes.calibre')];
  const express = require('express');
  const routesCalibre = require('../src/http/routes.calibre');
  const app = express();
  app.use(express.json());
  app.use(routesCalibre);
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/calibre/books`);
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.code, 'CALIBRE_UNAVAILABLE');
    assert.match(body.error, /calibre/);
  } finally {
    await new Promise((r) => srv.close(r));
    process.env.CALIBRE_URL = saved;
    delete require.cache[require.resolve('../src/db/calibre')];
    delete require.cache[require.resolve('../src/http/routes.calibre')];
  }
});
