# 📚 My books · 图书记录网站

一个 Apple 设计风格的个人图书记录网站,记录你读过的每一本书:状态、阅读记录、简介、封面、分类标签,并提供榜单与读书统计面板。手机和电脑均可自适应访问。

**线上地址:<https://helloac.top>**(备案号 `豫ICP备2026045565号`,已悬挂在页脚并链接工信部)

---

## 目录

- [功能总览](#功能总览)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
  - [总体架构](#总体架构)
  - [后端架构(serverjs--dbjs)](#后端架构serverjs--dbjs)
  - [数据模型](#数据模型)
  - [前端架构(public)](#前端架构public)
  - [关键实现细节](#关键实现细节)
  - [安全设计](#安全设计)
- [目录结构](#目录结构)
- [API 一览](#api-一览)
- [数据与备份](#数据与备份)
- [部署与运维](#部署与运维)(含九阶段上线手册 / 回滚 / 线上运维)

---

## 功能总览

### 页面与视图

单页应用,顶部导航在五个视图间切换:

| 视图 | 内容 |
| --- | --- |
| **首页** | Apple 官网式排版:Hero 标语 → 「最新上架」特色卡 → 双列书格(4 本)→ 「Endless entertainment.」双排无限轮播(复刻 apple.com media-gallery:自动播放、进度条圆点、拖拽/甩动、键盘方向键) |
| **书架** | 封面卡片网格,状态页签(想读/在读/已读)带计数,标签筛选 + 排序,支持添加 / 编辑 / 删除书籍(删除有确认提示) |
| **榜单** | 英雄区(总藏书 / 读完数)+ **重读榜**(读过两次以上的书,按次数排序,至多 8 本) |
| **统计** | 阅读印象 Hero(总藏书 / 已读及占比 / 在读 / 想读)+ 每年读完柱状图 + 标签分布(点击标签跳回书架筛选) |
| **读书心得** | 子页面,渲染单本书的 Markdown 心得,支持 hash 深链 `#/notes/<id>`(浏览器前进后退可用) |

### 记录字段与阅读记录

- **字段**:书名(必填)、作者、状态(想读 / 在读 / 已读)、图书简介(≤1000 字)、分类标签、封面、心得链接
- **阅读记录**:每次阅读的起止日期列表,是日期类字段的**唯一数据源** ——
  - 「读完日期」= 记录中最晚的读完日;「开始日期」= 最近一次的开读日
  - 「读过次数」= 记录中已有读完日期的条数
  - 前端状态联动:切「已读」自动补最近一次记录的读完日期;切「在读」自动新增一条今天开读的记录
- 兼容旧数据:没有阅读记录但有起止日期的书,编辑时自动迁移为一条记录

### 读书心得(GitHub 仓库)

- 右上角 ⚙ 设置一个 **GitHub 公开仓库**(格式 `owner/repo`,可选分支,默认 `main`)
- 心得写成 `.md` 按**书名**命名(如 `三体.md`)放仓库根目录,详情页/心得页自动获取并渲染 Markdown
- 也可在编辑书籍里为单本书填写完整的 GitHub 文件链接(优先级高于按书名自动匹配)
- 服务端代理拉取(raw.githubusercontent.com),内存缓存 5 分钟;渲染前经 **DOMPurify** 消毒

### 封面

- 三种来源:粘贴图片链接 / 上传本地图片(png、jpg、gif、webp,≤5MB,base64 上传)/ 无封面时自动生成渐变占位封面
- 占位封面按书名哈希从 6 组 Apple 产品配色(午夜色、星光色、远峰蓝、银色、原野绿、深空灰)中确定性选色
- 首页大卡与小卡会用 Canvas 提取封面主色,为卡片生成同源渐变背景与深浅自适应文字

### 搜索 / 筛选 / 排序

- 按书名 / 作者模糊搜索(300ms 防抖;**发起检索会清空状态与标签筛选**,即全库检索)
- 按状态页签与标签筛选;按最近更新 / 读完日期 / 书名排序
- 排序与筛选都在 SQL 层完成,标签匹配走 JSON 字符串 `LIKE`

### 移动端与无障碍

- 手机两列卡片 + 底部抽屉弹窗 + 全屏菜单(apple.com 风);平板 / 电脑最多六列自适应
- 顶栏搜索是移动端一级入口(点图标展开整行搜索栏);左边缘右滑返回(≤819px)
- 弹窗 / 轮播 / 下拉均带 aria 标注与键盘操作;轮播尊重 `prefers-reduced-motion`
- 首次启动自动写入 **17 本**示例书(见 `db.js` 的种子数据),可像普通书一样编辑或删除

---

## 快速开始

```bash
npm install   # 首次使用安装依赖(运行时依赖仅 3 个:express、marked、dompurify)
npm start     # 启动服务
```

然后浏览器打开 **http://localhost:3000** 即可。

> 需要 **Node.js ≥ 22.5**(数据库使用 Node 内置的 `node:sqlite`,无需任何数据库安装与配置)。
> 首次启动自动创建 `data/books.db` 并写入 17 本示例书;`uploads/` 目录也会自动创建。

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口;线上为 `3002` |
| `HOST` | `0.0.0.0` | 监听地址;**线上必须为 `127.0.0.1`**,由 Nginx 反代对外,Node 端口不暴露公网 |
| `ADMIN_TOKEN` | — | 写接口管理令牌(优先级高于 `data/admin-token` 文件);**未配置时写接口一律 503 拒绝** |
| `NODE_ENV` | — | 线上设为 `production` |
| `TZ` | — | 线上设为 `Asia/Shanghai`,保证时间戳与备份文件名可读 |

管理令牌二选一:`ADMIN_TOKEN` 环境变量,或单行文本文件 `data/admin-token`(推荐,
该文件已在 .gitignore 中;生成:`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`)。
心得仓库设置存在数据库 `settings` 表里,通过界面修改。

---

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 22.5 | 用内置 `node:sqlite`(`DatabaseSync`),零外部数据库 |
| 后端 | Express 4 | 分层结构(core / db / http),`server.js` 薄入口,REST API + 静态资源 + 两个代理接口 |
| 数据库 | SQLite 单文件 | `data/books.db`,启动时自动建表与迁移 |
| 前端 | 原生 HTML / CSS / JS | **无框架、无构建、无打包器**,直接静态文件 + 事件委托 |
| Markdown | marked(UMD)+ DOMPurify | 经 `/vendor/*` 端点直接从 `node_modules` 回包,绕开构建步骤 |
| 测试 | Node 内置 test runner | `npm test`,零新增依赖 |
| 托管 | PM2(主)/ systemd(备) | 单进程 fork 模式 |
| 反代 | Nginx | TLS 终结、gzip、安全头、写接口 Basic 口令、静态长缓存 |

---

## 系统架构

### 总体架构

```
        浏览器(SPA:原生 JS,无构建;public/ 静态文件)
            │  fetch /api/*(JSON)          fetch /api/notes、/api/img-proxy
            ▼                                        │
   ┌─────────────────────┐   301 跳 HTTPS             ▼
   │  Nginx 443(TLS 终结 │  ← 80 端口只留 ACME 路径   │
   │  gzip / 安全响应头    │                    回源外网(GitHub raw / 图床)
   │  写接口 Basic 口令    │
   │  client_max_body 100m│
   └──────────┬──────────┘
              │ proxy_pass http://127.0.0.1:3002
              ▼
   ┌──────────────────────────────────────────────┐
   │  Node.js + Express(PM2 单进程 fork 托管)      │
   │  server.js 薄入口(create app / 挂路由 / listen)│
   │  ├── http/  路由适配(books / misc / proxy)    │
   │  ├── db/    数据访问(CRUD / settings / stats) │
   │  ├── core/  纯业务规则(parseBook 等,有测试)   │
   │  ├── express.static  public/、/uploads/       │
   │  └── /vendor/*       marked.umd.js / purify   │
   └───────┬──────────────────────────┬───────────┘
           ▼                          ▼
   data/books.db(node:sqlite)   uploads/(上传的封面图片)
```

- 单进程即可:`instances: 1, exec_mode: 'fork'`(SQLite 文件锁 + 个人站点无并发压力)
- 前后端同源同进程部署,没有独立的前端服务;所有动态能力都走 `/api/*`

### 后端架构(三层:core / db / http)

后端按依赖方向严格分层:**core(纯规则)← db(数据访问)← http(HTTP 适配)← server.js(薄入口)**,
上层可以引用下层,下层不感知上层 —— `src/core/` 与 `src/db/` 里没有一行 express 代码,
`server.js` 里没有一条 SQL。这是"数据层与前端解耦"的关键:未来加 CLI、定时任务或第二个前端,
只需要复用 `src/db/`,不复制任何业务规则。

**`src/core/` 纯业务规则(可独立测试,不碰 I/O)**

- `book.js`:`parseBook()` 统一校验(书名必填、状态白名单、标签去重、日期格式、读过次数 0~999、
  阅读记录结构与先后关系、简介截断 1000 字)+ **「阅读记录是唯一日期来源」推导规则**;
  `mergeUpdate()` 实现 PUT 局部更新语义(未提供的字段保留数据库旧值)
- `stats.js`:`computeStats()` 统计聚合(状态分组 / 按年读完 / 标签 Top12)

**`src/db/` 数据访问(只 import node: 内置模块与 core)**

- `index.js`:打开 `data/books.db`、建表、**幂等迁移**(缺列补齐;`review`/`rating` 下线删列,
  `rating` 删除前自动备份)、书架为空时写 17 本种子数据(数据在 `seed-data.js`)
- `search.js`:**独立全文检索层**(对标 calibre `db/search.py` + `db/fts`)。FTS5 虚表
  `books_fts`(trigram 分词,中文子串友好)通过外部内容连接 books 主表,增删改由
  `books.js` 同步一行;检索 ≥3 字走 FTS+BM25 相关度排序,1~2 字短词回退 LIKE(tags 仍走 LIKE)
- `books.js`:CRUD 与列表查询;有搜索词时 `listBooks` 委托 `search.js`,无搜索词走主表
  (排序白名单 / 筛选拼装在 SQL 层,标签匹配走 JSON 字符串 LIKE)
- `settings.js`:心得仓库设置读写与校验
- `stats.js`:取全量行后交给 `core/computeStats` 聚合(个人书架数据量小,全表扫描即可)

**`src/http/` HTTP 适配(解析请求 → 调 db → 组响应,不写规则与 SQL)**

- `routes.books.js`:书籍 CRUD 路由
- `routes.misc.js`:设置 / 上传(MIME 白名单 + 5MB + 随机文件名)/ 统计路由
- `routes.proxy.js`:两个出站代理,原样保留缓存与超时:
  - `/api/notes`:仅接受 `github.com` 与 `raw/gist.githubusercontent.com` 链接;短文件名解析到设置里的仓库;`AbortSignal.timeout(30s)`;缓存 5 分钟
  - `/api/img-proxy`:SSRF 防护(内网地址黑名单)、仅 http/https、`content-type` 必须为 `image/*`、≤5MB、15s 超时 + 失败自动重试一次;缓存 1 小时并给浏览器 `Cache-Control: public, max-age=3600`

**`server.js` 薄入口(约 45 行)**

- 中间件:`express.json({ limit: '10mb' })`(封面 base64 编码后约 6.7MB,必须留足)、`express.static` 服务 `public/` 与 `/uploads/`
- `/vendor/marked.umd.js`、`/vendor/purify.min.js`:把 `node_modules` 里的 UMD 文件直接回给浏览器
  (marked v16+ 的 exports 限制子路径,需手动拼接包内路径),因此前端无需任何构建

### 测试

`npm test`(Node 内置 test runner,零新依赖),当前 **42 条用例**全部通过:

- `test/book.test.js`(17 条):校验规则 + 核心推导规则 —— 有记录时日期与次数由记录推导、
  请求体旧值被忽略、进行中记录不计次数、无记录时保留兜底值(API 兼容)、PUT 保留旧值语义等
- `test/stats.test.js`(5 条):状态分组 / byYear 只计已读完 / topTags 降序取 12 / 坏 JSON 容错 / 空书架
- `test/auth.test.js`(11 条):恒时比较 / 请求头提取 / GET 放行 / 无 token 401 或 503(fail closed)/
  错 token 401 / 对 token 放行(两种头都验)
- `test/search.test.js`(9 条):独立全文检索层 —— trigram 中文子串命中标题/作者/简介/标签、
  1~2 字短词 LIKE 兜底、status/tag 与检索正交、增删改同步索引、BM25 相关度排序、迁移建索引、重建索引

### 数据模型

`books` 表(`tags`、`read_logs` 为 JSON 字符串):

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 自增 |
| `title` | TEXT NOT NULL | 书名(必填) |
| `author` | TEXT | 作者 |
| `status` | TEXT | `wish` / `reading` / `done`,CHECK 约束 |
| `summary` | TEXT | 图书简介,服务端截断 ≤1000 字 |
| `tags` | TEXT | JSON 数组,如 `["小说","科幻"]` |
| `start_date` / `finish_date` | TEXT | `YYYY-MM-DD`;**由 `read_logs` 自动推导**,无记录时保留表单兜底值 |
| `cover` | TEXT | 封面地址(`/uploads/...` 相对路径或外链);空则前端生成占位封面 |
| `notes_url` | TEXT | 心得 Markdown 链接;空且已配置仓库时按《书名》.md 自动匹配 |
| `read_count` | INTEGER | 读过次数;**有记录时 = `read_logs` 中 `finish` 非空的条数** |
| `read_logs` | TEXT | JSON 数组 `[{start, finish}]`,每行一次阅读 |
| `created_at` / `updated_at` | TEXT | ISO 时间戳 |

`settings` 表:`key TEXT PRIMARY KEY, value TEXT`;现用键:`notes_repo`、`notes_branch`。

**推导规则**(服务端 `parseBook` 强制执行):阅读记录存在时,`read_count` / `finish_date` / `start_date` 全部由记录推导,忽略请求体里的旧值;无记录时保留请求体兜底值(API 兼容旧客户端)。

### 前端架构(public/)

- **无构建管线**:4 个 `<script>` 按序加载 —— `vendor/marked.umd.js`、`vendor/purify.min.js`、`js/endless-gallery.js`、`js/app.js`;样式单文件 `css/style.css`
- **缓存失效**:`index.html` 里静态资源用版本号查询串(`style.css?v=23`、`app.js?v=25`…)控制;**改动静态文件后记得同步递增对应 `?v=`**
- `js/app.js`(约 1600 行)模块划分:
  - 全局状态 `state { q, status, tag, sort, view, prevView, books, settings }` + `api()` fetch 封装
  - 视图切换 `switchView()`:home / shelf / rank / stats / notes 五个 `<section>` 显隐切换;hash 路由 `#/notes/<id>`、`#/rank`
  - 书架渲染、统计渲染、榜单渲染、首页渲染均由事件委托绑定,重渲染无需重复挂监听
  - **竞态防护**:列表 / 统计 / 取色各自维护会话号(`fetchSeq`、`statsSeq`、`tintSeq`),旧响应一律丢弃
  - 表单:阅读记录编辑器 + 状态联动;封面编辑器(链接 / 上传 / 移除,类型与 5MB 前置校验)
  - 自定义下拉:原生 `<select>` 隐藏作唯一数据源,视觉上渲染「胶囊按钮 + 圆角浮层」,选中后回写 `select.value` 并派发 `change`
  - 移动端:全屏菜单、顶栏搜索展开、左边缘右滑返回(层级:弹窗 → 菜单 → 搜索栏 → 下拉 → 子页面/深链 → 返回首页)
- `js/endless-gallery.js`(约 560 行):逐项复刻 apple.com 首页 media-gallery ——
  - 卡片绝对定位 + `translate3d`,位置用**模运算取最短路径**,循环无跳变;两排共享同一索引、各排按自身数量取模
  - 4.16s 自动播放周期(进度条晚 160ms 起跑)、1s `cubic-bezier(0.645,0.045,0.355,1)` 滑动
  - dotnav:当前点展开为进度轨道;圆点 >7 个时启用 Apple 同款「7 点变距窗口」与交错淡入淡出
  - 交互:拖拽 / 甩动(0.35px/ms 阈值)/ 方向键 / Home/End / 点击侧边卡翻页;离屏(`IntersectionObserver`)与切后台自动暂停;`prefers-reduced-motion` 降低动效
- 首页封面取色管线:封面缩到 24×24 canvas → 3bit/通道量化分桶取最大桶 → 相近色合并(Δ<90)→ `derivePalette()` 做 HSL 钳制与深浅自适应文字

### 关键实现细节

- **阅读记录是唯一日期来源**:服务端推导 + 前端联动双向保证,避免「记录」与「起止日期」两套数据并存
- **搜索即全库检索**:输入非空时自动清掉状态/标签筛选(前端行为),避免「在标签下搜不到书」
- **请求竞态防护**:列表 / 统计 / 取色都带会话号,连续操作只采纳最后一次结果
- **零构建的 Markdown 管线**:marked + DOMPurify 以 UMD 形式从 `node_modules` 经 Express 直出,升级依赖即升级前端库
- **PUT 局部更新语义**:未提交的字段保留旧值,方便脚本 / 旧客户端只改部分字段
- **静态资源版本号**:改 `public/` 下文件后同步递增 `index.html` 里的 `?v=`,避免线上缓存旧资源

### 安全设计

| 面 | 措施 |
| --- | --- |
| 写接口鉴权 | **双层**:外圈 Nginx `limit_except GET HEAD + auth_basic`(浏览器弹框);里圈应用内 `src/http/middleware.auth.js` —— 非 GET/HEAD 的 `/api/*` 要求 `Authorization: Bearer <token>` 或 `X-Admin-Token` 头,恒时比较防时序侧信道;**未配置 token 时写接口一律 503(fail closed)**。读接口公开。命令行调用:`curl -H "Authorization: Bearer <token>" -X POST …` |
| 网络暴露 | 生产 Node 只绑 `127.0.0.1:3002`;云安全组不放行应用端口 |
| XSS | 所有 HTML 插值经 `esc()` 转义;Markdown 渲染结果经 `DOMPurify.sanitize()` |
| SSRF | `/api/img-proxy` 内网地址黑名单(localhost、127/8、10/8、172.16/12、192.168/16、169.254/16、IPv6 回环/ULA/链路本地、0/8);`/api/notes` 仅允许 GitHub 三个域名 |
| 上传 | MIME 白名单(png/jpeg/gif/webp)+ 5MB 上限 + `时间戳-随机hex` 文件名,不透传原始文件名 |
| 传输 | TLS 1.2/1.3(免费 DV 单域名证书,不做 www);HTTP 80 一律 301 到 HTTPS |
| 响应头 | Nginx 统一加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: strict-origin-when-cross-origin` |
| 外链图片 | 封面 `<img>` 带 `referrerpolicy="no-referrer"` |
| 请求体 | `express.json` 限 10MB(封面 base64);电子书走 multipart,上限 80MB;Nginx `client_max_body_size 100m`(需 ≥ 应用层上限,否则超限先被 Nginx 以 413 拦下) |

---

## 目录结构

```
my-books/
├── package.json                      # 依赖(express/marked/dompurify)、启动与测试脚本
├── server.js                         # 薄入口:创建 app、挂路由、listen(不含业务规则与 SQL)
├── src/
│   ├── core/                         # 纯业务规则(不依赖 express / 数据库,可独立测试)
│   │   ├── book.js                   # parseBook 校验+推导、mergeUpdate 局部更新语义
│   │   └── stats.js                  # computeStats 统计聚合
│   ├── db/                           # 数据访问层(只 import node: 与 core)
│   │   ├── index.js                  # 打开 books.db、建表、幂等迁移、种子判断
│   │   ├── seed-data.js              # 17 本示例书数据
│   │   ├── books.js                  # 书籍 CRUD 与列表查询(SQL 拼装)
│   │   ├── settings.js               # 心得仓库设置读写
│   │   └── stats.js                  # 统计查询入口
│   └── http/                         # HTTP 适配层(解析请求 → 调 db → 组响应)
│       ├── middleware.auth.js        # 写接口应用内鉴权(Bearer token,恒时比较,fail closed)
│       ├── routes.books.js           # 书籍 CRUD 路由
│       ├── routes.misc.js            # 设置 / 上传 / 统计路由
│       └── routes.proxy.js           # notes / img-proxy 出站代理(缓存 + SSRF 防护)
├── test/                             # node:test 用例(npm test)
│   ├── auth.test.js                  # 鉴权中间件行为(放行/401/503/恒时比较)
│   ├── book.test.js                  # 校验规则 + 「记录是唯一日期来源」+ PUT 语义
│   └── stats.test.js                 # 统计聚合规则
├── deploy/
│   ├── ecosystem.config.js           # PM2 进程配置(主方案:3002 / 127.0.0.1 / fork)
│   ├── my-books.service              # systemd 单元(备选,与 PM2 二选一)
│   ├── nginx-helloac.top.conf        # 根域名站点(80→301 + 443 反代,含写接口口令块)
│   ├── nginx-ecook.helloac.top.conf  # ecook 子域名站点(同机共存的另一站点)
│   └── update.sh                     # 一键更新:备份 → 拉代码 → 装依赖 → 重启 → 自检
├── public/
│   ├── index.html                    # 单页应用结构(页脚含备案号)
│   ├── logo.png / logo-mark.png / add-icon.png
│   ├── css/style.css                 # Apple 风格响应式样式(单文件)
│   └── js/
│       ├── app.js                    # 前端主逻辑(约 1600 行)
│       └── endless-gallery.js        # 首页复刻 apple.com 的双排无限轮播
├── data/                             # 运行时自动创建;.gitignore 忽略 *.db
│   ├── books.db                      # SQLite 数据库(唯一数据文件)
│   └── backup/                       # update.sh 的滚动备份(保留 10 份)
└── uploads/                          # 上传的封面图片(运行时自动创建;.gitignore 忽略)
```

---

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books?q=&status=&tag=&sort=` | 书籍列表;`q` 模糊搜书名/作者,`status` ∈ wish/reading/done,`tag` 精确匹配标签,`sort` ∈ updated(默认)/created/finish/title |
| GET | `/api/books/:id` | 单本书详情(不存在返回 404) |
| POST | `/api/books` | 添加书籍;服务端统一校验并推导阅读记录字段 |
| PUT | `/api/books/:id` | 更新书籍;未提供的字段保留旧值 |
| DELETE | `/api/books/:id` | 删除书籍 |
| POST | `/api/upload` | 上传封面;JSON 体 `{ data: "data:image/png;base64,…" }`,≤5MB,返回 `{ url }` |
| GET | `/api/settings` | 读心得仓库设置 `{ notesRepo, notesBranch }` |
| PUT | `/api/settings` | 保存心得仓库;`notesRepo` 自动去掉 `https://github.com/` 前缀与 `.git` 后缀 |
| GET | `/api/notes?url=` | 代理拉取 GitHub 上的心得 Markdown(内存缓存 5 分钟);`url` 可为完整 GitHub 链接或按书名短文件名 |
| GET | `/api/img-proxy?url=` | 外链封面图片代理:同源化供 Canvas 取色(SSRF 防护,缓存 1 小时,失败重试一次) |
| GET | `/api/stats` | 统计数据 `{ total, byStatus, byYear, topTags }`(topTags 至多 12 个) |

另有两个静态 vendor 端点:`GET /vendor/marked.umd.js`、`GET /vendor/purify.min.js`(供前端渲染 Markdown 用)。

> **线上鉴权(双层)**:写操作(`POST / PUT / DELETE` 与 `/api/upload`)受两层保护 ——
> ① Nginx Basic 口令(浏览器弹账号密码框,`curl -u admin:密码`);
> ② 应用内管理令牌:请求头带 `Authorization: Bearer <token>` 或 `X-Admin-Token`(`data/admin-token`
> 文件内容)。浏览器首次写操作会弹一次令牌输入框,之后存 localStorage 无感。
> 所有 `GET` 读接口保持公开,浏览与搜索不受影响。

---

## 数据与备份

- 书籍数据保存在 **`data/books.db` 单个文件**;上传的封面在 `uploads/`,上传的电子书在 `books-files/`
- `deploy/update.sh` 每次更新前自动备份到 `data/backup/`(各保留最近 10 份):
  - 数据库 `books-*.db`,并做 `integrity_check` 对账(校验失败即中止更新)
  - 文件快照 `files-*/(uploads/ + books-files/)`,优先用硬链接(`cp -al`)——瞬时完成、不占额外空间;因应用写文件一律「先写临时名再原子 rename」,被替换的旧文件在快照里仍是完整旧版本
- 线上另有 cron 每日 03:30 全量打包 `data + uploads + books-files`(保留 7 份),见[线上运维](#线上运维)
- 旧库升级(补列 / 删列)在启动时自动完成;`rating` 列删除前会留一份 `data/books.backup-before-drop-rating`

---

## 部署与运维

**线上地址:https://helloac.top**(备案号 `豫ICP备2026045565号`,已悬挂在页脚并链接工信部)

### 上线状态

线上状态(2026-09-17 上线,外网实测):

| 项 | 状态 |
| --- | --- |
| `https://helloac.top` | ✅ `200`,`http` 自动 301 跳到 `https` |
| 证书 | 云厂商免费 DV 证书(TrustAsia 签发),有效期至 **2026-12-16** |
| 写接口 | ✅ Nginx Basic 口令保护(POST/PUT/DELETE 与上传要口令,浏览公开) |
| 端口 | 3002 只监听 `127.0.0.1`,公网不可达 |

### 服务器拓扑

部署在 Ubuntu 24.04 云服务器 `120.53.29.226`,与 ecook 共用一台机器、共用 Nginx:

| 域名 | 反代到 | PM2 进程 |
| --- | --- | --- |
| `helloac.top` | `127.0.0.1:3002` | `my-books` |
| `ecook.helloac.top` | `127.0.0.1:3001` | `ecook` |

**服务器 Node 必须 ≥ 22.5**(项目用 Node 内置 `node:sqlite`),运行方式为
`PORT=3002 HOST=127.0.0.1`,端口不对公网开放,统一由 Nginx 反代。

配套文件:

| 文件 | 用途 |
| --- | --- |
| `deploy/nginx-helloac.top.conf` | 本站站点配置(80→301 + 443 → `127.0.0.1:3002`,含写接口口令块) |
| `deploy/nginx-ecook.helloac.top.conf` | ecook 子域名站点配置(80→301 + 443 → `127.0.0.1:3001`) |
| `deploy/ecosystem.config.js` | PM2 进程配置(主方案) |
| `deploy/my-books.service` | systemd 单元(备选,与 PM2 二选一) |
| `deploy/update.sh` | 一键更新:备份 → 拉代码 → 装依赖 → 重启 → 自检 |

### 部署总目标

把 my-books 部署到 `120.53.29.226`,让 `https://helloac.top` 打开书架页,ecook 迁到 `ecook.helloac.top`。

> 下面的九阶段步骤于 2026-09-17 在一台新机器上**完整执行过一遍**;之后**换机器重建**或**灾后恢复**
> 照着敲即可。阶段 1 里的「实测基线」表是当时的现场记录,用于说明为什么要那样改,不代表当前状态。

### 前提(已确认)与操作纪律

- **只有一台生产机,没有测试机、没有灰度环境。** 这台机器上的一切改动都按「生产变更」对待:改动前先备份,验收不过就停手回滚,不要硬往下做。
- 这台机器就是 **`120.53.29.226`(Ubuntu 24.04 LTS)** —— 已在 2026-09-17 向用户确认。注:ecook 的 README 旧版曾把它标为「测试机」,该标注作废,现在它就是线上唯一的生产机。
- 线上域名统一为 **`helloac.top`**;读书网站(本地目录 `D:\littleBIngbing\my-books`)**占用根域名**,ecook 让位到 `ecook.helloac.top`。
- 两个站点同机共存(3002 / 3001),代码目录、端口、数据库三者**互不共享**;停掉 my-books 不影响 ecook 与小程序。
- 顺序纪律:**本地先跑通 → 服务器上一次性改完再 reload → 每阶段验收**。尤其 Nginx 的 ecook.conf 与 helloac.top.conf 要全部改完再 reload,否则根域名会出现「无人接管」的窗口。
- 根域名只服务 `helloac.top` 本身:**免费证书是单域名、不覆盖 `www`**,故不做 `www` 访问(省一张证书);若确实要保留 `www`,需另行申请证书并单独加 server 块。

**开始前,先把三个占位符记下来**(下面命令里出现时直接替换):

| 占位符 | 你的实际值 |
| --- | --- |
| `root@120.53.29.226` | 你的 SSH 登录账号 + 服务器 IP(root 登录就写 `root@120.53.29.226`) |
| `/root` | **PM2 运行账号**的家目录(已实测:PM2 跑在 `root` 下) |
| `120.53.29.226` | 服务器公网 IP |

每个阶段末尾有 ✅ **验收标准**,不通过就别往下走。中途出问题看 [阶段 9 回滚](#阶段-9出问题怎么回滚)。

---

### 阶段 1:登录服务器,确认现状(不改任何东西)

```bash
ssh root@120.53.29.226
```

```bash
whoami && echo "HOME=$HOME"
node -v                      # 现在应该是 v20.x
nginx -v                     # 实测 1.24.0(配置语法通用,不用改)
pm2 ls                       # ecook = online
ps -eo user,cmd | grep -m1 "[P]M2"      # 看 PM2 是哪个账号跑的,记住这个账号名
grep -rn "server_name" /etc/nginx/conf.d/
ls -l /etc/nginx/ssl/
sudo ss -lntp | grep -E ':(80|443|3001|3002|3306)'

# 本机 conf.d 没有 server_name,所以要找出真正生效的配置:
sudo nginx -T 2>/dev/null | grep -nE '# configuration file|server_name|listen |root |proxy_pass'
ls -l /etc/nginx/sites-enabled/ /etc/nginx/sites-available/ 2>/dev/null
```

**✅ 验收**:与下面两张基线表逐项对照,**不一致的地方才是重点**,记下来再进阶段 2。
本次实测已确认三件事:① **部署账号 = `root`**(PM2 God Daemon 跑在 root 下);
② **443 没有任何监听**、`ufw` 为 inactive → 443 不通的原因是 **Nginx 里根本没有 443 server 块**(不是防火墙);
③ **`/etc/nginx/conf.d/` 里没有任何 `server_name`** → 生效的站点配置在别处,必须先找出真正被加载的配置文件(阶段 7 的前提)。

#### 外网实测基线(2026-09-17 21:06,从本机探测 `120.53.29.226`)

> 部署前现场记录,保留用于说明「为什么要这么改」。

| 探测 | 实测结果 | 含义 |
| --- | --- | --- |
| 80 · 任意 Host | `200 OK`,返回旧静态页「我的读书清单」(`nginx/1.24.0`) | 存在一个**默认站点**兜底指向旧的静态读书页;**不是** 301 跳转 |
| 443 | **Connection refused** | 服务器侧已证实:`ss -lntp` 无 443 监听、`ufw` inactive → **Nginx 没有 443 server 块**(与文档「443 反代 3001」不符) |
| 3001 | **公网可直接访问**,`/api/ping` 返回 `{"ok":true,...}` | ecook 裸奔中,上线后必须关闭 |
| 3002 | 不可达 | ✅ 空闲,my-books 可用 |
| 3306 | 不可达 | ✅ 未暴露 |
| DNS | `helloac.top` / `www` / `ecook.helloac.top` → `120.53.29.226` | ✅ 已生效 |

> 提示:`www.helloac.top` 也解析到了本机,但我们不做 www —— 若不想让它落到那个默认站点上,
> 去 DNSPod 把 `www` 这条 A 记录删掉即可(不删也不影响上线)。

#### 服务器侧实测(2026-09-17 21:11,阶段 1 输出)

| 项目 | 实测 | 含义 |
| --- | --- | --- |
| 登录账号 / 家目录 | `root` / `/root` | **部署账号 = root** → 路径统一为 `/root/my-books` |
| Node | **v20.20.2** | 需升到 22(阶段 2) |
| PM2 | v7.0.3,God Daemon 在 `/root/.pm2`,user = **root** | `ecook` 进程 user=root、online、累计重启 134 次 |
| 80 | `0.0.0.0:80` nginx | 正常 |
| 443 | **无监听** | 结合 `ufw` inactive → 确认是 Nginx 没有 443 server 块 |
| 3001 | `0.0.0.0:3001` node(`/home/ecook/server`) | 公网裸奔,上线后必须关 |
| 3002 | 无监听 | ✅ 空闲,my-books 可用 |
| ufw | **inactive** | 端口拦截不在本机防火墙层 |
| `/etc/nginx/conf.d/` | **无任何 `server_name`** | 生效配置在别处(`sites-enabled/` 或 `nginx.conf`/**待查**) |
| `/etc/nginx/ssl/` | **空** | 印证 443 从未配置过(文档里说的「自签过渡」并不存在) |

**⚠️ 关键(已实测)**:PM2 God Daemon 跑在 **`root`** 下,而你就是以 root 登录的 —— 部署账号
就是 `root`,**后面所有命令直接以 root 执行即可**(PM2 才认得你启动的进程)。
既然已是 root,命令里的 `sudo` 可留可去,不影响结果。

**同时去做(不占服务器时间)**:
- DNS 控制台加一条 A 记录:`ecook` → `120.53.29.226`
- 云控制台安全组:放行 `80`、`443`;确认 `3001`、`3002`、`3306` **没有**放行

```bash
dig +short ecook.helloac.top    # 在你自己电脑上执行,返回 120.53.29.226 才算生效
```

---

### 阶段 2:升级 Node 20 → 22(本手册唯一的风险点)

```bash
# 2.1 留好回滚路径 + 保存 PM2 进程列表
sudo cp /usr/bin/node /root/node20.bak
node -v | sudo tee /root/node-before-upgrade.txt
pm2 save

# 2.2 升级
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v            # ✅ 期望 v22.x.x
npm -v
```

**2.3 立刻把 ecook 拉起来实测**(升级唯一影响的既有服务):

```bash
cd /home/ecook/server                      # ecook 后端目录
ls node_modules 2>/dev/null | grep -E "^(sharp|canvas|bcrypt|sqlite3|better-sqlite3|node-gyp)$" \
  || echo "无原生模块,跳过 rebuild"
# 如果上面列出了模块,执行一次重新编译:
# npm rebuild

pm2 restart all --update-env
pm2 save
pm2 ls                                     # ✅ ecook 必须还是 online
curl -s -o /dev/null -w "ecook 本机 %{http_code}\n" http://127.0.0.1:3001/
pm2 logs ecook --lines 50                  # 看有没有报错
```

**✅ 验收**:ecook online、curl 返回 200/302、日志无异常报错。

- 若 `pm2` 命令找不到:`sudo npm i -g pm2` 重装一次。
- 若 ecook 起不来 → 先按 [阶段 9 回滚](#阶段-9出问题怎么回滚)退回 Node 20,
  再回来告诉我具体报错,不要硬往下做。

---

### 阶段 3:把代码和你的真实数据放上去

```bash
cd /root
git clone https://github.com/shyshineinn/my-books.git my-books
cd my-books
npm ci --omit=dev
mkdir -p data uploads                      # 先把目录建出来,方便从本地上传数据
```

用**打包上传**的方式(实测通过,推荐;`git clone` 只在本地已全部推送时才可用):

```bash
# 本地执行 —— 必须用 Git Bash,不要用 PowerShell(PowerShell 不支持 \ 续行、单引号规则也不同)
cd /d/littleBIngbing/my-books
tar --exclude=node_modules --exclude=.git --exclude=.workbuddy \
    --exclude=.codeartsdoer --exclude=.office-claw --exclude=.merkle-snapshot.json \
    --exclude=data \
    --exclude='./__shot_*.png' --exclude='./add.png' --exclude='./logo.png' \
    --exclude='public/__*.html' \
    --owner=root --group=root \
    -czf ../my-books.tar.gz .
ls -lh ../my-books.tar.gz          # 约 180KB

scp ../my-books.tar.gz root@120.53.29.226:/tmp/

# 服务器上
mkdir -p /root/my-books
tar -xzf /tmp/my-books.tar.gz -C /root/my-books
cd /root/my-books
mkdir -p data uploads
npm ci --omit=dev
```

> ⚠️ **排除项里两个坑(已踩过)**:
> 1. `--exclude=logo.png` 会连 **`public/logo.png`(站点图标,必需)** 一起排掉 —— GNU tar 里
>    不带路径的模式会匹配任意同名文件。必须写成 `--exclude='./logo.png'` 只排根目录那个。
> 2. 打包后**务必核对** `public/logo.png`、`public/logo-mark.png`、`public/add-icon.png`
>    都在包里:`tar -tzf ../my-books.tar.gz | grep public/logo`
> 3. **从 Windows 打包要加 `--owner=root --group=root`**(已写进上面命令)。否则 tar 会把 Windows 侧的
>    UID/GID(如 `197609`)带进去,服务器解包后文件属主显示成一串数字、服务器上并不存在该用户。
>    忘了加也不影响运行(root 能读写任何文件),`chown -R root:root /root/my-books` 补一下即可。

**上传你本地的书籍数据和封面**(本地执行,当前目录 = `D:\littleBIngbing\my-books`):

```bash
scp data/books.db root@120.53.29.226:/root/my-books/data/books.db
scp -r uploads/. root@120.53.29.226:/root/my-books/uploads/
```

> 这一步不做的话,线上打开是 17 本示例书,你在本地记的书不会出现。
> 现在传最安全(服务还没启动,不会写到一半被覆盖)。

---

### 阶段 4:前台试跑,确认能起来

```bash
cd /root/my-books
PORT=3002 HOST=127.0.0.1 node server.js
```

**✅ 验收**:打印 `My books 已启动: http://127.0.0.1:3002`(会有一行 SQLite 的 ExperimentalWarning,正常)。

另开一个 SSH 窗口验证,然后回第一个窗口 `Ctrl+C` 停掉:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3002/          # 200
curl -s http://127.0.0.1:3002/api/stats | head -c 300
```

---

### 阶段 5:交给 PM2 托管

```bash
cd /root/my-books
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 ls                      # ✅ ecook 与 my-books 都 online
pm2 logs my-books --lines 20
```

配置里的 `cwd` 已按 `/root/my-books` 写好;只有你把代码放在别的目录时才需要改:

```bash
nano deploy/ecosystem.config.js     # cwd 改成你的实际目录
```

**确认开机自启**(ecook 能自启就说明配过):

```bash
sudo systemctl list-unit-files | grep pm2
# 没有输出就执行一次,并照抄它打印的 sudo 命令:
pm2 startup
```

---

### 阶段 6:申请两张免费证书并传上服务器(先不碰 Nginx)

> **只「申请 + 下载」,不要用「部署 / 一键替换 / 证书托管」。** 腾讯云 SSL 控制台的部署类功能
> (部署、更新、托管、查询证书关联资源)需要服务相关角色 `SSL_QCSLinkedRoleInReplaceLoadCertificate`,
> 缺少 `sts:AssumeRole` 权限时会报「没有操作 … 获取扮演角色的临时身份凭证 的权限」。
> 我们的证书是装在自己的 Nginx 上,不需要这个角色 —— 签发后直接下载「Nginx」格式即可。
> (若该报错已出现,它只是控制台部署面板的失败提示,不影响证书申请与下载。)

> **「部署」这个词有两套含义,别混淆:**
> - 控制台里的「部署」= 把证书装到**云资源**(CLB / CDN / WAF / COS / TKE …)上 —— 需要上面那个
>   服务相关角色权限,**我们不用,也不要点**。
> - 本手册说的「部署」= 把证书**文件**放进服务器的 `/etc/nginx/ssl/`,再由我们自己写的 Nginx 配置
>   引用它 —— **我们要的是这个**,只需要「下载 + scp」两步,不涉及任何权限审批。

在云控制台(**SSL 证书** / **数字证书管理服务**)申请 **免费 DV 证书**,申请**两张**:

| 序号 | 绑定域名 | 说明 |
| --- | --- | --- |
| 1 | `helloac.top` | my-books 用。**免费证书是单域名,不覆盖 www** |
| 2 | `ecook.helloac.top` | ecook 用。小程序严格校验证书,**自签证书必然失败,这张必须换** |

申请时按提示完成域名验证(一般是加一条 DNS TXT 记录,几分钟内签发)。
签发后**下载「Nginx」格式**(一个 `.crt` + 一个 `.key`)。

上传到服务器(本地执行,文件换成你下载的实际名字):

```bash
scp helloac.top_bundle.crt helloac.top.key root@120.53.29.226:/tmp/
scp ecook.helloac.top_bundle.crt ecook.helloac.top.key root@120.53.29.226:/tmp/
```

服务器上归位:

```bash
sudo mkdir -p /etc/nginx/ssl/helloac.top /etc/nginx/ssl/ecook.helloac.top

# 文件名按你实际下载的改(2>/dev/null 表示文件不在就跳过,不报错)
sudo mv /tmp/helloac.top_bundle.crt /tmp/helloac.top.key \
          /etc/nginx/ssl/helloac.top/ 2>/dev/null
sudo mv /tmp/ecook.helloac.top_bundle.crt /tmp/ecook.helloac.top.key \
          /etc/nginx/ssl/ecook.helloac.top/ 2>/dev/null

sudo chmod 600 /etc/nginx/ssl/*/*.key
ls -l /etc/nginx/ssl/helloac.top/ /etc/nginx/ssl/ecook.helloac.top/
```

> **⚠️ 记下实际文件名**——阶段 7 要写进 Nginx 配置。
> 腾讯云下载包通常叫 `域名_bundle.crt` + `域名.key`,阿里云是 `.pem` + `.key`。

> **证书还没下来 / 想让站点先跑起来?** 跳过本阶段直接做阶段 7,但要先把
> `/etc/nginx/conf.d/helloac.top.conf` 里两行 `ssl_certificate` 临时改成你现有的自签证书路径
> (`ls /etc/nginx/ssl/` 看是哪两个文件),等证书到了再换回来。自签状态下浏览器会警告,
> **小程序会请求失败**。

---

### 阶段 7:切换 Nginx(让默认站点退出 + 挂两个新站)

> 2026-09-17 服务器实测后的**真实情况**:`/etc/nginx/conf.d/` 是空的、443 从未监听、
> ecook **没有任何 Nginx 配置** —— 80 端口由 Ubuntu 默认站点(`sites-enabled/default`,
> `root /home/ecook/website-books`,也就是那个旧的静态「我的读书清单」页)兜底。
> 所以本阶段不是"改造 ecook.conf",而是**新建两份配置 + 让默认站点退出**。

```bash
# 7.1 全量备份(可整目录回滚)
sudo cp -a /etc/nginx "/root/nginx-backup-$(date +%F)"

# 7.2 让 Ubuntu 默认站点退出(只移走软链,文件仍留在 sites-available/)
sudo mv /etc/nginx/sites-enabled/default /root/

# 7.3 安装两份站点配置(证书必须先按阶段 6 放好,否则 7.5 会失败)
sudo cp /root/my-books/deploy/nginx-helloac.top.conf       /etc/nginx/conf.d/helloac.top.conf
sudo cp /root/my-books/deploy/nginx-ecook.helloac.top.conf /etc/nginx/conf.d/ecook.helloac.top.conf

# 7.4 确认证书路径与阶段 6 上传的实际文件名一致
sudo grep -n "ssl_certificate" /etc/nginx/conf.d/*.conf
ls -l /etc/nginx/ssl/helloac.top/ /etc/nginx/ssl/ecook.helloac.top/

# 7.5 校验 + 重载(nginx -t 失败就不要 reload)
sudo nginx -t && sudo systemctl reload nginx
```

> **回滚**(把默认站点放回去、撤掉两个新站):
> ```bash
> sudo mv /etc/nginx/conf.d/helloac.top.conf /root/
> sudo mv /etc/nginx/conf.d/ecook.helloac.top.conf /root/
> sudo mv /root/default /etc/nginx/sites-enabled/default
> sudo nginx -t && sudo systemctl reload nginx
> ```

**✅ 验收**(在服务器上执行,四条都要对):

```bash
curl -I   https://helloac.top                          | head -2
curl -I   https://ecook.helloac.top                    | head -2
curl -kI  https://127.0.0.1 -H "Host: helloac.top"     | head -1
curl -kI  https://127.0.0.1 -H "Host: ecook.helloac.top" | head -1

# 证书颁发者与有效期(不应再是 self-signed)
echo | openssl s_client -connect helloac.top:443 -servername helloac.top 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

浏览器打开 `https://helloac.top` → 应看到书架页(你的真实数据),地址栏是小锁头。
再用手机确认一次移动端布局。

**同时去改小程序**:微信公众平台 →「开发管理 → 开发设置 → 服务器域名 → request 合法域名」
加上 `https://ecook.helloac.top`,然后**重新发布小程序版本**。不做这步,线上小程序会请求失败。

---

### 阶段 8:收尾(安全 + 备案核对 + 备份)

**8.1 给写接口加口令**(现在任何人都能删你的书、传垃圾图):

```bash
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd admin          # 按提示设密码

sudo nano /etc/nginx/conf.d/helloac.top.conf
#   找到「可选:给写接口加口令」那段,把 location /api/ { ... } 的注释取消
sudo nginx -t && sudo systemctl reload nginx
```

验证:浏览、搜索照常;**点「添加书籍」时会弹账号密码框**。

**8.2 关掉应用端口的外部访问**:云控制台安全组确认 `3001`、`3002` 未放行。
ecook 现在还监听 `0.0.0.0:3001`(它自己绑的),想彻底改掉要动它的启动配置,改完
`pm2 restart ecook --update-env`;不改也不影响,安全组不放行就等于外部进不来。

**8.3 备案号核对**:打开 `https://helloac.top`,滚到页面最底部,应看到
`豫ICP备2026045565号` 且点击能跳到工信部备案系统。同时确认网站名称、内容与备案申报一致。

**8.4 公安联网备案**:备案后 30 日内到 `https://beian.mps.gov.cn/` 办理,
拿到号后告诉我也行,我把图标和备案号加进页脚。

**8.5 备份**(每天 03:30,`crontab -e` 追加一行):

```bash
30 3 * * * cd /root/my-books && tar -czf ~/backup-mybooks-$(date +\%F).tar.gz data uploads books-files && find ~ -maxdepth 1 -name 'backup-mybooks-*.tar.gz' -mtime +7 -delete
```

> 注意必须包含 `books-files/`:电子书正文(单本可达 80MB)此前不在备份范围,硬盘故障会连同文件一起丢失(库里只会剩指向空文件的 `file_path`)。
> 若该目录较大,可改为只备份数据库与封面、电子书另行用对象存储同步。

**8.6 以后更新代码**:

```bash
chmod +x /root/my-books/deploy/update.sh     # 首次
bash /root/my-books/deploy/update.sh         # 会先备份数据库,再拉代码重启
```

---

### 阶段 9:出问题怎么回滚

**my-books 有问题,要立刻把根域名还给 ecook(恢复小程序可用)**:

```bash
sudo mv /etc/nginx/conf.d/helloac.top.conf /root/
sudo cp /etc/nginx/conf.d/ecook.conf.bak-YYYY-MM-DD /etc/nginx/conf.d/ecook.conf
sudo nginx -t && sudo systemctl reload nginx
pm2 stop my-books
```

**ecook 在 Node 22 上异常,退回 Node 20**:

```bash
sudo cp /root/node20.bak /usr/bin/node && pm2 restart all && pm2 save
```

**常见报错速查**:

| 报错 / 现象 | 处理 |
| --- | --- |
| `Cannot find module 'node:sqlite'` | Node 还是 20:`node -v` 确认,重做阶段 2,然后 `pm2 restart my-books --update-env` |
| 日志里有 `Cannot find module '.../index.js'`,但服务能正常访问 | 大概率是**历史日志**(PM2 日志是追加的,`--lines` 看到的是旧内容)。用行数对比确认:`wc -l /root/.pm2/logs/ecook-error.log` → `pm2 restart ecook` → `sleep 3` → 再看行数,不变就是历史记录;想彻底清爽用 `pm2 flush ecook` 清空后重启 |
| `nginx -t` 报证书文件不存在 | 阶段 6 的文件名/路径与配置不一致,或证书还没上传 |
| `nginx -t` 报 duplicate server name | 还有文件绑着 `helloac.top`:`grep -rn server_name /etc/nginx/conf.d/` |
| 打开域名是 ecook 的接口输出 | ecook.conf 的 server_name 没改成功,回阶段 7.2 |
| 502 Bad Gateway | `pm2 ls` 看 my-books 是否 online;`pm2 logs my-books --lines 50` |
| 上传封面/电子书报 413 | 配置里的 `client_max_body_size` 被覆盖或调小了(应为 `100m`,需 ≥ 应用层上限);检查编辑是否保存,改后 `nginx -s reload` |
| 小程序请求失败 | request 合法域名没加、小程序没重新发布、或 ecook 还是自签证书 |
| 数据不见了 | 从 `data/backup/` 或你本地的 `data/books.db` 重新上传(先 `pm2 stop my-books`) |

---

### 线上运维

```bash
pm2 restart my-books                    # 重启
pm2 logs my-books                       # 实时日志
bash /root/my-books/deploy/update.sh    # 更新代码(先备份 books.db,再拉代码、装依赖、重启)
```

- **改写接口口令**:`sudo htpasswd /etc/nginx/.htpasswd admin`
  ⚠️ 不要加 `-c`,否则会把整个口令文件清空重建;改完 `sudo systemctl reload nginx`。
- **证书续期**:免费证书 90 天,到期前在云控制台重新申请,替换 `/etc/nginx/ssl/helloac.top/`
  下的两个文件后 `sudo systemctl reload nginx`。
- **每日备份**:`crontab -e` 追加一行(每天 03:30,保留 7 份):

  ```
  30 3 * * * cd /root/my-books && tar -czf /root/backup-mybooks-$(date +\%F).tar.gz data uploads books-files && find /root -maxdepth 1 -name 'backup-mybooks-*.tar.gz' -mtime +7 -delete
  ```

### 一句话版流程

```text
阶段1 确认现状(ecook online / Node v20 / 3002 空闲 / DNS 加 ecook 子域)
阶段2 升 Node 22 → 重启 ecook 并实测(不行就退回 20)
阶段3 clone 代码 + 上传 books.db 与 uploads
阶段4 前台试跑 PORT=3002 HOST=127.0.0.1
阶段5 pm2 start + save
阶段6 申请两张免费证书并上传到 /etc/nginx/ssl/
阶段7 改 ecook server_name → 挂 helloac.top.conf → nginx -t / reload → 改小程序域名
阶段8 htpasswd 保护写接口 + 安全组 + 备案号核对 + 备份任务
```
