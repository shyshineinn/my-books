# my-books · 与 calibre 的差距复核

> 目标:回答一个问题 —— **以 `calibre-master` 为参照,my-books 现在还差在哪些地方。**
> 方法:不以现有文档为准,直接读两边源码 + 跑现有测试 + 查真实库,再用结果去核对
> `CALIBRE-对标方案.md`(下称「原方案」)的说法是否还成立。
> 配套:`CALIBRE-对标方案.md`(分期方案)、`PROJECT_MEMORY.md`、`PROGRESS.md`。
> 复核日期:2026-09-23(代码状态 = HEAD `d388512` 工作区)

---

## 0. 一句话结论

**差的不是「功能条数」,而是「功能的覆盖面」与「已被真实使用的程度」。**

- 规模上差 **约 79 倍**(我方自研 10,883 行 / calibre ≈ 859,000 行),这个差距**不可能也没必要抹平**;
  真正有意义的是逐项判断「哪些差距挡着我用、哪些差距与我无关」。
- **原方案的三条根因(G1 位置模型 / G2 渲染管线 / G3 数据模型)判断依然成立**,且 G1 已落地。
- **真正没被任何文档记下来的差距有 12 项**(见 §8),其中「重复检测」「回收站软删除」「书内正文全文检索」
  「一本书多格式」四项是个人藏书管理里最容易被绊到的。
- **另有一项与对标无关、但会挡住真实使用的既有问题**:`/books-files/` 无鉴权(见 §6.1)。
  **已决策 2026-09-23 = 方案 B(保持公开,只上传不敏感的书),零代码改动。**
  注意实测事实:公网 API 会主动返回 `file_path`,所以不存在「文件名难猜」这层隐晦 ——
  B 的等价表述是「该书库等价于完全公开的静态文件服务」,控制点只有上传自律。

---

## 1. 复核方式与基线

### 1.1 规模对比(实测,非估算)

| 项 | my-books | calibre-master | 倍数 |
| --- | --- | --- | --- |
| 自研代码行数 | **10,883**(src+public+test 10,382 / deploy 501,40+6 个文件) | **≈ 859,000**(`src/calibre` 1,409 个 `.py` = 818,880 行;`src/pyj` 132 个 `.pyj` = 40,146 行) | ≈ 79× |
| 数据表 | 3 张实体表(`books` / `settings` / `read_positions`)+ 1 个 FTS5 虚表 | schema `user_version=27`,含 `books`/`authors`/`series`/`publishers`/`tags`/`ratings`/`languages`/`identifiers`/`data`/`comments`/`annotations`/`last_read_positions`/`custom_columns`/`preferences`… 及全部 `books_*_link` 连接表 | — |
| 阅读器实现 | `public/read.html` 850 行(epub.js + pdf.js 双原生引擎) | `src/pyj/read_book` 58 文件 / 19,482 行 + `src/calibre/gui2/viewer` 21 文件 / 8,202 行 + 渲染管线 `render_book.py` 1,022 行 | — |
| 元数据字段 | `books` 表 22 列 | 内置字段约 28 个 + 10 种自定义字段类型 | — |
| 测试 | 13 个文件 / **116 条全绿**(本轮实测) | `db/tests` 约 8,000 行等 | — |

### 1.2 `calibre-master` 这份源码的性质(重要,先看清参照物)

本轮实测发现:

- **它不是一份可直接运行的 calibre。** `ast.parse` 逐个解析 1,409 个文件,**90 个失败**
  (6.4%),全部是 Python-2 的 `except A, B:` 语法,例:`db/backend.py:1349`、`db/cache.py:961`、
  `db/fields.py:275`、`library/field_metadata.py:687`。要跑起来得先把这些 `except` 补上括号。
- **它是多个 calibre 时代的混合体**:既有已被新版删除的 `src/polyglot/`(py2/py3 兼容层)与
  `src/pyj/`(RapydScript,新版已改 TypeScript),又声明 `numeric_version = (9, 15, 0)`
  (`src/calibre/constants.py:15`)。
- **结论:只当「架构参考读物」用,行号可引,程序不可跑。** 原方案对它的引用经复核**是准确的**
  (数字逐项核对见 §10),可信度高。

### 1.3 权威 schema 的一处纠正

原方案引 `resources/metadata_sqlite.sql`(653 行,`pragma user_version=27`)作为 schema 权威来源,
**这是对的**(`db/backend.py:1616-1621` 直接执行该文件建库)。但要注意:
`src/calibre/db/schema_upgrades.py`(818 行,只到 `upgrade_version_26`)**是历史迁移路径,
不是当前 schema** —— 它里面各表的形状是旧版(例如 `books` 还带 `isbn`/`lccn`/`flags`)。
原方案把两者都列了但没说明区别,回读时容易看错。

