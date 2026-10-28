'use strict';
const statusEl = document.getElementById('accountStatus');
const form = document.getElementById('loginForm');
const panel = document.getElementById('accountPanel');
let currentId = '';
async function request(path, options = {}) {
  const res = await fetch('/api/auth/' + path, {
    ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function refresh() {
  try {
    const status = await request('status');
    if (!status.initialized) {
      statusEl.textContent = '服务器尚未初始化。请在服务器终端运行 npm run setup，设置管理员账号。';
      return;
    }
    let me;
    try { me = await request('me'); } catch {
      statusEl.textContent = '使用服务器管理员账号登录。';
      form.hidden = false; panel.hidden = true; return;
    }
    currentId = me.device.id;
    form.hidden = true; panel.hidden = false;
    statusEl.textContent = '已登录 · ' + me.device.label;
    const list = document.getElementById('deviceList');
    list.replaceChildren();
    for (const device of await request('devices')) {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = device.label + (device.id === currentId ? '（当前设备）' : '')
        + ' · 到期 ' + new Date(device.expiresAt).toLocaleDateString();
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn btn-ghost'; button.textContent = '撤销';
      button.addEventListener('click', async () => {
        try { await request('devices/' + encodeURIComponent(device.id), { method: 'DELETE' }); await refresh(); }
        catch (error) { statusEl.textContent = error.message; }
      });
      li.append(text, button); list.append(li);
    }
  } catch (error) { statusEl.textContent = error.message; }
}
async function login(useToken) {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const fields = new FormData(form);
    const credentials = useToken ? { token: fields.get('token') }
      : { username: fields.get('username'), password: fields.get('password') };
    await request('login', { method: 'POST', body: JSON.stringify({ ...credentials, device_name: '网页浏览器' }) });
    localStorage.removeItem('mybooks.adminToken');
    form.reset();
    // 仅允许同源相对跳转，防止登录页被用于开放重定向。
    const next = new URLSearchParams(location.search).get('next');
    const destination = next && new URL(next, location.origin);
    if (destination && destination.origin === location.origin && destination.pathname !== '/login') {
      location.assign(destination.href);
    } else { await refresh(); }
  } catch (error) { statusEl.textContent = error.message; }
  finally { buttons.forEach((b) => { b.disabled = false; }); }
}
form.addEventListener('submit', (event) => { event.preventDefault(); login(false); });
document.getElementById('tokenLogin').addEventListener('click', () => login(true));
document.getElementById('logout').addEventListener('click', async () => {
  try { await request('logout', { method: 'POST' }); localStorage.removeItem('mybooks.adminToken'); await refresh(); }
  catch (error) { statusEl.textContent = error.message; }
});
refresh();
