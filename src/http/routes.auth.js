const express = require('express');
const { auth, authStore, loadToken, safeEqual, sameOrigin, COOKIE_NAME,
  rateCheck, rateFail, rateClear, requireSession } = require('./middleware.auth');
const router = express.Router();

router.use('/api/auth', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/api/auth/status', (req, res) => res.json({
  service: 'my-books', auth_version: 1, initialized: auth.initialized(),
  public_read: process.env.MYBOOKS_PUBLIC_READ === 'true',
}));

router.post('/api/auth/login', async (req, res, next) => {
  try {
    if (!sameOrigin(req)) return res.status(403).json({ error: '请求来源不匹配', code: 'ORIGIN_REJECTED' });
    if (!auth.initialized()) return res.status(503).json({ error: '请先在服务器运行 npm run setup', code: 'SETUP_REQUIRED' });
    if (!rateCheck(req, res)) return;
    const { username, password, token, device_name } = req.body || {};
    const master = loadToken();
    const valid = typeof token === 'string' && token.length <= 1024 && master && safeEqual(token, master)
      || await authStore.verifyPassword(username, password);
    if (!valid) {
      rateFail(req);
      return res.status(401).json({ error: '用户名、密码或管理员令牌不正确', code: 'AUTH_REQUIRED' });
    }
    const session = authStore.issueSession(device_name);
    rateClear(req);
    // 反代 TLS 通过 PUBLIC_URL 配置；直连 TLS 使用 req.secure。
    const secure = req.secure || process.env.MYBOOKS_PUBLIC_URL?.startsWith('https://');
    res.cookie(COOKIE_NAME, session.token, {
      httpOnly: true, secure: !!secure, sameSite: 'lax', path: '/',
      maxAge: Date.parse(session.expires_at) - Date.now(),
    });
    res.json(session);
  } catch (err) { next(err); }
});

router.get('/api/auth/me', requireSession, (req, res) => res.json({
  authenticated: true, device: { id: req.authSession.id, label: req.authSession.label },
}));
router.get('/api/auth/devices', requireSession, (req, res) => res.json(authStore.listSessions()));
router.delete('/api/auth/devices/:id', requireSession, (req, res) => {
  authStore.revoke(req.params.id);
  res.status(204).end();
});
router.post('/api/auth/logout', requireSession, (req, res) => {
  authStore.revoke(req.authSession.id);
  res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax' });
  res.status(204).end();
});
module.exports = router;