---

## 2. 我这边的现状(源码 + 真实库核实)

### 2.1 数据现状(`data/books.db`,只读打开实测)

| 项 | 值 |
| --- | --- |
| `user_version` | 5(WAL 模式,`foreign_keys=1`) |
| 书籍 | **31 本**(已读 23 / 在读 3 / 想读 5) |
| 有封面 | 9 / 31 |
| **有电子书文件** | **0 / 31** |
| **`read_positions` 行数** | **0** |
| `books-files/` 目录 | **空** |
| `settings` | `notes_repo`、`notes_branch` 两项 |
| `data-check.js` | 31 本书,0 问题 |
| 测试 | 116 条全绿,且跑测试前后真实库 mtime/大小未变(隔离性成立) |

> **这是本轮最值得注意的结论**:阅读器那一半能力(渲染、进度、设置)**在真实数据上等于没被用过**。
> 0 本书有文件、0 条阅读位置。也就是说,「阅读功能好不好用」目前还没有真实反馈,
> 而 §6.1 的鉴权问题正好卡在「第一次真的上传书」这一步。

### 2.2 API 面(18 个端点)

| 分组 | 端点 |
| --- | --- |
| 书籍 CRUD | `GET/POST /api/books`、`GET/PUT/DELETE /api/books/:id` |
| 电子书文件 | `POST/DELETE/GET /api/books/:id/file` |
| 阅读位置 | `GET/PUT/DELETE /api/books/:id/position` |
| 设置/统计/封面上传 | `GET/PUT /api/settings`、`GET /api/stats`、`POST /api/upload` |
| 出站代理 | `GET /api/notes`(GitHub 白名单)、`GET /api/img-proxy`(防盗链定向 Referer) |
| 元数据 | `GET /api/metadata/search`(豆瓣) |

全部同时挂 `/api/v1/*`(多端契约)。鉴权只覆盖非 GET 的 `/api/*`。

### 2.3 阅读器现状(`public/read.html`,850 行)

已具备:**EPUB / PDF** 站内阅读;进度记忆(服务端 + `localStorage` 三层降级、按 `书+格式+设备` 分区、
换设备提示不覆盖);阅读设置(字号 12–32 / 行距 1.2–2.4 / 边距 0–64 / 主题 日间·米黄·灰色·夜间 /
字体 衬线·黑体 / 翻页 分页·滚动);TOC(EPUB navigation / PDF outline);快捷键 6 类。

位置坐标:EPUB 用 epub.js 原生 **EPUBCFI**,PDF 用 `{page, offsetY}` —— 即**已具备 G1 地基**,
书签/高亮/批注可直接复用这套坐标(与原方案 §6.3 的规划一致)。

### 2.4 书目现状

单表 `books` 22 列;状态/标签筛选;4 种排序白名单(`updated`/`created`/`finish`/`title`);
FTS5 元数据检索(`title`/`author`/`summary`/`tags`,trigram + BM25,短词 LIKE 兜底,
**前端已接线** —— `app.js:157` 确认会发 `q` 参数);统计数据聚合;重读榜;GitHub 心得 Markdown;
豆瓣单源元数据抓取(移植 NewDouban 插件的子集)。

**删除是硬删除**(`DELETE FROM books`),唯一恢复途径是备份。

---

## 3. 差距总表:在线阅读

图例:**〔计划〕**= 原方案已列期次;〔**未记**〕= 原方案没有的本轮新增发现;〔不追〕= 建议明确排除。

