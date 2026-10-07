# my-books · 对标 calibre 完整方案

> 目标:以现有代码为地基,把「在线阅读」与「书本信息记录」两块能力补齐到 calibre 的对应水准。
> 范围:核心对标 —— 阅读器全能力 + 书目管理全能力。不含 OPDS、多用户权限、插件框架、30+ 格式元数据内嵌读写。
> 参考源码:`calibre-master/`(只读,已 gitignore)。所有 calibre 引用均标注 `文件:行`,可回查。
> 配套文档:`PROJECT_MEMORY.md`(项目记忆)、`PROGRESS.md`(进展清单)、`README.md`(对外说明)。
> 编写日期:2026-09-22

---

## 0. 结论摘要

my-books 缺的不是「阅读功能」本身,而是三件地基。其余所有表面差距都是这三件的派生:

| # | 地基 | 现状 | 为什么它是根因 |
| --- | --- | --- | --- |
| **G1** | **稳定位置模型** | 无。`read.html` 全文零持久化 | 进度记忆、书签、高亮、批注、位置分享 —— 这五件事全都要「一个能跨会话复现的坐标」。没有它,五件事一件都建不起来 |
| **G2** | **统一渲染管线** | pdf.js + epub.js 双原生引擎 | 每加一种格式就要再接一个库。`core/ebook.js:10-11` 把 MOBI/AZW3/TXT 列为「只存不读」正是这个后果 |
| **G3** | **规范化数据模型** | 单表 22 列,`author`/`tags` 存字符串 | 决定「作者改名」是改一行还是扫全表改字符串;决定「加一个维度」是加配置还是改五处代码 |

对标结论:**G1 优先做且投入最小**(两个渲染引擎都免费提供位置坐标);**G2 属重活应复用而非自研**;**G3 收益最大但应等到真正被绊到时再做**。

---

## 1. 对标基线

### 1.1 calibre 的阅读器架构(两套前端 + 一个共用内核)

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 桌面 viewer | `src/calibre/gui2/viewer/` | Python/Qt WebEngine 外壳 + JS bridge(`web_view.py`) |
| Web 阅读器 | `src/pyj/read_book/**` | pyj/RapydScript 编译成 JS,约 30 个 `.pyj` 模块 |
| **共用渲染内核** | `src/calibre/srv/render_book.py` | 把任意格式炸成 HTML + `calibre-book-manifest.json` |
| 位置模型 | `src/pyj/read_book/cfi.pyj` | EPUBCFI 完整实现(984 行):计算/解析/比较 |
| 注释 | `src/calibre/db/annotations.py` + `annotations.pyj` | 书签/高亮/批注 + 合并算法 |
| 进度存储 | `src/calibre/srv/last_read.py` | 服务端 `last_read_positions` 表 |

关键设计事实:**calibre 不做原生 PDF 渲染**。PDF 先经 `ebooks/pdf/reflow.py`(2273 行)重排成 HTML,换来可选中/可重排/可搜索/可标注。这与 my-books 用 pdf.js 逐页渲染的方向**恰好相反**。

### 1.2 calibre 的书目管理架构

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 字段定义 | `src/calibre/library/field_metadata.py:33-471` | 约 28 个内置字段的元数据描述 |
| schema 快照 | `resources/metadata_sqlite.sql`(653 行,`user_version=27`) | 全部表 DDL 的权威来源 |
| 迁移历史 | `src/calibre/db/schema_upgrades.py`(895 行) | 逐版本迁移,my-books 的迁移机制即借鉴此文件 |
| 自定义字段 | `src/calibre/db/backend.py:1386-1534` | `create_custom_column()`,10 种数据类型 |
| 字段搜索语法 | `src/calibre/db/search.py` + `utils/search_query_parser.py` | `and/or/not` + 字段前缀 + 正则 + 范围 |
| 数据完整性 | `src/calibre/library/check_library.py` | 文件系统与数据库双向对照 |

### 1.3 本次对标范围

**做**:

- 阅读器:位置模型、进度同步、TOC 导航、书签/高亮/批注、书内搜索、阅读设置面板、翻页流、朗读
- 书目:作者/标签/系列/语言/标识符规范化、自定义字段、字段搜索语法、保存搜索、排序分组、元数据多源抓取
- 运维:格式管线(复用 `ebook-convert`)、完整性校验扩展、注释与进度的备份

**不做**(见 §12 不动清单):OPDS、多用户与权限、插件框架、30+ 格式元数据内嵌读写(`set_metadata`)、C 扩展。

---

## 2. 现状评估

### 2.1 在线阅读(`public/read.html`,167 行)

| 能力 | 现状 | 实现位置 | calibre 对应 |
| --- | --- | --- | --- |
| 渲染引擎 | pdf.js 4.8.69 + epub.js 0.3.93,双原生引擎 | `read.html:49,90,137` | `render_book.py:563` 转 HTML 统一内核 |
| 支持格式 | EPUB/PDF 站内读;MOBI/AZW3/TXT 只存不读 | `core/ebook.js:10-11` | 20+ 格式含 CBZ/DJVU |
| 阅读进度 | **零持久化**(全文无 `localStorage`) | — | `srv/last_read.py:13` 表 + EPUBCFI |
| 目录导航 | 无 | — | `toc.pyj` + `goto.pyj` |
| 书签/高亮/批注 | 无 | — | `db/annotations.py` + `annotations.pyj` |
| 书内搜索 | 无 | — | `search_worker.pyj` |
| 阅读设置 | 仅夜间/日间切换 | `read.html:158-162` | `prefs/*` 全套面板 |
| 翻页交互 | 方向键 + 25%/75% 边缘点击 | `read.html:121-124,148-152` | paged/flow 双模式 + 约 60 条快捷键 |
| PDF 内存控制 | 逐页渲染,只留当前页 canvas | `read.html:108` | reflow 成 HTML,可全文索引 |
| 朗读/自动滚 | 无 | — | TTS + autoscroll |
| 导出 | `download` 属性下原文件 | `app.js:501` | 打印 PDF、高亮导出 md/txt/json |

### 2.2 书本信息记录

| 能力 | 现状 | calibre 对应 |
| --- | --- | --- |
| 字段总量 | 单表 22 列(v1→v4 迁移累积) | `field_metadata.py:33-471` 约 28 内置 + 派生 |
| 作者 | `author` 单字符串 | `authors` 表 + link,多作者,每人 sort |
| 标签 | JSON 字符串 + `LIKE '%"tag"%'` | `tags` 表 + link,层级,计数,改名合并 |
| 系列 | **无**(豆瓣上游解析了「丛书」但移植时丢弃) | `series` + `series_index` |
| 语言 | 无 | `languages` 表 + link |
| 标识符 | `isbn` / `douban_id` 两个固定列 | `identifiers(book,type,val)` + UNIQUE 去重 |
| 自定义字段 | 无 | 10 种类型 + 多值 + 枚举 + 复合 |
| 元数据抓取 | 豆瓣单源 | 插件体系 + 字段级合并策略 |
| 搜索表达力 | `status`/`tag` 过滤 + FTS5 关键词 | `and/or/not` + 字段前缀 + 正则 + 范围 |
| 排序 | 4 种固定白名单 | 任意字段排序 + tag browser 分组 |
| 虚拟书库 | 无 | 保存搜索 + `vl:Name` |
| 完整性 | PRAGMA 加固 + 版本迁移 + `data-check.js` | `check_library.py` 双向对照 + 重复检测 |
| 前端展示 | **豆瓣字段抓了但详情页不展示** | 全字段可搜可排可分组 |

