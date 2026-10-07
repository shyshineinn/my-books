/* 直接访问线上站点诊断 —— 不再让用户粘贴代码
 * 用全新 Chrome profile(模拟首次访问的干净用户),打开线上阅读页,抓真实现场
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const LIVE = 'https://helloac.top';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const c = new Cdp(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.pending.has(msg.id)) { const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
      else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

(async () => {
  const CDP_PORT = await freePort();
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'live-check-'));
  let chrome = null, cdp = null;
  try {
    /* 全新 profile = 模拟一个从没访问过的干净用户(无旧 SW) */
    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--no-sandbox', '--window-size=1400,1000', 'about:blank'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let chLog = '';
    chrome.stderr.on('data', (d) => { chLog += d; });

    let ver = null;
    for (let i = 0; i < 60; i++) { try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { await sleep(300); } }
    if (!ver) throw new Error('Chrome 未就绪:\n' + chLog.slice(0, 500));
    console.log('Chrome:', ver.Browser, '(全新 profile)\n');

    const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Network.enable');

    const cons = [];
    const notFound = [];
    const fails = [];
    cdp.ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        cons.push(`[${msg.params.type}] ` + (msg.params.args || []).map((a) => a.value ?? a.description).join(' ').slice(0, 300));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        cons.push('EXC: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300));
      }
      if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
        notFound.push(msg.params.response.status + '  ' + msg.params.response.url);
      }
      if (msg.method === 'Network.loadingFailed') {
        fails.push(msg.params.errorText + ' ' + (msg.params.blockedReason || ''));
      }
    });

    /* 1. 先访问首页,让 SW 注册(模拟真实用户第一次访问) */
    console.log('=== 1. 访问首页,注册 SW ===');
    await cdp.send('Page.navigate', { url: LIVE + '/' });
    await sleep(6000);
    const sw1 = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return JSON.stringify({
          hasReg: !!reg,
          active: reg && reg.active ? reg.active.state : null,
          scriptURL: reg && reg.active ? reg.active.scriptURL : null,
          controlling: !!navigator.serviceWorker.controller,
          caches: await caches.keys(),
        });
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    console.log('  ' + sw1.result.value);

    /* 2. 打开线上阅读页(那本 PDF) */
    console.log('\n=== 2. 打开线上阅读页 /read/20 ===');
    cons.length = 0; notFound.length = 0; fails.length = 0;
    await cdp.send('Page.navigate', { url: LIVE + '/read/20' });

    let state = null, rendered = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const p = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          canvas: document.querySelectorAll('#pdfContainer canvas').length,
          err: (document.querySelector('#error')||{}).hidden === false ? (document.querySelector('#error')||{}).textContent.slice(0,120) : '',
          pageinfo: (document.querySelector('#pageinfo')||{}).textContent || '',
          tocLen: (document.querySelector('#tocList')||{}).innerText ? document.querySelector('#tocList').innerText.length : 0,
        })`,
        returnByValue: true,
      }).catch(() => null);
      if (p) {
        state = JSON.parse(p.result.value);
        if (state.canvas > 0) { rendered = true; console.log(`  ${i + 1}s: canvas 出现, 页码=${state.pageinfo}`); break; }
        if (state.err) { console.log(`  ${i + 1}s: 显示错误 -> ${state.err}`); break; }
      }
    }
    if (!state) console.log('  (未能取到页面状态)');

    await sleep(3000);

    /* 3. 详细现场 */
    const detail = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const out = {};
        const c = document.querySelector('#pdfContainer canvas');
        out.canvas存在 = !!c;
        if (c) {
          out.canvas尺寸 = c.width + 'x' + c.height;
          try {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let dark = 0, total = 0;
            for (let i = 0; i < d.length; i += 4) { total++; if ((d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114) < 128) dark++; }
            out.深色像素 = (dark/total*100).toFixed(2) + '%';
            out.有可见内容 = dark/total > 0.005;
          } catch (e) { out.取像素失败 = e.message; }
        }
        out.页码 = (document.querySelector('#pageinfo')||{}).textContent || '';
        out.错误 = (document.querySelector('#error')||{}).hidden === false ? document.querySelector('#error').textContent : '';
        out.目录前60字 = (document.querySelector('#tocList')||{}).innerText ? document.querySelector('#tocList').innerText.slice(0,60) : '';
        // 页面用的哪个库源
        const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src).filter(Boolean);
        out.脚本源 = scripts;
        const reg = await navigator.serviceWorker.getRegistration();
        out.SW = { active: reg && reg.active ? reg.active.state : null, controlling: !!navigator.serviceWorker.controller };
        out.caches = await caches.keys();
        return JSON.stringify(out, null, 1);
      })()`,
      awaitPromise: true, returnByValue: true, timeout: 30000,
    });
    console.log('\n=== 3. 线上真实现场 ===');
    console.log(detail.result.value);

    console.log('\n=== 4. console 输出 ===');
    console.log(cons.length ? [...new Set(cons)].slice(0, 15).map((x) => '  ' + x).join('\n') : '  (无)');

    console.log('\n=== 5. HTTP >= 400 ===');
    console.log(notFound.length ? [...new Set(notFound)].slice(0, 15).map((x) => '  ' + x).join('\n') : '  (无)');

    console.log('\n=== 6. 请求失败 ===');
    console.log(fails.length ? [...new Set(fails)].slice(0, 10).map((x) => '  ' + x).join('\n') : '  (无)');

    console.log('\n=== 判读 ===');
    console.log('  干净用户能渲染 -> 问题在用户浏览器的旧 SW/缓存');
    console.log('  干净用户也不渲染 -> 问题在线上部署,需按上面的 404/console 定位');

  } catch (e) {
    console.log('\n!! ' + e.message);
  } finally {
    cdp?.close(); chrome?.kill();
    await sleep(700);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
