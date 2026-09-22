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

const TOKEN_FILE = path.join(__dirname, '..', '..', 'data', 'admin-token');

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
const failLog = new Map(); // ip -> { count, blockedUntil }

function clientIp(req) {
  // 有反代时优先取 X-Forwarded-For 首个(Nginx 已配置传递);否则直连地址
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || 'unknown';
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
  const rec = failLog.get(ip) || { count: 0, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= FAIL_LIMIT) rec.blockedUntil = Date.now() + COOLDOWN_MS;
  failLog.set(ip, rec);
}

function rateClear(req) {
  failLog.delete(clientIp(req));
}

// express 中间件:只拦写方法
//
// 开关语义(用 token 文件/环境变量的存在性做开关,不引入新配置):
//   · 未配置 token(无 ADMIN_TOKEN 且无 data/admin-token 文件)→ 直接放行,
//     写操作由外圈 Nginx Basic 保护(单人 + 仅网页访问的日常模式,不弹令牌框);
//   · 一旦配置 token(建文件或设环境变量 + 重启)→ 双层模式,写操作必须带 Bearer token。
// 也就是说:开/关 = 建/删 data/admin-token 文件。
function requireAdmin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const serverToken = loadTokenCached();
  if (!serverToken) {
    // 未配置应用层令牌:放行,交给外圈 Nginx Basic(单层模式)
    return next();
  }

  // 双层模式:先看该 IP 是否处于限速冷却期
  if (!rateCheck(req, res)) return;

  const clientToken = extractToken(req);
  if (!clientToken || !safeEqual(clientToken, serverToken)) {
    rateFail(req);
    res.set('WWW-Authenticate', 'Bearer realm="my-books-admin"');
    return res.status(401).json({
      error: '需要管理令牌:请求头带 Authorization: Bearer <token> 或 X-Admin-Token',
      code: 'AUTH_REQUIRED',
    });
  }
  rateClear(req);   // 成功即清空该 IP 的失败计数
  return next();
}

// 供测试:重置文件 token 缓存与限速计数
function resetTokenCache() {
  cachedFileToken = null;
  failLog.clear();
}

module.exports = { requireAdmin, safeEqual, extractToken, loadToken, resetTokenCache, TOKEN_FILE, FAIL_LIMIT };
