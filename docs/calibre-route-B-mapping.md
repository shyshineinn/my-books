# 路线 B 字段映射表:my-books `/api/*` → calibre Content server

> 目的:把 my-books 的前端(书架/榜单/统计/阅读)接到 calibre `calibre-server` 的真实后端上。
> 本文档只做**接口与字段映射**,不含代码改动。所有结论均来自两侧源码实读,已标注文件与行号。
>
> 版本基线:calibre `9.15.0`(
> `src/calibre/constants.py:15`),my-books 见其 `README.md`(schema v6)。

---

## 0. 结论速览

| 判定 | 数量 | 说明 |
|---|---|---|
| ✅ 可直接映射 | 8 组 | 展示类数据:书名/作者/标签/系列/封面/简介/语言/格式 |
| ⚠️ 需落成 calibre 自定义列 | 6 个 | `status`、`read_logs`、`read_count`、`start_date`、`finish_date`、`douban_id` |
| ❌ 必须砍掉或另找载体 | 3 个 | `notes_url`(可用 calibre "注释"替代)、`rating` 口径、(见 §3) |
| 🔴 阻塞项 | 2 个 | 阅读位置/批注接口**要求登录**;写操作**要求认证** |

**一句话**:读路径基本能通,写路径和"个人阅读追踪"这套语义整体错位;
`status`/`read_logs` 这类字段在 calibre 里**根本不存在**,只能做成自定义列,而且**建列不能走 HTTP**。

---

## 1. 端点映射总表

calibre 侧路由来自 `src/calibre/srv/` 下各模块的 `@endpoint` 装饰器(共 96 处),
运行时由 `srv/handler.py:212-214` 扫描 `SRV_MODULES`(`handler.py:195`)注册。

### 1.1 书籍读路径

| my-books | calibre | 备注 |
|---|---|---|
| `GET /api/books?q=&status=&tag=&sort=` | `GET /ajax/search?query=&num=&offset=&sort=&sort_order=&vl=` | 返回**只有 book_ids**(`ajax.py:555-567`),要再取 `/ajax/books?ids=` 才有元数据 |
| `GET /api/books/:id` | `GET /ajax/book/{book_id}` 或 `/ajax/books?ids=1,2` | 单本用前者,列表批量用后者(避免 N+1) |
| — | `GET /interface-data/books-init` | calibre 自家前端用的聚合入口,`code.py:469`,一次返回搜索+元数据 |
| `GET /api/stats` | ❌ 无对应 | calibre 无统计端点;需前端用 `/ajax/categories` + `/ajax/books_in` 自行聚合 |
| 封面 `book.cover` | `GET /get/cover/{book_id}` | `content.py:394`,支持 `/get/thumb/{id}?sz=60x80` |
| 电子书正文 | `GET /get/{fmt}/{book_id}` | `content.py:443-447`;PDF/EPUB 都能直出 |

### 1.2 书籍写路径

| my-books | calibre | 备注 |
|---|---|---|
| `POST /api/books` | `POST /cdb/add-book/{job_id}/{add_duplicates}/{filename}` | `cdb.py:73`,**body 是文件内容**,不是 JSON;元数据由文件解析得出,不能直接建"只有元数据的空记录" |
| | 或 `POST /cdb/cmd/add/{version}` + `action='empty'` | `cmd_add.py:26` 支持 `empty`,但**该命令 `no_remote` 未置位**,理论上可远程调用(需实测) |
| `PUT /api/books/:id` | `POST /cdb/set-fields/{book_id}` | `cdb.py:182`,body `{'changes': {...}, 'loaded_book_ids': [...]}` |
| `DELETE /api/books/:id` | `POST /cdb/delete-books/{book_ids}` | `cdb.py:129`,book_ids 为逗号分隔 |
| `POST /api/upload`(封面) | `POST /cdb/set-cover/{book_id}` | `cdb.py:149`,body 为**原始图片字节**(非 base64) |
| `POST /api/books/:id/file` | `POST /cdb/cmd/add_format/{version}` | `cmd_add_format.py:14`,body 为 `('unused', bytes)` |

> 所有写端点都标了 `needs_db_write=True`,经 `routes.py:369` → `handler.py:120 check_for_write_access()`
> 校验。**匿名用户一律 403**,除非来自 `trusted_ips` 或 `local_write`(`loop.py:179-181`)。

### 1.3 阅读位置 / 批注