### 2.3 已具备的良好基础(不要重做)

- 三层架构 `core/`(纯函数)→ `db/`(数据访问)→ `http/`(适配),依赖方向纪律清晰
- 版本化迁移机制(`src/db/index.js:113-132`),事务包裹,幂等
- FTS5 检索层(`src/db/search.js`),trigram + BM25 + 短词 LIKE 兜底
- PRAGMA 加固、原子写(`src/core/fs-utils.js`)、LRU 缓存、优雅退出
- 应用内鉴权 + 限速(`middleware.auth.js`),恒时比较
- 42 条测试 + `data-check.js` 自检 + 备份对账的 `update.sh`
- 封面取色、无限轮播等前端能力

**对标工作必须在这套纪律上增量推进,不推倒重来。**

---

## 3. 三条根因(展开)

### G1 稳定位置模型

`read.html` 的「页码」在重排文本里不可靠(窗口宽窄、字号一变页码就变)。缺一个稳定坐标导致:

```
无位置模型
  ├─ 阅读进度无法记忆     ← localStorage / 服务端都要求一个可存的坐标
  ├─ 书签无法建立         ← 书签 = 命名的位置
  ├─ 高亮无法建立         ← 高亮 = 区间 [start, end]
  ├─ 批注无法挂载         ← 批注挂在区间上
  └─ 位置分享无法实现     ← 分享 = 交换坐标
```

calibre 的答案是 **EPUBCFI**(核心实现在 `src/pyj/read_book/cfi.pyj`,985 行:`encode`/`decode`/`cfi_sort_key`/`sort_cfis`),可精确到字符、可跨设备。
**my-books 的务实答案**:不实现完整 CFI。epub.js 的 `rendition.currentLocation()` 原生返回 `cfi` 与 `start.percentage`;pdf.js 用 `page + offsetInPage`。两者都能立刻拿到稳定坐标。

### G2 统一渲染管线

现状是「一格式一引擎」,加第三种的边际成本高。calibre 用 input plugin 抽象掉这个成本。
**my-books 的务实答案**:不自研转换,复用 `ebook-convert`(详见 §10)。

### G3 规范化数据模型

`author` 存字符串的直接后果:「作者改名」要 `UPDATE books SET author=REPLACE(...)` 并可能破坏同名不同人;`tags` 用 `LIKE` 匹配无法支持层级与计数。calibre 用「实体表 + link 表」解决。
**代价**:这是唯一需要改 schema 并搬迁全部历史数据的部分,风险最高,收益也最长线。

---

## 4. 数据模型设计

### 4.1 一个关键简化:用真外键,而非 calibre 的触发器模拟

calibre **没有**启用 `PRAGMA foreign_keys`,所有外键约束靠 `BEFORE INSERT/UPDATE` 触发器手工 `RAISE(ABORT)` 模拟(`resources/metadata_sqlite.sql:429-470` 等),级联删除集中在单个 `books_delete_trg`(`metadata_sqlite.sql:354-370`)。这是它为了兼容历史库与跨库场景付出的代价。

**my-books 已在 `src/db/index.js:33` 启用 `PRAGMA foreign_keys = ON`**。因此本方案直接用 SQL 级 `REFERENCES ... ON DELETE CASCADE`,不搬 calibre 的触发器方案:

- 代码量从「每张子表 2~4 个触发器」降到 0
- 约束由数据库强制,应用层写错也插不进脏数据
- 删书自动级联,不需要维护一张越来越长的手工清理清单

这是 my-books 在新项目上相对 calibre 的**结构性优势**,方案里要主动利用。

### 4.2 v5:阅读位置 + 注释(纯增量,零数据搬迁)

支撑 G1。**不含任何对 `books` 表已有列的改动**,因此零风险、可独立上线。

```sql
-- v5.1 阅读位置:一本书 + 一个格式 + 一台设备 → 一个位置
CREATE TABLE IF NOT EXISTS read_positions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  book         INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format       TEXT    NOT NULL COLLATE NOCASE,   -- EPUB / PDF
  device       TEXT    NOT NULL DEFAULT '',       -- 设备标识(手机/电脑分区,互不覆盖)
  locator      TEXT    NOT NULL,                  -- 坐标本体,按 locator_kind 解释
  locator_kind TEXT    NOT NULL DEFAULT 'epubcfi'
                       CHECK (locator_kind IN ('epubcfi','pdfpage')),
  pos_frac     REAL    NOT NULL DEFAULT 0,        -- 0~1 全文进度,列表展示用
  epoch        INTEGER NOT NULL,                  -- Unix 毫秒
  UNIQUE (book, format, device)
);
CREATE INDEX IF NOT EXISTS read_positions_book_idx ON read_positions (book);
```

设计说明:

| 决策 | 取值 | 理由 |
| --- | --- | --- |
| `locator` 单列承载两种坐标 | EPUB 存 CFI 串;PDF 存 JSON `{page,offsetY,scale}` | 两引擎坐标形态不同,但上层「存一个串、取一个串」的用法一致。`locator_kind` 决定解析方式 |
| `device` 分区 | 手机/电脑各存各 | 与 calibre 的 `UNIQUE(user,device,book,format)` 同思路(`schema_upgrades.py:664-680`),但**单用户故去掉 `user` 列** |
| `epoch` 用 INTEGER 毫秒 | 非 REAL 秒 | 项目现有时间戳全为字符串 ISO;此表是高频写入的进度,用毫秒整数便于比较且无歧义 |
| 去掉 calibre 的 `tooltip` | — | calibre 服务端表存进度提示文案(`srv/last_read.py:13-26`);my-books 由前端按 `pos_frac` 现算,不存冗余文案 |

