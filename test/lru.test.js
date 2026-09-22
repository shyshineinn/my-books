/* ============================================================
 * LRU 缓存(src/http/lru.js)行为测试
 * ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const { LruCache } = require('../src/http/lru');

test('容量 1:写入新键淘汰旧键', () => {
  const c = new LruCache(1);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.has('a'), false);
  assert.equal(c.get('b'), 2);
  assert.equal(c.evictions, 1);
});

test('get 命中会把条目提到最新位,免于淘汰', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');           // a 变最新,b 成最旧
  c.set('c', 3);        // 淘汰 b
  assert.equal(c.has('a'), true);
  assert.equal(c.has('b'), false);
  assert.equal(c.get('c'), 3);
});

test('get 未命中返回 undefined 且计 miss', () => {
  const c = new LruCache(3);
  assert.equal(c.get('nope'), undefined);
  assert.equal(c.misses, 1);
  assert.equal(c.hits, 0);
});

test('重复 set 同一 key:更新值、不新增条目、不淘汰', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 10);       // 更新,不淘汰 b
  assert.equal(c.size, 2);
  assert.equal(c.get('a'), 10);
  assert.equal(c.has('b'), true);
  assert.equal(c.evictions, 0);
});

test('达到容量上限前不淘汰', () => {
  const c = new LruCache(3);
  for (let i = 0; i < 3; i++) c.set(`k${i}`, i);
  assert.equal(c.evictions, 0);
  assert.equal(c.size, 3);
});

test('stats 返回命中/未命中/淘汰计数', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.get('zzz');
  c.set('c', 3);
  const s = c.stats();
  assert.deepEqual(s, { size: 2, capacity: 2, hits: 1, misses: 1, evictions: 1 });
});

test('非法容量抛异常', () => {
  assert.throws(() => new LruCache(0));
  assert.throws(() => new LruCache(-1));
  assert.throws(() => new LruCache(1.5));
});
