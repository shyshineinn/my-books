/* ==========================================================================
 * 未完待续 · 复刻 apple.com 首页「Endless entertainment.」media-gallery
 *
 * 与 apple.com 线上实现对齐的要点:
 *   · 卡片绝对定位,用 translate3d 做位移,容器不滚动(apple 用同一套变换模型)
 *   · 位置用模运算取"最短路径",相邻卡片始终在左右各露一条边,循环时无跳变
 *   · 定时 dotnav:当前圆点展开为 32px 进度条,840ms 后起跑,4.16s 充满整周期 5s
 *   · 播放 / 暂停圆钮、拖拽、方向键、离屏冻结后原地续播、prefers-reduced-motion
 * ========================================================================== */
(function (global) {
  'use strict';

  var CYCLE_MS = 5000;       // apple.com: 每项 5s = 1s 滑动 + 4s 停留(fill 840ms 起跑 + 4160ms)
  var SLIDE_MS = 1000;       // apple.com: model.Slide.duration = 1s(cubic-bezier(0.645,0.045,0.355,1))
  var SLIDE_EASE = 'cubic-bezier(0.645, 0.045, 0.355, 1)';   // apple animateToItem 默认缓动
  var FLICK_SPEED = 0.35;    // px/ms,超过即判定为"甩动"翻页
  var AXIS_LOCK = 5;         // 判定拖拽方向的位移阈值(px)
  var SMALL_DOTS_MAX = 5;    // apple.com: 视口 ≤480px 时最多同时可见 5 个圆点
  var LARGE_DOTS_MAX = 7;    // apple.com: 更宽时最多同时可见 7 个圆点
  var SMALL_DOTS_WIDTH = 480;
  var TRUNC_MS = 1080;       // 变距迁移的清理延时(variable duration 1s + 余量)

  var reduceMotion = global.matchMedia
    ? global.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  function mod(v, m) { return ((v % m) + m) % m; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function nowMs() { return global.performance ? global.performance.now() : Date.now(); }

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
      if (el && items.length) self.rails.push({ el: el, items: items, count: items.length, wrap: wrap });
    });
    this.dotnav = root.querySelector('.media-gallery-dotnav');
    this.dotnavItems = root.querySelector('.dotnav-items');
    this.dots = Array.prototype.slice.call(root.querySelectorAll('.dotnav-item'));
    this.pauseBtn = root.querySelector('.media-gallery-dotnav-iconcontrol');
    this.n = this.rails.length ? this.rails[0].count : 0;
    this.maxDots = global.innerWidth <= SMALL_DOTS_WIDTH ? SMALL_DOTS_MAX : LARGE_DOTS_MAX;

    this.index = 0;
    this.pos = 0;
    this.prevIndex = -1;
    this.visualIndex = 0;
    this._lastTruncIndex = 0;
    this._truncTimer = 0;
    this._fadeAnims = [];
    this.playing = false;
    this.started = false;
    this.visible = false;
    this.sliding = false;      // CSS transition 滑动进行中
    this.slideTimer = 0;
    this._slideFrom = 0;       // 本次滑动的起点位置(供打断时反推当前位置)
    this._probeIndex = 0;      // 主排中未环回的卡,用于读插值矩阵
    this.holdId = 0;
    this.resumeId = 0;
    this.drag = null;
    this.suppressClick = false;
    this._hasClickedOnce = false;
    this.destroyed = false;
    this.resizeId = 0;
    this._scrollRaf = 0;
    this._wheelAcc = 0;
    this._wheelTimer = 0;
    this._wheelLock = 0;
    this._listeners = [];

    // apple 的自动播放是一条 5s 时间线:翻页即起算;暂停 / 离屏 / 切后台时原地冻结,恢复后接着走
    this.cycleStart = nowMs();
    this.cyclePaused = 0;
    this.cyclePauseStart = 0;
    this._frozen = false;

    this._onResize = this._onResize.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onScroll = this._onScroll.bind(this);
    this._onWheel = this._onWheel.bind(this);

    this._bind();
    this.render();
    this._syncDots();
    this._setFrozen(true);
    this._updateTruncation(0, false);   // 初始窗口:圆点多于 maxDots 个时只亮起窗口内的点
    this._checkInView();   // apple: startPaused = true,等画廊盖住视口中线才首播
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
      // 各排按自身落位取模:第二排数量与主排不同,用主排索引取模会标错当前卡
      var localCur = mod(self.pos, rail.count);
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
        b.tabIndex = i === self.index ? 0 : -1;   // apple:只有当前点进入 Tab 顺序
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
    if (!this.started) {
      this.started = true;
      this._beginCycle();
    }
    this.playing = true;
    this._syncPauseLabel();
    if (!this.visible || document.hidden) { this._setFrozen(true); return; }
    this._resume();
  };

  EndlessGallery.prototype.pause = function () {
    this.playing = false;
    this._freeze();
    this._syncPauseLabel();
  };

  EndlessGallery.prototype.toggle = function () {
    if (this.playing) this.pause();
    else {
      this._hasClickedOnce = false;
      this.play();
    }
  };

  // apple:手动选点"武装"过暂停后,下一次外部暂停(滚出中线 / 切后台 / 失焦)
  // 会升级为用户暂停,回来也不再自动续播;未武装时只冻结,回到视口继续
  EndlessGallery.prototype._externalPause = function () {
    if (!this.playing) { this._clearHold(); return; }
    if (this._hasClickedOnce) this.pause();
    else this._freeze();
  };

  EndlessGallery.prototype._syncPauseLabel = function () {
    if (!this.pauseBtn) return;
    this.pauseBtn.setAttribute('aria-label', this.playing ? '暂停自动播放' : '开始自动播放');
  };

  // 周期被重置但当前圆点没换(拖拽回弹 / 点当前点)时,让进度条从 0 重播
  EndlessGallery.prototype._restartFill = function () {
    if (!this.dotnav) return;
    this.dotnav.classList.add('dotnav-restart-fill');
    void this.dotnav.offsetWidth;
    this.dotnav.classList.remove('dotnav-restart-fill');
  };

  EndlessGallery.prototype._clearHold = function () {
    if (this.holdId) { clearTimeout(this.holdId); this.holdId = 0; }
  };

  EndlessGallery.prototype._clearResume = function () {
    if (this.resumeId) { clearTimeout(this.resumeId); this.resumeId = 0; }
  };

  /* ---------- 5s 时间线:冻结 / 续播 ---------- */

  EndlessGallery.prototype._beginCycle = function () {
    this.cycleStart = nowMs();
    this.cyclePaused = 0;
    this.cyclePauseStart = this._frozen ? this.cycleStart : 0;
  };

  EndlessGallery.prototype._cycleRemaining = function () {
    var now = nowMs();
    var paused = this.cyclePaused + (this.cyclePauseStart ? now - this.cyclePauseStart : 0);
    return Math.max(0, CYCLE_MS - (now - this.cycleStart - paused));
  };

  // apple 的 AutoPlay 暂停时停在原位:进度条、圆点形态、倒计时三者一起冻结
  EndlessGallery.prototype._setFrozen = function (frozen) {
    if (this.dotnav) this.dotnav.classList.toggle('dotnav-timed-paused', frozen);
    if (frozen === this._frozen) return;
    var now = nowMs();
    if (frozen) {
      this.cyclePauseStart = now;
    } else if (this.cyclePauseStart) {
      this.cyclePaused += now - this.cyclePauseStart;
      this.cyclePauseStart = 0;
    }
    this._frozen = frozen;
  };

  EndlessGallery.prototype._freeze = function () {
    this._clearHold();
    this._setFrozen(true);
  };

  EndlessGallery.prototype._resume = function () {
    if (this.destroyed || !this.playing || !this.started) return;
    if (!this.visible || document.hidden) return;
    this._setFrozen(false);
    this._scheduleNext();
  };

  EndlessGallery.prototype._scheduleNext = function () {
    var self = this;
    this._clearHold();
    if (this.destroyed || !this.playing || !this.started || this._frozen ||
        !this.visible || document.hidden) return;
    this.holdId = setTimeout(function () {
      self.holdId = 0;
      self.next();
    }, this._cycleRemaining());
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
    this._beginCycle();                               // 新的 5s 周期从翻页这一刻起算
    this._previewDots(mod(Math.round(t), this.n));    // 圆点形态立即切换,与滑动同步
    this._animateTo(t);
  };

  // apple 的 dotnav 交互:第一次手动选点只"武装"暂停(当前周期继续走),
  // 第二次起立即暂停自动播放;播放按钮重新开始时再次武装
  EndlessGallery.prototype._userGoTo = function (target) {
    var active = this.playing && !this._frozen && this.visible && !document.hidden;
    this.goTo(target);
    if (!active) return;
    if (this._hasClickedOnce) this.pause();
    else this._hasClickedOnce = true;
  };

  // 手动选点 / 自动翻页时,圆点形态不等滑动落位、立即切换(apple 行为):
  // 目标圆点 250ms 展开为进度轨道,原圆点同步收缩回圆点;
  // 进度条 840ms 后起跑、4.16s 充满,正好在翻页后第 5s 结束。
  EndlessGallery.prototype._previewDots = function (target) {
    if (!this.dots.length) return;
    if (this.visualIndex === target) { this._restartFill(); return; }
    var prev = this.visualIndex;
    var dir = target > prev ? 'left' : 'right';
    if (prev === this.n - 1 && target === 0) dir = 'left';
    else if (prev === 0 && target === this.n - 1) dir = 'right';
    // 落位前的 _syncDots 会用 prevIndex 重刷 previous-current;
    // 滑动被打断时它必须指向本次预览的旧当前点,否则会误闪收缩动画
    this.prevIndex = prev;
    this._updateTruncation(target, true, dir);   // 变距窗口先于形态类,同帧生效
    this.visualIndex = target;
    this.dots.forEach(function (li, i) {
      li.classList.toggle('current', i === target);
      li.classList.toggle('dotnav-focused', i === target);
      li.classList.toggle('dotnav-previous-current', i === prev);
      var b = li.querySelector('.dotnav-link');
      if (b) {
        b.tabIndex = i === target ? 0 : -1;
        if (i === target) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      }
    });
  };

  /* ---------- 变距 dotnav(apple.com 同款) ----------
   * 圆点数 ≤ maxDots(≤480px 为 5,更宽为 7):全部等大显示,当前点为进度轨道;
   * 超出时开一条固定长度的窗口,按开头 / 中段 / 结尾三种模板分级:
   *   开头 [1…1,2,3]、中段 [3,2,1…1,2,3]、结尾 [3,2,1…1](2=0.75,3=0.5),
   *   窗外隐藏;窗口移动时先量出重排位移并用行内 translate 抵消,再滑回原位,
   *   进出的点按 40ms 级联淡入 / 淡出。 */
  EndlessGallery.prototype._dotWindow = function (index, count, m) {
    var edge = (m - 1) / 2;
    var start = index <= edge ? 0
      : index >= count - 1 - edge ? count - m
      : index - edge;
    start = clamp(start, 0, Math.max(0, count - m));
    return { start: start, end: start + m - 1, m: m };
  };

  EndlessGallery.prototype._dotLevel = function (i, win, count) {
    if (i < win.start || i > win.end) return 4;
    var slot = i - win.start;
    var m = win.m;
    if (win.start === 0) return slot === m - 1 ? 3 : slot === m - 2 ? 2 : 1;
    if (win.end === count - 1) return slot === 0 ? 3 : slot === 1 ? 2 : 1;
    return slot === 0 || slot === m - 1 ? 3
      : slot === 1 || slot === m - 2 ? 2 : 1;
  };

  EndlessGallery.prototype._setDotTrunc = function (li, level) {
    var levels = ['dotnav-trunc-1', 'dotnav-trunc-2', 'dotnav-trunc-3', 'dotnav-trunc-4'];
    var changed = false;
    for (var i = 0; i < 4; i++) {
      var on = i === level - 1;
      if (li.classList.contains(levels[i]) !== on) changed = true;
      li.classList.toggle(levels[i], on);
    }
    return changed;
  };

  EndlessGallery.prototype._clearTruncAnim = function () {
    if (this._truncTimer) { clearTimeout(this._truncTimer); this._truncTimer = 0; }
    if (this._fadeAnims.length) {
      this._fadeAnims.forEach(function (a) { a.anim.cancel(); });
      this._fadeAnims = [];
    }
    if (this.dotnav) this.dotnav.classList.remove('dotnav-transitioning');
    this.dots.forEach(function (li) {
      li.classList.remove('dotnav-transitioning', 'dotnav-becoming-visible', 'dotnav-becoming-invisible',
        'dotnav-stagger-1', 'dotnav-stagger-2', 'dotnav-stagger-3');
      li.style.transition = '';
      li.style.translate = '';
    });
  };

  // 变距动画进行中又换窗(连续滑动/反向滑动):记下在飞圆点当前的 link 透明度与缩放,
  // 清掉动画类后用 WAAPI 从这里续走到新状态 —— 否则新动画会从 0%/100% 重新起跳,
  // 视觉上表现为圆点瞬间闪一下(apple 的换窗锁只挡点击,挡不住继续滑动)
  EndlessGallery.prototype._captureFadeState = function () {
    var actives = this._fadeAnims;
    var snap = null;
    this.dots.forEach(function (li, i) {
      var fading = li.classList.contains('dotnav-becoming-visible') ||
        li.classList.contains('dotnav-becoming-invisible');
      if (!fading) {
        for (var k = 0; k < actives.length; k++) {
          if (actives[k].index === i) { fading = true; break; }
        }
      }
      if (!fading) return;
      var link = li.querySelector('.dotnav-link');
      if (!link) return;
      var cs = global.getComputedStyle(link);
      if (!snap) snap = {};
      snap[i] = {
        opacity: parseFloat(cs.opacity) || 0,
        scale: cs.scale === 'none' ? 1 : (parseFloat(cs.scale) || 0)
      };
    });
    return snap;
  };

  // 取当前视觉位置稳定的一个点做参照(隐藏点被绝对定位/裁切,量不到真实行内位置)
  EndlessGallery.prototype._pickRowRef = function (preferred, fallback) {
    var count = this.dots.length;
    if (!count) return -1;
    var order = [preferred, fallback];
    for (var i = 0; i < count; i++) order.push(i);
    for (var k = 0; k < order.length; k++) {
      var idx = mod(order[k], count);
      var li = this.dots[idx];
      if (!li || li.classList.contains('dotnav-trunc-4')) continue;
      if (li.querySelector('.dotnav-link')) return idx;
    }
    return -1;
  };

  EndlessGallery.prototype._dotRowX = function (index) {
    var li = this.dots[index];
    var link = li && li.querySelector('.dotnav-link');
    if (!link) return null;
    var r = link.getBoundingClientRect();
    return r.left + r.width / 2;
  };

  // 换窗那一下布局会瞬时重排(进出点让位、整行重新居中)。这里先量出视觉位移,
  // 用行内 translate 把整排钉在原位,再用 1s 滑到新位置 —— apple 的 shift 效果
  EndlessGallery.prototype._compensateRowShift = function (refIndex, refX) {
    if (refIndex < 0 || refX == null) return;
    var afterX = this._dotRowX(refIndex);
    if (afterX == null) return;
    var dx = refX - afterX;
    if (Math.abs(dx) < 0.5) return;
    var dots = this.dots;
    dots.forEach(function (li) {
      li.style.transition = 'none';
      li.style.translate = dx.toFixed(2) + 'px 0';
    });
    void this.dotnav.offsetWidth;
    dots.forEach(function (li) {
      li.style.transition = 'translate var(--sk-dotnav-variable-duration) ease-in-out';
      li.style.translate = '0px 0px';
    });
  };

  EndlessGallery.prototype._updateTruncation = function (target, animate, dir) {
    var count = this.dots.length;
    if (!count || !this.dotnav) return;
    var m = Math.min(count, this.maxDots);
    this.dotnav.style.setProperty('--sk-dotnav-count', String(Math.min(count, LARGE_DOTS_MAX)));

    var prev = this._lastTruncIndex;
    this._lastTruncIndex = target;

    var self = this;
    var dots = this.dots;
    // 重排前先记下参照点的视觉位置;落类后再量一次,差值即需要抵消的位移
    var refIndex = animate ? this._pickRowRef(target, prev) : -1;
    var refX = refIndex >= 0 ? this._dotRowX(refIndex) : null;
    var fadeSnap = animate ? this._captureFadeState() : null;
    this._clearTruncAnim();
    if (animate) void this.dotnav.offsetWidth;   // 同名 CSS 动画需要重排后才能再次触发

    if (count <= this.maxDots) {
      dots.forEach(function (li) { self._setDotTrunc(li, 1); });
      this._compensateRowShift(refIndex, refX);
      this._finishTruncAnim(animate);
      return;
    }

    var oldWin = this._dotWindow(prev, count, m);
    var newWin = this._dotWindow(target, count, m);

    dots.forEach(function (li, i) {
      if (self._setDotTrunc(li, self._dotLevel(i, newWin, count)) && animate) {
        li.classList.add('dotnav-transitioning');   // apple:只有截断等级变化的点才迁移
      }
    });

    if (animate) {
      var entering = [], leaving = [];
      for (var i = 0; i < count; i++) {
        var was = i >= oldWin.start && i <= oldWin.end;
        var nowIn = i >= newWin.start && i <= newWin.end;
        if (nowIn && !was) entering.push(i);
        else if (was && !nowIn) leaving.push(i);
      }
      // 进入点自窗口内侧向外 440/480ms 级联;
      // 离开点反向:最外侧先淡出(0ms),靠内的一点晚 40ms(apple 同款)
      entering.sort(dir === 'left' ? function (a, b) { return a - b; } : function (a, b) { return b - a; });
      leaving.sort(dir === 'left' ? function (a, b) { return a - b; } : function (a, b) { return b - a; });
      // apple:换窗期间整排锁住点击,避免在淡入/淡出中途再次翻转动画
      if (entering.length || leaving.length) this.dotnav.classList.add('dotnav-transitioning');
      entering.forEach(function (i, k) {
        if (fadeSnap && fadeSnap[i]) return;
        dots[i].classList.add('dotnav-becoming-visible', 'dotnav-stagger-' + Math.min(3, k + 1));
      });
      leaving.forEach(function (i, k) {
        if (fadeSnap && fadeSnap[i]) return;
        dots[i].classList.add('dotnav-becoming-invisible', 'dotnav-stagger-' + Math.min(3, k + 1));
      });
      if (fadeSnap) {
        Object.keys(fadeSnap).forEach(function (key) {
          var i = +key;
          var link = dots[i].querySelector('.dotnav-link');
          if (!link) return;
          // 窗外点淡出后本就不可见;link 保持满尺寸,缩回交给 trunc-4 的尺寸过渡
          var targetOpacity = self._dotLevel(i, newWin, count) === 4 ? 0 : 1;
          try {
            var anim = link.animate([
              { opacity: fadeSnap[key].opacity, scale: fadeSnap[key].scale },
              { opacity: targetOpacity, scale: 1 }
            ], { duration: 480, easing: 'ease-in-out', fill: 'both' });
            self._fadeAnims.push({ index: i, anim: anim });
          } catch (_) {}
        });
      }
    }

    this._compensateRowShift(refIndex, refX);
    this._finishTruncAnim(animate);
  };

  EndlessGallery.prototype._finishTruncAnim = function (animate) {
    if (!animate) return;
    var self = this;
    this._truncTimer = setTimeout(function () {
      self._truncTimer = 0;
      self._clearTruncAnim();
    }, TRUNC_MS);
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

  // 冻结进行中的滑动:清掉 transition 与落位定时器,让卡片停在当前渲染位置
  EndlessGallery.prototype._slideStop = function () {
    if (this.slideTimer) { clearTimeout(this.slideTimer); this.slideTimer = 0; }
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
    // 保留滑动的虚拟位置(可能为 -1 / n 等),只把圆点索引归一化:
    // 两排数量不同,第二排按 pos 取模才能停在动画终点;若把 pos 折回 0..n-1,
    // 环回落位时会按主排周期重算,第二排的卡片会在滑动停止瞬间换掉
    this.pos = Math.round(target);
    this.index = mod(this.pos, this.n);
    this.root.classList.remove('media-gallery-is-sliding');
    // 环回卡在屏外滑出了一整圈,此处统一吸附回规范位置(屏外瞬移,不可见)
    this.render();
    this._syncDots();
    this._focusCurrentDot();
    // 周期锚点是翻页发起那一刻(进度条在 +840ms 起跑),落位时只余下剩余时长
    this._scheduleNext();
  };

  // apple:方向键翻页后若焦点还在圆点栏里,把焦点带到新的当前点
  EndlessGallery.prototype._focusCurrentDot = function () {
    var active = document.activeElement;
    if (!active || !this.dotnavItems || !this.dotnavItems.contains(active)) return;
    var cur = this.dots[this.index];
    var link = cur && cur.querySelector('.dotnav-link');
    if (link && link !== active) {
      try { link.focus({ preventScroll: true }); } catch (_) { link.focus(); }
    }
  };

  /* ---------- 拖拽 ---------- */

  EndlessGallery.prototype._onPointerDown = function (e) {
    if (this.destroyed || this.n < 2) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.suppressClick = false;
    // 打断进行中的滑动:冻结在当前渲染位置,保留圆点的预览态(不回退),
    // 否则中途抓住轮播图时整个圆点栏会先跳回旧位置再跳回来
    if (this.sliding) {
      this.pos = this._currentPos();
      this._slideStop();
      this.render();
    }
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
    this._beginCycle();
    this._previewDots(mod(Math.round(target), this.n));
    this._animateTo(target);
    if (d.moved) this.suppressClick = true;
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
    if (local === mod(this.pos, count)) {
      // apple:点当前卡(打开详情)即让画廊停下,关掉弹窗后也保持暂停,由播放钮重启
      if (this.playing && e.target.closest && e.target.closest('.media-gallery-wrapper-link')) this.pause();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.goTo(local);   // 点侧边卡片同样不打断自动播放
  };

  EndlessGallery.prototype._onKeydown = function (e) {
    if (this.n < 2) return;
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.media-gallery-wrapper-link')) {
      if (this.playing) this.pause();   // 键盘开详情与点击同款:暂停,交给委托打开
      return;
    }
    if (e.key === 'ArrowRight') { this._userGoTo(this.index + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { this._userGoTo(this.index - 1); e.preventDefault(); }
    else if (e.key === 'Home') { this._userGoTo(0); e.preventDefault(); }
    else if (e.key === 'End') { this._userGoTo(this.n - 1); e.preventDefault(); }
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
      add(rail.wrap, 'wheel', self._onWheel, { passive: false });   // apple:触控板横滑翻页
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
        self._userGoTo(i);
      });
    });

    add(global, 'resize', this._onResize);
    add(global, 'scroll', this._onScroll, { passive: true });
    add(document, 'visibilitychange', this._onVisibility);
    // apple: 窗口失焦暂停,回焦后等 100ms 再续播
    add(global, 'blur', function () { self._externalPause(); });
    add(global, 'focus', function () { self._onVisibility(); });
  };

  // apple 的 ScrollGroup:画廊盖住视口中线时在播,离开中线即暂停(实测阈值)
  EndlessGallery.prototype._onScroll = function () {
    var self = this;
    if (this._scrollRaf) return;
    this._scrollRaf = global.requestAnimationFrame(function () {
      self._scrollRaf = 0;
      self._checkInView();
    });
  };

  EndlessGallery.prototype._checkInView = function () {
    if (this.destroyed || !this.root) return;
    var rect = this.root.getBoundingClientRect();
    var mid = (global.innerHeight || document.documentElement.clientHeight) / 2;
    var visible = rect.top <= mid && rect.bottom >= mid;
    if (visible !== this.visible) this._setVisible(visible);
  };

  // apple 的触控板横滑:横向占优累计 40px,100ms 内继续累加;翻一页后锁定 440ms
  EndlessGallery.prototype._onWheel = function (e) {
    if (this.destroyed || this.n < 2) return;
    var ax = Math.abs(e.deltaX);
    var ay = Math.abs(e.deltaY);
    if (ax > ay && ax > 0 && e.cancelable) e.preventDefault();
    var now = nowMs();
    if (now < this._wheelLock) return;
    if (!(ax > ay * 1.2 && ax > 5)) return;

    var self = this;
    this._wheelAcc += e.deltaX;
    clearTimeout(this._wheelTimer);
    this._wheelTimer = setTimeout(function () { self._wheelAcc = 0; }, 100);
    if (Math.abs(this._wheelAcc) < 40) return;

    var dir = this._wheelAcc > 0 ? 1 : -1;
    this._wheelAcc = 0;
    clearTimeout(this._wheelTimer);
    this._wheelTimer = 0;
    this._wheelLock = now + 440;
    this.goTo(mod(this.index + dir, this.n));
    this.pause();   // apple:横滑属于用户接管,翻页后保持暂停
  };

  EndlessGallery.prototype._setVisible = function (visible) {
    if (this.destroyed) return;
    this.visible = visible;
    if (!visible) {
      this._externalPause();
      return;
    }
    if (document.hidden) return;
    if (!this.started) {
      // apple: startPaused = true,进入视口才首播;prefers-reduced-motion 下保持静默
      if (!reduceMotion.matches) this.play();
    } else if (this.playing) {
      this._resume();
    }
  };

  EndlessGallery.prototype._onResize = function () {
    var self = this;
    var m = global.innerWidth <= SMALL_DOTS_WIDTH ? SMALL_DOTS_MAX : LARGE_DOTS_MAX;
    if (m !== this.maxDots && this.dots.length) {
      this.maxDots = m;
      this._updateTruncation(this.visualIndex, false);
    }
    this._checkInView();
    if (this.resizeId) clearTimeout(this.resizeId);
    this.resizeId = setTimeout(function () { self.render(); }, 120);
  };

  EndlessGallery.prototype._onVisibility = function () {
    if (this.destroyed) return;
    this._clearResume();
    if (document.hidden) {
      this._externalPause();
      return;
    }
    var self = this;
    // apple: 回到前台 / 回焦后先等 100ms 再续播
    this.resumeId = setTimeout(function () {
      self.resumeId = 0;
      if (!self.visible) return;
      if (!self.started) {
        if (!reduceMotion.matches) self.play();
      } else if (self.playing) {
        self._resume();
      }
    }, 100);
  };

  EndlessGallery.prototype.destroy = function () {
    this.destroyed = true;
    this._clearHold();
    this._clearResume();
    this._clearTruncAnim();
    if (this.slideTimer) { clearTimeout(this.slideTimer); this.slideTimer = 0; }
    if (this.resizeId) clearTimeout(this.resizeId);
    if (this._scrollRaf) { global.cancelAnimationFrame(this._scrollRaf); this._scrollRaf = 0; }
    if (this._wheelTimer) { clearTimeout(this._wheelTimer); this._wheelTimer = 0; }
    this._listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    this._listeners = [];
  };

  global.EndlessGallery = EndlessGallery;

})(window);
