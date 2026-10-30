/* ============================================================
 * 首页 / 榜单 feed:只返回会渲染的少量书,选取顺序与旧前端一致
 * ============================================================ */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mybooks-feeds-'));
process.env.MYBOOKS_STORAGE_DIR = root;
process.env.MYBOOKS_SEED_DEMO = 'false';

const { db } = require('../src/db/index.js');
const { homeFeed, rankFeed } = require('../src/db/feeds.js');
const routesFeeds = require('../src/http/routes.feeds.js');

const app = express();
app.use(routesFeeds);
let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function reset() {
  db.exec('DELETE FROM books');
}

let seq = 0;
function add(title, { status = 'done', readCount = 0, finish = '' } = {}) {
  seq += 1;
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  db.prepare(`
    INSERT INTO books (title, author, status, tags, read_count, finish_date, read_logs, created_at, updated_at)
    VALUES (?, '', ?, '[]', ?, ?, '[]', ?, ?)
  `).run(title, status, readCount, finish, ts, ts);
}

const titles = (rows) => rows.map((b) => b.title);

test('homeFeed:有重读时按次数选大屏,画廊按旧顺序拼接', () => {
  reset();
  add('A', { readCount: 3, finish: '2024-01-03' });
  add('B', { readCount: 3, finish: '2024-01-04' });
  add('C', { readCount: 2, finish: '2024-01-05' });
  add('D', { readCount: 1, finish: '2024-01-01' });
  add('E', { status: 'wish' });
  add('F', { status: 'reading' });

  const feed = homeFeed(db, { gridMax: 1, entLimit: 3 });
  assert.equal(feed.featured.title, 'B');
  assert.deepEqual(titles(feed.grid), ['A']);
  assert.deepEqual(titles(feed.gallery), ['C', 'D', 'F']);
});

test('homeFeed:没有重读时回退全部已读,未读完进画廊', () => {
  reset();
  add('旧书', { readCount: 1 });
  add('新书', { readCount: 0 });
  add('想读', { status: 'wish' });

  const feed = homeFeed(db, { gridMax: 1, entLimit: 3 });
  assert.equal(feed.featured.title, '新书');
  assert.deepEqual(titles(feed.grid), ['旧书']);
  assert.deepEqual(titles(feed.gallery), ['想读']);
});

test('homeFeed:空库返回空结构', () => {
  reset();
  assert.deepEqual(homeFeed(db, { gridMax: 4, entLimit: 16 }), {
    featured: null, grid: [], gallery: [],
  });
});

test('rankFeed:总数/已读数与重读榜,排序与旧前端一致', () => {
  reset();
  add('A', { readCount: 3, finish: '2024-01-01' });
  add('B', { readCount: 3, finish: '2024-01-02' });
  add('C', { readCount: 1 });
  add('D', { status: 'wish' });

  const feed = rankFeed(db, { size: 1 });
  assert.equal(feed.total, 4);
  assert.equal(feed.done, 3);
  assert.deepEqual(titles(feed.reread), ['B']);
});

test('HTTP feed:返回 JSON 并带 no-store', async () => {
  reset();
  add('A', { readCount: 2 });
  const home = await fetch(`${base}/api/home/feed?grid=1&ent=3`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('cache-control'), /no-store/);
  assert.equal((await home.json()).featured.title, 'A');

  const rank = await fetch(`${base}/api/rank/feed?size=8`);
  assert.equal(rank.status, 200);
  const body = await rank.json();
  assert.equal(body.total, 1);
  assert.equal(body.done, 1);
  assert.deepEqual(titles(body.reread), ['A']);
});