| # | calibre 的能力 | 出处(行号可信) | 我方现状 | 归类 |
| --- | --- | --- | --- | --- |
| R1 | **统一渲染管线**(任意格式 → HTML + manifest) | `srv/render_book.py:804-847` 入口、`:563-726` 组装、manifest 字段 `:622-641` | 双原生引擎,一格式一库 | 〔计划〕G2 / P9 |
| R2 | **位置模型** EPUBCFI 完整实现 | `pyj/read_book/cfi.pyj`(984 行:`encode:194`/`decode:321`/`cfi_sort_key:421`/`at:503`) | epub.js 原生 CFI + `{page,offsetY}`,已够用 | 已达成(G1) |
| R3 | 服务端进度表 | `resources/metadata_sqlite.sql:152`;API `srv/books.py:208/233` | 已有(`read_positions`,v5) | 已达成 |
| R4 | **书签 / 高亮 / 批注** | 表 `metadata_sqlite.sql:163-174` + 2 张 FTS5 表 `:176-197`;模型 `db/annotations.py`;合并「新时间戳胜」`pyj/read_book/annotations.pyj:46-102` | **零** | 〔计划〕P3 |
| R5 | 高亮样式:5 内置色 + 2 装饰 + 自定义 | `pyj/read_book/highlights.pyj:28-71`;`constants.py:62-79` | 零 | 〔计划〕P3 |
| R6 | 注释导出(txt / Markdown / calibre collection) | `pyj/read_book/highlights.pyj:611-663` | 零 | 〔计划〕P10 |
| R7 | **书内搜索**(包含/整词/正则 + 大小写,Web Worker) | `pyj/read_book/search.pyj:105-233`、`search_worker.pyj:160-259` | **零** | 〔计划〕P4 |
| R8 | **书正文全文检索**(独立 FTS 库 + worker pool) | `db/fts/`(630 行)、`srv/fts.py:21` | 只有**书目** FTS,不索引正文 | 〔**未记**〕 |
| R9 | 命中高亮 | `pyj/read_book/find.pyj:198-246` | 零 | 〔计划〕P4 |
| R10 | **朗读 TTS** | 浏览器 `pyj/read_book/tts.pyj:111-126`;桌面 `gui2/viewer/tts.py` | 零 | 〔计划〕P10 |
| R11 | 有声书跟读(SMIL media overlays) | `srv/render_book.py:289-388`、`pyj/read_book/smil.pyj` | 零 | 〔**未记**〕 |
| R12 | 脚注自动识别 + 沙箱弹窗 | `pyj/read_book/footnotes.pyj:33-103`、`content_popup.pyj:34-80` | 零 | 〔**未记**〕 |
| R13 | 阅读统计(剩余时间/章节用时/阅读速率) | `pyj/read_book/overlay.pyj:695-819`、`timers.pyj:7-79` | 零 | 〔**未记**〕 |
| R14 | 页眉页脚 3 槽 × 十几种可选内容 | `pyj/read_book/prefs/head_foot.pyj:21-56` | 零 | 〔**未记**〕 |
| R15 | 自动滚动(速度/边界延迟) | `pyj/read_book/flow_mode.pyj:338-504` | 零 | 〔**未记**〕 |
| R16 | 主题体系(5 配色 + 用户配色 + 覆盖书色三态 + 背景图 + 用户样式表) | `prefs/colors.pyj:52-116`、`prefs/user_stylesheet.pyj:46-165` | 4 主题,**无自定义样式表/背景图** | 〔计划〕P2 部分 |
| R17 | 每屏栏数(1–20)+ 最大文本宽高 | `prefs/layout.pyj:58-98` | 零 | 〔**未记**〕 |
| R18 | 触摸手势 22 种 + 分模式默认 | `pyj/read_book/touch.pyj:16-43`、`gestures.pyj:14-113` | 仅书架层左缘右滑返回 | 〔**未记**〕 |
| R19 | 快捷键约 90 项且可重映射 | `pyj/read_book/shortcuts.pyj:93-377` | 6 类固定 | 〔**未记**〕 |
| R20 | 阅读器配置档导入导出 | `pyj/read_book/profiles.pyj`、`srv/content.py:366-391` | 零 | 〔**未记**〕 |
| R21 | 离线缓存(IndexedDB)+ 待同步队列 + 「未同步」提示 | `pyj/read_book/db.pyj:15-71`、`ui.pyj:361-417` | 仅位置 `localStorage` 兜底 | 〔**未记**〕 |
| R22 | 数学公式 MathJax | `srv/render_book.py:103-109`、`pyj/read_book/mathjax.pyj:48-109` | 零 | 〔**未记**〕 |
| R23 | 印刷版页码表(page-list)与 landmarks | `pyj/read_book/goto.pyj:25-56` | 零 | 〔**未记**〕 |
| R24 | 图像查看 / 漫画(CBZ/CBR/CB7/CBC) | `plugins/comic_input.py:311-344` | 不接受这些格式,无图像模式 | 〔**未记**〕 |
| R25 | 打印/导出 PDF(仅桌面) | `gui2/viewer/printing.py:185-217` | 零(Web 端本来也缺) | 〔不追〕 |
| R26 | 查词 / 联网搜索 / 引用生成 / **LLM 面板** | `gui2/viewer/lookup.py`、`llm.py`、`pyj/read_book/referencing.pyj` | 零 | 〔不追〕原方案 §12 已排除 |
| R27 | 参考模式、链接提示叠加层 | `referencing.pyj:9-22`、`hints.pyj:13-40` | 零 | 〔不追〕 |