| my-books | calibre | 备注 |
|---|---|---|
| `GET /api/books/:id/position?format=&device=` | `GET /book-get-last-read-position/{library_id}/{book_id}-{fmt}` | `books.py:208`。🔴 **`books.py:215-217`:`if not user: raise HTTPNotFound('login required for sync')`** |
| `PUT /api/books/:id/position` | `POST /book-set-last-read-position/{library_id}/{book_id}/{fmt}` | `books.py:233`,body `{device, cfi, pos_frac}` |
| `GET /api/books/:id/annotations` | `GET /book-get-annotations/{library_id}/{book_id}-{fmt}` | `books.py:255`;`user = rd.username or '*'` |
| `POST /api/books/:id/annotations` | `POST /book-update-annotations/{library_id}/{book_id}/{fmt}` | `books.py:281`,body 为 `{annot_id: [annot, ...]}` |

**这是路线 B 最大的功能性回退**:my-books 现在 READ 位置是完全公开的
(`routes.positions.js:11` 注释明确写"读取公开"),换到 calibre 后**必须登录**才能同步进度。

---

## 2. 字段级映射:`books` 表 → calibre 字段

my-books 的列见 `src/db/index.js` 的 `migrateV1`~`migrateV6`;
calibre 的标准字段见 `src/calibre/library/field_metadata.py`。

### 2.1 ✅ 直接映射(calibre 原生有)

| my-books 列 | calibre 字段 | 映射说明 |
|---|---|---|
| `title` | `title` | 直接。注意 calibre 侧另有只读派生 `sort`(`field_metadata.py:570-572`) |
| `author`(单串) | `authors`(**list**) | 需拆分。calibre 用 `&` 作 UI 分隔(`field_metadata.py:95`),`authors` 是 list,my-books 的 `author` 是单个字符串 → 单元素 list |
| `tags`(JSON 数组字符串) | `tags`(**list**) | 直接对应。`is_multiple` 为 `{cache_to_list:',', ui_to_list:',', list_to_ui:', '}`(`field_metadata.py:162`) |
| `summary`(≤1000 字纯文本) | `comments`(**HTML**) | calibre 会按 `interpret_as` 处理,默认 `html` → **需要转义**。若设为 `make_category` 外还可设 markdown(`metadata.py:53-59`) |
| `publisher` | `publisher` | 直接 |
| `isbn` | `identifiers.isbn` | ⚠️ 不是独立列;calibre 把 ISBN 存在 `identifiers` dict 里(如 `{'isbn':'...'}`),`TOP_LEVEL_IDENTIFIERS`(`book/__init__.py:24`)允许直接读写 `isbn` 别名 |
| `pub_year` | `pubdate` | ⚠️ calibre `pubdate` 是 **datetime**,不是年份字符串。需补 `-01-01` |
| `file_path`/`file_format`/`file_size` | `formats` + `format_metadata` | calibre 由库目录自动推导,只读;不要试图写入 |
| `cover`(URL 或 `/uploads/x.png`) | `cover`(文件) | 语义不同:calibre 封面是库内 `cover.jpg`,不是 URL。外链封面需先下载再 `set-cover` |

### 2.2 ⚠️ 需落成 calibre 自定义列

这些在 calibre 里**没有对应概念**,必须在库里建自定义列(键入 `#label`)。

| my-books 列 | 建议自定义列 | datatype | 说明 |
|---|---|---|---|
| `status`(`wish`/`reading`/`done`) | `#status` | **enumeration** | 用 `display={"enum_values":["wish","reading","done"]}`(`cmd_add_custom_column.py:63`)。**不可用 `tags`** —— tags 可被用户随手改,且会让三态语义泄漏进标签体系 |
| `read_count`(0~999) | `#read_count` | int | |
| `read_logs`(`[{start,finish}]`) | `#read_logs` | **text** | JSON 字符串塞进 text 列。calibre 的 text 列可 `is_multiple`,但 JSON 含逗号,`is_multiple` 必须为 **False**,否则会被 calibre 按分隔符拆碎 |
| `start_date` | `#start_date` | datetime 或 text | 建议 text,保持 `YYYY-MM-DD` 与前端一致(calibre datetime 会带时区,前端解析要改) |
| `finish_date` | `#finish_date` | datetime 或 text | 同上;统计"按年读完"要用它 |
| `douban_id` | `#douban_id` | text | 纯标识 |

> 🔴 **建列不能走 HTTP。** `cmd_add_custom_column.py:12` 明确写了 `no_remote = True`,
> `db/cli/main.py:56-57` 对 `no_remote` 的命令直接 `SystemExit`。
> 也就是说 `#status` 等列**必须在服务器上用命令行预建**:
> ```
> calibredb add_custom_column status Status enumeration --display='{"enum_values":["wish","reading","done"]}'
> ```
> 建完还**必须重启 calibre-server**(字段元数据在库打开时载入)。

