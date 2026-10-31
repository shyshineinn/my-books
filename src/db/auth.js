// 单管理员与独立设备会话。只落密码哈希及令牌摘要；不依赖应用数据库单例。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DATA_DIR } = require('../core/paths');
const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 30 * 24 * 3600 * 1000;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function createAuthStore(file = path.join(DATA_DIR, 'auth.json')) {
  function read() {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.sessions)) throw new Error('无效的授权文件');
      return state;
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 1, admin: null, sessions: [] };
      throw err; // 损坏的授权文件不能被当作未初始化，防止重新接管。
    }
  }
  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return {
    initialized: () => !!read().admin,
    async initialize(username, password) {
      username = String(username || '').trim();
      if (!username || username.length > 80 || typeof password !== 'string' || password.length < 12 || password.length > 1024) {
        throw new Error('用户名不能为空且最多 80 字，密码须为 12 至 1024 字符');
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt, 64)).toString('hex');
      // scrypt 期间可能有另一初始化操作完成；提交前再检查。
      const current = read();
      if (current.admin) throw new Error('管理员已初始化，拒绝覆盖管理员和设备数据');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        write({ ...current, admin: { username, salt, hash } });
        return;
      }
      fs.writeFileSync(file, JSON.stringify({ version: 1, admin: { username, salt, hash }, sessions: [] }), {
        flag: 'wx', mode: 0o600,
      });
    },
    async verifyPassword(username, password) {
      if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024) return false;
      const admin = read().admin;
      // 即使用户不存在也执行同样的密码计算，避免快速返回暴露用户名。
      const result = await scrypt(password, admin?.salt || 'mybooks-uninitialized', 64);
      const expected = admin ? Buffer.from(admin.hash, 'hex') : Buffer.alloc(64);
      return expected.length === result.length && crypto.timingSafeEqual(result, expected) && admin?.username === username;
    },
    issueSession(label, deviceKey = '') {
      const state = read();
      state.sessions = state.sessions.filter((s) => s.expiresAt > Date.now());
      const keyHash = String(deviceKey || '').trim()
        ? digest(String(deviceKey).trim().slice(0, 200))
        : '';
      if (keyHash) {
        // 同一浏览器重复登录:替换旧会话,避免设备列表堆积。
        state.sessions = state.sessions.filter((s) => s.deviceKeyHash !== keyHash);
      }
      if (state.sessions.length >= 100) throw Object.assign(new Error('设备数量已达上限，请先撤销不用的设备'), { status: 409 });
      const token = crypto.randomBytes(32).toString('base64url');
      const session = {
        id: crypto.randomUUID(), tokenHash: digest(token),
        label: String(label || '设备').trim().slice(0, 100),
        createdAt: new Date().toISOString(), expiresAt: Date.now() + SESSION_MS,
        ...(keyHash ? { deviceKeyHash: keyHash } : {}),
      };
      state.sessions.push(session);
      write(state);
      return { token, id: session.id, expires_at: new Date(session.expiresAt).toISOString() };
    },
    authenticate(token) {
      if (!token) return null;
      const hash = digest(token);
      return read().sessions.find((s) => s.tokenHash === hash && s.expiresAt > Date.now()) || null;
    },
    listSessions() {
      return read().sessions.filter((s) => s.expiresAt > Date.now())
        .map(({ tokenHash, deviceKeyHash, ...session }) => session);
    },
    revoke(id) {
      const state = read();
      state.sessions = state.sessions.filter((s) => s.id !== id);
      write(state);
    },
  };
}

module.exports = { createAuthStore };
