/* ============================================================
 * 扫码引擎(书籍条形码 → ISBN)
 *
 * calibre 没有扫码功能(桌面端),这是 web 侧的新增:
 *   调用设备后置摄像头 → 解码 EAN-13 条形码 → 回调 ISBN 字符串。
 * 解码用 html5-qrcode(内含 zxing-js 纯 JS 解码,不依赖 BarcodeDetector),
 * 因此 iOS Safari / 微信内置浏览器都能用;有原生 BarcodeDetector 的
 * 安卓 Chrome 会自动走原生通道(experimentalFeatures)。
 *
 * 加载策略:库文件 375KB,懒加载 —— 用户第一次点「扫码」才注入 script,
 * 首屏不受影响;PWA 离线也能用(SW 对 /vendor 缓存优先)。
 *
 * 本文件是纯引擎,不做业务判断:
 *   解码结果原样交给 onDetect(raw, source),校验/查重/回填由调用方
 *   (common.js)走 /api/isbn/check —— 前端不复制一份校验位算法,
 *   避免"两处实现漂移"(与后端核心层同源的只有一份真理)。
 *
 * 对外接口:
 *   BookScanner.open({ onDetect, onCancel })
 *     onDetect(rawText, source)  source: 'camera' | 'manual'
 *   BookScanner.resume()  连扫:检测到一次后暂停,恢复继续扫
 *   BookScanner.close()   停摄像头 + 移除浮层(触发 onCancel 的只有用户点✕/取消)
 *   BookScanner.isOpen()
 *
 * 错误引导(按浏览器实际报错名翻译成人话):
 *   · 非 HTTPS → 摄像头 API 不存在,提示手动输入
 *   · NotAllowedError → 权限被拒,教用户去浏览器设置放行
 *   · NotFoundError → 没找到摄像头(台式机常见),引导手动输入
 *   · NotReadableError → 摄像头被其他程序占用
 * ============================================================ */