### 2.3 ❌ 无法映射 / 需改变行为

| my-books | 问题 | 处置建议 |
|---|---|---|
| `rating`(0~5,一位小数) | calibre 的 `rating` 是 **0~10 的整数**(`metadata_sqlite.sql:137` `CHECK(rating > -1 AND rating < 11)`)。且 `/ajax/book` 默认**除以 2** 输出(`ajax.py:62-65`),即 HTTP 层看到的是 0~5,写入时又是 0~10 | 前端不要直接读写 `rating`;如必须,走 `#my_rating` 自定义列(float)规避两套刻度 |
| `notes_url`(外链 Markdown) | calibre 无"外链心得"概念;它有自己的 **notes**(富文本 notes 库,`/get-note`,`/set-note`) | 二选一:(a) 保留 my-books 的 `/api/notes` 代理(它只是回源 GitHub,与 calibre 无关,可原样保留);(b) 改用 calibre notes |
| `created_at` / `updated_at` | calibre 是 `timestamp`(入库时间)/`last_modified`(改动时间) | 语义接近,但**不可写**(由 calibre 维护)。前端若依赖 `sort=created`,用 calibre 的 `timestamp` |
| `settings` 表(`notes_repo`/`notes_branch`) | calibre 无对应 | 保留在 my-books 侧(Node 层),或改用 calibre 的 `prefs` |

---

## 3. 🔴 三个会改变架构的阻塞项

### 3.1 认证模型整体换掉

| | my-books | calibre |
|---|---|---|
| 读 | 公开 | 公开(未开 `--enable-auth`) |
| 写 | Nginx Basic + `Authorization: Bearer <token>` 双层(`middleware.auth.js`) | Basic/Digest,由 `--enable-auth` + `--userdb` 控制(`handler.py:202-210`);或 `--trusted-ips` 白名单(`loop.py:180-181`) |
| 进度/批注同步 | 公开读 + token 写 | **必须登录**(见 §1.3) |

**结论**:你现有的 Bearer token 体系(`data/admin-token` 文件、限速、恒时比较)**对 calibre 完全无效**。
两条路:
- **A. 用 `--trusted-ips`**:让 Node 反代成为唯一调用方,`calibre-server` 只监听 `127.0.0.1`,
  把 Node 的 IP 加进白名单 → 保留现有鉴权,calibre 侧不再校验。
  这是**改动最小**的方案,但意味着 `calibre-server` 不能对公网开放(正好符合你的部署习惯)。
- **B. 用 `--enable-auth --auth-mode=basic`**:Node 反代时注入 `Authorization: Basic`,
  用 calibre 自带的用户库与权限(含 per-library restriction,`handler.py:88-98`)。

### 3.2 位置/批注的 "device 分区" 语义要重做

| | my-books | calibre |
|---|---|---|
| 位置唯一键 | `UNIQUE(book, format, device)`(`index.js:127`) | `UNIQUE(user, device, book, format)`(`metadata_sqlite.sql:160`) |
| 批注唯一键 | `UNIQUE(book, format, annot_type, annot_id)`(`index.js:161`) | `UNIQUE(book, user_type, user, format, annot_type, annot_id)`(`metadata_sqlite.sql:173`) |
| 你的设计取舍 | 位置**按设备分区**(注释见 `index.js:136-139`,并说明"注释是内容资产,应跨设备共享") | calibre 额外按 **user** 分区,即天然多用户 |

calibre 比 my-books **多了 user 维度**。所以:
- 单用户场景:`user` 恒为同一值(如 `reader`),行为等价于你现在按 device 分区 → **可平滑迁移**。
- 批注用 `user_type='web'`(calibre 自家网页阅读器就是这个,见 `books.py:276`);若用 `local`,
  会和 calibre GUI(桌面端)的批注混在一起。

### 3.3 阅读位置的数据形状不同

| my-books `read_positions` | calibre `last_read_positions` |
|---|---|
| `locator`(TEXT)+ `locator_kind`(`epubcfi`/`pdfpage`) | `cfi`(TEXT) |
| `pos_frac` REAL | `pos_frac` REAL ✅ |
| `epoch`(Unix **毫秒**) | `epoch` REAL(秒) |
| 无 `user` 列 | `user` TEXT NOT NULL |