**小结**:阅读器是差距最集中、且原方案覆盖最全的一块(P3/P4/P9/P10 已排期)。
但「书内正文 FTS」「脚注」「统计」「页眉页脚」「自动滚动」「栏数」「触摸手势」「配置档」
「离线注释队列」「MathJax」「页列表」「漫画」**12 项原方案没提**,其中**书内正文 FTS** 与
**脚注**是最影响日常阅读体验的两项。

---

## 4. 差距总表:书目管理

| # | calibre 的能力 | 出处 | 我方现状 | 归类 |
| --- | --- | --- | --- | --- |
| B1 | 实体表规范化(authors/series/tags/languages/identifiers + link 表) | `resources/metadata_sqlite.sql:1,105,111,141,147` | 单表字符串列 | 〔计划〕G3 / P6 |
| B2 | **系列 + 系列序号**(含 sort 触发器、下一序号策略) | `metadata_sqlite.sql:641-650`;`db/__init__.py:18-48` | **无此字段**;且豆瓣「丛书」根本没解析(`core/douban.js:84` 注释提到但无分支) | 〔计划〕P6 |
| B3 | 语言字段 | `metadata_sqlite.sql:111` | 无 | 〔计划〕P6 |
| B4 | 标识符表(开放式 type,UNIQUE 去重) | `metadata_sqlite.sql:105-110` | 固定 `isbn` / `douban_id` 两列 | 〔计划〕P6 |
| B5 | 出版社 / 评分规范化表 | `metadata_sqlite.sql:130,136` | 保留为列 | 〔不追〕原方案 §12 已排除 |
| B6 | 自定义字段(10 种类型、多值、枚举、复合) | `db/backend.py:1386-1534` | 无 | 〔计划〕P8 |
| B7 | **完整字段搜索语法** | `utils/search_query_parser.py`(483 行) | `status`/`tag` 过滤 + FTS 关键词 | 〔计划〕P5 |
| B8 | 保存的搜索 / **虚拟书库** / 用户分类 / 分组搜索词 | `db/search.py:457-521,593-627,896-918` | 无 | 〔计划〕P5 |
| B9 | 标签浏览器(层级 + 计数 + 均分) | `metadata_sqlite.sql:218-327` | 标签云取前 12,无层级无计数浏览 | 〔计划〕P7 |
| B10 | 任意字段排序 / 多列排序 / 分组计数 | `db/cache.py:1735-1827` | 4 种排序白名单 | 〔计划〕P7 |
| B11 | **重复检测**(两级:标题精确 + 模糊作者/标题/语言) | `db/cache.py:2596-2608`、`:3278-3316`、`db/utils.py:50-70` | **无任何重复检测** | 〔**未记**〕 |
| B12 | **回收站软删除**(`.caltrash`,14 天 TTL) | `db/constants.py:11-13`、`db/backend.py:2393-2564` | **硬删除**,只能靠备份 | 〔**未记**〕 |
| B13 | **一本书多格式**(`data` 表,UNIQUE(book,format)) | `metadata_sqlite.sql:93-99` | 一本书只留一个文件,再传即替换(`db/books.js:81-89`) | 〔**未记**〕 |
| B14 | 多源元数据抓取(5 内置源)+ **字段级合并引擎** | `ebooks/metadata/sources/identify.py:261-343`(672 行) | 豆瓣**单源**,无合并策略 | 〔计划〕§7.3 只提了方向 |
| B15 | 元数据持续性备份(`metadata.opf` 后台线程 + 脏队列) | `db/backup.py:21-128` | 只有整库备份,无**单本**元数据导出 | 〔**未记**〕 |
| B16 | 完整性校验:12 项**文件系统 ↔ 数据库双向**对照 | `library/check_library.py:34-47,101-264` | `data-check.js` 87 行,只查库内自洽(无 `file_path` ↔ 磁盘对照) | 〔计划〕§7.4 |
| B17 | 页数统计(后台 worker + 失败日志) | `db/page_count.py:32-141` | 无 | 〔**未记**〕 |
| B18 | 批量导出到磁盘(模板路径 + plugboard) | `library/save_to_disk.py:298-354` | 无批量导出 | 〔**未记**〕 |
| B19 | 目录生成(EPUB/MOBI/CSV/BibTeX) | `gui2/catalog/catalog_epub_mobi.py`(1,573 行) | 无 | 〔不追〕 |
| B20 | 模板语言 + 130 个内置函数 + plugboard | `utils/formatter.py`(2,128)+ `formatter_functions.py`(4,522) | 无 | 〔不追〕原方案 §12 已排除 |
| B21 | `calibredb` 命令行(~28 命令) | `db/cli/` | 只有 `data-check.js` | 〔**未记**〕 |
| B22 | 转换选项 / 注释 / 偏好 均入库 | `metadata_sqlite.sql:75,126,163` | 偏好有 `settings` 表;注释无 | 〔计划〕P3 |