```sql
-- v5.2 注释:书签 / 高亮 / 批注三合一
CREATE TABLE IF NOT EXISTS annotations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  book          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format        TEXT    NOT NULL COLLATE NOCASE,
  annot_type    TEXT    NOT NULL CHECK (annot_type IN ('bookmark','highlight','note')),
  annot_id      TEXT    NOT NULL,                  -- 客户端生成 uuid,重复上传幂等
  start_locator TEXT    NOT NULL,                  -- 书签位置;高亮/批注的区间起点
  end_locator   TEXT    NOT NULL DEFAULT '',       -- 区间终点(书签为空)
  text          TEXT    NOT NULL DEFAULT '',       -- 被高亮的原文
  note          TEXT    NOT NULL DEFAULT '',       -- 用户写的批注
  color         TEXT    NOT NULL DEFAULT '',       -- 高亮配色
  chapter       TEXT    NOT NULL DEFAULT '',       -- 章名,注释列表展示用
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  UNIQUE (book, format, annot_type, annot_id)
);
CREATE INDEX IF NOT EXISTS annotations_book_idx ON annotations (book);

-- 注释全文检索(与 books_fts 同用 trigram,中文友好)
CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5(
  text, note, searchable_chapter, content='annotations', content_rowid='id', tokenize='trigram'
);
```

与 calibre 的差异(有意为之):

| 项 | calibre | my-books | 理由 |
| --- | --- | --- | --- |
| 类型 | `annot_type` 自由文本 + `annot_data` JSON | `CHECK` 约束三值 + 显式列 | 只有三种类型,展开成列后查询/索引直观,不必每次解 JSON |
| 唯一键 | 6 列 `UNIQUE(book,user_type,user,format,annot_type,annot_id)`(`metadata_sqlite.sql:163-197`) | 4 列(去掉用户维度) | 单用户 |
| FTS | 两套虚表(unicode61 + porter),靠触发器同步 | 一套 trigram | 中文场景 trigram 优于英文词干;且项目已有 FTS 同步经验(`src/db/books.js:58-72`),沿用应用层同步而非触发器 |

**FTS 同步策略**:沿用项目现有做法(应用层在写注释时显式同步索引),不用 calibre 的触发器。原因:`src/db/books.js:55-72` 已踩过「外部内容 FTS 表 UPDATE 时旧词条残留」的坑并写了正确解法,同一套纪律复用到注释表即可,可测且可控。

### 4.3 v6:实体表规范化(需要搬迁历史数据)

支撑 G3。**风险最高的一步**,迁移策略见 §5。

```sql
-- v6.1 作者
CREATE TABLE IF NOT EXISTS authors (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  sort TEXT NOT NULL DEFAULT '' COLLATE NOCASE,   -- 排序名,空则回退 name
  link TEXT NOT NULL DEFAULT ''                   -- 作者主页(可选)
);
CREATE INDEX IF NOT EXISTS authors_sort_idx ON authors (sort COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS books_authors_link (
  book       INTEGER NOT NULL REFERENCES books(id)   ON DELETE CASCADE,
  author     INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  item_order INTEGER NOT NULL DEFAULT 0,           -- 保持「第一作者」顺序
  PRIMARY KEY (book, author)
);
CREATE INDEX IF NOT EXISTS books_authors_link_aidx ON books_authors_link (author);
```

> 与 calibre 差异:calibre 用 `id INTEGER PRIMARY KEY` 代理主键 + 单独 `UNIQUE(book,author)`。my-books 用**复合主键** `PRIMARY KEY (book, author)` —— 一次同时得到唯一约束与索引,少一列少一个索引。代理主键是为 calibre 的 GUI 行编辑与 API 兼容服务的,本项目无此约束。

```sql
-- v6.2 标签(含层级:用 `.` 分隔,如「文学.科幻」)
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  link TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tags_name_idx ON tags (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS books_tags_link (
  book INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (book, tag)
);
CREATE INDEX IF NOT EXISTS books_tags_link_aidx ON books_tags_link (tag);

-- v6.3 系列 + 序号(序号存 books.series_index,与 calibre 一致)
CREATE TABLE IF NOT EXISTS series (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  sort TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  link TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS books_series_link (
  book   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  series INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  PRIMARY KEY (book)
);
ALTER TABLE books ADD COLUMN series_index REAL NOT NULL DEFAULT 1.0;

-- v6.4 语言
CREATE TABLE IF NOT EXISTS languages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  lang_code TEXT NOT NULL COLLATE NOCASE UNIQUE,   -- ISO 639:zh / en / ja
  link      TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS books_languages_link (
  book       INTEGER NOT NULL REFERENCES books(id)      ON DELETE CASCADE,
  lang_code  INTEGER NOT NULL REFERENCES languages(id)  ON DELETE CASCADE,
  item_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book, lang_code)
);

-- v6.5 标识符:替代 isbn / douban_id 两个固定列
CREATE TABLE IF NOT EXISTS identifiers (
  book INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  type TEXT    NOT NULL DEFAULT 'isbn' COLLATE NOCASE,  -- isbn / douban / doi / asin...
  val  TEXT    NOT NULL COLLATE NOCASE,
  PRIMARY KEY (book, type)
);
CREATE INDEX IF NOT EXISTS identifiers_val_idx ON identifiers (val);
```

**标识符的价值**:现在 `isbn` 与 `douban_id` 是两个固定列,加第三个来源(如 `doi`)就要再加一列。改成 `(book, type, val)` 后,新来源只是新 `type` 值,零 schema 变更。calibre 的 `UNIQUE(book,type)`(`metadata_sqlite.sql:105-110`)保证「一书一类型一值」,本方案用复合主键等价实现。

### 4.4 v7:自定义字段

支撑「加维度不改代码」。calibre 的 10 类型 + normalized 双轨制(`backend.py:1386-1534`)对个人项目过重,本方案简化为**单表 + JSON 值**:

```sql
-- 字段定义(元数据)
CREATE TABLE IF NOT EXISTS custom_fields (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,        -- 内部名,如 reading_medium
  label      TEXT NOT NULL,               -- 显示名,如「阅读介质」
  datatype   TEXT NOT NULL CHECK (datatype IN ('text','int','float','date','bool','rating','enum')),
  is_multiple INTEGER NOT NULL DEFAULT 0, -- 是否多值
  enum_values TEXT NOT NULL DEFAULT '[]', -- datatype='enum' 时的可选项 JSON
  display    TEXT NOT NULL DEFAULT '{}',  -- 展示配置(排序/单位/颜色)
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 字段值(每书每字段一行;多值则多行)
CREATE TABLE IF NOT EXISTS custom_field_values (
  book       INTEGER NOT NULL REFERENCES books(id)         ON DELETE CASCADE,
  field      INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value_text TEXT    NOT NULL DEFAULT '',
  value_num  REAL,
  item_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book, field, item_order)
);
CREATE INDEX IF NOT EXISTS cfv_field_idx ON custom_field_values (field, value_text);
```

设计取舍:

