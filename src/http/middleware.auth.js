/* ============================================================
 * 写操作鉴权中间件(应用内,不依赖 Nginx)
 *
 * 规则:
 *   · GET / HEAD 一律放行(浏览公开)
 *   · 其余方法要求 Authorization: Bearer <token> 或 X-Admin-Token: <token>
 *   · token 来源(按优先级):环境变量 ADMIN_TOKEN → data/admin-token 文件(单行)
 *   · 比较用 crypto.timingSafeEqual(恒时,防时序侧信道)
 *
 * 生成 token:node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
 * Nginx 的 Basic 口令保留作外圈纵深防御;应用层自此不依赖它。
 * ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('../core/paths');
const { createAuthStore } = require('../db/auth');

const TOKEN_FILE = path.join(DATA_DIR, 'admin-token');
const authStore = createAuthStore();

// 读取 token:环境变量优先;文件方案不需要任何配置库,data/ 天然不进仓库。
// 每次请求都重新解析环境变量成本可忽略;文件只在存在时读一次并缓存,
// 删除文件即可吊销(缓存随模块生命周期,部署重启即刷新)。
function loadToken() {
  const env = String(process.env.ADMIN_TOKEN || '').trim();
  if (env) return env;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    }
  } catch { /* 文件不可读视为无 token */ }
  return '';
}

let cachedFileToken = null; // null = 未读过;'' = 读过但为空

function getFileToken() {
  if (cachedFileToken !== null) return cachedFileToken;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      cachedFileToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    } else {
      cachedFileToken = '';
    }
  } catch {
    cachedFileToken = '';
  }
  return cachedFileToken;
}

function loadTokenCached() {
  if (process.env.ADMIN_TOKEN) return String(process.env.ADMIN_TOKEN).trim();
  return getFileToken();
}

