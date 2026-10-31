/* ============================================================
 * My books · Liquid Glass 渲染层
 *
 * 真实折射只在 Chromium 上启用：backdrop-filter 引用一个由
 * feDisplacementMap 构成的 SVG 滤镜，位移贴图是圆角矩形 SDF 的
 * 法线场（中心清晰、边缘朝外弯折），直接采样浏览器实时合成后的
 * 背景 —— 不克隆页面 DOM，不复制背景图，滚动/动画都实时跟随。
 *
 * Safari / Firefox 等不支持把 SVG 滤镜放进 backdrop-filter 的
 * 浏览器只使用磨砂材质（blur + saturate + 边缘高光），不伪装折射。
 *
 * 贴图是静态的，不运行 feTurbulence 动画；滤镜按几何 + 光学参数
 * 复用，元素移除/隐藏/降级时归还引用。声明方式：
 *   <div data-glass="refract">…</div>   可参与实时折射的小控件
 *   <div data-glass="frost">…</div>     只使用磨砂材质
 *   <div data-glass="off">…</div>       不处理
 *
 * 位移贴图的圆角矩形 SDF 思路来自 @tomagranate/liquid-glass
 * (MIT, https://github.com/tomagranate/liquid-glass)，此处重写为
 * 无依赖、面向 backdrop-filter 的实现；许可与版权见
 * THIRD_PARTY_NOTICES.md 与 public/vendor/liquid-glass/LICENSE。
 * ============================================================ */