| 取舍 | 选择 | 理由 |
| --- | --- | --- |
| 不做 normalized 双轨 | 统一单表 | calibre 的 `normalized` 分支会建「实体表 + link 表 + 4 触发器 + 2 视图」(`backend.py:1414-1501`);本项目自定义字段数量个位数,单表足够 |
| 不做 composite 公式 | 不做 | 模板引擎(`utils/formatter.py` `safe_format`)是 calibre 最复杂的部分之一,个人站用不上 |
| 值分 `value_text`/`value_num` 两列 | 双列 | 数值排序/范围查询走 `value_num`,文本匹配走 `value_text`,避免 SQLite 动态类型比较的坑 |

### 4.5 v8:保存的搜索

```sql
CREATE TABLE IF NOT EXISTS saved_searches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  query      TEXT NOT NULL,               -- 搜索表达式,如 status:reading rating:>4
  created_at TEXT NOT NULL
);
```

取代硬编码的 `status` 三态:想读/在读/已读用三个保存的搜索表达,而非三处硬编码分支。

---

## 5. 迁移策略(最关键的一节)

### 5.1 分期原则

项目已有成熟的迁移机制(`src/db/index.js:113-132`:事务包裹、幂等、`user_version` 计数)。本方案**严格沿用**,只追加函数,不改历史:

```
v1 基线 ─ v2 FTS ─ v3 文件字段 ─ v4 豆瓣字段 ─┐
                                              ├─ 现状 user_version=4
v5 位置+注释 → v6 实体表 → v7 自定义字段 → v8 保存搜索 → v9 清理遗留列
   ↑零搬迁      ↑需搬迁      ↑纯增量        ↑纯增量       ↑删列(最后做)
```

每期独立可上线、独立可回滚。**不把多个 schema 变更塞进一个大版本**。

### 5.2 v6 的数据搬迁(唯一有风险的步骤)

搬迁规则(逐项对照现有数据):

| 源 | 目标 | 规则 |
| --- | --- | --- |
| `books.author` | `authors` + `books_authors_link` | 按 ` / `、`,`、`;` 切分多作者;每个名字 `INSERT OR IGNORE` 进 `authors`,再建 link,`item_order` 按切分顺序 |
| `books.tags`(JSON) | `tags` + `books_tags_link` | 解析 JSON 数组,逐项入 `tags` 与 link;`. ` 分隔的自动获得层级语义 |
| `books.isbn` | `identifiers(type='isbn')` | 非空则搬 |
| `books.douban_id` | `identifiers(type='douban')` | 非空则搬 |
| `books.publisher` | **暂不搬** | 出版社做实体表收益低(改名的需求几乎不存在),保留为列,见 §12 |
| `books.rating` | **不搬** | 保持列。评分是「单值 + 数值比较」,规范化无收益 |

**搬迁必须在单个事务内完成**,失败整体 `ROLLBACK`,这是 `runMigrations` 已有的保证。

### 5.3 双写过渡期(行为零变化的关键)

用户明确要求「行为零变化 + 每步验证」。因此 v6 **不删任何旧列**,而是进入双写期:

```
写入路径:books.updateBook()
   ├─ 写旧列 author / tags / isbn / douban_id   ← 旧代码与旧测试继续通过
   └─ 写新表 authors / tags / identifiers        ← 新能力就绪

读取路径:
   ├─ 旧 API(/api/books)← 仍从旧列投影,返回形状不变
   └─ 新 API(/api/v1/books)← 从新表 JOIN 组装
```

**投影一致性**由 `data-check.js` 扩展校验(见 §9):比对 `books.author` 字符串与 `books_authors_link` JOIN 出来的名字串是否一致。两者不一致即报错,而不是静默漂移。

等新旧完全对齐、且新 API 稳定后,才在 **v9** `ALTER TABLE books DROP COLUMN` 删掉 `author` / `tags` / `isbn` / `douban_id`。

> 这个「双写 → 校验 → 再删列」的三步节奏,正是项目 v1 处理 `rating` 列时用过的模式(`src/db/index.js:68-72`:删前自动备份),直接沿用。

### 5.4 回滚计划

| 期 | 回滚方式 | 数据风险 |
| --- | --- | --- |
| v5 | 删表即可,`books` 未动 | 无 |
| v6 | 旧列仍在且为权威,删新表即回退到当前行为 | 低(新表数据可丢) |
| v7 / v8 | 删表 | 无 |
| v9 删列 | **唯一不可逆步骤** | 删前自动备份 `data/books.backup-before-v9-drop-legacy` |

**v9 之前,任何一期出问题都能安全回退。** v9 执行前必须先确认:
1. 双写期至少稳定运行一段时间
2. `data-check.js` 投影一致性连续通过
3. 备份已验证可读(`update.sh` 已有 `integrity_check` 对账)

### 5.5 验证方式(每期必做)

项目已有测试纪律,每期对应补测试:

| 期 | 新增测试 | 验证内容 |
| --- | --- | --- |
| v5 | `test/read-positions.test.js`、`test/annotations.test.js` | 位置 upsert 幂等、设备分区不互相覆盖、注释唯一键去重、级联删除 |
| v6 | `test/entities.test.js`、`test/migrate-v6.test.js` | 作者切分规则、搬迁前后数据等价、双写一致性 |
| v7 | `test/custom-fields.test.js` | 多值字段、类型转换、约束 |
| v8 | `test/saved-searches.test.js` | 表达式存取 |

**迁移测试要用 `openDb(临时目录)` 建隔离库**(项目已有此工厂,`src/db/index.js:135`),在临时库里演练「老库 → 新库」的完整升级,绝不在真实数据上试。

> 注:沙箱内 `node --test` 派生子进程会 `spawn EPERM`,验证改用进程内方式 `node test/xxx.test.js`(`PROJECT_MEMORY.md:100-101` 已记录)。

---

## 6. 在线阅读实现路径

### 6.1 关键前提:两个引擎都免费提供位置坐标

这是本方案最重要的事实 —— **不需要实现 EPUBCFI**:

| 引擎 | 获取位置 | 定位到位置 |
| --- | --- | --- |
| epub.js | `rendition.currentLocation()` → `{start:{cfi,percentage,href,displayed}, end:{...}}` | `rendition.display(cfi)` |
| pdf.js | 当前页 `page` + canvas 内 `offsetY` | `pdf.getPage(n)` + 滚动偏移 |
| epub.js 目录 | `book.loaded.navigation` → TOC 树 | `rendition.display(href)` |
| epub.js 搜索 | `book.search(query)` → 含 `cfi` 的结果 | `rendition.display(cfi)` |
| pdf.js 目录 | `pdf.getOutline()` → 大纲树 | `pdf.getDestination()` |

epub.js 的 `cfi` 就是标准 EPUBCFI 串,直接存进 `read_positions.locator` 即可跨会话复现。**calibre 的 `cfi.pyj`(984 行)解决的是「自己实现渲染引擎」的问题,my-books 用现成库则不必。**

### 6.2 分期路线

