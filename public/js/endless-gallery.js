/* ==========================================================================
 * 未完待续 · 复刻 apple.com 首页「Endless entertainment.」media-gallery
 *
 * 与 apple.com 线上实现对齐的要点:
 *   · 卡片绝对定位,用 translate3d 做位移,容器不滚动(apple 用同一套变换模型)
 *   · 位置用模运算取"最短路径",相邻卡片始终在左右各露一条边,循环时无跳变
 *   · 定时 dotnav:当前圆点展开为 32px 进度条,充满后自动翻页(apple 为 4.16s)
 *   · 播放 / 暂停圆钮、拖拽、方向键、离屏自动暂停、prefers-reduced-motion
 * ========================================================================== */
(function (global) {
  'use strict';

  var ITEM_MS = 4160;        // apple.com: 每张总周期 data-ac-gallery-item-duration = 4.16s
  var FILL_DELAY_MS = 160;   // apple.com: AutoPlay.transitionOffset = 0.16,进度条晚 160ms 起跑
  var SLIDE_MS = 1000;       // apple.com: model.Slide.duration = 1s(cubic-bezier(0.645,0.045,0.355,1))
  var SLIDE_EASE = 'cubic-bezier(0.645, 0.045, 0.355, 1)';   // apple animateToItem 默认缓动
  var FLICK_SPEED = 0.35;    // px/ms,超过即判定为"甩动"翻页
  var AXIS_LOCK = 5;         // 判定拖拽方向的位移阈值(px)
  var MAX_DOTS = 7;          // apple.com: 圆点超过 7 个才启用变距截断
  var TRUNC_MS = 420;        // 变距迁移动画的清理延时(320ms 过渡 + 余量)

  var reduceMotion = global.matchMedia
    ? global.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  function mod(v, m) { return ((v % m) + m) % m; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function EndlessGallery(root) {
    this.root = root;
    // 两排共用同一索引但各显示各的书:第二排按自身数量取模,所以依旧同频滑动
    this.rails = [];
    var self = this;
    ['.tv-media-gallery', '.fam-media-gallery'].forEach(function (name) {
      var wrap = root.querySelector(name);
      if (!wrap) return;
      var el = wrap.querySelector('.media-gallery-item-container');
      var items = Array.prototype.slice.call(wrap.querySelectorAll('.media-gallery-item'));
      if (el && items.length) self.rails.push({ el: el, items: items, count: items.length });
    });
    this.dotnav = root.querySelector('.media-gallery-dotnav');
    this.dots = Array.prototype.slice.call(root.querySelectorAll('.dotnav-item'));
    this.pauseBtn = root.querySelector('.media-gallery-dotnav-iconcontrol');
    this.n = this.rails.length ? this.rails[0].count : 0;

    this.index = 0;
    this.pos = 0;
    this.prevIndex = -1;
    this.visualIndex = 0;
    this._lastTruncIndex = 0;
    this._truncTimer = 0;
    this.playing = false;
    this.visible = true;
    this.sliding = false;      // CSS transition 滑动进行中
    this.slideTimer = 0;
    this._slideFrom = 0;       // 本次滑动的起点位置(供打断时反推当前位置)
    this._probeIndex = 0;      // 主排中未环回的卡,用于读插值矩阵
    this.holdId = 0;
    this.drag = null;
    this.suppressClick = false;
    this.destroyed = false;
    this.resizeId = 0;
    this._listeners = [];

    this._onResize = this._onResize.bind(this);
    this._onVisibility = this._onVisibility.bind(this);

    this._bind();
    this._observe();
    this.render();
    this._syncDots();
    this._updateTruncation(0);   // 初始窗口:圆点多于 7 个时只亮起当前点附近

    // 减少动效只影响滑动时长(见 _animateTo),不再整体停摆,否则圆点与轮播会完全静止
    if (this.n > 1) this.play();
    else this.pause();
  }

  /* ---------- 渲染 ---------- */

  EndlessGallery.prototype.render = function () {
    if (this.destroyed || !this.n) return;
    // 每排按自己的数量取模:位置函数对 local±count 不变,所以回绕时依旧连续
    for (var r = 0; r < this.rails.length; r++) {
      var rail = this.rails[r];
      var step = rail.items[0].offsetWidth;
      if (!step) continue;   // 视图被隐藏时量不到宽度,先不动,等重新显示后再算
      var local = mod(this.pos, rail.count);
      for (var i = 0; i < rail.count; i++) {
        var d = mod(i - local + rail.count / 2, rail.count) - rail.count / 2;
        rail.items[i].style.transform = 'translate3d(' + (d * step).toFixed(2) + 'px,0,0)';
      }
    }
  };

  EndlessGallery.prototype._syncDots = function () {
    var self = this;
    // 第一排:当前卡片可聚焦、可达;其余排只同步 current-item 视觉态
    this.rails.forEach(function (rail, r) {
      var primary = r === 0;
      var localCur = mod(self.index, rail.count);
      rail.items.forEach(function (el, i) {
        var on = i === localCur;
        el.classList.toggle('current-item', on);
        if (!primary) return;
        el.setAttribute('aria-hidden', on ? 'false' : 'true');
        var link = el.querySelector('.media-gallery-wrapper-link');
        if (link) link.setAttribute('tabindex', on ? '0' : '-1');
      });
    });
    this.dots.forEach(function (li, i) {
      li.classList.toggle('current', i === self.index);
      // 形态态跟随当前项(与 apple 一致,暂停时也保持展开轨道,由 CSS 冻结进度)
      li.classList.toggle('dotnav-focused', i === self.index);
      li.classList.toggle('dotnav-previous-current', i === self.prevIndex);
      var b = li.querySelector('.dotnav-link');
      if (b) {
        if (i === self.index) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      }
    });
    if (this.pauseBtn) {
      this.pauseBtn.setAttribute('aria-label', this.playing ? '暂停自动播放' : '开始自动播放');
    }
    this.prevIndex = this.index;
    this.visualIndex = this.index;
  };

  /* ---------- 播放控制 ---------- */

  EndlessGallery.prototype.play = function () {
    if (this.n < 2 || this.destroyed) return;
    this.playing = true;
    this._clearHold();
    if (this.dotnav) this.dotnav.classList.remove('dotnav-timed-paused');
    // 重启动画:先摘掉再挂上,强制 reflow,否则同一张卡片恢复播放时进度条不会重新走
    this.dots.forEach(function (li) { li.classList.remove('dotnav-focused'); });
    if (this.dots[this.index]) void this.dots[this.index].offsetWidth;
    this._syncDots();
    this._schedule();
  };

  EndlessGallery.prototype.pause = function () {
    this.playing = false;
    this._clearHold();
    if (this.dotnav) this.dotnav.classList.add('dotnav-timed-paused');
    this._syncDots();
  };

  EndlessGallery.prototype.toggle = function () {
    if (this.playing) this.pause();
    else this.play();
  };

  EndlessGallery.prototype._clearHold = function () {
    if (this.holdId) { clearTimeout(this.holdId); this.holdId = 0; }
  };

  /* ---------- 翻页 ---------- */

  EndlessGallery.prototype.next = function () { this.goTo(this.n === 2 ? (this.index === 0 ? 1 : 0) : this.index + 1); };
  EndlessGallery.prototype.prev = function () { this.goTo(this.n === 2 ? (this.index === 0 ? 1 : 0) : this.index - 1); };

  EndlessGallery.prototype.goTo = function (target) {
    if (this.destroyed || this.n < 2) return;
    var t = target;
    if (this.n === 2) t = clamp(t, 0, 1);
    else {
      // 挑与当前位置最近的等价目标,保证走最短路径
      t = t + Math.round((this.pos - t) / this.n) * this.n;
    }
    this._clearHold();
    this._previewDots(mod(Math.round(t), this.n));   // 圆点形态立即切换,与滑动同步
    this._animateTo(t);
  };

  // 手动选点 / 自动翻页时,圆点形态不等滑动落位、立即切换(apple 行为):
  // 目标圆点 250ms 展开为进度轨道,原圆点同步收缩回圆点;
  // 进度条与 apple 一致:换点即重置,160ms 后起跑,滑动期间照常生长
  EndlessGallery.prototype._previewDots = function (target) {
    if (!this.dots.length) return;
    if (this.visualIndex === target) return;
    this._updateTruncation(target);   // 变距窗口先于形态类,同帧生效
    var prev = this.visualIndex;
    this.visualIndex = target;
    this.dots.forEach(function (li, i) {
      li.classList.toggle('current', i === target);
      li.classList.toggle('dotnav-focused', i === target);
      li.classList.toggle('dotnav-previous-current', i === prev);
      var b = li.querySelector('.dotnav-link');
      if (b) {
        if (i === target) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      }
    });
  };

  /* ---------- 变距 dotnav(apple.com 同款) ----------
   * 圆点 ≤ 7 个:全部等大显示,当前点为进度轨道;
   * 圆点 > 7 个:永远显示 7 个一圈的窗口(当前点 ±3,端部收敛),
   *   按与当前点的距离分级:轨道(1.0)、相邻(1.0)、±2(0.75)、±3(0.5),
   *   窗外隐藏;翻页时整排按 8px×步数位移,进出窗口的圆点交错淡入/淡出。 */
  EndlessGallery.prototype._windowOf = function (index, count) {
    return { start: clamp(index - 3, 0, count - 7), end: clamp(index - 3, 0, count - 7) + 6 };
  };

  EndlessGallery.prototype._setDotTrunc = function (li, level) {
    var levels = ['dotnav-trunc-1', 'dotnav-trunc-2', 'dotnav-trunc-3', 'dotnav-trunc-4'];
    for (var i = 0; i < 4; i++) li.classList.toggle(levels[i], i === level - 1);
  };

  EndlessGallery.prototype._updateTruncation = function (target) {
    var count = this.dots.length;
    if (!count || !this.dotnav) return;
    var prev = this._lastTruncIndex;
    this._lastTruncIndex = target;

    var self = this;
    var clearAnim = function () {
      if (self._truncTimer) { clearTimeout(self._truncTimer); self._truncTimer = 0; }
      self.dots.forEach(function (li) {
        li.classList.remove('dotnav-transitioning', 'dotnav-becoming-visible', 'dotnav-becoming-invisible', 'dotnav-stagger-1', 'dotnav-stagger-2', 'dotnav-stagger-3');
        for (var s = 1; s <= 3; s++) {
          li.classList.remove('dotnav-shift-left-' + s);
          li.classList.remove('dotnav-shift-right-' + s);
        }
      });
      self.dotnav.classList.remove('dotnav-transitioning');
    };

    if (count <= MAX_DOTS) {
      // 全量显示:清掉所有截断类(等大圆点)
      clearAnim();
      this.dots.forEach(function (li) { self._setDotTrunc(li, 1); });
      return;
    }

    var dir = target > prev ? 'left' : target < prev ? 'right' : null;
    var oldWin = this._windowOf(prev, count);
    var newWin = this._windowOf(target, count);
    var steps = 0;
    if (dir === 'left') steps = Math.min(3, Math.max(0, newWin.start - oldWin.start));
    if (dir === 'right') steps = Math.min(3, Math.max(0, oldWin.end - newWin.end));

    this.dots.forEach(function (li, i) {
      var d = Math.abs(i - target);
      var level = i < newWin.start || i > newWin.end ? 4 : (d <= 1 ? 1 : d === 2 ? 2 : 3);
      self._setDotTrunc(li, level);
      li.classList.add('dotnav-transitioning');   // 尺寸/透明度走 320ms 过渡,期间禁点

      if (steps) {
        li.classList.add(dir === 'left' ? 'dotnav-shift-left-' + steps : 'dotnav-shift-right-' + steps);
        var entering = i >= newWin.start && i <= newWin.end && (i < oldWin.start || i > oldWin.end);
        var leaving = i >= oldWin.start && i <= oldWin.end && (i < newWin.start || i > newWin.end);
        if (entering) {
          li.classList.add('dotnav-becoming-visible');
          // apple 的 40ms 级联:进入点离窗口边越远,淡入越晚(100/140/180ms)
          var enterDist = dir === 'left' ? i - newWin.start : newWin.end - i;
          li.classList.add(enterDist < 1 ? 'dotnav-stagger-1' : enterDist < 2 ? 'dotnav-stagger-2' : 'dotnav-stagger-3');
        } else if (leaving) {
          li.classList.add('dotnav-becoming-invisible');
          // 离开点淡出即起跑,离边越远越晚(0/40/80ms)
          var leaveDist = dir === 'left' ? oldWin.end - i : i - oldWin.start;
          li.classList.add(leaveDist < 1 ? 'dotnav-stagger-1' : leaveDist < 2 ? 'dotnav-stagger-2' : 'dotnav-stagger-3');
        }
      }
    });
    if (steps) this.dotnav.classList.add('dotnav-transitioning');

    if (this._truncTimer) clearTimeout(this._truncTimer);
    this._truncTimer = setTimeout(clearAnim, TRUNC_MS);
  };

  EndlessGallery.prototype._animateTo = function (target) {
    var self = this;
    // 上一次滑动未落位就被打断:从实际渲染位置续走(apple 的 clip 行为)
    if (this.sliding) {
      this.pos = this._currentPos();
      this._slideStop();
    }

    var from = this.pos;
    var dist = target - from;
    if (Math.abs(dist) < 0.001) { this.pos = target; this._finish(target); return; }

    var step0 = this.rails.length ? this.rails[0].items[0].offsetWidth : 0;
    if (!step0) { this.pos = target; this._finish(target); return; }   // 视图不可量:直接落位

    var dur = reduceMotion.matches ? 1 : SLIDE_MS;
    this._slideFrom = from;
    this.sliding = true;
    this._probeIndex = 0;

    // apple 同款:浏览器合成器驱动的 CSS transition,逐卡起止位置由模运算给出。
    // 环回卡(起止位置跨越整圈的那张):不许可它横穿屏幕 —— 终点改为沿行进方向
    // 再多滑一整圈(滑出屏外),落位时 render() 在屏外把它归位到规范位置。
    this.rails.forEach(function (rail) {
      var step = rail.items[0].offsetWidth;
      if (!step) return;
      var local = mod(from, rail.count);
      var tLocal = mod(target, rail.count);
      var probeSet = false;
      rail.items.forEach(function (it, i) {
        var d = mod(i - local + rail.count / 2, rail.count) - rail.count / 2;
        var dt = mod(i - tLocal + rail.count / 2, rail.count) - rail.count / 2;
        var end = dt;
        if (dt - d > rail.count / 2) end = dt - rail.count;        // 环回:继续向左滑出屏
        else if (d - dt > rail.count / 2) end = dt + rail.count;   // 环回:继续向右滑出屏
        if (rail === self.rails[0] && !probeSet && end === dt) {   // 未环回卡:供打断时反推位置
          self._probeIndex = i;
          probeSet = true;
        }
        it.style.transition = 'transform ' + dur + 'ms ' + SLIDE_EASE;
        it.style.transform = 'translate3d(' + (end * step).toFixed(2) + 'px,0,0)';
      });
    });

    if (this.slideTimer) clearTimeout(this.slideTimer);
    this.slideTimer = setTimeout(function () {
      self.slideTimer = 0;
      self._slideStop();
      self._finish(target);
    }, dur + 60);
  };

  // 冻结进行中的滑动:清掉 transition,让卡片停在当前渲染位置
  EndlessGallery.prototype._slideStop = function () {
    this.sliding = false;
    this.rails.forEach(function (rail) {
      rail.items.forEach(function (it) { it.style.transition = ''; });
    });
  };

  // 反推 transition 进行中的实际位置(读主排一张未环回卡的插值矩阵)
  EndlessGallery.prototype._currentPos = function () {
    var rail = this.rails[0];
    var idx = this._probeIndex || 0;
    var it = rail && rail.items[idx];
    var step = it ? it.offsetWidth : 0;
    if (!it || !step) return this.pos;
    var m = global.getComputedStyle(it).transform;
    if (!m || m === 'none') return this.pos;
    var x;
    if (typeof global.DOMMatrixReadOnly === 'function') {
      x = new DOMMatrixReadOnly(m).m41;
    } else {
      var p = m.match(/matrix.*\((.+)\)/);
      if (!p) return this.pos;
      x = parseFloat(p[1].split(',')[4]);
    }
    var local0 = mod(this._slideFrom, rail.count);
    var d0 = mod(idx - local0 + rail.count / 2, rail.count) - rail.count / 2;
    return this._slideFrom - (x / step - d0);
  };

  EndlessGallery.prototype._finish = function (target) {
    this.pos = mod(Math.round(target), this.n);
    this.index = this.pos;
    this.root.classList.remove('media-gallery-is-sliding');
    // 环回卡在屏外滑出了一整圈,此处统一吸附回规范位置(屏外瞬移,不可见)
    this.render();
    this._syncDots();
    // 周期锚点是翻页发起那一刻(进度条在此刻 +160ms 起跑),落位时只余下剩余时长
    this._schedule(ITEM_MS - SLIDE_MS);
  };

  // 重新起算停留时间与进度条;ms 缺省为整周期(无滑动先行的场景,如 play())
  EndlessGallery.prototype._schedule = function (ms) {
    var self = this;
    this._clearHold();
    var wait = typeof ms === 'number' ? ms : ITEM_MS;
    if (this.playing && this.visible && !document.hidden) {
      this.holdId = setTimeout(function () { self.next(); }, wait);
    }
  };

  /* ---------- 拖拽 ---------- */

  EndlessGallery.prototype._onPointerDown = function (e) {
    if (this.destroyed || this.n < 2) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.suppressClick = false;
    // 打断进行中的滑动:冻结在当前渲染位置,圆点预览态回滚到原当前项,再开始拖拽
    if (this.sliding) {
      this.pos = this._currentPos();
      this._slideStop();
      this.render();
    }
    this._syncDots();
    this._updateTruncation(this.index);
    // 注意:此处不要停表,否则轻点卡片(未构成拖拽)会把自动播放掐断
    this.drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      pos0: this.pos,
      step: this.rails[0].items[0].offsetWidth || 1,
      rail: e.currentTarget,
      axis: null,
      moved: false,
      v: 0,
      lastX: e.clientX,
      lastT: e.timeStamp || performance.now()
    };
  };

  EndlessGallery.prototype._onPointerMove = function (e) {
    var d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    var dx = e.clientX - d.x0;
    var dy = e.clientY - d.y0;

    if (d.axis === null) {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      if (Math.abs(dx) <= Math.abs(dy)) { this.drag = null; return; } // 纵向手势交还页面
      d.axis = 'x';
      this._clearHold();                                   // 确认是横向拖拽才停下自动播放
      this.root.classList.add('media-gallery-is-sliding');
      try { d.rail.setPointerCapture(d.id); } catch (_) {}
    }

    if (Math.abs(dx) > 4) d.moved = true;
    var now = e.timeStamp || performance.now();
    if (now - d.lastT > 8) {
      d.v = (e.clientX - d.lastX) / (now - d.lastT);
      d.lastX = e.clientX;
      d.lastT = now;
    }
    var p = d.pos0 - dx / d.step;
    this.pos = this.n < 3 ? clamp(p, -0.2, this.n - 1 + 0.2) : p;   // 两张时不循环,给一点阻尼
    this.render();
    if (e.cancelable) e.preventDefault();
  };

  EndlessGallery.prototype._endDrag = function (e) {
    var d = this.drag;
    if (!d) return;
    this.drag = null;
    this.root.classList.remove('media-gallery-is-sliding');
    try { d.rail.releasePointerCapture(d.id); } catch (_) {}
    if (d.axis !== 'x') return;   // 轻点:不打断播放,交给点击处理

    var base = Math.round(d.pos0);
    var target;
    // 甩动优先,其次看拖过的比例;每次最多跨一张,与 apple 一致
    if (Math.abs(d.v) > FLICK_SPEED) target = base + (d.v < 0 ? 1 : -1);
    else target = clamp(Math.round(this.pos), base - 1, base + 1);
    if (this.n < 3) target = clamp(target, 0, this.n - 1);
    this._animateTo(target);
    if (d.moved) this.suppressClick = true;
    if (!this.playing) this.pause();
  };

  EndlessGallery.prototype._onClick = function (e) {
    if (this.suppressClick) {
      this.suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    var item = e.target.closest ? e.target.closest('.media-gallery-item') : null;
    if (!item) return;
    // 找到卡片属于哪一排、在本排的第几位
    var local = -1, count = 0;
    for (var r = 0; r < this.rails.length && local < 0; r++) {
      var k = this.rails[r].items.indexOf(item);
      if (k >= 0) { local = k; count = this.rails[r].count; }
    }
    if (local < 0) return;
    if (local === mod(this.index, count)) return;   // 已是本排当前卡,交给委托开详情
    e.preventDefault();
    e.stopPropagation();
    this.goTo(local);   // 点侧边卡片同样不打断自动播放
  };

  EndlessGallery.prototype._onKeydown = function (e) {
    if (this.n < 2) return;
    if (e.key === 'ArrowRight') { this.goTo(this.index + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { this.goTo(this.index - 1); e.preventDefault(); }
    else if (e.key === 'Home') { this.goTo(0); e.preventDefault(); }
    else if (e.key === 'End') { this.goTo(this.n - 1); e.preventDefault(); }
  };

  /* ---------- 生命周期 ---------- */

  EndlessGallery.prototype._bind = function () {
    var self = this;
    var add = function (target, type, fn, opts) {
      if (!target) return;
      target.addEventListener(type, fn, opts);
      self._listeners.push([target, type, fn, opts]);
    };

    // 两排都可拖拽,拖哪一排都是同一个索引
    this.rails.forEach(function (rail) {
      add(rail.el, 'pointerdown', function (e) { self._onPointerDown(e); });
      add(rail.el, 'pointermove', function (e) { self._onPointerMove(e); }, { passive: false });
      add(rail.el, 'pointerup', function (e) { self._endDrag(e); });
      add(rail.el, 'pointercancel', function (e) { self._endDrag(e); });
      add(rail.el, 'dragstart', function (e) { e.preventDefault(); });
    });
    add(this.root, 'click', function (e) { self._onClick(e); });
    add(this.root, 'keydown', function (e) { self._onKeydown(e); });

    add(this.pauseBtn, 'click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      self.toggle();
    });

    this.dots.forEach(function (li, i) {
      var link = li.querySelector('.dotnav-link');
      if (!link) return;
      add(link, 'click', function (e) {
        e.preventDefault();
        // 与 apple 一致:手动选点不打断自动播放,goTo 会重启 hold 与进度条
        self.goTo(i);
      });
    });

    add(global, 'resize', this._onResize);
    add(document, 'visibilitychange', this._onVisibility);
  };

  EndlessGallery.prototype._observe = function () {
    if (!('IntersectionObserver' in global)) return;
    var self = this;
    this.io = new IntersectionObserver(function (entries) {
      self.visible = entries[0].isIntersecting;
      if (self.visible) {
        if (self.playing) { self.play(); }   // 重新进入视口:续上计时与进度条
      } else {
        self._clearHold();
      }
    }, { threshold: 0.35 });
    this.io.observe(this.root);
  };

  EndlessGallery.prototype._onResize = function () {
    var self = this;
    if (this.resizeId) clearTimeout(this.resizeId);
    this.resizeId = setTimeout(function () { self.render(); }, 120);
  };

  EndlessGallery.prototype._onVisibility = function () {
    if (document.hidden) this._clearHold();
    else if (this.playing) this.play();
  };

  EndlessGallery.prototype.destroy = function () {
    this.destroyed = true;
    this._clearHold();
    if (this._truncTimer) clearTimeout(this._truncTimer);
    if (this.slideTimer) { clearTimeout(this.slideTimer); this.slideTimer = 0; }
    if (this.resizeId) clearTimeout(this.resizeId);
    if (this.io) this.io.disconnect();
    this._listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    this._listeners = [];
  };

  global.EndlessGallery = EndlessGallery;

})(window);
