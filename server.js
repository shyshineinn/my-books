/* ============================================================
 * My books 服务入口(薄壳)
 *
 * 职责只剩:创建 app、挂中间件、注册路由、监听端口。
 * 业务规则在 src/core/,数据访问在 src/db/,HTTP 适配在 src/http/。
 * ============================================================ */

const express = require('express');
const path = require('node:path');

const routesBooks = require('./src/http/routes.books');
const routesNotes = require('./src/http/routes.notes');
const routesMisc = require('./src/http/routes.misc');
const routesProxy = require('./src/http/routes.proxy');
const routesFiles = require('./src/http/routes.files');
const routesMetadata = require('./src/http/routes.metadata');
const routesIsbn = require('./src/http/routes.isbn');
const routesCategories = require('./src/http/routes.categories');
const routesSavedSearches = require('./src/http/routes.savedSearches');
const routesCustomFields = require('./src/http/routes.customFields');
const routesFeeds = require('./src/http/routes.feeds');
const routesExport = require('./src/http/routes.export');
const routesEnrich = require('./src/http/routes.enrich');
const routesImport = require('./src/http/routes.import');
const { requireAdmin, requireLibraryAccess } = require('./src/http/middleware.auth');
const routesAuth = require('./src/http/routes.auth');
const routesSync = require('./src/http/routes.sync');
const { UPLOAD_DIR, FILES_DIR } = require('./src/core/paths');
const { attachVlScope } = require('./src/http/middleware.vl');
const { db } = require('./src/db/index');
const books = require('./src/db/books');
const notes = require('./src/db/notes');
const { removeBookAssets } = require('./src/core/fs-utils');

const app = express();
const PORT = process.env.PORT || 3000;
// 线上建议 HOST=127.0.0.1:只监听本机,由 Nginx 反代对外,不把 Node 端口暴露到公网
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '10mb' }));
if (process.env.MYBOOKS_TRUST_PROXY) app.set('trust proxy', process.env.MYBOOKS_TRUST_PROXY);
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
// 认证端点先注册，不受书库读权限或业务写权限的阻挡。
app.use(routesAuth);
app.use('/api/v1/auth', (req, res, next) => {
  req.url = '/api/auth' + (req.url === '/' ? '' : req.url);
  routesAuth(req, res, next);
});
// CSV 导入允许直接发 text/csv 请求体(比 JSON 包一层 base64 省 33% 体积,
// 也更符合"把文件拖进来"的直觉)。只对这一个路由生效,不给全局加文本解析器 ——
// 那会让所有路由都接受任意文本体,收窄攻击面。
app.use('/api/import.csv', express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));
// 静态资源缓存策略:HTML 一律 no-cache(每次向服务器验证新鲜度),
// 解决"备案号/新功能要强制刷新才出现"—— index.html 自身没有 ?v= 缓存戳,
// 浏览器会缓存它,导致新发布的页面内容看不到。其余资源靠 ?v= 长缓存不受影响。
// extensions:['html'] 提供干净 URL:/shelf → shelf.html、/rank → rank.html、/stats → stats.html
// 注意:/notes 裸路径要重定向,必须挂在 static 之前 —— 否则会被 extensions
// 的 /notes → /notes.html 内部重写抢先命中(无 id 的心得页只能显示"找不到")。
app.get('/notes', (req, res) => res.redirect('/shelf'));

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.use('/uploads', requireLibraryAccess, express.static(UPLOAD_DIR));
// 电子书文件:GET 下载/阅读用(上传经 /api/* 走鉴权);原文件名不落盘
app.use('/books-files', requireLibraryAccess, express.static(FILES_DIR));

// 读书心得页:/notes/<书籍 id> —— 带路径参数,静态目录兜不住,显式路由。
// 与 *.html 同一套 no-cache 策略;非法 id 直接回书架(旧 hash 深链也收敛到这里)。
app.get('/notes/:id(\\d+)', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'notes.html'));
});
// 非法/缺失 id 的心得链接:/notes/abc → 书架(页面脚本会给出"找不到这本书"的引导)
app.get('/notes/:rest(.*)', (req, res) => res.redirect('/shelf'));

// 写操作鉴权(应用内):GET/HEAD 放行,POST/PUT/DELETE 要求 Bearer token。
// token 来源:环境变量 ADMIN_TOKEN 或 data/admin-token 文件;Nginx Basic 是外圈,这层是里圈。
app.use('/api', requireLibraryAccess, requireAdmin);
// 虚拟书库作用域(?vl=名称):解析一次挂到 req.vlScope,各路由只管取用
app.use('/api', attachVlScope);