```svg
<svg viewBox="0 0 680 560" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif">
  <style>
    .ttl { font-size:14px; font-weight:500; fill:#1d1d1f }
    .ph  { font-size:12px; font-weight:500; fill:#0066cc }
    .n   { font-size:13px; fill:#1d1d1f }
    .c   { font-size:11px; fill:#86868b }
    .box { fill:#f5f5f7; stroke:#d2d2d7; stroke-width:0.5 }
    .hot { fill:#eef5fd; stroke:#0066cc; stroke-width:0.5 }
    .cold { fill:#fafafa; stroke:#c7c7cc; stroke-width:0.5; stroke-dasharray:3 3 }
    .bar { stroke:#c7c7cc; stroke-width:1 }
  </style>

  <text class="ttl" x="40" y="26">阅读器能力分期:投入由小到大,依赖由下到上</text>

  <rect class="cold" x="40" y="44" width="600" height="72" rx="8"/>
  <text class="ph" x="56" y="66">R4 · 后期(重活,复用而非自研)</text>
  <text class="n" x="56" y="86">统一格式管线 · 朗读 TTS · 打印导出 · 位置分享</text>
  <text class="c" x="56" y="104">MOBI/AZW3/CBZ 站内读走 ebook-convert;EPUB→HTML 后即可复用全部阅读能力</text>

  <rect class="box" x="40" y="128" width="600" height="88" rx="8"/>
  <text class="ph" x="56" y="150">R3 · 中期(依赖 R1 的位置模型)</text>
  <text class="n" x="56" y="170">书签 · 高亮 · 批注 · 书内搜索</text>
  <text class="c" x="56" y="188">epub.js 的 rendition.annotations 与 book.search() 直接可用;</text>
  <text class="c" x="56" y="204">数据落 v5 的 annotations 表,离线队列可选</text>

  <rect class="box" x="40" y="228" width="600" height="88" rx="8"/>
  <text class="ph" x="56" y="250">R2 · 短中期(纯前端,零数据风险)</text>
  <text class="n" x="56" y="270">阅读设置面板 · TOC 导航 · 翻页流</text>
  <text class="c" x="56" y="288">epub.js 的 themes.register / themes.fontSize 直接支持字号行距配色;</text>
  <text class="c" x="56" y="304">paged 与 flow 双模式;pdf.js 侧改 canvas scale 与滚动容器</text>

  <rect class="hot" x="40" y="328" width="600" height="88" rx="8"/>
  <text class="ph" x="56" y="350">R1 · 最先做(地基,投入最小)</text>
  <text class="n" x="56" y="370">阅读进度记忆 + 跨会话恢复</text>
  <text class="c" x="56" y="388">epub.js 的 currentLocation().start.cfi 与 percentage;publisher.publish 节流上报;</text>
  <text class="c" x="56" y="404">落 v5 的 read_positions 表 + localStorage 兜底(离线可读)</text>

  <line class="bar" x1="60" y1="416" x2="60" y2="436"/>
  <polygon points="60,440 56,432 64,432" fill="#c7c7cc"/>
  <text class="c" x="74" y="436">每个分期都必须先有 R1 —— 它提供其余全部能力所需的坐标</text>

  <text class="c" x="40" y="472">依赖关系:R2 不依赖数据;R3 与 R4 全部依赖 R1 的位置模型</text>
  <text class="c" x="40" y="492">数据依赖:R1 与 R3 需要 v5 表;R2 与 R4 不碰数据库</text>
  <text class="c" x="40" y="512">建议节奏:一次只上一期,验收后再进下一期(遵循既有渐进增强纪律)</text>
  <text class="c" x="40" y="538">「完全对标」不等于一次做完 —— 分期是为了每步都可验证、可回滚</text>
</svg>
```

### 6.3 R1 阅读进度记忆(最先做)

**为什么最先做**:投入最小(两引擎免费给坐标)、收益立刻可见、且 R3 的注释功能完全依赖它。

实现要点:

1. **采集**:epub.js 监听 `rendition.on('relocated', ...)`,取 `location.start.cfi` 与 `location.start.percentage`;pdf.js 在翻页/滚动后取当前页与偏移。
2. **存储分层**:先写 `localStorage`(即时、离线可用),再节流(如 3 秒)同步到 `read_positions` 表。这样即使服务端不可达,单机阅读体验也不退化。
3. **恢复**:打开书时先尝试服务端位置,失败回退 `localStorage`,再失败从头开始。三者都失败必须静默降级,不能报错阻断阅读。
4. **设备分区**:`device` 由前端生成并持久化(如 `phone` / `desktop`,或 `navigator.userAgent` 简化标识)。换设备时提示「上次在另一设备读到 42%」,而不是强行覆盖。
5. **API**:

```
GET  /api/books/:id/position?format=EPUB&device=desktop   → { locator, pos_frac, epoch } | 404
PUT  /api/books/:id/position                              → 幂等 upsert
       body: { format, device, locator, locator_kind, pos_frac }
```

注意:进度是**高频写入**,但 Nginx 与应用层鉴权对写操作有约束(Non-GET 需 token,见 `middleware.auth.js:122-145`)。两个选择:

- **方案 A(推荐)**:进度上报走**独立路径**且降级为「无 token 可写」——因为它只影响自己的阅读位置,破坏性极低。但需评估:公网可写的接口会被刷。
- **方案 B(更保守)**:阅读器页面携带 token(登录后存 sessionStorage),进度上报正常带 token。

推荐 **B**:复用现有鉴权体系,不新开无鉴权写口。前端 `api()` 封装已有 401 处理流程(`PROGRESS.md:106` 记载 `app.js?v=26` 的 401 流程),直接复用。

### 6.4 R2 阅读设置面板 + TOC 导航

**设置面板**(改 `read.html`,无需后端):

| 设置 | epub.js | pdf.js |
| --- | --- | --- |
| 字号 | `themes.fontSize('18px')` | 缩放系数 |
| 行距 | `themes.override('line-height','1.8')` | 不适用(固定版式) |
| 配色 | `themes.register()` 多套:`day`/`night`/`sepia`/`gray` | canvas 上叠加滤镜或调背景 |
| 页边距 | `themes.override('padding','0 40px')` | 不适用 |
| 最大宽度 | 容器 CSS | canvas `max-width` |
| 单双栏 | epub.js 的 `spread: 'auto'\|'none'`(已有) | 不适用 |

设置持久化在 `localStorage`(不需要上服务端,它是设备级偏好)。calibre 的 `prefs/*` 面板(`session.pyj:38-70` 有默认值)可作布局参考。

**TOC 导航**:epub.js 用 `book.loaded.navigation.toc` 渲染侧栏;pdf.js 用 `getOutline()`。点击跳转分别用 `rendition.display(href)` 与 `pdf.getDestination()`。**epub.js 已内建 TOC 加载能力,只是 `read.html` 没用。**