**小结**:书目侧原方案的最大盲区是 **B11 重复检测** 与 **B12 回收站软删除** —— 这两项
恰恰是「书一多、手一抖」时最先出事的地方,而当前只有备份兜底。**B13 多格式** 也很实际:
现在给一本书传第二个格式会静默替换掉第一个。

---

## 5. 差距总表:格式、转换、服务端、设备与周边

### 5.1 格式与转换

| 项 | calibre | 我方 |
| --- | --- | --- |
| 可接受的输入格式 | **23 个输入插件**:azw4、chm、cbz/cbr/cb7/cbc、djvu/djv、docx/docm、epub/kepub、fb2/fbz、opf/html/htm/xhtml、htmlz、lit、lrf、mobi/prc/azw/azw3/pobi、odt、pdb/updb、pdf、pml/pmlz、rb、recipe、rtf、snb、tcr、txt/txtz/md/markdown/textile(+zip/rar/oebzip) | **5 个**:epub、pdf、mobi、azw3、txt;其中**只有 epub/pdf 能站内读** |
| 输出格式 | **20 个**(含独立的 KEPUB 输出、HTML 输出写 zip) | 无转换 |
| 转换管线 | `Plumber.run()` `conversion/plumber.py:1188-1456`,约 30 个变换阶段 | 无 |
| 转换选项 | 7 组(外观/启发式/查找替换/结构识别/目录/元数据/调试)+ ~80 个管线选项 | 无 |
| 设备排版配置档 | 12 输入 + 20 输出 profile | 无(Web 阅读意义不大) |
| 服务器端转换 API | `srv/convert.py:196-332` | 无 |

〔计划〕P9 的路线(复用 `ebook-convert`,不自研)经复核**是对的**:自研等于重写 47 万行的
`ebooks/` 子树。但要注意 P9 的前置条件 —— **服务器上得先有 calibre**,这是运维成本。

### 5.2 服务端与多端

| 项 | calibre | 我方 | 归类 |
| --- | --- | --- | --- |
| 端点规模 | **约 90 个**(`srv/` 16,162 行) | 18 个 | — |
| 鉴权 | HTTP Digest/Basic + **失败封禁** + SQLite 用户表(per-user restriction/readonly) | 单 token,`timingSafeEqual`,Nginx Basic 外圈 | 〔不追〕多用户 |
| OPDS 目录服务 | 5 个端点(`srv/opds.py:616-770`),acquisition links | 无 | 〔不追〕原方案 §12 已排除 |
| PWA | `manifest.json` + `service_worker.js` | **有**(`public/manifest.json`、`sw.js`) | 已达成 |
| 远程写 API | `/cdb/cmd/*`(供 `calibredb` 远程调用) | 无 | 〔不追〕 |
| 阅读会话数据同步 | `/interface-data/set-session-data` | 无(设置只存本地) | 〔不追〕单端 |
| 多库 broker / WebSocket / Bonjour | `srv/library_broker.py`、`web_socket.py`、`bonjour.py` | 无 | 〔不追〕 |
| 书正文 FTS | `/fts/search`、`/fts/reindex`、`/fts/snippets` | 无 | 〔**未记**〕见 R8 |

### 5.3 设备与桌面

| 项 | calibre | 我方 |
| --- | --- | --- |
| 设备驱动 | **约 100 个**(`devices/` 24,969 行):Kindle / Kobo / PocketBook / Sony / Nook / MTP / 无线设备 / 文件夹设备…;含 Kindle APNX 页码表、`KoboReader.sqlite` 直读 | 无 |
| 发送到设备 / 设备书目同步 | `gui2/device.py`(2,108 行) | 无 |
| 桌面 GUI | `gui2/` 179,817 行 | 无(Web 即界面) |
| 电子书**内容编辑器** | `gui2/tweak_book/` **26,770 行** + `ebooks/oeb/polish/` 12,120 行 | 无 |

**设备与桌面 GUI 这一整块,对纯 Web 个人应用完全不适用** —— 这里差 20 万行是正常的,
应该明确写进「不追」清单,而不是记成差距。

