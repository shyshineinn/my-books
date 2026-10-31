const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pages = ['public/index.html', 'public/shelf.html', 'public/rank.html', 'public/stats.html', 'public/tags.html', 'public/notes.html'];
const style = read('public/css/style.css');
const shelfCss = read('public/css/shelf-workbench.css');
const glassCss = read('public/css/liquid-glass.css');

function ruleBody(source, rawSelector) {
  const selector = rawSelector.replace(/\s*\{$/, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(source);
  if (!match) return '';
  const start = match.index + match[0].length - 1;
  const close = source.indexOf('}', start);
  return close > start ? source.slice(start + 1, close) : '';
}

test('全站使用冷白 token，不再有暖米白/登录彩虹场景', () => {
  assert.match(style, /--canvas:\s*#f5f5f7/i);
  assert.match(style, /--surface:\s*#ffffff/i);
  assert.match(style, /--surface-2:\s*#f2f2f5/i);
  assert.match(shelfCss, /--wb-canvas:\s*var\(--canvas/);
  assert.doesNotMatch(style + shelfCss + glassCss, /#f6f5f2|#f7f6f3|247, 246, 243|247 246 243/i);
  assert.doesNotMatch(glassCss, /rgba\(10, 132, 255|rgba\(255, 159, 10|rgba\(191, 90, 242|rgba\(48, 209, 88|#f8f5ef|#f7f9fd/i);
  assert.doesNotMatch(glassCss, /body\.login-page::(before|after)/);
});

test('玻璃参数克制且仍保留真实折射引擎', () => {
  assert.match(glassCss, /--liquid-refraction:\s*12/);
  assert.match(glassCss, /--liquid-chroma:\s*0\.12/);
  assert.match(glassCss, /--liquid-saturation:\s*140%/);
  assert.match(glassCss, /--liquid-opacity:\s*0\.76/);
  assert.match(glassCss, /backdrop-filter:\s*var\(--lg-filter/);
  const engine = read('public/js/liquid-glass.js');
  assert.match(engine, /feDisplacementMap/);
  assert.match(engine, /resolveTier/);
});

test('按钮/分段控件共享 control token，不再用黑/蓝实底表示选中', () => {
  assert.match(style, /--control-bg:/);
  assert.match(style, /--selected-bg:/);
  assert.match(ruleBody(style, '.btn {'), /var\(--control-bg\)/);
  assert.match(ruleBody(style, '.icon-btn {'), /var\(--control-bg\)/);
  assert.match(ruleBody(style, '.sel-trigger {'), /var\(--control-bg\)/);
  const segActive = ruleBody(style, '.seg button.active');
  assert.match(segActive, /var\(--selected-bg\)/);
  assert.doesNotMatch(segActive, /background:\s*(var\(--accent\)|#0066cc|#1d1d1f|var\(--wb-ink\))/i);
  const primary = ruleBody(style, '.btn-primary {');
  assert.match(primary, /var\(--accent\)/);
  assert.doesNotMatch(primary, /background:\s*(#0066cc|#0077ed|#1d1d1f|var\(--night\))/i);
  assert.doesNotMatch(shelfCss, /\.wb-inspector-status/);
  assert.doesNotMatch(ruleBody(shelfCss, '.wb-layout-seg button.active'), /var\(--wb-ink\)|#1d1d1f|#fff/);
  assert.doesNotMatch(ruleBody(shelfCss, '.wb-view button.active'), /var\(--wb-ink\)|#1d1d1f|#fff/);
  assert.match(ruleBody(shelfCss, '.wb-action'), /var\(--control/);
});

test('详情只剩一套：BookDetails 供 Inspector 与其他页面共用，旧 detailModal 已移除', () => {
  assert.match(read('public/js/common.js'), /window\.BookDetails\.create/);
  assert.match(read('public/js/shelf/inspector.js'), /BookDetails\.create/);
  assert.doesNotMatch(read('public/js/chrome.js'), /id="detailModal"|detailBody|detail-box/);
  assert.match(read('public/js/chrome.js'), /id="bookDetailModal"/);
  assert.match(read('public/js/chrome.js'), /id="bookDetailHost"/);
  assert.doesNotMatch(read('public/js/common.js'), /detailBody|detail-body|seriesHtml|identifiersHtml/);
  const main = read('public/js/shelf/main.js');
  assert.doesNotMatch(main, /openDetail\(Number\(target\.dataset\.id\)\)/);
  assert.match(main, /S\.inspector\.editBook/);
  const details = read('public/js/book-details.js');
  ['data-bd-status', 'data-bd-rating', 'data-bd-collection-add', 'data-bd-edit', 'data-bd-delete', 'data-bd-grabber'].forEach((needle) => {
    assert.ok(details.includes(needle), `book-details.js 缺少 ${needle}`);
  });
  assert.match(details, /onClose/);
  assert.match(details, /onChanged/);
  pages.forEach((page) => {
    assert.match(read(page), /\/js\/book-details\.js\?v=1/, `${page} 缺少统一详情组件`);
  });
});

test('双击/选择/键盘路径与资源版本保持接线', () => {
  const shelf = read('public/shelf.html');
  assert.ok(shelf.indexOf('/js/book-details.js') < shelf.indexOf('/js/shelf/inspector.js'));
  const versions = {
    'css/style.css': '112',
    'css/liquid-glass.css': '3',
    'css/shelf-workbench.css': '36',
    'js/chrome.js': '38',
    'js/common.js': '43',
    'js/modal.js': '2',
    'js/select.js': '3',
    'js/shelf/main.js': '37',
    'js/shelf/inspector.js': '37',
    'js/book-details.js': '1',
  };
  pages.forEach((page) => {
    const html = read(page);
    Object.entries(versions).forEach(([asset, version]) => {
      const re = new RegExp(`/${asset.replace(/[/.]/g, '\\$&')}\\?v=([0-9]+)`);
      const match = html.match(re);
      if (match) assert.equal(match[1], version, `${page} ${asset} 版本不一致`);
    });
  });
  const sw = read('public/sw.js');
  assert.match(sw, /CACHE_VERSION = 'v169'/);
  Object.entries(versions).forEach(([asset, version]) => {
    assert.match(sw, new RegExp(`'/${asset.replace(/[/.]/g, '\\$&')}\\?v=${version}'`), `sw.js 缺少 ${asset}@${version}`);
  });
  assert.match(sw, /'\/js\/book-details\.js\?v=1'/);
});