**翻页流**:epub.js 的 `flow` 参数已有两值(`read.html:142` 用的是 `paginated`)—— 加一个开关切到 `scrolled-doc` 就是连续滚动模式,几乎零成本。

### 6.5 R3 书签 / 高亮 / 批注 + 书内搜索

**注释**:

- epub.js 提供 `rendition.annotations.add(type, cfiRange, {}, cb, className, {color})`,原生支持 `highlight` 与 `underline` 两种渲染;`rendition.on('selected', (cfiRange, contents) => ...)` 捕获用户选中的区间与文本。
- 落库到 v5 的 `annotations` 表。**区间用 `start_locator` + `end_locator` 两列**,书签只填 `start_locator`。
- 书签按「位置去重」(`annot_id` 用位置哈希或 uuid);高亮按 `annot_id` 幂等。
- 注释列表:侧栏按 `chapter` 分组展示,点击 `rendition.display(start_locator)` 跳回。

**书内搜索**:

- epub.js 有 `book.search(query)`,返回结果数组,每项含 `cfi` 与上下文片段 —— 直接渲染成结果列表,点击跳到 `cfi`。
- pdf.js 无内建搜索:需遍历每页 `getTextContent()` 做匹配。**这是 PDF 侧明确的能力洼地**(也是 §6.7 建议对 PDF 换思路的原因之一)。

### 6.6 R4 统一格式管线 + 朗读 + 导出

**统一格式管线**(承接 G2):

```
上传 .mobi / .azw3 / .cbz
   ↓ 上传成功即入队转换
ebook-convert book.mobi book.epub     ← 复用 calibre 的 CLI,不自研
   ↓ 转换产物登记
books.file_format 保持原格式(下载仍下原文件);
  但站内阅读指向转换后的 EPUB
```

设计要点:

- **转换是异步的**。上传接口立即返回,转换在后台队列跑;完成后更新一本书的「可读格式」记录。需要一个新表(如 `book_renditions`)记录 `book + source_format + readable_format + readable_path + status`。
- **不阻塞上传**:80MB 的 PDF 转换可能耗时较久,不能让 HTTP 请求等它。
- **失败要可见**:转换失败写 `status='failed'` 与错误原因,前端提示「暂不支持站内阅读,可下载」——退回当前行为,不产生坏体验。
- **`ebook-convert` 的可用性**:服务器需能调用。若服务器不便安装 calibre,可选「本地转换后上传 EPUB」的半手动路径作为过渡。

> 决策依据:项目方向已明确「复用 calibre 做重活 + 自己做 Web/记录/笔记体验」(`PROJECT_MEMORY.md:13`),且 `PROJECT_MEMORY.md:123` 写明「不自研格式转换」。本方案遵守此约束。

**朗读 TTS**:浏览器原生 `SpeechSynthesis` 即可实现,epub.js 侧可取当前章节文本(calibre 的 Web 版也是用 `SpeechSynthesisUtterance`,`tts.pyj:112`)。零依赖、零成本,可作为差异化小功能。

**导出**:

- 注释导出 Markdown(拼 `chapter` + `text` + `note`)—— 纯前端,数据已在高亮表里。
- 打印/导出 PDF 属浏览器能力(`window.print()` + 打印样式),不必实现 calibre 的 `printing.py`(它依赖 `ebook-convert`)。

### 6.7 关于 PDF:一个需要用户决策的分叉

现状 pdf.js 逐页渲染,版式忠实但**文字不可选中、不可搜索、不可标注**。calibre 走 reflow 成 HTML,换来可选中/可搜索/可标注,代价是丢失原版式。

两条路:

| 路 | 得到 | 失去 | 适用 |
| --- | --- | --- | --- |
| **留在 pdf.js** | 原版式忠实、离线可用 | 无法高亮/批注/全文搜索 | 扫描版、图文混排、杂志、教材 |
| **reflow 成 HTML** | 可搜索/可高亮/可批注、与 EPUB 共用一套能力 | 原版式、图表排版 | 纯文字 PDF、小说、论文 |

**建议:两条都留,按书选择。** 默认用 pdf.js 保版式;对纯文字书提供「重排阅读」开关(经 `ebook-convert` reflow)。这样不为少数场景牺牲多数场景,也不必做非此即彼的架构选择。

---

## 7. 书目管理实现路径

### 7.1 字段搜索语法(最实用的单项升级)

现状只有 `status` / `tag` 两个固定过滤 + FTS 关键词。calibre 的表达式语言(`utils/search_query_parser.py` 483 行)支持 `and/or/not` + 字段前缀 + 匹配种类 + 数值/日期范围。

**建议实现一个子集**,覆盖日常 90% 的查询:

```
status:reading                       状态等于
tag:科幻                             含该标签
author:刘慈欣                        作者匹配
rating:>=4                           数值范围
finish:2026                          日期范围(年)
pub_year:>2020                       出版年范围
series:三体                          系列
q:关键词                             全文检索(走现有 FTS)
status:reading and rating:>=4        组合
not tag:小说                         取反
(status:done or status:reading) and tag:科幻    括号分组
```

落地方案:

- **解析**:在 `src/core/` 新增 `search-query.js`(纯函数,可独立测试)—— 这是核心业务规则,符合「规则进 core」的项目纪律。
- **编译**:解析成 AST 后编译为 SQL `WHERE` 片段 + 参数数组,**绝不拼接用户输入**(沿用 `src/db/search.js:81-83` 的转义纪律)。
- **字段白名单**:只有白名单字段能进 SQL,其余忽略或报错(防止任意列探测)。
- **复用 FTS**:`q:` 项走现有 `search.js`,与结构化条件以 `AND` 组合。
- **保存的搜索**(v8 表):命名常用查询,取代硬编码的 `status` 三态。想读/在读/已读变成三个保存的搜索。

### 7.2 排序与分组

现状是 4 种固定排序白名单(`src/db/books.js:10-15`)。扩展为:

| 能力 | 实现 |
| --- | --- |
| 任意字段排序 | 白名单扩展到新字段(series_index、rating、pub_year、page_count) |
| 多列排序 | `ORDER BY a, b` 组合 |
| 分组浏览 | 按作者/系列/标签/出版社分组,各带计数(对标 calibre 的 `tag_browser_*` 视图) |
| 分组计数 | 一组 SQL:每个实体值 + `COUNT` 关联书数 |

分组视图是实体表规范化的**直接红利**:v6 之后,「按作者分组」是一句 JOIN + GROUP BY;v6 之前只能用字符串切分勉强模拟。

### 7.3 元数据多源抓取

现状:豆瓣单源(`src/core/douban.js`),Cookie + 随机延迟反爬。

**建议的扩展顺序**(按收益):