真正值得注意的反而是 **电子书编辑器(26,770 行)**:它对应「改错别字/改元数据/修目录」这类
真实需求。个人自用场景下,更务实的等价物是「能改进库里的元数据 + 能重新导出」。

### 5.4 周边能力(原方案完全未涉及的新能力域)

| 项 | calibre 规模 | 说明 | 归类 |
| --- | --- | --- | --- |
| **AI / LLM** | `ai/` 11,556 行;9 个 provider 插件(OpenAI/Anthropic/Google/Grok/Ollama/LM Studio/OpenRouter/Venice/OpenAI 兼容);`ai/cyoa.py` 2,474 行;阅读器 LLM 面板 `gui2/viewer/llm.py`;AI 封面生成 | 可做「按书问答/摘要/推荐」;亦有依赖外部服务的成本 | 〔**未记**〕可选 |
| **新闻 / 配方抓取** | `recipes/` **1,100 个 `.recipe`**;调度器 `web/feeds/recipes/collection.py`;无头浏览器抓取 `web/automate/`(camoufox 3,647 行) | 「把网站/订阅做成电子书」;体量与运维成本都高 | 〔不追〕 |
| 拼写检查 / 词典 | `spell/` 705 行 + hunspell 词典(`en-US`/`en-GB`/`es-ES`) | 服务于内容编辑器 | 〔不追〕 |
| 插件框架 | `customize/` 5,945 行,12 种插件基类 | 元数据源、设备、格式、界面动作… | 〔不追〕原方案 §12 已排除 |

---

## 6. 与对标无关、但会挡住使用的既有问题

### 6.1 `/books-files/` 无鉴权 —— **已决策:方案 B(保持公开)**

> **决策记录(用户,2026-09-23):保持 `/books-files` 公开,只上传不敏感的书。**
> 本节保留原分析以备将来改变主意;下面补一条决策时需要知道的事实。

实测:

- `server.js:35` —— `app.use('/books-files', express.static(...))`,**没有任何鉴权中间件**
- `server.js:43` —— 鉴权只挂在 `app.use('/api', requireAdmin)`,**不覆盖 `/books-files` 与 `/uploads`**
- `deploy/nginx-helloac.top.conf` —— **没有** `location /books-files/` 段落,请求落到 `location /`
  直接反代给 Node;而那段 `/api/` 的 Basic 口令即使启用,也是 `limit_except GET HEAD`(只挡写)

**决策前必须知道的一条(本轮补充,实测)**:文件名(`<id>-<时间戳>-<6位随机>.<ext>`)
看起来不易猜,但**公网 API 会主动把完整路径发出来**,所以「隐晦」这层根本不存在:

- `GET /api/books` → `books.listBooks()` 是 `SELECT * FROM books`(`src/db/books.js:34`)
- `GET /api/books/:id` → `books.getBook(id)` 也是 `SELECT *`(`src/db/books.js:39`)
- 两者都是 **GET,不鉴权**;返回行里含 `file_path`

即:任何人 `curl https://helloac.top/api/books` 就能拿到每本书的 `file_path`,
再拼 `https://helloac.top/books-files/<file_path>` 直接下载全文 —— **不需要猜,也没有任何阻碍**。

(这不是 bug:前端阅读器正是靠 `book.file_path` 取文件的,`public/read.html:840`。
它只是说明:**方案 B 之下没有技术保护,唯一的控制点就是「什么书可以上传」这条自律**。)

**因此方案 B 的等价表述是**:该书库等价于**完全公开的静态文件服务**。
上传前请按此标准自检(公版书 / 无版权顾虑 / 不含个人信息)。

三种走向的对照(保留,便于将来重新评估):

| 方案 | 代价 |
| --- | --- |
| A 阅读/下载走带 token 的接口(或签名 URL) | 在线阅读要带凭据;pdf.js 的 Range 分块请求也要带 header;分享链接需另做 |
| **B 保持公开,只上传不敏感的书(已选)** | **零改动;无技术保护,靠上传自律** |
| C 本地/内网保存正文,公网只留书目 | 失去「线上随时读」的核心体验 |

**若将来改变主意选 A**:需同时改 `server.js:35`、`public/read.html:840`(改走鉴权接口)、
`pdf.js` 的 `httpHeaders` 与 epub.js 取文件处,并给分享链接另做签名机制。

### 6.2 硬删除无软着陆

`DELETE FROM books` 立即生效,唯一恢复途径是备份(见 B12)。配合「目录生成/批量操作」一旦加进来,
误删风险会上升。

