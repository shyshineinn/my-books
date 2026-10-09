/* ============================================================
 * 本地预览用的假 calibre(开发/验收用,不要部署到生产)
 *
 * 用途:开发机上通常没装 calibre,但又需要验证新前端。
 * 这个脚本起一个实现 calibre 只读接口的假服务,字段形状与
 * 真实 calibre 一致(照着 srv/ajax.py 与 srv/metadata.py 的返回结构写),
 * 让 public/next/ 的界面能被真实渲染出来。
 *
 * 用法:
 *   # 终端 1
 *   node deploy/mock-calibre.js            # 默认 3003
 *   # 终端 2
 *   CALIBRE_URL=http://127.0.0.1:3003/calibre PORT=3002 node server.js
 *   # 浏览器打开 http://127.0.0.1:3002/next/
 *
 * 只实现只读接口(/ajax/*、/get/*、/fts/search)。写操作一律 403 ——
 * 因为真实架构下前端根本不写 calibre,写的是 reading.db。
 * ============================================================ */

const http = require('node:http');

const PORT = Number(process.env.MOCK_CALIBRE_PORT || 3003);

/* 封面占位图:SVG 转 PNG 太麻烦,直接给一个极小的合法 PNG。
   真实场景下 calibre 返回真封面,这里只为让 <img> 不报错。 */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAACWCAYAAAC/vElzAAAAAXNSR0IArs4c6QAAAARnQU1BAACx' +
  'jwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADkSURBVHhe7dExAQAADMOg+TfdmcgDkoDb' +
  '3TsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4NcAdL0AAWTZ' +
  'U9sAAAAASUVORK5CYII=',
  'base64',
);

/* 假书库:字段名、类型都对齐真实 calibre 的 /ajax/books 返回 */
const BOOKS = {
  1: {
    uuid: '11111111-1111-4111-8111-111111111111',
    title: '三体', authors: ['刘慈欣'], author_sort: 'Liu, Cixin',
    title_sort: '三体', sort: '三体',
    tags: ['科幻', '小说'], series: '地球往事', series_index: 1.0,
    publisher: '重庆出版社',
    comments: '<p>文化大革命期间,军方在太行山发现秘密基地,一场跨越四个世纪的文明博弈就此展开。</p>',
    languages: ['zho'], identifiers: { isbn: '9787536692930', douban: '2567698' },
    pubdate: '2008-01-01T00:00:00+00:00',
    timestamp: '2020-01-01T00:00:00+00:00',
    last_modified: '2020-01-02T00:00:00+00:00',
    rating: 5, formats: ['EPUB', 'MOBI', 'AZW3'],
    format_metadata: { EPUB: { size: 1048576, mtime: '2020-01-01T00:00:00+00:00' } },
  },
  2: {
    uuid: '22222222-2222-4222-8222-222222222222',
    title: '活着', authors: ['余华'], author_sort: 'Yu, Hua',
    title_sort: '活着', sort: '活着',
    tags: ['小说', '中国文学'], series: '', series_index: null,
    publisher: '作家出版社',
    comments: '<p>地主少爷福贵嗜赌成性输光家业,此后历经战乱与饥荒,亲人一个个先他而去,而他还活着。</p>',
    languages: ['zho'], identifiers: { isbn: '9787506365437' },
    pubdate: '2012-08-01T00:00:00+00:00',
    timestamp: '2021-03-01T00:00:00+00:00',
    last_modified: '2021-03-02T00:00:00+00:00',
    rating: 5, formats: ['EPUB'],
    format_metadata: { EPUB: { size: 524288, mtime: '2021-03-01T00:00:00+00:00' } },
  },
  3: {
    uuid: '33333333-3333-4333-8333-333333333333',
    title: '人类简史', authors: ['尤瓦尔·赫拉利'], author_sort: 'Harari, Yuval',
    title_sort: '人类简史', sort: '人类简史',
    tags: ['历史', '社科'], series: '', series_index: null,
    publisher: '中信出版社',
    comments: '<p>从认知革命到科学革命,重新理解人类如何成为地球的主宰。</p>',
    languages: ['zho'], identifiers: { isbn: '9787508647357' },
    pubdate: '2014-11-01T00:00:00+00:00',
    timestamp: '2022-06-01T00:00:00+00:00',
    last_modified: '2022-06-02T00:00:00+00:00',
    rating: 4, formats: ['EPUB', 'PDF'],
    format_metadata: { EPUB: { size: 2097152, mtime: '2022-06-01T00:00:00+00:00' } },
  },
  4: {
    uuid: '44444444-4444-4444-8444-444444444444',
    title: '沙丘', authors: ['弗兰克·赫伯特'], author_sort: 'Herbert, Frank',
    title_sort: '沙丘', sort: '沙丘',
    tags: ['科幻', '小说'], series: '沙丘', series_index: 1.0,
    publisher: '江苏凤凰文艺出版社',
    comments: '<p>厄拉科斯星球上的香料、沙虫与家族复仇。</p>',
    languages: ['zho'], identifiers: {},
    pubdate: '2017-01-01T00:00:00+00:00',
    timestamp: '2023-02-01T00:00:00+00:00',
    last_modified: '2023-02-02T00:00:00+00:00',
    rating: 0, formats: ['EPUB'],
    format_metadata: { EPUB: { size: 1572864, mtime: '2023-02-01T00:00:00+00:00' } },
  },
  5: {
    uuid: '55555555-5555-4555-8555-555555555555',
    title: '银河系漫游指南', authors: ['道格拉斯·亚当斯'], author_sort: 'Adams, Douglas',
    title_sort: '银河系漫游指南', sort: '银河系漫游指南',
    tags: ['科幻', '幽默'], series: '', series_index: null,
    publisher: '上海译文出版社',
    comments: '<p>别慌。答案是 42。</p>',
    languages: ['zho'], identifiers: {},
    pubdate: '2013-05-01T00:00:00+00:00',
    timestamp: '2023-08-01T00:00:00+00:00',
    last_modified: '2023-08-02T00:00:00+00:00',
    rating: 3, formats: ['EPUB', 'MOBI'],
    format_metadata: { EPUB: { size: 786432, mtime: '2023-08-01T00:00:00+00:00' } },
  },
};