1. **补回被丢弃的字段**。上游插件 `NewDouban/__init__.py:176-177` 解析了「丛书」,而移植的 `src/core/douban.js` 丢了这一项 —— 与 v6 的 `series` 表正好接上。
2. **加候选源**。ISBN 场景加 Google Books API(有免费配额、无需反爬)。
3. **字段级合并**(calibre 做法值得抄)。calibre 的 `ISBNMerge.merge()`(`sources/identify.py:261-343`)逐字段定策略:标题取最短、作者取最长、评分取平均、出版日期取最早、标识符取并集。my-books 可简化为「已有值默认不覆盖,只填空缺」+ 用户可选择覆盖。
4. **写回**(可选):calibre 能把元数据写回电子书文件(`db/cache.py:3657 embed_metadata`)。**本方案不做** —— 改用户文件的风险与收益不成比例。

### 7.4 完整性校验扩展

`data-check.js`(86 行)已有 JSON 解析、日期格式、逻辑一致性检查。扩展项:

| 新增检查 | 目的 |
| --- | --- |
| **投影一致性**(v6 双写期关键) | 比对 `books.author` 与 `authors` JOIN 结果是否一致 |
| **文件悬浮检查** | `books.file_path` 指向的文件是否存在;`books-files/` 里是否有孤儿文件 |
| **封面悬浮检查** | `books.cover` 指向的 `uploads/` 文件是否存在 |
| **标识符重复** | 同一 `isbn` 出现在多本书(可能的重复录入) |
| **注释孤儿** | `annotations.book` 是否有对应书籍(靠 FK 应已保证,做防御性检查) |

对标 calibre 的 `check_library.py`:它的 CHECKS 列表(`check_library.py:34-47`)包含 missing/extra formats、missing/extra covers、invalid paths 等 —— 思路直接可抄。

### 7.5 前端展示补齐(半小时的事,但别忘)

`app.js:485-508` 的详情弹窗只渲染 title/author/status/dates/tags/summary,而 `publisher`/`pub_year`/`isbn`/`rating` 存进库后**任何界面都不再出现**。抓取与存储都做完了,只差渲染。

建议详情页补:

- 出版信息行:`出版社 · 出版年`
- 评分:星级显示
- ISBN:`identifiers` 表取值
- 系列与序号(若 v6 落地)
- 编辑表单里的隐藏字段改为可见(或折叠的「更多信息」区)

**这是全部方案里投入产出比最高的一项。**

---

## 8. 分期总表

| 期 | 内容 | 依赖 | 数据风险 | 预估 |
| --- | --- | --- | --- | --- |
| **P0** | 详情页补豆瓣字段;`books-files/` 加入 gitignore;修 Nginx 上传上限 | 无 | 无 | 半天 |
| **P1** | 阅读进度记忆(localStorage + v5 表) | v5 | 无(纯增量表) | 1~2 天 |
| **P2** | 阅读设置面板 + TOC + 翻页流 | 无 | 无(纯前端) | 1~2 天 |
| **P3** | 书签 / 高亮 / 批注(落 v5) | P1 | 无 | 2~3 天 |
| **P4** | 书内搜索 | P1、P3 | 无 | 1 天 |
| **P5** | 字段搜索语法 + 保存的搜索(v8) | v8 | 无(纯增量表) | 2 天 |
| **P6** | 实体表规范化(v6,双写 + 校验) | — | **中**(需搬迁,但可回滚) | 3~4 天 |
| **P7** | 排序分组扩展 + 分组计数 | P6 | 无 | 1~2 天 |
| **P8** | 自定义字段(v7) | P6 | 无 | 2 天 |
| **P9** | 统一格式管线(ebook-convert) | 基础设施 | 无 | 2~3 天 |
| **P10** | 朗读 TTS + 注释导出 | P3 | 无 | 1 天 |
| **P11** | 清理遗留列(v9,删列) | P6~P8 稳定 | **高**(不可逆) | 半天 |

**排序理由**:P0~P5 全部零或低风险且互相独立,先把可摘的果子摘完;P6 是唯一有数据搬迁的一步,放在前面几期已建立信心、且 `data-check.js` 双写校验工具就绪之后;P9 依赖外部工具可用性,放最后。

---

## 9. 必须修的既有问题

这几项是写方案过程中发现的真实缺陷,**与对标无关但必须一并修**,否则对标成果会被它们抵消。

### 9.1 `books-files/` 没有被 git 忽略(高风险)

**实测证据**:

```
$ git status --porcelain --ignored -- books-files/
?? books-files/                    ← "??" 表示未跟踪,会被提交
$ git ls-files --others --exclude-standard -- books-files/
books-files/__probe.epub           ← 会被纳入版本控制
$ git add --dry-run books-files/__probe-test.epub
add 'books-files/__probe-test.epub'   ← 确认可暂存
```

`.gitignore` 第 12 行只有 `uploads/`,**没有 `books-files/`**。

> 排查记录:`git check-ignore -v books-files/`(带尾斜杠)曾报「`.gitignore:53`」,但第 53 行实际是空行,且不带尾斜杠时报 NOT IGNORED。以 `git status --ignored` 与 `git add --dry-run` 的**实证结果**为准 —— 即**未被忽略**。

**后果**:一旦上传电子书并执行 `git add -A`,几十 MB 的书籍文件会进入公开仓库(`README.md` 记载仓库是 GitHub 公开库)。这既是隐私问题也是仓库体积问题。

**修复**:`.gitignore` 增加 `books-files/`。**这一项应立即修,优先于所有对标工作。**

### 9.2 Nginx 上传上限与 80MB 应用上限冲突

- 应用层:`core/ebook.js:12` 定义 `EBOOK_MAX_SIZE = 80MB`,`routes.files.js:34` 的 multer 也设 80MB
- 网关层:`deploy/nginx-helloac.top.conf:65` 是 `client_max_body_size 10m`
- `README.md:272` 明确记录该值

**后果**:超过 10MB 的电子书会被 Nginx 以 **413** 拒绝,根本到不了应用层。`core/ebook.js:7` 的注释「Nginx client_max_body_size 需同步调大」说明作者意识到了,但配置从未同步。

**修复**:按需调大网关上限(如 `client_max_body_size 100m`),或在文档/UI 里把上限诚实地标为 10MB。**两者选一,不能维持「声称 80MB、实际 10MB」的状态**。

### 9.3 电子书文件完全不在备份范围内

- `deploy/update.sh:18-43` 只备份 `data/books.db`
- 线上 cron(`README.md:770`)打包 `data uploads` —— **不含 `books-files/`**

**后果**:服务器硬盘故障时,书籍文件全部丢失且无备份。数据库里只剩下 `file_path` 指向不存在的文件。

**修复**:`update.sh` 与 cron 都把 `books-files/` 纳入。注意 80MB×N 的体积 —— 可考虑增量同步或对象存储,而非每日全量 tar。

### 9.4 详情页不展示已抓取的元数据

见 §7.5。属于遗漏接线,非设计缺陷。

---

## 10. 安全与运维清单(对标新增面)

