const test = require('node:test');
const assert = require('node:assert/strict');
const glass = require('../public/js/liquid-glass.js');

test('Glass 档位：Full 只在 Chromium 实时折射，WebKit/Firefox 只走磨砂', () => {
  const base = { mode: 'auto', supportsBackdrop: true, supportsUrl: true };
  assert.equal(glass.resolveTier(base), 'full');
  assert.equal(glass.resolveTier({ ...base, mode: 'full' }), 'full');
  assert.equal(glass.resolveTier({ ...base, mode: 'frost' }), 'frost');
  assert.equal(glass.resolveTier({ ...base, mode: 'solid' }), 'solid');
  assert.equal(glass.resolveTier({ ...base, isWebKit: true }), 'frost');
  assert.equal(glass.resolveTier({ ...base, isFirefox: true }), 'frost');
  assert.equal(glass.resolveTier({ ...base, supportsUrl: false }), 'frost');
  assert.equal(glass.resolveTier({ ...base, supportsBackdrop: false }), 'solid');
  assert.equal(glass.resolveTier({ ...base, reducedTransparency: true }), 'solid');
  assert.equal(glass.resolveTier({ ...base, saveData: true }), 'frost');
});

test('Glass 几何：同尺寸共享、不同尺寸分开，折射与色散受 token 限制', () => {
  const a = glass.geometryFor(120, 36, 18, { scale: 12, chroma: 0.12 });
  const b = glass.geometryFor(119, 35, 18, { scale: 12, chroma: 0.12 });
  assert.deepEqual(a, b);
  assert.equal(glass.buildFilterKey(a, 1), glass.buildFilterKey(b, 1));
  const c = glass.geometryFor(260, 80, 18, { scale: 12, chroma: 0.12 });
  assert.notEqual(glass.buildFilterKey(a, 1), glass.buildFilterKey(c, 1));
  assert.ok(a.scale <= 12);
  assert.equal(a.chroma, 0.12);
});

test('Glass 滤镜池：同 key 复用、引用计数归零才删除、ID 不冲突', () => {
  const registry = glass.createFilterRegistry();
  const nodes = [];
  const make = (id) => {
    const node = { id, parentNode: { removeChild() {} } };
    nodes.push(node);
    return node;
  };
  const one = registry.acquire('a', make);
  const two = registry.acquire('a', make);
  assert.equal(one, two);
  assert.equal(registry.size, 1);
  registry.release('a');
  assert.equal(registry.size, 1);
  registry.release('a');
  assert.equal(registry.size, 0);
  const three = registry.acquire('b', make);
  assert.notEqual(three, one);
  registry.clear();
  assert.equal(registry.size, 0);
});