// 电子书文件路由(multipart 上传/列表/删除/下载登记)
app.use(routesFiles);
// 豆瓣元数据抓取(GET /api/v1/metadata/search)
app.use(routesMetadata);
// ISBN:单本校验查重 + 按 ISBN 批量添加
app.use(routesIsbn);

// API 版本化:多端(小程序/PWA/CLI)长期演进的保险。
// v1 是对多端承诺的稳定契约;老的 /api/* 路径继续工作,现有前端(网页端)零改动。
// 实现:挂载在 /api/v1 时 express 已把 req.url 剥成 "/books" 这类相对路径,
// 而路由定义在 "/api/books" 上 —— 所以挂载前把 "/api" 加回去,两套前缀共用同一套路由。
const apiV1 = express.Router();
apiV1.use((req, res, next) => {
  req.url = '/api' + req.url;   // /books → /api/books;缺失尾斜杠时补全
  if (req.url === '/api') req.url = '/api/';
  next();
});
apiV1.use(routesBooks);
apiV1.use(routesSync);
apiV1.use(routesNotes);
apiV1.use(routesMisc);
apiV1.use(routesProxy);
apiV1.use(routesFiles);
apiV1.use(routesMetadata);
apiV1.use(routesIsbn);
apiV1.use(routesCategories);
apiV1.use(routesSavedSearches);
apiV1.use(routesCustomFields);
apiV1.use(routesFeeds);
apiV1.use(routesExport);
apiV1.use(routesEnrich);
apiV1.use(routesImport);
app.use('/api/v1', apiV1);

app.use(routesBooks);
app.use(routesSync);
app.use(routesNotes);
app.use(routesMisc);
app.use(routesProxy);
app.use(routesCategories);
app.use(routesSavedSearches);
app.use(routesCustomFields);
app.use(routesFeeds);
app.use(routesExport);
app.use(routesEnrich);
app.use(routesImport);

// Markdown 渲染库(浏览器版;marked v16+ 的 exports 限制子路径,需手动拼接包内路径)
const MARKED_UMD = path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js');
app.get('/vendor/marked.umd.js', (req, res) => res.sendFile(MARKED_UMD));
app.get('/vendor/purify.min.js', (req, res) => res.sendFile(require.resolve('dompurify/dist/purify.min.js')));

// 统一错误处理(必须挂在所有路由之后):
// 完整堆栈只进日志;对外只回通用文案,不泄漏内部路径/依赖细节
// (借鉴 calibre srv/errors.py 的对外简洁、对内详尽原则)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ->`, err.stack || err);
  if (res.headersSent) return; // 响应已开始输出,交给 express 默认终止
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: '服务器内部错误,请稍后重试', code: 'INTERNAL' });
});

// 回收站过期清理(对标 calibre expire_old_trash):启动时一次 + 每 6 小时一次。
// 数据库删除在 db 层完成,磁盘资产在提交后由这里清;失败只记日志,不影响服务。
const TRASH_MAINTENANCE_INTERVAL_MS = 6 * 3600 * 1000;
function runTrashMaintenance() {
  try {
    const purged = books.purgeExpired(db);
    let failed = 0;
    for (const item of purged) {
      failed += removeBookAssets(item.assets);
      if (!notes.removeNote(item.id)) failed += 1;
    }
    if (purged.length) {
      console.log(`[trash] 已清理 ${purged.length} 本过期书籍${failed ? `,${failed} 个文件/心得未能移除` : ''}`);
    }
  } catch (err) {
    console.error('[trash] 过期清理失败:', err.stack || err);
  }
}
runTrashMaintenance();
setInterval(runTrashMaintenance, TRASH_MAINTENANCE_INTERVAL_MS).unref();

const server = app.listen(PORT, HOST, () => {
  console.log(`My books 已启动: http://${HOST === '0.0.0.0' || HOST === '127.0.0.1' ? 'localhost' : HOST}:${server.address().port}`);
});

// 优雅退出(借鉴 calibre srv/standalone.py 的 HandleInterrupt):
// SIGTERM(pm2 stop/restart)与 SIGINT(Ctrl+C)先停止接新请求,给在途请求
// 最多 3s 完成;之后兜底强杀。与 ecosystem.config.js 的 kill_timeout: 5000 呼应。
// WAL 模式下数据库本就崩溃安全,这里主要避免在途请求被硬切、临时文件残留。
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal},停止接受新请求,等待在途请求完成…`);
  server.close(() => {
    console.log('[shutdown] 全部连接已结束,进程退出');
    process.exit(0);
  });
  setTimeout(() => {
    console.log('[shutdown] 等待超时,强制退出');
    process.exit(1);
  }, 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