新能力带来新攻击面,逐项对照处理:

| 新增面 | 风险 | 对策 |
| --- | --- | --- |
| 进度上报接口 | 公网可写刷数据 | 复用现有 token 鉴权(§6.3 方案 B);按 `book+format+device` 唯一键 upsert,天然幂等 |
| 注释接口 | 同上;XSS(批注文本回显) | 鉴权;回显经 `esc()`;注释全文存库不做 HTML 渲染 |
| 注释 FTS | 与 `books_fts` 相同的同步纪律 | 沿用 `src/db/books.js:55-72` 的先取旧行再更新的正确做法 |
| 搜索表达式解析 | **SQL 注入**(拼接 WHERE) | AST 编译为参数化 SQL;字段白名单;绝不字符串拼接 |
| `ebook-convert` 调用 | **命令注入**(文件名/路径) | 不经 shell;用 `execFile` 传参数数组;输入文件名是系统生成名(`core/ebook.js:38-41`),不接受用户文件名 |
| 格式转换 | 恶意文件导致转换器崩溃 | 转换超时 + 资源限制;失败只影响单本书 |
| 电子书文件下载 | 未鉴权读取 | 当前 `/books-files` 是 `express.static` 无鉴权 —— **需评估**:书籍内容若敏感应加鉴权(这会影响在线阅读的体验,需权衡) |
| 抓取外部元数据 | SSRF | 沿用现有 `routes.proxy.js` 的黑白名单纪律 |
| 元数据写回文件 | 损坏用户文件 | **本方案不做此功能**(§7.3) |

**特别提示**:`/books-files` 现在是公开静态目录(`server.js:34`)。当前只有封面是敏感的,而封面在 `/uploads` 同样公开。**加入电子书全文后,若书本身不宜公开,必须给 `/books-files` 加鉴权**。这与「在线阅读要方便」冲突,建议:阅读走带 token 的接口(或签名 URL),下载同样。这是一个需要用户明确决策的点。

---

## 11. 验收标准

每期完成的定义(遵循项目「每步验证」纪律):

| 期 | 验收标准 |
| --- | --- |
| P0 | `git status` 不再列出 `books-files/`;详情页可见出版社/出版年/评分;上传 >10MB 文件按选定方案行为一致 |
| P1 | 关闭浏览器重开,EPUB 与 PDF 均回到上次位置;两台设备位置互不覆盖;断网时 `localStorage` 兜底仍生效 |
| P2 | 字号/行距/配色/边距调整后刷新保持;TOC 点击正确跳章;分页与滚动模式可切换 |
| P3 | 新增书签/高亮/批注后刷新仍在;区间高亮位置准确(换字号后不错位);删除书籍级联删除注释 |
| P4 | EPUB 内搜索命中并跳转;结果片段上下文正确 |
| P5 | `status:reading and rating:>=4` 等组合查询返回正确;保存的搜索可命名复用;注入尝试失败且不报错 |
| P6 | 迁移后 `data-check.js` 投影一致性通过;旧 API 返回形状与迁移前逐字节相同;删新表可完整回退 |
| P7 | 按作者分组计数正确;多列排序稳定 |
| P8 | 新建自定义字段后可在表单填写、列表展示、参与搜索 |
| P9 | MOBI/AZW3 上传后可站内阅读;转换失败时退回「仅下载」且提示明确 |
| P10 | 朗读可跟随滚动;注释导出 Markdown 格式正确 |
| P11 | 删列后全部测试通过;备份可读 |

**通用验收**:每期结束时 `npm test` 全绿 + `node data-check.js` 通过 + 本地启动烟测通过。

---

## 12. 明确不做的清单

「完全对标」的边界。(用户已确认排除平台化设施;以下进一步给出理由,避免范围蔓延。)

| 不做 | 理由 |
| --- | --- |
| **OPDS 目录服务** | 多端订阅协议,本项目只有一个网页前端 |
| **多用户与权限体系** | 单用户自用;已有 token 鉴权足够 |
| **插件框架** | 元数据源固定几个,直接写代码比建框架简单 |
| **30+ 格式元数据内嵌读写**(`set_metadata`) | 会改写用户的电子书文件,风险高收益低 |
| **C 扩展 / 自定义 SQLite 函数** | calibre 用 C++ 注册 `title_sort`/`concat` 等(`sqlite_extension.cpp`);已核实 `node:sqlite` 支持 `db.function()`(`DatabaseSync.prototype.function` 存在),需要时用 JS 实现即可,**无需 C 扩展** |
| **复合字段公式**(composite columns) | calibre 的模板引擎(`utils/formatter.py`)是整个项目最复杂部分之一;个人站用不上 |
| **整库内存缓存**(`cache.py` 178KB) | 几十本书不需要 |
| **出版社 / 评分规范化** | 二者「改名」需求几乎不存在;保留为列,避免无收益的表拆分 |
| **联网查词 / 引用生成** | calibre 的 `lookup.py`(22KB)与 `referencing.pyj`;学术场景才需要 |
| **RSVP 速读** | calibre 自己都没有(全库无 RSVP 实现),无需对标 |
| **`link` 列(实体表的外部链接)** | calibre 给 authors/tags/series 都加了 `link` 列;本项目暂无此需求,但实体表预留该列以便将来加 |

---

## 13. 关键风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| **v6 搬迁破坏数据** | 高 | 双写过渡 + 投影一致性校验 + 删列前备份;迁移测试在 `openDb(临时目录)` 演练 |
| **v9 删列不可逆** | 高 | 放在最后;前置条件三条齐全才执行(§5.4) |
| **PDF 注释能力受限于 pdf.js** | 中 | 承认洼地;提供 reflow 选项(§6.7)而非硬做 |
| **`ebook-convert` 服务器不可用** | 中 | 半手动路径过渡(本地转换上传);转换失败退回下载 |
| **80MB 文件占满磁盘** | 中 | 上限收紧 + 备份策略改为增量;监控 `books-files/` 体积 |
| **进度/注释高频写入拖慢 SQLite** | 低 | 前端节流(3s)+ 索引;单用户写入量可控 |
| **`/books-files` 公开** | 中 | 需用户决策(§10);若敏感则加鉴权 |
| **方案过大导致半途而废** | 高 | 严格分期,P0~P2 先落地见效;每期独立可上线 |

---

## 14. 下一步

**建议立刻做 P0**(半天,零风险,收益立见):

1. `.gitignore` 加 `books-files/`(§9.1,风险最高的一项)
2. 详情页补出版社/出版年/评分/ISBN(§7.5)
3. Nginx 上传上限与 80MB 对齐或改文档(§9.2)

然后按 P1(进度记忆)→ P2(设置面板)推进,每期验收后进入下一期。

> 本方案的分期设计原则:**任何一期中断都不留下半成品状态**。P0 是最小可交付,P1 起每期都自带完整的数据与回滚保障。

