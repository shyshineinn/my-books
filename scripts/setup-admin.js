// 在服务器本地初始化账号；不提供远程首次注册入口。
const fs = require('node:fs');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { createAuthStore } = require('../src/db/auth');

async function main() {
  const store = createAuthStore();
  if (store.initialized()) throw new Error('管理员已初始化，未修改任何账号或设备数据');
  let username = process.env.MYBOOKS_ADMIN_USERNAME || 'admin';
  let password;
  if (process.argv.includes('--password-stdin')) {
    password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  } else {
    if (!process.stdin.isTTY) throw new Error('请在交互终端运行，或使用 --password-stdin');
    let hidden = false;
    const output = new Writable({ write(chunk, encoding, callback) {
      if (!hidden) process.stdout.write(chunk, encoding);
      callback();
    } });
    const terminal = readline.createInterface({ input: process.stdin, output, terminal: true });
    try {
      username = (await terminal.question('管理员用户名 [admin]: ')).trim() || username;
      process.stdout.write('管理员密码（至少 12 字符，输入不回显）: ');
      hidden = true;
      password = await terminal.question('');
      hidden = false;
      process.stdout.write('\n');
      process.stdout.write('再次输入密码: ');
      hidden = true;
      const confirmation = await terminal.question('');
      hidden = false;
      process.stdout.write('\n');
      if (password !== confirmation) throw new Error('两次密码不一致');
    } finally { terminal.close(); }
  }
  await store.initialize(username, password);
  console.log('管理员已初始化。打开 /login 登录；安卓端填写服务器地址与相同的账号密码。');
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