(function () {
  const LIB_URL = '/vendor/html5-qrcode.min.js?v=1';
  // 书背条码都是 EAN-13(978/979 开头);限定格式可显著降低误识别
  const SCAN_FORMATS = ['EAN_13'];

  let libPromise = null;
  let overlay = null;       // 浮层根节点
  let readerEl = null;      // .scan-reader 定位容器
  let instance = null;      // Html5Qrcode 实例
  let starting = false;     // start() 进行中(防双击)
  let detected = false;     // 本轮是否已识别(识别后自动暂停,防连环回调)
  let onDetectCb = null;
  let onCancelCb = null;
  let readerSeq = 0;        // 每次开扫用新元素 id(库按 id 查找节点)

  // 懒加载解码库(成功缓存 Promise;失败清空,下次重试)
  function loadLib() {
    if (window.Html5Qrcode) return Promise.resolve();
    if (!libPromise) {
      libPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = LIB_URL;
        s.onload = () => resolve();
        s.onerror = () => {
          libPromise = null;
          reject(new Error('扫码组件加载失败(网络或缓存问题),请刷新重试'));
        };
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }

  // 摄像头不可用的静态判因(在加载库之前就能确定的):
  // getUserMedia 只在安全上下文(HTTPS/localhost)存在,局域网 http 部署
  // 会直接没有 navigator.mediaDevices —— 这条要给出和"权限被拒"区分开的提示
  function staticUnavailableReason() {
    if (!window.isSecureContext) {
      return '当前页面不是 HTTPS,浏览器不允许调用摄像头。请用 https:// 访问本站在线地址,或直接手动输入 ISBN';
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return '当前浏览器不支持摄像头扫码,请直接手动输入 ISBN';
    }
    return '';
  }

  // 库/浏览器抛出的错误 → 中文引导。
  // 注意:html5-qrcode 的部分失败路径 reject 的是**字符串**
  // ("Error getting userMedia, error = NotAllowedError: ..."),
  // 不是 Error 对象 —— err.name/err.message 都是空,不能只认标准形状。
  function friendlyError(err) {
    const raw = typeof err === 'string' ? err : '';
    const msg = String((err && err.message) || raw || '');
    const all = ((err && err.name) || '') + ' ' + msg;
    if (/NotAllowedError|PermissionDeniedError|permission/i.test(all)) {
      return '摄像头权限被拒绝。请在浏览器设置里允许本站使用摄像头(地址栏左侧图标 → 摄像头 → 允许),或直接手动输入 ISBN';
    }
    if (/NotFoundError|DevicesNotFoundError|OverconstrainedError/i.test(all)) {
      return '没有找到可用的摄像头,请直接手动输入 ISBN';
    }
    if (/NotReadableError|TrackStartError/i.test(all)) {
      return '摄像头被其他程序占用(如相机 App),关掉后重试,或直接手动输入 ISBN';
    }
    return '摄像头启动失败:' + (msg || '未知原因,请重试或直接手动输入 ISBN');
  }

  function setStatus(text, kind) {
    if (!overlay) return;
    const el = overlay.querySelector('.scan-status');
    el.textContent = text || '';
    el.className = 'scan-status' + (kind ? ' scan-status-' + kind : '');
  }

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-head">
          <h2>扫描书籍条形码</h2>
          <button type="button" class="icon-btn" data-scan-close aria-label="关闭">✕</button>
        </div>
        <div class="scan-reader" id="scanReaderWrap"></div>
        <p class="scan-hint">把书背面的条形码(ISBN)对准框内,保持几秒</p>
        <p class="scan-status" role="status"></p>
        <div class="scan-manual">
          <input type="text" inputmode="numeric" autocomplete="off"
                 placeholder="或手动输入 ISBN(978 开头 13 位)" aria-label="手动输入 ISBN">
          <button type="button" class="btn btn-primary" data-scan-manual>确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    readerEl = overlay.querySelector('.scan-reader');

    overlay.querySelector('[data-scan-close]').addEventListener('click', () => close(true));
    // 点浮层背景(非卡片区域)也关掉 —— 移动端误触成本低
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(true); });
    // Esc 关闭:与全站弹窗 (common.js) 的习惯一致
    document.addEventListener('keydown', onEsc);

    const input = overlay.querySelector('.scan-manual input');
    const submitManual = () => {
      const v = input.value.trim();
      if (!v) return;
      fire(v, 'manual');
    };
    overlay.querySelector('[data-scan-manual]').addEventListener('click', submitManual);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitManual(); } });
  }

  function fire(raw, source) {
    if (detected) return;
    detected = true;
    setStatus(source === 'manual' ? `已输入:${raw}` : `已识别:${raw}`, 'ok');
    // 相机还在跑就先停,省电也避免重复识别;调用方决定 close() 还是 resume()
    stopCamera();
    if (onDetectCb) onDetectCb(raw, source);
  }

  function onEsc(e) {
    if (e.key === 'Escape') close(true);
  }

  function stopCamera() {
    if (!instance) return Promise.resolve();
    const inst = instance;
    instance = null;
    return inst.stop().then(() => {
      try { inst.clear(); } catch { /* 元素可能已移除,忽略 */ }
    }).catch(() => { /* 未启动或已停,忽略 */ });
  }

  async function startCamera() {
    if (!overlay || !readerEl || starting || instance) return;
    // 静态判因先于加载库:不值得为必然失败的环境下载 375KB
    const staticReason = staticUnavailableReason();
    if (staticReason) {
      setStatus(staticReason, 'err');
      return;
    }
    starting = true;
    try {
      await loadLib();
      detected = false;
      // 每次开扫换一个全新的挂载节点:resume() 会二次启动,
      // 库里按元素 id 查节点,复用过期的旧节点容易踩残留状态
      const slot = document.createElement('div');
      slot.id = 'scanReader' + (++readerSeq);
      slot.className = 'scan-reader-slot';
      readerEl.replaceChildren(slot);
      const fmt = window.Html5QrcodeSupportedFormats;
      const formats = SCAN_FORMATS.map((n) => fmt[n]).filter((n) => n !== undefined);
      const inst = new window.Html5Qrcode(slot.id, false);
      instance = inst;
      // qrbox:横长条 —— 条码比例宽扁,正方形取景框反而要用户退很远
      const qrbox = (vw, vh) => {
        const w = Math.floor(Math.min(vw * 0.86, 420));
        const h = Math.floor(Math.max(Math.min(vh * 0.4, w * 0.42), 110));
        return { width: w, height: h };
      };
      await inst.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox,
          disableFlip: true,
          formatsToSupport: formats.length ? formats : undefined,
          // 有原生 BarcodeDetector(安卓 Chrome)就走原生,快且省电
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        },
        (text) => fire(String(text || '').trim(), 'camera'),
        () => { /* 逐帧未识别:正常状态,不打扰用户 */ }
      );
      setStatus('', '');
    } catch (err) {
      instance = null;
      setStatus(friendlyError(err), 'err');
    } finally {
      starting = false;
    }
  }

  function open(opts) {
    if (overlay) return; // 已开着(异步竞态下重复点击),忽略
    onDetectCb = (opts && opts.onDetect) || null;
    onCancelCb = (opts && opts.onCancel) || null;
    detected = false;
    buildOverlay();
    startCamera();
  }

  function resume() {
    if (!overlay) return;
    setStatus('', '');
    detected = false;
    startCamera();
  }

  function close(byUser) {
    if (!overlay) return;
    const cb = onCancelCb;
    const wasUser = !!byUser;
    document.removeEventListener('keydown', onEsc);
    overlay.remove();
    overlay = null;
    readerEl = null;
    onDetectCb = null;
    onCancelCb = null;
    stopCamera();
    if (wasUser && cb) cb();
  }

  window.BookScanner = {
    open,
    resume,
    close: () => close(false),
    isOpen: () => !!overlay,
  };
})();