---

## 7. 文档与实现已脱节的地方(复核副产物)

这些不是功能差距,但会误导下一次决策:

| 位置 | 文档说的 | 实际 |
| --- | --- | --- |
| `CALIBRE-对标方案.md` §2.1 | `read.html` **167 行**、「阅读进度**零持久化**」、「阅读设置**仅夜间/日间切换**」、「目录导航**无**」 | 已 850 行;进度记忆 + 完整设置面板 + TOC 均已落地(P1/P2,commit `cca8102`)。**该节整表已过时** |
| `CALIBRE-对标方案.md` §2.2 | 「豆瓣字段抓了但详情页不展示」 | P0 已修(commit `eebd4d5`) |
| `CALIBRE-对标方案.md` §9 | 四项「必须修的既有问题」(gitignore / Nginx 上限 / 备份范围 / 详情页) | **四项全已修**(`eebd4d5`、`2f98a68`) |
| `PROJECT_MEMORY.md` §9 第 6 项 | 「检索接前端 —— 前端搜索仍走旧全库调用,待做」 | **已接**:`app.js:157` 会发 `q` 参数 |
| `README.md:89` | 「首次启动自动写入 17 本示例书(见 `db.js` 的种子数据)」 | `db.js` 已删除,种子数据在 `src/db/seed-data.js`;且实测库是 31 本 |
| `PROGRESS.md` 头部 | 更新日期 2026-09-22,「42 条测试」 | 已有 116 条测试、P0/P1/P2 均已落地 |

**建议**:原方案 §2(现状评估)与 §9(必须修的问题)应各加一句「已过时,见本复核」的指针,
否则后续会话容易照着旧描述重复劳动。

---

## 8. 原方案**未覆盖**的差距清单(本轮新增,共 12 项)

按「值不值得补」排序:

| 序 | 差距 | 为什么值得考虑 | 参考实现 |
| --- | --- | --- | --- |
| 1 | **`/books-files` 鉴权**(§6.1) | 不解决就无法安心上传正文 | — |
| 2 | **回收站软删除** | 硬删除 + 只有备份,误删成本高 | `db/backend.py:2393-2564` |
| 3 | **重复检测** | 手动录入几十本后必然重复;豆瓣抓取也会重复入库 | `db/cache.py:2596-2608`、`:3278-3316` |
| 4 | **一本书多格式** | 现在传 PDF 会静默删掉已有的 EPUB | `data` 表 `metadata_sqlite.sql:93-99` |
| 5 | **书正文全文检索** | 「记得某句话在哪本书里」是真实需求;`books_fts` 只覆盖元数据 | `db/fts/`、`srv/fts.py` |
| 6 | **脚注弹窗** | 学术/注释类书必备,实现量不大 | `pyj/read_book/footnotes.pyj` |
| 7 | **单本元数据导出(OPF 等价物)** | 现在备份=整库;单本可读的元数据快照更耐灾 | `db/backup.py:21-128` |
| 8 | **阅读统计** | 与已有「统计/榜单」页天然衔接 | `pyj/read_book/overlay.pyj:695-819` |
| 9 | **页眉页脚 / 自动滚动** | 提升长时阅读体验,纯前端 | `prefs/head_foot.pyj`、`flow_mode.pyj` |
| 10 | **页数统计** | 书架展示与「读到第几页」都需要 | `db/page_count.py` |
| 11 | **per-book 完整性对照** | 扩 `data-check.js`:查 `file_path` 指向的文件是否真存在 | `library/check_library.py` |
| 12 | 触摸手势全集 / 配置档 / MathJax / 漫画 / 有声书 | 视实际使用场景取舍 | 见 §3 |

---

## 9. 建议的处理顺序

> 原则沿用原方案:**一次只做一件,做完验收再下一件**;不推倒重来。

**第 0 步(决策,不是编码)—— 已完成 2026-09-23**:`/books-files` 定为**方案 B**(保持公开,
只上传不敏感的书)。零代码改动。含义与风险见 §6.1。

**第 1 步(计划内,地基已就位)**:**P3 书签 / 高亮 / 批注**。
`read_positions` 的坐标模型已跑通,epub.js 的 `rendition.annotations.add()` 与 `'selected'` 事件
原生可用,是投入产出比最高的一步。

