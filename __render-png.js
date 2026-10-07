/* 决定性验证:把 PDF 页面渲染成 PNG,人眼确认到底有没有文字
 * 关键:提取文字(靠 ToUnicode) ≠ 渲染字形(靠字体程序),必须看图
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const ROOT = process.cwd();
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
  const APP_PORT = await freePort(), CDP_PORT = await freePort();
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const OUT = path.join(ROOT, '__render-out');
  fs.mkdirSync(OUT, { recursive: true });
  let chrome = null, cdp = null, app = null;
  try {
    /* 下载线上真实 PDF */
    const r = await fetch('https://helloac.top/books-files/20-1790088770246-mbaqo9.pdf');
    const pdfBuf = Buffer.from(await r.arrayBuffer());
    console.log('PDF:', (pdfBuf.length / 1024 / 1024).toFixed(2), 'MB');

    for (const item of ['server.js', 'src', 'public']) fs.cpSync(path.join(ROOT, item), path.join(SANDBOX, item), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(SANDBOX, 'node_modules'), 'junction');
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(SANDBOX, 'package.json'));
    for (const d of ['data', 'uploads', 'books-files']) fs.mkdirSync(path.join(SANDBOX, d), { recursive: true });
    fs.writeFileSync(path.join(SANDBOX, 'books-files', 'cn.pdf'), pdfBuf);

    app = spawn(process.execPath, ['server.js'], { cwd: SANDBOX, env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let appLog = ''; app.stdout.on('data', (d) => { appLog += d; }); app.stderr.on('data', (d) => { appLog += d; });
    const base = `http://127.0.0.1:${APP_PORT}`;
    let up = false;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/books')).ok) { up = true; break; } } catch { /* retry */ } await sleep(300); }
    if (!up) throw new Error('应用未启动:\n' + appLog);

    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(SANDBOX, 'prof')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', '--window-size=1400,1000', 'about:blank'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let ver = null;
    for (let i = 0; i < 60; i++) { try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { await sleep(300); } }
    if (!ver) throw new Error('Chrome 未就绪');
    const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Network.enable');

    /* 收集警告 */
    const warns = [];
    cdp.ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const t = (msg.params.args || []).map((a) => a.value ?? a.description).join(' ');
        if (/glyf|font|cmap|recover|Warn/i.test(t)) warns.push(`[${msg.params.type}] ${t.slice(0, 200)}`);
      }
    });

    await cdp.send('Page.navigate', { url: base + '/' });
    await sleep(2500);

    /* 渲染多页为 PNG 并保存 */
    console.log('\n渲染页面(带 cMap 配置,与 read.html 一致)...');
    const expr = `(async () => {
      const results = [];
      const warns = [];
      const ow = console.warn, oe = console.error;
      console.warn = (...a) => warns.push('WARN ' + a.join(' '));
      console.error = (...a) => warns.push('ERR ' + a.join(' '));
      try {
        const pdfjs = await import('/vendor/pdf.min.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
        const pdf = await pdfjs.getDocument({
          url: '/books-files/cn.pdf',
          cMapUrl: '/vendor/cmaps/', cMapPacked: true,
          standardFontDataUrl: '/vendor/standard_fonts/',
        }).promise;

        for (const n of [1, 5, 10, 20]) {
          const page = await pdf.getPage(n);
          const vp = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          // 统计
          const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let dark = 0, total = 0;
          for (let i = 0; i < d.length; i += 4) { total++; if ((d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114) < 128) dark++; }
          results.push({ page: n, w: canvas.width, h: canvas.height, darkPct: +(dark/total*100).toFixed(2), png: canvas.toDataURL('image/png') });
        }
      } catch (e) { results.push({ error: e.message }); }
      finally { console.warn = ow; console.error = oe; }
      return JSON.stringify({ results: results.map(r => ({ page: r.page, w: r.w, h: r.h, darkPct: r.darkPct, error: r.error, pngLen: r.png ? r.png.length : 0 })), warns, data: results.map(r => r.png) });
    })()`;

    const out = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 240000 });
    const parsed = JSON.parse(out.result.value);

    console.log('\n=== 各页渲染统计 ===');
    for (const r of parsed.results) {
      if (r.error) { console.log(`  第${r.page}页: 失败 ${r.error}`); continue; }
      console.log(`  第${r.page}页: ${r.w}x${r.h}  深色像素=${r.darkPct}%  PNG=${(r.pngLen/1024).toFixed(0)}KB`);
    }

    console.log('\n=== pdf.js 警告 ===');
    console.log(parsed.warns && parsed.warns.length ? [...new Set(parsed.warns)].map((w) => '  ' + w).join('\n') : '  (无)');

    /* 保存 PNG 供人眼确认 */
    const files = [];
    for (let i = 0; i < parsed.results.length; i++) {
      const r = parsed.results[i];
      if (!r.page || !parsed.data[i]) continue;
      const b64 = parsed.data[i].replace(/^data:image\/png;base64,/, '');
      const f = path.join(OUT, `page-${String(r.page).padStart(3, '0')}.png`);
      fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      files.push({ page: r.page, file: f, size: fs.statSync(f).size });
    }
    console.log('\n=== 已保存 PNG ===');
    files.forEach((f) => console.log(`  第${f.page}页 -> ${f.file}  (${(f.size/1024).toFixed(0)}KB)`));

  } catch (e) {
    console.log('\n!! ' + e.message);
  } finally {
    cdp?.close(); chrome?.kill(); app?.kill();
    await sleep(700);
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