// 恒时比较:先比长度再逐字节 XOR 归零;长度不同也要走完整循环,
// 避免通过"多快失败"推测长度
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    // 长度不同也做一次等价开销的比较,消耗同样的路径
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function extractToken(req) {
  const auth = String(req.headers['authorization'] || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const header = String(req.headers['x-admin-token'] || '').trim();
  return header || '';
}

// —— 登录尝试限速(防 token 暴力枚举;calibre 恒时比较之外的节流层)——
// 同一 IP 连续失败 ≥ FAIL_LIMIT 次 → 冷却 COOLDOWN_MS 内直接 429。
// 内存 Map 即可:个人站场景无需持久化,重启即清零(攻击者视角:重启不该是它的救星,
// 但双层模式下 token 本身 48 位 hex,有限速兜底已足够)。
const FAIL_LIMIT = 5;
const COOLDOWN_MS = 10 * 60 * 1000;
// Map 必须有上限:失败 IP 会被无限写进来(公网上扫你站段的爬虫每小时能造几百个),
// 无上限的 Map 会随进程寿命单调增长 —— 单用户站点内存缓慢泄漏的典型形态。
// 做法:超过 MAX_ENTRIES 时先淘汰已过期的记录,仍然满则清空最早的(整表收缩)。
// 淘汰只影响"哪些 IP 还记得自己失败过几次",不影响 fail-closed 语义。
const MAX_ENTRIES = 1000;
const failLog = new Map(); // ip -> { count, blockedUntil }

// 收紧:删掉所有冷却期已过的记录(它们的计数也该归零重来),
// 返回删除条数。在每次写入前调用,成本 O(n) 但 n ≤ MAX_ENTRIES。
function pruneFailLog() {
  const now = Date.now();
  let removed = 0;
  for (const [ip, rec] of failLog) {
    if (rec.blockedUntil <= now) {
      failLog.delete(ip);
      removed += 1;
    }
  }
  return removed;
}

function clientIp(req) {
  // 仅使用 Express 已按 trust proxy 配置解析的地址，不能信任任意 XFF。
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateCheck(req, res) {
  const ip = clientIp(req);
  const rec = failLog.get(ip);
  if (rec && rec.blockedUntil > Date.now()) {
    const secs = Math.ceil((rec.blockedUntil - Date.now()) / 1000);
    res.set('Retry-After', String(secs));
    res.status(429).json({ error: `尝试次数过多,请 ${secs} 秒后再试`, code: 'RATE_LIMITED' });
    return false;
  }
  return true;
}

function rateFail(req) {
  const ip = clientIp(req);
  // 先收紧再写入:保证 failLog 的条目数不超过 MAX_ENTRIES
  if (failLog.size >= MAX_ENTRIES) {
    pruneFailLog();
    // 淘汰过期后仍然满(极端情况:同一时刻有上千个 IP 正在冷却期)→ 整表收缩。
    // 代价是这些 IP 的失败计数归零重来;但它们本来就在 10 分钟冷却里,
    // 重新计满 5 次也要再等 5 次失败,暴力枚举的净成本没有下降。
    if (failLog.size >= MAX_ENTRIES) failLog.clear();
  }
  const rec = failLog.get(ip) || { count: 0, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= FAIL_LIMIT) rec.blockedUntil = Date.now() + COOLDOWN_MS;
  failLog.set(ip, rec);
}

function rateClear(req) {
  failLog.delete(clientIp(req));
}

// 写权限、私有书库读权限与设备会话使用同一鉴权入口。未初始化时拒绝访问。
const COOKIE_NAME = 'mybooks_session';

function cookieToken(req) {
  return String(req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE_NAME + '='))?.slice(COOKIE_NAME.length + 1) || '';
}

function sameOrigin(req) {
  if (req.get?.('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = req.get?.('Origin');
  if (!origin) return true; // 原生客户端没有 Origin；浏览器 cookie 另有 SameSite 限制。
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}

function createAuthMiddleware({ store = authStore, legacyToken = loadTokenCached,
  publicRead = () => process.env.MYBOOKS_PUBLIC_READ === 'true' } = {}) {
  function authenticate(req) {
    const token = extractToken(req) || cookieToken(req);
    const master = legacyToken();
    if (token && master && safeEqual(token, master)) return { id: 'legacy-admin', label: '管理员令牌' };
    return store.authenticate(token);
  }
  function initialized() { return store.initialized() || !!legacyToken(); }
  function requireSession(req, res, next) {
    if (!initialized()) {
      return res.status(503).json({ error: '请先在服务器运行 npm run setup 初始化管理员', code: 'SETUP_REQUIRED' });
    }
    if (!rateCheck(req, res)) return;
    const session = authenticate(req);
    if (!session) {
      // 匿名浏览不积累计数；实际提交错误凭据才计入。
      if (extractToken(req)) rateFail(req);
      res.set('WWW-Authenticate', 'Bearer realm="my-books-admin"');
      return res.status(401).json({ error: '请登录你的图书服务器', code: 'AUTH_REQUIRED' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !extractToken(req) && !sameOrigin(req)) {
      return res.status(403).json({ error: '请求来源不匹配', code: 'ORIGIN_REJECTED' });
    }
    req.authSession = session;
    rateClear(req);
    next();
  }
  return {
    authenticate, initialized, requireSession,
    requireAdmin(req, res, next) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      return requireSession(req, res, next);
    },
    requireLibraryAccess(req, res, next) {
      if (publicRead()) return next();
      res.set('Cache-Control', 'private, no-store');
      return requireSession(req, res, next);
    },
  };
}
const auth = createAuthMiddleware();
const { requireAdmin, requireLibraryAccess, requireSession } = auth;

// 供测试:重置文件 token 缓存与限速计数
function resetTokenCache() {
  cachedFileToken = null;
  failLog.clear();
}

// 供测试/运维:查看当前限速表规模(确认上限生效)
function failLogSize() {
  return failLog.size;
}

module.exports = { requireAdmin, requireLibraryAccess, requireSession, auth, authStore,
  createAuthMiddleware, sameOrigin, COOKIE_NAME, rateCheck, rateFail, rateClear,
  safeEqual, extractToken, loadToken, resetTokenCache, TOKEN_FILE, FAIL_LIMIT, MAX_ENTRIES, failLogSize };