**第 2 步(本轮新增,补漏)**:按 §8 的 2→3→4 补
**回收站软删除 → 重复检测 → 一本书多格式**。
放在 P3 之后、P4 之前,理由:地基类修复应当**先于**继续往上堆功能 ——
用法越重,一次误操作能毁掉的东西越多。
前两项改动集中在 `src/db/` 与 `src/core/`(加一条迁移 + 纯函数),不碰渲染,风险低;
第三项稍重 —— 需把 `books` 表上的 `file_path`/`file_format`/`file_size` 三列拆成
`book_files` 表(v6 迁移),并改 `routes.files.js`、`app.js` 展示与 `read.html:839-844`
的格式分支(那是按单个 `file_format` 直接分派的),但同样不碰渲染逻辑本身。
三项都直接消除「数据没了」的尾部风险。

**第 3 步(计划内)**:**P4 书内搜索**。与 P3 共用坐标与渲染钩子。

**暂缓**:P6 实体表规范化(唯一需要搬迁历史数据的一步,等到真被「作者改名/标签层级」绊到时再做);
P9 统一格式管线(依赖服务器装 calibre,重活)。

**明确不追**(建议写进文档,避免反复评估):设备驱动、桌面 GUI、电子书内容编辑器、
新闻配方抓取、拼写词典、插件框架、OPDS、多用户权限、模板语言与 plugboard、目录生成。

---

## 10. 复核方法与可复现命令

本轮全部结论可由以下步骤复现(不需要 calibre 可运行):

```powershell
# 1) 我方测试与数据体检(跑前后比对 books.db 的 mtime/大小,确认未被触碰)
cd D:\littleBIngbing\my-books
Get-ChildItem test\*.test.js | ForEach-Object { node $_.FullName }   # 116 条全绿
node data-check.js                                                   # 31 本书,0 问题

# 2) 真实库现状(只读打开:表、列、行数、FTS 虚表)
#    用 node:sqlite 的 DatabaseSync(path, {readOnly:true}) 查询
#    PRAGMA user_version / sqlite_master / COUNT(*) / read_positions

# 3) calibre 规模(自研 vs 参照物)
$f = Get-ChildItem -Recurse -File -Filter *.py calibre-master\src\calibre
($f | ForEach-Object { [System.IO.File]::ReadAllLines($_.FullName).Count } | Measure-Object -Sum).Sum   # 818,880

# 4) calibre 引用行号核对(原方案的关键数字全部复核通过)
#    cfi.pyj 984 行 / ebooks\pdf\reflow.py 2273 行 / resources\metadata_sqlite.sql 653 行(user_version=27)
#    注意:Measure-Object -Line 会跳过空行,须用 ReadAllLines().Count

# 5) 参照物可运行性自检(90/1409 文件因 py2 except 语法不可 parse)
#    按项目纪律"带引号的脚本一律写文件再跑",不要内联 python -c。
#    存成 __check-parse.py(用完删)后执行:python __check-parse.py
```

```python
# __check-parse.py
import ast, pathlib
root = pathlib.Path(r"D:\littleBIngbing\my-books\calibre-master\src\calibre")
files = list(root.rglob("*.py"))
bad = []
for f in files:
    try:
        ast.parse(f.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError as e:
        bad.append((str(f.relative_to(root)), e.lineno, str(e)[:70]))
print("total .py:", len(files), " parse failures:", len(bad))
for b in bad[:15]:
    print("  FAIL", b[0], "line", b[1], "->", b[2])
```

**原方案关键数字复核结果**(全部通过,可放心回引):

| 原方案的说法 | 实测 |
| --- | --- |
| `cfi.pyj` 984 行 | **984** ✓ |
| `ebooks/pdf/reflow.py` 2,273 行 | **2,273** ✓ |
| `resources/metadata_sqlite.sql` 653 行、`user_version=27` | **653 行 / user_version=27** ✓ |
| `db/cache.py` 约 174–178KB | **178,461 B**(4,334 行)✓ |
| `field_metadata.py` 约 28 个内置字段(`:33-471`) | 字段表确在 `:33-471`,实测 **28 个** 字段条目 ✓ |
| 阅读器为「两套前端 + 一个共用内核」 | 成立:桌面 `gui2/viewer` + 浏览器(`srv` 服务同一份 pyj 编译产物)✓ |

---

## 附:本轮结论的性质说明

- 所有行号均来自本轮对 `calibre-master` 的直接阅读,可用「文件:行」回查。
- `calibre-master` 不可执行(90 个文件 py2 语法),因此**本复核只声明「读到了什么」,
  不声明「运行起来是什么行为」**。
- 我方结论全部来自源码 + 真实库只读查询 + 实跑测试,并保持 `data/books.db` 未被修改
  (跑测试前后 mtime/大小一致)。