**关键差异**:my-books 用 `locator_kind` 显式区分 EPUB CFI 与 PDF `{page,offsetY}` JSON;
calibre 的 `cfi` 列**只有 CFI 一种语义**。翻译层必须:
- EPUB:直通。
- PDF:my-books 的 `{"page":n,"offsetY":y}` **在 calibre 里没有等价表示** ——
  要么塞进 `cfi` 列(脏数据,calibre 自己读写会误解析),要么放弃 PDF 进度同步。
- `epoch` 单位差 1000 倍,转换时必须显式处理,否则进度时间戳会离谱。

---

## 4. 前端改动量清单

以 `public/js/app.js`(约 1600 行)为基准。

| 区域 | 现状(行号) | 路线 B 后 |
|---|---|---|
| `api()` 封装 | `app.js:48-71`(Bearer token、`X-Admin-Token`) | 全改;token 逻辑要么删除(A 方案)要么换成 Basic |
| 列表加载 | `app.js:163` `api('/api/books?'+params)` | 改 `GET /ajax/search` → 再 `GET /ajax/books?ids=` **两次往返** |
| 书籍详情 | `app.js:491,552` | `GET /ajax/book/{id}`,字段名与结构全变 |
| 新增/编辑 | `app.js:1132,1135` | `POST /cdb/set-fields/{id}` / `POST /cdb/add-book/...`;`parseBook`(`core/book.js`)**语义无法保留** |
| 统计 | `app.js:236` `GET /api/stats` | ❌ **需自己实现**;calibre 无统计端点 |
| 阅读位置 | `app.js` 位置上报/恢复 | 接口路径与形状全变;且需先登录 |
| 封面 | `img-proxy` + 本地 `/uploads/` | 改 `/get/cover/{id}`;`/api/img-proxy` 可保留(与 calibre 无关) |
| 心得 | `/api/notes`(GitHub 代理) | ✅ **可原样保留**,与 calibre 无关 |

`src/core/book.js` 的 `parseBook()` 是本项目最有价值的资产(「阅读记录是唯一日期来源」
+ `mergeUpdate` 局部更新语义,128 行里有明确注释)。走路线 B 后:
- 校验逻辑**仍有价值** → 保留在 Node 中间层,不要丢;
- 但它写的目标从 `books` 表变成 calibre 的 `#status`/`#read_logs` → 需要一个**翻译层**。

---

## 5. 建议的落地形态

不要直接让浏览器打 calibre。建议在 Node 里加一层薄适配:

```
浏览器 ── /api/* ──► Node(Express,现有鉴权/parseBook 保留)
                        │
                        ├─► calibre-server (127.0.0.1:3003, --url-prefix /calibre)
                        │     仅由 Node 调用;trusted_ips 含 127.0.0.1
                        │
                        └─► 仍自持:settings 表、#status 语义翻译、/api/notes 代理
```

理由:
1. **保住鉴权**:你的 Bearer token + 限速 + 恒时比较是现成的,calibre 的 Basic/Digest 反而更弱。
2. **保住 `parseBook`**:这是你测试覆盖最厚的部分(`test/book.test.js` 17 条),不该为了换后端扔掉。
3. **保住统计**:calibre 无统计端点,Node 层聚合最自然。
4. **前端改动最小**:路径仍是 `/api/*`,只是 Node 内部改为转发 calibre。

---

## 6. 动手前的 checklist

- [ ] 用**官方 Linux 二进制**装 calibre(不要用发行版包;仓库里的 `calibre-master/` 是纯源码,
      C 扩展未编译,`stubs/calibre_extensions/` 下有 40+ 个 `.pyi` 但没有构建产物,**不能直接跑**)
- [ ] `calibredb add_custom_column` 预建 `#status`/`#read_logs`/`#read_count`/`#start_date`/`#finish_date`/`#douban_id`
- [ ] 重启 `calibre-server` 让字段元数据生效
- [ ] 决定认证方案(§3.1 的 A 或 B),**先在小库上验证写操作能过**
- [ ] 确认 `epoch` 单位与 PDF 位置降级策略(§3.3)
- [ ] 确认阅读位置/批注是否接受"必须登录"(§1.3)——
      **若不接受,这一块就该留在 my-books 自持,而不是迁到 calibre**
- [ ] 库的独占性:calibre 用**单机** `SingleInstance('db')` 锁(`standalone.py:178`),
      桌面 GUI 与服务器**不能**同时开同一批库
- [ ] `tar` 打包加 `--exclude=calibre-master`(见 my-books `README.md:586`,当前未排除,
      1.3 万+ 文件会被打进 180KB 的部署包)
- [ ] 评估 GPL:方案中若**移植** calibre 代码(如 `core/douban.js` 已注明移植自 NewDouban),
      则受 GPLv3 约束;站点公开需提供对应源码