function json(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    // 真实 calibre 的 Server 头(用于确认我们确实在跟它说话)
    Server: 'calibre 9.15.0 (mock)',
  });
  res.end(body);
}

/* 排序:模拟 calibre 的 sort 参数(它按字段 + sort_order 排) */
function sortIds(ids, sort, order) {
  const key = (id) => {
    const b = BOOKS[id];
    if (sort === 'timestamp') return b.timestamp;
    if (sort === 'last_modified') return b.last_modified;
    if (sort === 'authors' || sort === 'author_sort') return b.author_sort;
    if (sort === 'pubdate') return b.pubdate;
    return b.title_sort || b.title;
  };
  const arr = [...ids].sort((x, y) => String(key(x)).localeCompare(String(key(y)), 'zh'));
  return order === 'desc' ? arr.reverse() : arr;
}

/* 极简搜索:标题/作者/标签包含即命中(真实 calibre 是完整查询语言) */
function searchIds(query) {
  const all = Object.keys(BOOKS);
  if (!query || !query.trim()) return all;
  const q = query.trim().toLowerCase();
  // 支持 calibre 语法的一小部分:status:"x" 之类不认,直接当自由文本
  return all.filter((id) => {
    const b = BOOKS[id];
    return (b.title + ' ' + b.authors.join(' ') + ' ' + (b.tags || []).join(' ')
      + ' ' + (b.comments || '') + ' ' + (b.publisher || '')).toLowerCase().includes(q);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // 剥掉 --url-prefix /calibre
  const p = url.pathname.replace(/^\/calibre/, '') || '/';

  console.log(`${req.method} ${url.pathname}${url.search}`);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // 真实架构下前端不写 calibre(写的是 reading.db),所以这里一律拒绝
    return json(res, { err: 'mock calibre 是只读的;写操作请走 /api/reading/*' }, 403);
  }

  // 根路径:真实 calibre 返回自家 SPA;这里给出提示
  if (p === '/' || p === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>mock calibre</title>
<body style="font:15px/1.6 -apple-system,sans-serif;max-width:40em;margin:4em auto;padding:0 1em">
<h1>mock calibre</h1>
<p>这是开发用的假后端,只实现只读接口。真实的 calibre 阅读器 SPA 在这里。</p>
<p>本机已有 ${Object.keys(BOOKS).length} 本假书。</p>
<p>请打开 <a href="/next/">/next/</a> 查看新前端。</p>
<p style="color:#888;font-size:13px">生产环境请用 deploy/setup-calibre.sh 安装真的 calibre。</p>
</body>`);
  }

  // —— 库信息 ——
  if (p === '/ajax/library-info') {
    return json(res, { library_map: { mocklib: '演示书库' }, default_library: 'mocklib' });
  }

  // —— 搜索:只返回 book_ids(与真实 calibre 一致)——
  if (p === '/ajax/search') {
    const q = url.searchParams.get('query') || '';
    const num = parseInt(url.searchParams.get('num') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const sort = url.searchParams.get('sort') || 'title';
    const order = url.searchParams.get('sort_order') || 'asc';

    let ids = sortIds(searchIds(q), sort, order);
    const total = ids.length;
    ids = ids.slice(offset, offset + num);

    return json(res, {
      total_num: total, offset, num: ids.length, sort, sort_order: order,
      query: q, library_id: 'mocklib', book_ids: ids.map(Number),
    });
  }

  // —— 批量元数据:返回 {数字id: {...}} 字典 ——
  if (p === '/ajax/books') {
    const idsParam = url.searchParams.get('ids');
    const idIsUuid = url.searchParams.get('id_is_uuid') === 'true';
    let want;
    if (idsParam === 'all') {
      want = Object.keys(BOOKS);
    } else if (idIsUuid) {
      // 真实 calibre 用 lookup_by_uuid 解析(ajax.py:205)
      want = String(idsParam).split(',').map((u) => (
        Object.keys(BOOKS).find((k) => BOOKS[k].uuid === u.trim())
      )).filter(Boolean);
    } else {
      want = String(idsParam).split(',').map((s) => s.trim());
    }
    const out = {};
    for (const id of want) if (BOOKS[id]) out[id] = BOOKS[id];
    return json(res, out);
  }

  // —— 单本(注意真实 calibre 会 pop 掉 db_id,这里也照做以贴近真实)——
  if (p.startsWith('/ajax/book/')) {
    const raw = decodeURIComponent(p.slice('/ajax/book/'.length));
    const idIsUuid = url.searchParams.get('id_is_uuid') === 'true';
    const id = idIsUuid ? Object.keys(BOOKS).find((k) => BOOKS[k].uuid === raw) : raw;
    if (!id || !BOOKS[id]) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<html><body>No book with id</body></html>');
    }
    // 真实 calibre 的 book_to_json 会删掉这些键(srv/ajax.py:67)
    const copy = { ...BOOKS[id] };
    for (const k of ['publication_type', 'size', 'db_id', 'lpath', 'mime', 'rights', 'book_producer']) {
      delete copy[k];
    }
    return json(res, copy);
  }

  // —— 分类(标签树):真实 calibre 返回 {root:{id,children}, item_map:{}} ——
  if (p === '/ajax/categories' || p.startsWith('/ajax/categories/')) {
    const itemMap = {};
    const children = [];
    // 按标签聚合成一个扁平分类,够前端验证渲染
    const tagCount = {};
    for (const id of Object.keys(BOOKS)) {
      for (const t of BOOKS[id].tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    }
    let n = 0;
    const tagChildren = [];
    for (const [tag, count] of Object.entries(tagCount).sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
      const nid = `n${n++}`;
      itemMap[nid] = { category: 'tags', name: tag, count, is_category: false, is_editable: true };
      tagChildren.push({ id: nid, children: [] });
    }
    const cid = 'c0';
    itemMap[cid] = { category: 'tags', name: '标签', is_category: true, count: tagChildren.length };
    children.push({ id: cid, children: tagChildren });
    return json(res, { root: { id: null, children }, item_map: itemMap });
  }

  // —— 全文检索 ——
  if (p === '/fts/search') {
    const q = url.searchParams.get('query') || '';
    const hits = searchIds(q);
    const metadata = {};
    const results = [];
    for (const id of hits) {
      metadata[id] = {
        title: BOOKS[id].title,
        authors: BOOKS[id].authors.join(' & '),
        uuid: BOOKS[id].uuid,
      };
      results.push({ book_id: Number(id), text: BOOKS[id].title });
    }
    return json(res, {
      indexing_status: { left: 0, total: Object.keys(BOOKS).length },
      metadata, results,
    });
  }

  // —— 封面 / 缩略图 / 正文 ——
  if (p.startsWith('/get/')) {
    const parts = p.split('/').filter(Boolean); // ['get', what, id...]
    const what = parts[1];
    if (what === 'cover' || what === 'thumb') {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': PLACEHOLDER_PNG.length,
        ETag: '"mock-cover-etag"',
        'Cache-Control': 'public',
      });
      return res.end(PLACEHOLDER_PNG);
    }
    // 正文:返回一段无害文本,证明路由通了
    const body = Buffer.from(`mock calibre file: ${what}\n`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    return res.end(body);
  }

  // —— OPDS ——
  if (p === '/opds') {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    return res.end('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>mock</title></feed>');
  }

  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end(`<html><body><h1>404</h1><p>mock calibre 未实现:${p}</p></body></html>`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock calibre 已启动: http://127.0.0.1:${PORT}/calibre/`);
  console.log(`共 ${Object.keys(BOOKS).length} 本假书。只读接口。`);
  console.log('');
  console.log('配合使用:');
  console.log(`  CALIBRE_URL=http://127.0.0.1:${PORT}/calibre PORT=3002 node server.js`);
  console.log('  浏览器打开 http://127.0.0.1:3002/next/');
});