(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LiquidGlass = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MODE_KEY = 'mybooks.glass.mode';
  const MODES = ['auto', 'full', 'frost', 'solid'];
  const TIER_LABEL = { full: '完整折射', frost: '磨砂玻璃', solid: '纯色' };
  const REFRACT_LIMIT = 14;
  const REFRACT_LIMIT_COMPACT = 10;

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeMode(value) {
    const mode = String(value || '').toLowerCase();
    return MODES.includes(mode) ? mode : 'auto';
  }

  /* ---------- 环境与分级 ---------- */

  function detectEnvironment(win) {
    const nav = win.navigator || {};
    const ua = String(nav.userAgent || '');
    const isIOS = /iPad|iPhone|iPod/.test(ua)
      || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
    const isFirefox = /Firefox|FxiOS/i.test(ua);
    // iOS 上的 Chrome/Edge 仍是 WebKit，不支持 url() 形式的 backdrop-filter。
    const isWebKit = isIOS || (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/i.test(ua));
    let supportsBackdrop = false;
    let supportsUrl = false;
    try {
      const css = win.CSS;
      supportsBackdrop = !!(css && (css.supports('backdrop-filter', 'blur(1px)')
        || css.supports('-webkit-backdrop-filter', 'blur(1px)')));
      supportsUrl = !!(css && (css.supports('backdrop-filter', 'url("#lg-probe")')
        || css.supports('-webkit-backdrop-filter', 'url("#lg-probe")')));
    } catch { /* ignore */ }
    const mq = (query) => {
      try { return !!(win.matchMedia && win.matchMedia(query).matches); } catch { return false; }
    };
    return {
      ua,
      isFirefox,
      isWebKit,
      coarse: mq('(pointer: coarse)'),
      reducedMotion: mq('(prefers-reduced-motion: reduce)'),
      reducedTransparency: mq('(prefers-reduced-transparency: reduce)'),
      saveData: !!(nav.connection && nav.connection.saveData),
      deviceMemory: Number(nav.deviceMemory) || 0,
      cores: Number(nav.hardwareConcurrency) || 0,
      supportsBackdrop,
      supportsUrl,
    };
  }

  function resolveTier(options = {}) {
    const mode = normalizeMode(options.mode);
    const supportsBackdrop = options.supportsBackdrop !== false;
    if (!supportsBackdrop) return 'solid';
    if (mode === 'solid') return 'solid';
    if (options.reducedTransparency) return 'solid';
    if (mode === 'frost') return 'frost';
    // CSS.supports 对 url() 在 Safari 上可能过于乐观；WebKit/Firefox 一律不启用。
    const canRefract = options.supportsUrl !== false
      && !options.isWebKit && !options.isFirefox;
    if (mode === 'full') return canRefract ? 'full' : 'frost';
    if (options.saveData) return 'frost';
    if ((options.deviceMemory && options.deviceMemory <= 2)
      || (options.cores && options.cores <= 2)) return 'frost';
    return canRefract ? 'full' : 'frost';
  }

  /* ---------- 几何与位移贴图 ---------- */

  function sdfRoundRect(px, py, halfW, halfH, radius) {
    const qx = Math.abs(px) - (halfW - radius);
    const qy = Math.abs(py) - (halfH - radius);
    return Math.min(Math.max(qx, qy), 0)
      + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
  }

  function smoothstep(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  function bucket(value, step) {
    return Math.max(step, Math.round(value / step) * step);
  }

  function geometryFor(width, height, radius, options = {}) {
    const w = bucket(Math.max(1, Number(width) || 0), 4);
    const h = bucket(Math.max(1, Number(height) || 0), 4);
    const maxRadius = Math.min(w, h) / 2;
    const r = clamp(radius, 0, maxRadius);
    // 深度也基于分桶后的尺寸，1–3px 的布局抖动不会让同款控件换一份贴图。
    const depth = clamp(Math.min(w, h) * (options.depthRatio || 0.16), 5, options.maxDepth || 20);
    const maxScale = clamp(options.scale || 18, 4, 32);
    const scale = clamp(depth * 1.35, 5, maxScale);
    const chroma = clamp(options.chroma == null ? 0.45 : options.chroma, 0, 1);
    return {
      width: w,
      height: h,
      radius: bucket(r, 2),
      depth: Math.round(depth * 10) / 10,
      scale: Math.round(scale * 10) / 10,
      chroma: Math.round(chroma * 100) / 100,
    };
  }

  function buildFilterKey(geometry, dpr) {
    return [geometry.width, geometry.height, geometry.radius,
      geometry.depth, geometry.scale, geometry.chroma, dpr].join(':');
  }

  /**
   * 生成滤镜区域（元素外扩 10%）的 RGBA 位移贴图。
   * R/G = 法线方向 × 边缘衰减，中心为 128（无位移）。
   */
  function createDisplacementMap(doc, geometry, dpr) {
    const margin = 0.1;
    const regionW = geometry.width * (1 + margin * 2);
    const regionH = geometry.height * (1 + margin * 2);
    let scale = clamp(dpr || 1, 1, 2);
    while (regionW * regionH * scale * scale > 640 * 640 && scale > 1) scale *= 0.8;
    const w = Math.max(2, Math.round(regionW * scale));
    const h = Math.max(2, Math.round(regionH * scale));
    const canvas = doc.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const image = ctx.createImageData(w, h);
    const data = image.data;

    const cx = w / 2;
    const cy = h / 2;
    const halfW = (geometry.width * scale) / 2;
    const halfH = (geometry.height * scale) / 2;
    const radius = Math.min(geometry.radius * scale, halfW, halfH);
    const rim = Math.max(1, geometry.depth * scale);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const px = x + 0.5 - cx;
        const py = y + 0.5 - cy;
        const sdf = sdfRoundRect(px, py, halfW, halfH, radius);
        if (sdf >= 0) {
          data[i] = 128;
          data[i + 1] = 128;
          data[i + 2] = 128;
          data[i + 3] = 255;
          continue;
        }
        let gx = sdfRoundRect(px + 1, py, halfW, halfH, radius)
          - sdfRoundRect(px - 1, py, halfW, halfH, radius);
        let gy = sdfRoundRect(px, py + 1, halfW, halfH, radius)
          - sdfRoundRect(px, py - 1, halfW, halfH, radius);
        const len = Math.hypot(gx, gy) || 1;
        gx /= len;
        gy /= len;
        const magnitude = 1 - smoothstep(-sdf / rim);
        data[i] = clamp((0.5 + 0.5 * gx * magnitude) * 255, 0, 255) | 0;
        data[i + 1] = clamp((0.5 + 0.5 * gy * magnitude) * 255, 0, 255) | 0;
        data[i + 2] = 128;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  }

  function svgEl(doc, name, attrs = {}) {
    const node = doc.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach((key) => node.setAttribute(key, attrs[key]));
    return node;
  }

  function buildFilterNode(doc, id, geometry, dpr) {
    const mapUrl = createDisplacementMap(doc, geometry, dpr);
    if (!mapUrl) return null;
    const filter = svgEl(doc, 'filter', {
      id,
      x: '-10%',
      y: '-10%',
      width: '120%',
      height: '120%',
      filterUnits: 'objectBoundingBox',
      primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB',
    });
    filter.appendChild(svgEl(doc, 'feImage', {
      href: mapUrl,
      x: '0',
      y: '0',
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'none',
      result: 'lg-map',
    }));

    const scale = geometry.scale;
    const chroma = geometry.chroma;
    if (chroma > 0) {
      // 三通道用略微不同的位移强度采样，再按通道合成：边缘产生轻微色散。
      const passes = [
        ['disp-r', scale * (1 + 0.12 * chroma), '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', 'lg-r'],
        ['disp-g', scale, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', 'lg-g'],
        ['disp-b', scale * (1 - 0.12 * chroma), '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0', 'lg-b'],
      ];
      passes.forEach(([result, amount, matrix, channel]) => {
        filter.appendChild(svgEl(doc, 'feDisplacementMap', {
          in: 'SourceGraphic',
          in2: 'lg-map',
          scale: String(amount),
          xChannelSelector: 'R',
          yChannelSelector: 'G',
          result,
        }));
        filter.appendChild(svgEl(doc, 'feColorMatrix', {
          in: result,
          type: 'matrix',
          values: matrix,
          result: channel,
        }));
      });
      filter.appendChild(svgEl(doc, 'feComposite', {
        in: 'lg-r', in2: 'lg-g', operator: 'arithmetic',
        k1: '0', k2: '1', k3: '1', k4: '0', result: 'lg-rg',
      }));
      filter.appendChild(svgEl(doc, 'feComposite', {
        in: 'lg-rg', in2: 'lg-b', operator: 'arithmetic',
        k1: '0', k2: '1', k3: '1', k4: '0',
      }));
    } else {
      filter.appendChild(svgEl(doc, 'feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'lg-map',
        scale: String(scale),
        xChannelSelector: 'R',
        yChannelSelector: 'G',
      }));
    }
    return filter;
  }

  /* ---------- 滤镜注册表 ---------- */

  function createFilterRegistry() {
    const entries = new Map();
    let sequence = 0;
    const registry = {
      acquire(key, build) {
        const existing = entries.get(key);
        if (existing) {
          existing.refs += 1;
          return existing.id;
        }
        sequence += 1;
        const id = `lg-filter-${sequence}`;
        const node = build(id);
        if (!node) return null;
        entries.set(key, { id, node, refs: 1 });
        return id;
      },
      release(key) {
        const entry = entries.get(key);
        if (!entry) return;
        entry.refs -= 1;
        if (entry.refs > 0) return;
        if (entry.node && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
        entries.delete(key);
      },
      has(key) { return entries.has(key); },
      get size() { return entries.size; },
      ids() { return [...entries.values()].map((entry) => entry.id); },
      clear() {
        entries.forEach((entry) => {
          if (entry.node && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
        });
        entries.clear();
      },
    };
    return registry;
  }

  /* ---------- 模式持久化 ---------- */

  function readMode(win) {
    try {
      const fromUrl = normalizeMode(new URLSearchParams(win.location.search).get('glass'));
      if (win.location.search && /(?:^|[?&])glass=/.test(win.location.search)) return fromUrl;
    } catch { /* ignore */ }
    try {
      return normalizeMode(win.localStorage.getItem(MODE_KEY));
    } catch { return 'auto'; }
  }

  function writeMode(win, mode) {
    try { win.localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
  }

  /* ---------- 引擎 ---------- */

  function createEngine(win, options = {}) {
    const doc = win.document;
    const env = detectEnvironment(win);
    const registry = createFilterRegistry();
    const surfaces = new Map();
    const compactQuery = win.matchMedia ? win.matchMedia('(max-width: 560px)') : null;
    let mode = normalizeMode(options.mode || readMode(win));
    let tier = resolveTier({ ...env, mode });
    let defs = null;
    let frame = 0;
    let destroyed = false;
    let lastDpr = clamp(win.devicePixelRatio || 1, 1, 2);
    let mutation = null;
    let resizeHandler = null;
    let started = false;
    const mediaListeners = [];

    function dispatch(name, detail) {
      try {
        doc.dispatchEvent(new win.CustomEvent(name, { detail }));
      } catch { /* ignore */ }
    }

    function ensureDefs() {
      if (defs && defs.isConnected) return defs;
      if (!doc.body) return null;
      const svg = svgEl(doc, 'svg', {
        'data-lg-defs': '',
        'aria-hidden': 'true',
        focusable: 'false',
        width: '0',
        height: '0',
      });
      svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      const node = svgEl(doc, 'defs');
      svg.appendChild(node);
      doc.body.prepend(svg);
      defs = node;
      return defs;
    }

    function currentLimit() {
      const compact = compactQuery ? compactQuery.matches : false;
      return compact ? REFRACT_LIMIT_COMPACT : REFRACT_LIMIT;
    }

    function measure(el) {
      const css = win.getComputedStyle(el);
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      let radius = parseFloat(css.borderTopLeftRadius);
      if (!Number.isFinite(radius)) radius = 0;
      const scaleToken = parseFloat(css.getPropertyValue('--liquid-refraction'));
      const chromaToken = parseFloat(css.getPropertyValue('--liquid-chroma'));
      return geometryFor(width, height, radius, {
        scale: Number.isFinite(scaleToken) ? scaleToken : 18,
        chroma: Number.isFinite(chromaToken) ? chromaToken : 0.45,
        depthRatio: el.classList.contains('lg-bar') ? 0.14 : 0.16,
      });
    }

    function releaseFilter(surface) {
      if (surface.filterKey) registry.release(surface.filterKey);
      surface.filterKey = null;
      surface.filterId = null;
      surface.el.classList.remove('lg-refract');
      surface.el.style.removeProperty('--lg-filter');
    }

    function attachFilter(surface) {
      const geometry = measure(surface.el);
      const key = buildFilterKey(geometry, lastDpr);
      if (surface.filterKey === key && surface.filterId) return;
      releaseFilter(surface);
      const defsNode = ensureDefs();
      if (!defsNode) return;
      const id = registry.acquire(key, (filterId) => {
        const node = buildFilterNode(doc, filterId, geometry, lastDpr);
        if (node) defsNode.appendChild(node);
        return node;
      });
      if (!id) return;
      surface.filterKey = key;
      surface.filterId = id;
      surface.el.style.setProperty('--lg-filter', `url(#${id})`);
      surface.el.classList.add('lg-refract');
    }

    function rebalance() {
      frame = 0;
      if (destroyed) return;
      const candidates = [];
      surfaces.forEach((surface) => {
        const width = surface.el.offsetWidth;
        const height = surface.el.offsetHeight;
        surface.visible = width > 4 && height > 4 && surface.inView !== false;
        if (surface.kind === 'refract' || surface.kind === 'bar') {
          if (tier === 'full' && surface.visible) candidates.push(surface);
          else releaseFilter(surface);
        }
      });
      if (tier !== 'full') return;
      candidates.sort((a, b) => {
        const barA = a.kind === 'bar' ? 0 : 1;
        const barB = b.kind === 'bar' ? 0 : 1;
        if (barA !== barB) return barA - barB;
        return (a.el.offsetWidth * a.el.offsetHeight) - (b.el.offsetWidth * b.el.offsetHeight);
      });
      const limit = currentLimit();
      candidates.forEach((surface, index) => {
        if (index < limit) attachFilter(surface);
        else releaseFilter(surface);
      });
    }

    function schedule() {
      if (destroyed || frame) return;
      // 用定时器而不是 rAF：后台标签页/隐藏 iframe 会暂停 rAF，
      // 菜单刚显示时滤镜就永远挂不上；这里只需要一次性合并布局读取。
      frame = win.setTimeout(rebalance, 24);
    }

    function updateSize(surface) {
      const dpr = clamp(win.devicePixelRatio || 1, 1, 2);
      if (dpr !== lastDpr) {
        lastDpr = dpr;
        surfaces.forEach((item) => {
          if (item.filterKey) releaseFilter(item);
        });
      }
      schedule();
    }

    function attach(el) {
      if (!el || el.nodeType !== 1 || surfaces.has(el)) return;
      if (el.hasAttribute && el.hasAttribute('data-lg-defs')) return;
      const kind = String(el.dataset ? el.dataset.glass : '').toLowerCase();
      if (!kind || kind === 'off' || !['refract', 'frost', 'bar'].includes(kind)) return;
      const surface = {
        el,
        kind,
        inView: true,
        visible: false,
        filterKey: null,
        filterId: null,
        observer: null,
        intersection: null,
      };
      el.classList.add('lg-surface');
      if (kind === 'bar') el.classList.add('lg-bar');
      surfaces.set(el, surface);
      if (win.ResizeObserver) {
        surface.observer = new win.ResizeObserver(() => updateSize(surface));
        surface.observer.observe(el);
      }
      if (win.IntersectionObserver) {
        surface.intersection = new win.IntersectionObserver((entries) => {
          entries.forEach((entry) => { surface.inView = entry.isIntersecting; });
          schedule();
        });
        surface.intersection.observe(el);
      }
      schedule();
    }

    function detach(el) {
      const surface = surfaces.get(el);
      if (!surface) return;
      releaseFilter(surface);
      if (surface.observer) surface.observer.disconnect();
      if (surface.intersection) surface.intersection.disconnect();
      el.classList.remove('lg-surface', 'lg-bar', 'lg-refract');
      el.style.removeProperty('--lg-filter');
      surfaces.delete(el);
    }

    function detachWithin(node) {
      surfaces.forEach((surface) => {
        if (node === surface.el || (node.contains && node.contains(surface.el))) detach(surface.el);
      });
    }

    function scan(scope) {
      const rootNode = scope || doc;
      if (rootNode.nodeType === 1 && rootNode.matches && rootNode.matches('[data-glass]')) attach(rootNode);
      if (!rootNode.querySelectorAll) return;
      rootNode.querySelectorAll('[data-glass]').forEach(attach);
      schedule();
    }

    function applyTier() {
      tier = resolveTier({ ...env, mode });
      const html = doc.documentElement;
      html.dataset.glassTier = tier;
      html.dataset.glassMode = mode;
      html.dataset.glassMotion = env.reducedMotion ? 'reduced' : 'full';
      if (tier !== 'full') surfaces.forEach(releaseFilter);
      schedule();
      dispatch('glass-tier-changed', {
        mode,
        tier,
        label: TIER_LABEL[tier],
        requestedFull: mode === 'full',
      });
    }

    function setMode(next, options2 = {}) {
      mode = normalizeMode(next);
      if (options2.persist !== false) writeMode(win, mode);
      applyTier();
      return tier;
    }

    function refreshEnvironment() {
      Object.assign(env, detectEnvironment(win));
      applyTier();
    }

    function listenMedia(query, handler) {
      if (!win.matchMedia) return;
      const list = win.matchMedia(query);
      const listener = () => handler();
      if (list.addEventListener) list.addEventListener('change', listener);
      else if (list.addListener) list.addListener(listener);
      mediaListeners.push({ list, listener });
    }

    function start() {
      if (started) return;
      started = true;
      scan(doc);
      applyTier();
      // 首屏同步生成一次，避免模块/菜单首次出现时先看到磨砂再跳成折射。
      if (frame) {
        win.clearTimeout(frame);
        frame = 0;
      }
      rebalance();
      if (win.MutationObserver && doc.body) {
        mutation = new win.MutationObserver((records) => {
          let changed = false;
          records.forEach((record) => {
            const target = record.target;
            if (target && target.closest && target.closest('[data-lg-defs]')) return;
            if (record.type === 'attributes') {
              if (target && target.dataset && ['refract', 'frost', 'bar'].includes(String(target.dataset.glass || '').toLowerCase())) {
                attach(target);
              } else {
                detach(target);
              }
              changed = true;
              return;
            }
            record.addedNodes.forEach((node) => {
              if (node.nodeType !== 1 || (node.matches && node.matches('[data-lg-defs]'))) return;
              scan(node);
              changed = true;
            });
            record.removedNodes.forEach((node) => {
              if (node.nodeType !== 1) return;
              detachWithin(node);
              changed = true;
            });
          });
          if (changed) schedule();
        });
        mutation.observe(doc.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-glass'],
        });
      }
      resizeHandler = () => {
        const dpr = clamp(win.devicePixelRatio || 1, 1, 2);
        if (dpr !== lastDpr) updateSize({});
        else schedule();
      };
      win.addEventListener('resize', resizeHandler, { passive: true });
      listenMedia('(prefers-reduced-transparency: reduce)', refreshEnvironment);
      listenMedia('(prefers-reduced-motion: reduce)', refreshEnvironment);
      dispatch('glass-ready', { mode, tier, environment: { ...env } });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) {
        win.clearTimeout(frame);
        frame = 0;
      }
      if (mutation) mutation.disconnect();
      if (resizeHandler) win.removeEventListener('resize', resizeHandler);
      mediaListeners.forEach(({ list, listener }) => {
        if (list.removeEventListener) list.removeEventListener('change', listener);
        else if (list.removeListener) list.removeListener(listener);
      });
      [...surfaces.keys()].forEach(detach);
      registry.clear();
      if (defs && defs.parentNode && defs.parentNode.parentNode) defs.parentNode.parentNode.removeChild(defs.parentNode);
      defs = null;
      const html = doc.documentElement;
      delete html.dataset.glassTier;
      delete html.dataset.glassMode;
      delete html.dataset.glassMotion;
    }

    function getStats() {
      let refracting = 0;
      surfaces.forEach((surface) => {
        if (surface.el.classList.contains('lg-refract')) refracting += 1;
      });
      return {
        mode,
        tier,
        tierLabel: TIER_LABEL[tier],
        surfaces: surfaces.size,
        refracting,
        filters: registry.size,
        filterIds: registry.ids(),
        environment: { ...env },
      };
    }

    const engine = {
      start,
      scan,
      destroy,
      setMode,
      getStats,
      get mode() { return mode; },
      get tier() { return tier; },
      get environment() { return { ...env }; },
      refreshEnvironment,
    };
    return engine;
  }

  const api = {
    MODE_KEY,
    MODES,
    TIER_LABEL,
    version: '1.0.0',
    detectEnvironment,
    resolveTier,
    geometryFor,
    buildFilterKey,
    createFilterRegistry,
    createDisplacementMap,
    sdfRoundRect,
    normalizeMode,
    createEngine,
    start(options) {
      if (api.instance) return api.instance;
      const engine = createEngine(root && root.document ? root : globalThis, options);
      api.instance = engine;
      ['start', 'scan', 'destroy', 'setMode', 'getStats', 'refreshEnvironment'].forEach((name) => {
        api[name] = engine[name].bind(engine);
      });
      Object.defineProperties(api, {
        mode: { get: () => engine.mode, configurable: true },
        tier: { get: () => engine.tier, configurable: true },
        environment: { get: () => engine.environment, configurable: true },
      });
      engine.start();
      return engine;
    },
  };

  if (root && root.document) {
    const boot = () => {
      const body = root.document.body;
      if (body && body.dataset && body.dataset.glassAuto === 'off') return;
      api.start(body && body.dataset ? { mode: body.dataset.glassMode } : {});
    };
    if (root.document.readyState === 'complete' || root.document.readyState === 'interactive') {
      // defer 脚本执行时 DOM 已解析；等 DOMContentLoaded 让页面脚本先完成首屏渲染。
      if (root.document.readyState === 'interactive') {
        root.document.addEventListener('DOMContentLoaded', boot, { once: true });
      } else {
        boot();
      }
    } else {
      root.document.addEventListener('DOMContentLoaded', boot, { once: true });
    }
  }

  return api;
});
