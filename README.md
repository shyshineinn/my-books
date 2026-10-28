# 📚 My books · 图书记录网站

> 新的自部署与账号登录说明见 [自部署指南](docs/SELF_HOSTING.md)。默认私有访问；升级前请阅读权限变化说明。

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
  - [后端架构(core--db--http-三层)](#后端架构coredbhttp-三层)
  - [测试](#测试)
  - [数据模型](#数据模型)
  - [前端架构(public)](#前端架构public)
  - [关键实现细节](#关键实现细节)
  - [历史决策记录](#历史决策记录)
  - [安全设计](#安全设计)
- [目录结构](#目录结构)
- [API 一览](#api-一览)
- [数据与备份](#数据与备份)
- [部署与运维](#部署与运维)(含九阶段上线手册 / 回滚 / 线上运维)

---

## 功能总览

### 页面与视图

多页应用(MPA),每个视图是独立页面,顶部导航用 `<a href>` 真实跳转:

| 页面 | URL | 内容 |
| --- | --- | --- |
| **首页** | `/` | Apple 官网式排版:Hero 标语 → 「最新上架」特色卡 → 双列书格(4 本)→ 「Endless entertainment.」双排无限轮播(复刻 apple.com media-gallery:自动播放、进度条圆点、拖拽/甩动、键盘方向键) |
| **书架** | `/shelf` | 纯封面卡片网格,**页内不放任何按钮与下拉框**;筛选与排序全由 URL 查询串 `?q=&status=&tag=&author=&vl=&sort=` 驱动(可分享/回退),虚拟书库靠地址栏或顶栏搜索面板切换;长按卡片(手机)或 Ctrl/⌘+点击(电脑)进入多选,底部浮出操作条可批量编辑状态/标签/系列/出版/评分 |
| **榜单** | `/rank` | 英雄区(总藏书 / 读完数)+ **重读榜**(读过两次以上的书,按次数排序,至多 8 本) |
| **统计** | `/stats` | 阅读印象 Hero(总藏书 / 已读及占比 / 在读 / 想读)+ 每年读完柱状图 + 标签分布(点击标签跳 `/shelf?tag=…` 筛选) |
| **分类** | `/tags` | 标签 / 作者的双列管理(重命名 / 合并 / 删除,均同步全部书籍)+ **自定义字段**管理(新建 / 编辑 / 软删除后恢复 / 彻底删除)+ **回收站**、**重复书籍**扫描与合并、**CSV 导出**入口 |
| **读书心得** | `/notes/:id` | 独立页面,渲染单本书的 Markdown 心得 |

> 旧单页深链 `#/notes/<id>`、`#/rank` 由 `chrome.js` 的 `legacyHashRedirect` 用 `location.replace` 兼容跳转到新页面,老书签/分享链接照常可用。

### 记录字段与阅读记录

- **字段**:书名(必填)、作者、状态(想读 / 在读 / 已读)、图书简介(≤1000 字)、分类标签、封面、豆瓣元数据(出版社 / 出版年 / ISBN / 评分 / 条目 id)
- **自定义字段**(2026-10-15 新增,对标 calibre 的自定义列):在 `/tags` 页可自行增删字段,
  **不必改代码、不必发版**。支持 9 种类型:单行文本(可多值)、长文本、整数、小数、评分(0~10)、
  日期、是/否、枚举(受控选项)、系列。建好后出现在书籍编辑弹窗里,并可用 `#字段名:值` 参与检索。
  删除是**软删除**(字段定义与已填取值都保留,可随时恢复),只有显式「彻底删除」才连值一起清掉。
- **阅读记录**:每次阅读的起止日期列表,是日期类字段的**唯一数据源** ——
  - 「读完日期」= 记录中最晚的读完日;「开始日期」= 最近一次的开读日
  - 「读过次数」= 记录中已有读完日期的条数
  - 前端状态联动:切「已读」自动补最近一次记录的读完日期;切「在读」自动新增一条今天开读的记录
- 兼容旧数据:没有阅读记录但有起止日期的书,编辑时自动迁移为一条记录

### 读书心得(服务器存储)

- 心得正文存在**服务器本地** `notes-files/{id}.md`,与书籍一一对应
- 接口:`GET /api/books/:id/notes`(读,公开)、`PUT /api/books/:id/notes`(写,需口令)、
  `DELETE /api/books/:id/notes`(删,需口令)
- 页面内可直接编辑并保存;写请求带 `expected_updated_at`,服务器上已被别处改过则回 409
  (前端提示"是否用当前内容覆盖"),避免两处编辑互相吞掉对方的修改
- 渲染前经 **DOMPurify** 消毒;随书删除时心得文件一并清理

### 封面

- 三种来源:粘贴图片链接 / 上传本地图片(png、jpg、gif、webp,≤5MB,base64 上传)/ 无封面时自动生成渐变占位封面
- 占位封面按书名哈希从 6 组 Apple 产品配色(午夜色、星光色、远峰蓝、银色、原野绿、深空灰)中确定性选色
- 首页大卡与小卡会用 Canvas 提取封面主色,为卡片生成同源渐变背景与深浅自适应文字

### 搜索 / 筛选 / 排序

- 按书名 / 作者模糊搜索(300ms 防抖;**发起检索会清空状态与标签筛选**,即全库检索)
- 按状态页签、标签、作者筛选;按最近更新 / 读完日期 / 书名 / 作者 / **系列** / 添加时间排序
- **高级搜索语法**:`tag:科幻 author:刘慈欣 status:done rating>=9 三体`,支持 `and` / `or` / `not` / 前导 `-`(否定)、值加引号含空格;页面内「语法?」按钮有完整说明
- **布尔优先级与括号**:`and` **优先于** `or`(`a or b and c` ≡ `a or (b and c)`),
  括号可改变优先级:`(tag:科幻 or tag:小说) and status:done`;
  `not ( ... )` 可否定一整组(与 `not a and not b` 语义不同)
- **三种匹配强度**(写在值开头):`=` 精确相等、`~` 正则、`^` 字符变体(忽略大小写与变音符号)
- **字段有无**:`cover:true` / `series:false` / `format:false`;也接受「是」「否」
- **加入日期**:`date:today` / `date:>10daysago` / `date:<=2026-01-01`(支持 `yesterday`、`thismonth`)
- **大小**:`size:>1M`(K / M / G,不写按字节)
- **多值计数**:`tags:#>4`(标签多于 4 个)、`authors:#=2`
- **系列检索**:`series:地球往事`(精确)、`series_index:>=2`(序号比较)
- **标识符检索**:`identifier:goodreads:5907`;只写类型表示「有该类标识符」
- **自定义字段检索**:`#字段名:值`,如 `#页数:>=300`
- **虚拟书库检索**:`vl:已读科幻`,把另一条保存搜索的结果当条件用(名字含空格要加引号:`vl:"我的 书库"`);
  可 `not vl:` 取补集,也可被别的虚拟书库嵌套引用(循环引用直接报错而不是栈溢出)
- 排序与筛选都在 SQL 层完成;标签 / 作者走归一化链接表的 `EXISTS` 精确匹配

> **正则的边界**:`~` 只近似翻译 `^` `$` `.*` `.` `+` `?`(转成 LIKE)。
> 分组 `( )`、选择 `|`、字符类 `[ ]` 在零依赖前提下无法下推到 SQLite,
> 会**降级为「取第一个分支做子串」**而不是报错。要表达「或」请用布尔的 `or`。

### 系列与标识符

**系列(series + series_index)**:一本书可归属一个系列并带序号。

- 序号支持小数(中篇插队:`2.5`);`0` 表示未指定序号
- 输入时可以写「基地 [3]」一次带出序号(服务端拆分),也可以分别填两个框
- `GET /api/series` 给出系列列表(带计数与序号范围),编辑框里作为输入建议
- 排序选「系列」时按 `系列名 + 序号`,未入系列的书排在最后

**标识符(identifiers)**:`isbn` 与 `douban_id` 走专用输入框,其余类型任意添加。

- 常见类型(goodreads / doi / amazon / openlibrary / google / issn / url)在详情页**自动生成外链**
- 每种类型每本书一个值;清空该值即删除该标识符
- `GET /api/identifiers/duplicates` 可查「同类型同值被多本书占用」(合订本 / 再版排查)

### 按 ISBN 添加(扫码 / 批量)

ISBN 是书的「身份证」:扫码或手输条码数字即可精确取元数据,比书名匹配准得多。

- **扫码**:编辑弹窗里「扫码」按钮直接调起摄像头,识别封底 EAN-13 条形码;解码库
  (`public/vendor/html5-qrcode.min.js`,约 375KB)**首次扫码才懒加载**,不上传图像、不依赖外部 CDN。
  需 HTTPS 或 localhost(浏览器摄像头权限的硬要求),iOS Safari / 微信内浏览器可用;
  无权限 / 无摄像头时给出明确指引,退路是手输
- **精确回填**:填好 ISBN 点「✨ 从豆瓣填充元数据」会按 ISBN 直查(豆瓣的 `/isbn/` 短链,
  比书名搜索准);豆瓣没收录的外版书自动回退 **Open Library**(免费开放 API,无需 key);
  两源都未命中时保留 ISBN、提示手动填写
- **批量添加**:弹窗里「按 ISBN 批量添加」,一次粘贴多行 ISBN(换行 / 逗号 / 分号分隔,单次 ≤50 条),
  可顺带打标签;逐条给出结果 —— **已添加 / 已存在(可点开查看)/ 无效 / 未找到 / 豆瓣拒绝**,
  「未找到」的可一键「手动录入」(跳到编辑弹窗,ISBN 已预填)
- **查重**:录入前先按 ISBN 查库(编辑现有书时排除自身);批量导入默认勾选「跳过书库中已有的
  ISBN」,不会重复建档;另有「ISBN-10 统一转 13 位」开关(两副面孔归到同一个查重键)

> 对标 calibre 的 *Add books → Add from ISBN*(多行列表、逐条结果、查重、ISBN-10→13 同款);
> calibre 自身没有扫码功能,扫码是网页端新增的路径。

### 电子书文件(只存不读)

上传的电子书文件**仅作存储与下载**,站内在线阅读已于 2026-10-14 下线(见[历史](#历史决策记录))。

- 一本书可挂**多个格式**(EPUB / PDF / MOBI / AZW3 / TXT),同一格式只保留一份,重复上传即替换
- 单文件上限 80MB;存储用「先写临时名再原子改名」,被替换的旧文件在登记成功后删除
- 下载走 `/books-files/`,由详情弹窗的下载链接提供(`download` 属性带书名)

### 回收站(软删除)

删除书籍默认**移入回收站**,而不是立刻抹掉数据:

- 删除后 14 天内可恢复(保留期与 calibre 默认一致);`/tags` 页的「回收站」区可恢复或彻底删除
- 删除后的书**不参与**列表、搜索、统计、标签/作者计数、系列列表与 ISBN 查重;重新添加同一 ISBN 不会被它挡住
- 恢复只需清掉墓碑标记,标签链接、作者链接、自定义字段值、阅读记录、标识符与 FTS 索引都原样保留
- **彻底删除**才清理磁盘上的封面与电子书文件,并清掉失去全部引用的标签/作者
- 恢复时若 ISBN 已被其他在架书占用 → `409 CONFLICT`,提示冲突书名;先处理冲突再恢复
- 过期清理在服务启动时与每 6 小时执行一次;`data-check.js` 会同时检查回收站条目的时间戳

> 实现取舍:calibre 把书目录移到 `.trash` 再从 OPF 重建行;本项目元数据真源是规范化
> SQLite,搬目录会丢关联数据,所以用 `books.deleted_at` 墓碑 + 查询层过滤。生命周期与
> 交互(14 天、恢复、彻底删除)与 calibre 对齐。

### 数据导出(CSV)

`/tags` 页底部有「导出 CSV」入口,也可以直接请求 `GET /api/export.csv`:

- 查询参数与 `/api/books` 完全一致(`q` / `status` / `tag` / `author` / `vl` / `sort`),所以可以只导出当前筛选,
  例如 `/api/export.csv?status=done&tag=科幻`
- 固定列包含:书名/排序键、作者/排序键、状态(原值 + 中文标签)、标签、系列与序号、评分、出版信息、
  ISBN/豆瓣 ID、阅读日期与 `read_logs`、简介、封面、uuid、电子书格式、全部标识符、创建/更新时间
- 每个**自定义字段**自动追加一列,列名为 `#label`;回收站中的书**不导出**
- 文件为 **UTF-8 BOM + CRLF**,Excel / WPS 打开中文不乱码;字段按 RFC 4180 转义,
  以 `= + - @` 开头的单元格会加单引号前缀,避免 CSV 公式注入
- 对标 calibre 的 *Catalog → CSV*(`library/catalogs/csv_xml.py`),但保留本项目的阅读记录、
  uuid 与自定义字段,便于后续迁移/备份

### 数据导入(CSV)

导出的另一半。`/tags` 页「数据导入 / 导出」区选文件,或直接 `POST /api/import.csv`。

- **两步走**:选文件后先**预览**(服务端跑完校验与查重但**一行不写**),确认无误再真导。
  导入是不可逆的批量写,不能在写完之后才发现列名打错
- **表头宽松识别**:首行是表头,至少要有一列 `title` / `书名`。中英别名都认
  (`作者`/`author`、`评分`/`rating`…);`#label` 列自动当自定义字段;
  服务端派生列(`id`/`uuid`/`title_sort`/`created_at`/`file_formats`)直接跳过;未知列静默忽略
- **重复时**(对标 calibre 的 `duplicate_action`):
  - `总是新建` —— 不查重
  - `跳过已有的`(默认)—— 命中就跳过,报告里注明是第几行的哪本书
  - `合并进已有记录` —— 把字段并进已有书,可再选合并方式
- **合并方式**(对标 calibre 的 `automerge_action`):`只补空字段`(默认)/ `覆盖已有` / `另建一条`
- **查重依据**(对标 calibre `find_identical_books`):先看 **ISBN 归一化后是否相同**(最强),
  再看**书名规范化后相同且作者能对上**。书名规范化会忽略大小写、中英文标点、冠词与分隔符
  (`《三体》` ≡ `三体`,`三体:地球往事` ≡ `三体 地球往事`)
- 一次最多 500 行、10MB;逐行返回结果(新建 / 合并 / 跳过 / 无效 / 出错),不影响其它行
- **实现取舍**:calibre 是拿来导入 OPF 与书籍文件的,本项目只导元数据 ——
  所以它的 `add_formats_to_existing` 在这里收窄成「把字段并进已有记录」
  (CSV 里没有电子书正文,没有格式可并入)。名字保留是为了与 calibre 的语义对得上

### 批量编辑

书架页没有任何控件,多选靠手势进入:**手机长按卡片(约半秒),电脑 Ctrl / ⌘ + 点击卡片**。
进入后点卡片继续勾选,底部浮出操作条显示已选数量,「批量编辑」可一次修改:
(退出按 `Esc`,或点操作条上的「取消」;`Esc` 与操作条只在多选期间出现)

- **状态**:与单本编辑相同的阅读记录联动 —— 切「已读」补读完日、切「在读」补开读日
- **标签**:添加 / 移除(只增删,不清空其它标签;同一标签不能同时增删)
- **系列 / 系列序号 / 出版社 / 出版年 / 评分**(评分 0 = 清空评分)
- **留空 = 不修改**,避免批量误清;所有书在**一个事务**内更新,任一 id 不存在或已在回收站则整体拒绝
- API:`POST /api/books/bulk`,体 `{ ids: [...], patch: {...} }`;一次最多 500 本

> 对标 calibre 的 *Edit metadata in bulk*。当前覆盖常用字段;自定义字段的批量填写暂未纳入。

### 虚拟书库

虚拟书库 = **一条被标记为「书库」的保存搜索**,选中它相当于把整个视图收进这个条件里
(对标 calibre 的 *Virtual library* 与 `vl:` 检索字段)。

- **设为书库**:顶栏搜索面板 → 「保存的搜索」→ 点「编辑」→ 按 `▣` 切换;被标记的行会挂上「书库」字样
- **切换 / 退出**:在同一个面板里点它的名字,书架即收进该书库;再点「全部书籍」或清空地址栏即退出。
  作用域的唯一真源是地址栏 `?vl=名字`,所以刷新、回退、分享链接都保持同一个书库视图
- **收窄范围**:书籍列表、全文检索、标签 / 作者计数、系列列表、统计、重复扫描、CSV 导出**一起**收进去;
  书库外的标签与作者直接不出现(而不是显示成 0),与 calibre 虚拟书库的观感一致
- **统计口径跟着走**:`/api/stats` 接受同一份作用域,书架上编辑弹窗的**标签建议**只给书库里的标签;
  `/stats` 页本身不带书库条件(它统计的是全架)
- **可嵌套**:书库的查询里还能写 `vl:另一个书库`;超过 10 层或出现循环引用会明确报错
- **失效自愈**:地址栏里的书库被改名 / 删除 / 取消标记后,书架自动退回全部书籍并给一条提示,不会卡在错误页

> 书架页不放下拉框,所以「切换书库」这件事只发生在搜索面板与地址栏两处 —— 少一个控件,
> 也少一处会和地址栏不同步的状态。

### 重复书籍与合并

`/tags` 页「重复书籍」区自动扫描疑似重复:

- **检测证据**:ISBN 归一化后相同;书名规范化后相同(忽略大小写/标点/空白/英文冠词);
  或书名与作者同时高度相似(处理错字/副标题差异);同书名不同作者不会误合并
- **合并**:每组选择一本目标书,点「合并其余 N 本到所选」
  - 标签取并集、阅读记录合并去重、状态取 `done > reading > wish`
  - 目标为空的字段用来源补(封面/简介/出版社/出版年/评分/系列),目标已有值优先
  - 来源独有的电子书格式迁到目标;自定义字段、标识符一并合并(冲突时目标优先)
  - **来源记录永久删除**(不进回收站);磁盘资产在事务提交后清理
- API:`GET /api/books/duplicates`(只读扫描)、`POST /api/books/merge`(`{ targetId, sourceIds }`)

> 对标 calibre 的 *Merge book records*。合并不可恢复,操作前有二次确认。

### 批量补全元数据与封面

书架多选后点底部操作条的「补全元数据」,一次把简介、出版社、出版年、评分、系列、封面补齐。

- **取数顺序**:有 ISBN → 按 ISBN 直查(豆瓣 → Open Library 兜底,最准);
  无 ISBN 有书名 → 豆瓣搜索(**标题精确比对 + 作者佐证**,不张冠李戴);两者都无 → 跳过
- **默认只补空** —— 你手写的简介、自选的封面不会被冲掉;要覆盖得显式打开
- **书名与作者永远不改** —— 那是书的身份,批量操作里动它等于换了本书
- **标签只追加** —— 取并集,永不删你已有的标签
- **封面落盘**:外链封面会失效或被防盗链拦,补全时顺手存进 `uploads/`,
  失败才退回用外链 URL(封面只是锦上添花,不影响其它字段)
- 一次最多 100 本;逐条结果里区分「补全 / 无可补 / 未找到 / 豆瓣拒绝 / 缺 ISBN / 出错」

> 对标 calibre 的 *Edit metadata → Download metadata and covers*。
> 注意它与「按 ISBN 批量添加」是两件事:那边是库里**没有**这本书、靠 ISBN 建档;
> 这边是库里**已有**、给它补字段。

### 移动端与无障碍

- 手机两列卡片 + 底部抽屉弹窗 + 全屏菜单(apple.com 风);平板 / 电脑最多六列自适应
- 顶栏搜索是移动端一级入口(点图标展开整行搜索栏);左边缘右滑返回(≤819px)
- 弹窗 / 轮播 / 下拉均带 aria 标注与键盘操作;轮播尊重 `prefers-reduced-motion`
- 首次启动自动写入 **17 本**示例书(见 `src/db/seed-data.js`),可像普通书一样编辑或删除

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

---

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 22.5 | 用内置 `node:sqlite`(`DatabaseSync`),零外部数据库 |
| 后端 | Express 4 | 分层结构(core / db / http),`server.js` 薄入口,REST API + 静态资源 + 两个代理接口 |
| 数据库 | SQLite 单文件 | `data/books.db`,启动时自动建表与迁移 |
| 前端 | 原生 HTML / CSS / JS | **无框架、无构建、无打包器**,直接静态文件 + 事件委托 |
| Markdown | marked(UMD)+ DOMPurify | 经 `/vendor/*` 端点直接从 `node_modules` 回包,绕开构建步骤 |
| 扫码 | html5-qrcode 2.3.8(UMD) | 静态入库在 `public/vendor/`,首次扫码才懒加载;纯前端解码条形码(EAN-13)|
| 测试 | Node 内置 test runner | `npm test`,零新增依赖 |
| 托管 | PM2(主)/ systemd(备) | 单进程 fork 模式 |
| 反代 | Nginx | TLS 终结、gzip、安全头、写接口 Basic 口令、静态长缓存 |

---

## 系统架构

### 总体架构

```
        浏览器(MPA:原生 JS,无构建;public/ 静态文件)
            │  fetch /api/*(JSON)          fetch /api/img-proxy
            ▼                                        │
   ┌─────────────────────┐   301 跳 HTTPS             ▼
   │  Nginx 443(TLS 终结 │  ← 80 端口只留 ACME 路径   │
   │  gzip / 安全响应头    │                    回源外网(图床)
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
  `mergeUpdate()` 实现 PUT 局部更新语义(未提供的字段保留数据库旧值);`splitAuthors()` 拆多作者
- `sort_keys.js`:排序键 —— `titleSort()`(剥引号 + 英语冠词移位,对标 calibre `title_sort`);
  `authorToAuthorSort()`(姓名倒装「Smith, John」,对标 `author_to_author_sort`)
- `series.js`:系列规则 —— `系列名 [序号]` 输入解析(对标 `_get_series_values`)、序号规范与
  `nextSeriesIndex()` 自动递增(对标 `series_index_auto_increment` 的 first_free 策略)
- `identifiers.js`:标识符规则 —— 类型归一(对标 `clean_identifier`)、已知类型的外链构造、展示列表
- `custom_fields.js`:自定义字段规则 —— `parseColumnDef()` 校验定义(label 正则 + datatype 白名单 +
  多值收窄 + 枚举选项)、`normalizeValue()` 按 9 种类型规范化取值、`displayValue()` 生成展示文本
- `query.js`:高级搜索语法解析 —— 递归下降解析器(`expr/term/unary` 三层),
  括号与 `and` 优先于 `or` 的优先级、`not ( ... )` 否定整组、
  值前缀 `=`/`~`/`^` 三种匹配强度、`#自定义字段` 与中文别名
- `douban.js`:豆瓣搜索页与详情页解析(纯函数)+ 到 `books` 字段的映射
- `isbn.js`:ISBN 校验 / 归一化(对标 calibre `check_isbn` / `normalize_isbn`)—— 校验位算法、
  分隔符容错、全同数字拒绝、ISBN-10→13、`isbnKey` 查重键;`isbn_import.js`:「按 ISBN 批量添加」编排
  (校验 → 查重 → 抓元数据 → 建档,逐条 created / duplicate / invalid / not_found / blocked / error)
- `openlibrary.js`:Open Library 解析(edition / work / author 三跳 → `books` 字段映射),豆瓣未收录时兜底
- `ebook.js`:电子书格式 / 大小 / 存储名规则;`fs-utils.js`:原子写 + 受边界约束的删除;`paths.js`:目录常量
- `stats.js`:`computeStats()` 统计聚合(状态分组 / 按年读完 / 标签 Top12)

**`src/db/` 数据访问(只 import node: 内置模块与 core)**

- `index.js`:打开 `data/books.db`、**PRAGMA 加固**(`busy_timeout` / `WAL` / `foreign_keys`)、
  **版本化迁移**(`user_version` 计数 + 事务包裹 + 失败回滚,v1~v14)、新库写 17 本种子数据;
  另导出 **`inTransaction(db, fn)`** —— 嵌套安全的事务包裹助手(各层都无脑 BEGIN 会报
  "cannot start a transaction within a transaction";用 `db.isTransaction` 判断,不靠计数器)
- `search.js`:**独立全文检索层**(对标 calibre `db/search.py` + `db/fts`)。FTS5 虚表
  `books_fts`(trigram 分词,中文子串友好)通过外部内容连接 books 主表,增删改由
  `books.js` 同步一行;检索 ≥3 字走 FTS+BM25 相关度排序,1~2 字短词回退 LIKE。
  结构化检索把 `#自定义字段` 翻译成 `book_custom_values` 上的 `EXISTS` 子查询,
  把 `vl:书库名` 翻译成**递归调用自身**(解析另一条保存搜索,带深度上限与循环检测);
  所有查询都吃 `scopeIds` —— 虚拟书库的书 id 集合一旦确定,列表 / 分类计数 / 统计一起收窄
- `books.js`:CRUD 与列表查询(**主表 + 标签/作者链接 + 自定义值 + FTS 索引整体裹事务**);
  列表一律委托 `search.js`(有无搜索词都一样,区别只在要不要建 FTS 子查询)
- `custom_fields.js`:自定义字段注册表 CRUD(含**软删除 / 恢复 / 物理删除**)+ 取值读写
  (`setValues` 按 label 局部更新,空值删行);db 句柄由调用方传入(测试可完全隔离)
- `identifiers.js`:标识符读写 —— `isbn` / `douban` 与 `books` 专用列**双写**,读以表为准、旧列兜底;
  另有 `findDuplicates()` 冲突检测、`pruneOrphans()` 兜底清理与 `listIsbnIndex()` 查重索引
  (专用列 + 标识符表两条来源合并,ISBN-10/13 两形态归一后命中)
- `categories.js`:标签 / 作者归一化(重命名 / 合并 / 删除后重算缓存并重建 FTS);
  `listTags` / `listAuthors` 支持 `scopeIds`,作用域外的分类**不出现**而不是计数为 0
- `saved_searches.js`:保存的搜索 + **虚拟书库**(`is_virtual` 标记,同名大小写不敏感唯一);
  `getVirtualByName` / `listVirtual` 供 `vl:` 谓词与 `/api/virtual-libraries` 使用
- `book_files.js` / `stats.js`(`getStats` 同样吃 `scopeIds`)

**`src/http/` HTTP 适配(解析请求 → 调 db → 组响应,不写规则与 SQL)**

- `routes.books.js`:书籍 CRUD;挂载 `custom`(原始值)与 `custom_display`(展示文本);
  检索语法错误转 400
- `routes.customFields.js`:自定义字段管理(列表带 `usage` 引用计数、新建、改、软删 / 恢复 / 彻底删除)
- `routes.categories.js` / `routes.savedSearches.js` / `routes.files.js` / `routes.metadata.js`
- `routes.isbn.js`:ISBN 校验查重(`/api/isbn/check`)、按 ISBN 查元数据(`/api/isbn/lookup`,不落库)、
  批量添加(`/api/books/from-isbn`)
- `metadata-sources.js`:元数据源网络层 —— 豆瓣(反爬 UA / Cookie / 限速 / 按 ISBN 短链直查)与
  Open Library 兜底;组合入口 `lookupIsbn()` 让扫码回填与批量导入共用同一条取数链路
- `routes.misc.js`:上传(MIME 白名单 + 5MB + 随机文件名)/ 统计路由
- `routes.notes.js`:读书心得读写(`GET` / `PUT` / `DELETE /api/books/:id/notes`),
  正文存 `notes-files/{id}.md`;写带 `expected_updated_at` 防并发覆盖
- `middleware.auth.js`:写接口鉴权(Bearer token、恒时比较、失败限速)
- `middleware.vl.js`:`?vl=名字` → 解析成书 id 集合挂到 `req.vlScope`,列表 / 分类 / 统计 /
  系列 / 查重 / 导出共用同一份作用域;名字不存在或循环引用返回 `400 VALIDATION`,
  多个 `?vl=` 取交集。**客户端自己传的 `scopeIds` 一律丢弃**,作用域只能由服务端解析
- `routes.proxy.js`:出站代理(外链封面图片),保留缓存与超时:
  - `/api/img-proxy`:SSRF 防护(内网地址黑名单)、仅 http/https、`content-type` 必须为 `image/*`、≤5MB、15s 超时 + 失败自动重试一次;缓存 1 小时并给浏览器 `Cache-Control: public, max-age=3600`

**`server.js` 薄入口**

- 中间件:`express.json({ limit: '10mb' })`(封面 base64 编码后约 6.7MB,必须留足)、`express.static` 服务 `public/`、`/uploads/` 与 `/books-files/`
- **API 版本化**:全部路由同时挂 `/api/*` 与 `/api/v1/*`(多端契约)
- 优雅退出:`SIGTERM` / `SIGINT` 先停止接新请求,3s 兜底强杀
- `/vendor/marked.umd.js`、`/vendor/purify.min.js`:把 `node_modules` 里的 UMD 文件直接回给浏览器
  (marked v16+ 的 exports 限制子路径,需手动拼接包内路径),因此前端无需任何构建
- `/vendor/html5-qrcode.min.js`:扫码解码库,静态入库在 `public/vendor/`(不进 `package.json`),
  前端首次扫码才加载

### 测试

`npm test`(Node 内置 test runner,零新依赖),当前 **442 条用例**全部通过(35 个文件):

- `test/book.test.js`(18 条):校验规则 + 核心推导规则 —— 有记录时日期与次数由记录推导、
  请求体旧值被忽略、进行中记录不计次数、无记录时保留兜底值(API 兼容)、PUT 保留旧值语义等
- `test/stats.test.js`(5 条):状态分组 / byYear 只计已读完 / topTags 降序取 12 / 坏 JSON 容错 / 空书架
- `test/auth.test.js`(14 条):恒时比较 / 请求头提取 / GET 放行 / 无 token 401 或 503(fail closed)/
  错 token 401 / 对 token 放行(两种头都验)/ 失败限速
- `test/search.test.js`(9 条)+ `test/search-robust.test.js`(8 条):独立全文检索层 —— trigram 中文子串
  命中标题/作者/简介/标签、1~2 字短词 LIKE 兜底、status/tag 与检索正交、增删改同步索引、BM25 相关度排序
- `test/query.test.js`(19 条)+ `test/advanced-search.test.js`(11 条):高级搜索语法与结构化检索 ——
  字段谓词 / 运算符 / 引号值 / 中文别名 / `or`·`not`·`-` / 未知字段降级 /
  **括号与优先级**(`a or b and c` ≡ `a or (b and c)`、`(a or b) and c`、嵌套、不配对降级)/
  `not ( ... )` 否定整组 / **三种匹配强度**(`=` `~` `^`)
- `test/search-syntax-v15.test.js`(30 条,2026-10-20 新增):检索语法补强的行为验证 ——
  括号与优先级(A 组 5 条)、not 组(B 组 3 条)、检索类型前缀(C 组 5 条)、
  字段有无 `cover`/`series`/`format`(D 组 4 条)、日期特殊值与区间(E 组 5 条)、
  多值计数 `tags:#>4`(F 组 2 条)、大小 `size:>1M`(G 组 3 条)、组合回归(H 组 3 条)
- `test/enrich.test.js`(36 条,2026-10-20 新增):批量补全元数据与封面 ——
  `buildPatch` 只补空 / `overwrite` 覆盖 / tags 并集 / identifiers 只补缺 / title·author 永不改(A 组 12)、
  `enrichBook` 白名单列 + FTS 同步 + 空 patch 幂等(B 组 5)、
  编排的有 ISBN/无 ISBN/都没有、blocked 与 not_found 区分、封面双维度记账、单条异常不拖垮整批(C 组 19)
- `test/import-csv.test.js`(55 条,2026-10-20 新增):CSV 导入 ——
  `parseCsv` 与 `toCsv` **往返一致** / BOM / 三种行尾 / 引号内逗号换行 / 公式前缀还原(A 组 8)、
  表头宽松映射与行校验 / 中文别名 / `#label` / 未知列忽略(B 组 13)、
  `fuzzyTitle` 中文标点两组处理 + `findIdentical` 的 ISBN 优先与作者取交集(C 组 9)、
  duplicate × automerge **策略矩阵** + dry_run 不写库(D 组 14)、
  数据层端到端 + **E11 守卫**(跑测试前后真实库行数必须不变)(E 组 11)
- `test/custom-fields.test.js`(38 条,2026-10-15 新增):自定义字段 —— 定义校验(label 正则 / datatype
  白名单 / 多值收窄 / 枚举选项)、9 种类型的值规范化、注册表 CRUD 与软删除 / 恢复 / 物理删除、
  外键级联、`#字段` 检索(含数值比较两种写法、否定、未知字段报错)、`inTransaction` 嵌套安全与回滚
- `test/a-group-v12.test.js`(45 条,2026-10-15 新增):A 组剩余数据模型 ——
  `titleSort`(冠词移位 / 中文原样 / 引号剥离 / 边界)、`authorToAuthorSort`(倒装 / 前缀称谓 / 多作者)、
  系列解析(`系列 [n]` / 小数序号 / `nextSeriesIndex`)、标识符(归一化 / 双写 / 清空 / 批量 / 冲突检测)、
  uuid 迁移回填与幂等、v12 迁移结构与「内置 series 与 #series 两个命名空间共存」
- `test/isbn.test.js`(10 条)+ `test/openlibrary.test.js`(6 条,2026-10-16 新增):ISBN 基础层与 Open Library
  映射 —— 校验位(ISBN-10 含 X / ISBN-13)、连字符与空格容错、全同数字与长度错拒绝、ISBN-10→13 重算、
  `isbnKey` 两形态归一(查重不漏)、非法存量值退化比较;出版日期取年、封面 -1 视为无、作者去重上限、
  edition/work/author 三跳字段映射与缺字段容错
- `test/isbn-import.test.js`(10 条)+ `test/isbn-lookup.test.js`(5 条,2026-10-16 新增):批量导入编排与
  查询链 —— 多行 / 逗号 / 分号拆分、无效逐条报 invalid、命中建档时 isbn/douban 标识符双写、
  10 位存量 vs 13 位输入命中 duplicate、本次输入内重复只查一次、not_found/blocked/error 互不影响、
  convertTo13 决定查询与存储形态、超 50 条拒绝、查重索引覆盖旧列与标识符表;豆瓣 `/isbn/` 直连 302、
  跳搜索页时取 ISBN 精确匹配、候选不匹配宁可 not_found、豆瓣被拒且 OL 未命中报 blocked、OL 兜底成功
- `test/trash.test.js`(9 条,2026-10-20 新增):回收站 —— v13 迁移、软删除后的列表/搜索/统计/
  标签作者计数/系列/ISBN 索引过滤、恢复与 FTS 免重建、恢复时 ISBN 冲突、彻底删除的级联清理、
  共享封面保护、过期清理边界、磁盘资产按目录收口删除
- `test/csv.test.js`(5 条)+ `test/catalog.test.js`(3 条,2026-10-20 新增):CSV 导出 ——
  BOM/CRLF、RFC 4180 转义、空值与首尾空格、公式注入前缀、固定列与 `#自定义字段` 动态列、
  标识符/文件格式/阅读记录、筛选与回收站排除、空结果表头
- `test/bulk.test.js`(6 条,2026-10-20 新增):批量编辑 —— `{ ids, patch }` 请求形状、ids/patch
  校验、状态→阅读记录联动、标签增删与保留、系列/出版/评分、事务整体拒绝、FTS 同步
- `test/duplicates.test.js`(7 条)+ `test/merge.test.js`(6 条)+ `test/duplicates-db.test.js`(2 条)
  + `test/merge-db.test.js`(2 条,2026-10-20 新增):查重与合并 —— 书名/作者归一化、相似度、
  ISBN 分组、传递分组、同书名不同作者不误报、标签并集、阅读记录去重、字段回填、
  文件格式迁移、来源永久删除、缺失/回收站来源整体拒绝
- `test/virtual.test.js`(7 条,2026-10-20 新增):虚拟书库 —— v14 迁移 `is_virtual` 默认 0、
  `addSaved/updateSaved` 的标记可设可改且省略时保持、`vl:` 收窄结果与 `not vl:` 取补集、
  带空格名字加引号 / 未知名与非书库名报 VALIDATION、嵌套引用与循环引用拒绝(不栈溢出)、
  `scopeIds` 让列表 / 搜索 / 分类计数 / 统计一起收窄(空数组 = 不命中)、`listSeries` 作用域
- `test/categories.test.js`(11 条)/ `test/migrations.test.js`(6 条)/ `test/saved-searches.test.js`(8 条)/
  `test/ebook.test.js`(10 条)/ `test/delete-assets.test.js`(11 条)/ `test/douban.test.js`(7 条)/
  `test/fs-utils.test.js`(6 条)/ `test/lru.test.js`(7 条)/ `test/metadata-cache.test.js`(3 条)/
  `test/seed-data.test.js`(4 条)

### 数据模型

`books` 表(`tags`、`read_logs` 为 JSON 字符串):

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 自增 |
| `title` | TEXT NOT NULL | 书名(必填) |
| `author` | TEXT | 作者(展示缓存,由 `book_authors` 重算) |
| `author_sort` | TEXT | 首位作者(排序键) |
| `status` | TEXT | `wish` / `reading` / `done`,CHECK 约束 |
| `summary` | TEXT | 图书简介,服务端截断 ≤1000 字 |
| `tags` | TEXT | JSON 数组,如 `["小说","科幻"]`(展示缓存,由 `book_tags` 重算) |
| `start_date` / `finish_date` | TEXT | `YYYY-MM-DD`;**由 `read_logs` 自动推导**,无记录时保留表单兜底值 |
| `cover` | TEXT | 封面地址(`/uploads/...` 相对路径或外链);空则前端生成占位封面 |
| `read_count` | INTEGER | 读过次数;**有记录时 = `read_logs` 中 `finish` 非空的条数** |
| `read_logs` | TEXT | JSON 数组 `[{start, finish}]`,每行一次阅读 |
| `publisher` / `pub_year` / `isbn` / `rating` / `douban_id` | TEXT/REAL | 豆瓣抓取的元数据;`rating` 为 **10 分制**(可含小数) |
| `series` | TEXT | 系列名(v12);空 = 未入系列 |
| `series_index` | REAL | 系列序号(v12),支持小数;**0 表示未指定** |
| `title_sort` | TEXT | 书名排序键(v12):剥外层引号 + 英语冠词移位(「The Hobbit」→「Hobbit, The」);中文书名与原书名相同 |
| `uuid` | TEXT | 单本稳定标识(v12):跨库/导入导出时识别「同一本书」,不受自增 id 变化影响 |
| `deleted_at` | TEXT | 回收站墓碑(v13):空 = 在架;ISO 时间串 = 删除时间(14 天后自动彻底删除) |
| `created_at` / `updated_at` | TEXT | ISO 时间戳 |

> `author_sort` 自 v12 起改用**图书馆惯例的倒装键**(「Smith, John」),多作者用 ` & ` 连接
> (对标 calibre `authors_to_sort_string`)。**中文名是单 token,原样返回**,所以中文书的排序结果与改造前一致。

**标识符表**(v12):`book_identifiers(book, type, value)`,`PRIMARY KEY(book, type)`
—— 对标 calibre 的 `identifiers` 表(每类型一个值,类型无上限)。
`books.isbn` / `books.douban_id` 两列**保留**(豆瓣抓取 / FTS / 前端都在用),
由 `src/db/identifiers.js` **双写**保证两处一致:读以表为准、旧列兜底。

**归一化分类表**(v9):`tags(id,name)` / `book_tags(book,tag)` / `authors(id,name,sort)` /
`book_authors(book,author,position)` —— 真源是这四张表,`books.tags` / `books.author` 是派生缓存。

**文件表**(v7):`book_files(id, book, format, path, size, ...)`,`UNIQUE(book, format)`;
一本书可挂多个格式,彻底删书经外键 `CASCADE` 自动清登记(磁盘文件由路由层在 DB 提交后删)。
软删除只写 `books.deleted_at`,不碰文件登记与内容。

**回收站(v13)**:`books.deleted_at` 是墓碑列,索引 `books_deleted_idx`。
所有面向用户的查询统一过滤 `deleted_at IS NULL`;搜索层在 `legacyFilterClauses()` 一处收口。
过期清理在 `server.js` 启动时与每 6 小时执行,复用 `collectAssets` + `removeBookAssets`
清理磁盘文件;封面仍被其他书(含回收站)引用时保留。

**自定义字段**(v11,对标 calibre 的自定义列):

`custom_columns` —— 字段注册表:

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 自增 |
| `label` | TEXT NOT NULL | 机器名(小写字母开头,`UNIQUE COLLATE NOCASE`),检索时写作 `#label` |
| `name` | TEXT NOT NULL | 显示名 |
| `datatype` | TEXT NOT NULL | `text`/`comments`/`int`/`float`/`bool`/`date`/`rating`/`enumeration`/`series`,**CHECK 白名单**(与 `core/custom_fields.js` 的清单由测试钉死一致) |
| `is_multiple` | INTEGER | 0/1,仅 `text` 可为 1(CHECK 约束) |
| `options` | TEXT | 枚举选项,JSON 数组 |
| `display_order` | INTEGER | 表单与列表里的排列顺序 |
| `mark_for_delete` | INTEGER | 0/1 **软删除标记** —— 删除字段只是置 1,定义与取值都保留,可恢复 |

`book_custom_values` —— 取值表:`PRIMARY KEY(book, column_id)`,两列均为外键 + `ON DELETE CASCADE`
(删书或物理删字段时自动清值)。值为统一 `TEXT`:多值存 JSON 数组串(如 `["科幻","硬科幻"]`),
数值存数字串,空串表示未填(**不在表里留空行**)。

> **为什么不像 calibre 那样每个字段建一张物理表**(`custom_column_N`):那是为几十万册书库的索引
> 性能服务的。本项目有一条更重要的不变量 —— **schema 只由 `src/db/index.js` 的 `migrations` 数组定义**。
> 运行时 DDL 会让"库的结构"取决于"用户的操作历史",备份 / 恢复 / 自检都失去确定性。
> 单张值表 + 约束实现同样的语义,代价是值表宽一点,收益是 schema 恒定可推演。

`saved_searches` 表(v10):`name UNIQUE COLLATE NOCASE` + `query`(原始语法串)+ `sort`;
v14 追加 `is_virtual INTEGER NOT NULL DEFAULT 0 CHECK (is_virtual IN (0,1))` —— 为 1 时这条
保存搜索就是一个**虚拟书库**,`vl:` 谓词按 `name`(大小写不敏感)反查它的 `query` 并递归求解。

**推导规则**(服务端 `parseBook` 强制执行):阅读记录存在时,`read_count` / `finish_date` / `start_date` 全部由记录推导,忽略请求体里的旧值;无记录时保留请求体兜底值(API 兼容旧客户端)。

### 前端架构(public/)

- **无构建管线**:六个 HTML 页面(`index.html` / `shelf.html` / `rank.html` / `stats.html` / `tags.html` / `notes.html`)各带自己的 `<main>`;顶栏 / 弹窗 / 移动端菜单 / 页脚由 `js/chrome.js` 按 `body[data-page]` 统一注入(单一来源,避免多份副本手工同步);样式单文件 `css/style.css`
- **脚本加载顺序**(全部 `defer`,classic script 共享全局):`chrome.js` → `common.js` → `page-<name>.js`(`js/scanner.js` 紧随 `common.js`,扫码浮层打开时才注入解码库);`vendor/marked.umd.js` + `vendor/purify.min.js` 只在心得页加载,`endless-gallery.js` 只在首页加载
- **干净 URL**:`express.static` 的 `extensions:['html']` 让 `/shelf` → `shelf.html`;`/notes/:id` 用显式路由(非法 id 重定向回书架);HTML 一律 `Cache-Control: no-cache`,靠 `?v=` 的静态资源长缓存不受影响
- **跨页协调**:弹窗保存/删除后派发 `books-changed` 文档事件刷新本页数据;顶栏搜索在非书架页回车跳 `/shelf?q=…`,在书架页则派发 `shelf-search` 实时筛选;`/api/stats` 全站共享缓存(`sharedStats`),变更时作废
- **缓存失效**:各页面 HTML 里静态资源用版本号查询串(`style.css?v=N`、`chrome.js?v=N`…)控制;**改动静态文件后记得同步递增对应 `?v=`,并同步 `sw.js` 的 `SHELL_ASSETS` 清单与 `CACHE_VERSION`**(这里的 N 只作示意:实际数字以各页面 HTML 为准,不要照抄本行)
- 模块划分:
  - `js/chrome.js`(约 250 行):外壳注入(顶栏/弹窗/菜单/Toast/页脚)、旧 hash 深链兼容、Service Worker 注册
  - `js/common.js`:`api()` fetch 封装(401 提示 token 并重试)、详情/编辑弹窗、表单(阅读记录编辑器 + 状态联动;封面编辑器;电子书上传;**ISBN 输入与扫码回填、按 ISBN 批量添加弹窗**;**自定义字段的动态控件**)、自定义下拉(原生 `<select>` 隐藏作唯一数据源,视觉渲染「胶囊按钮 + 圆角浮层」,选中回写 `value` 并派发 `change`)、搜索接线、移动端全屏菜单与左边缘右滑返回(层级:弹窗 → 菜单 → 搜索栏 → 下拉 → 返回首页)、`sharedStats` 缓存
  - `js/page-*.js`:各页渲染与数据加载,筛选状态存页面闭包
  - **竞态防护**:列表 / 取色各自维护会话号(`fetchSeq`、`tintSeq`),旧响应一律丢弃
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
- **静态资源版本号**:改 `public/` 下文件后同步递增各页面 HTML 里的 `?v=`,并同步 `sw.js` 的 `SHELL_ASSETS` 与 `CACHE_VERSION`,避免线上缓存旧资源
### 历史决策记录

> 记「移除过什么、为什么」,避免后人照着旧记忆重复劳动。

| 日期 | 决策 | 原因 |
| --- | --- | --- |
| 2026-10-09 | 引入 calibre 集成后又**整体回滚**(commit `84c3b2e`) | 需求澄清:calibre 用它自带的 web 前端单独成站,my-books 保持原状。故删除了 `src/db/calibre.js`、`routes.calibre.js`、`public/next/*`、`deploy/setup-calibre.sh` 等 |
| 2026-10-14 | **站内在线阅读下线**(commit `df96a56`) | 删除 `public/read.html`、`src/core/position.js`、`src/db/positions.js`、`routes.positions.js` 与 v5/v6 的 `read_positions` / `annotations` 两表。**书签 / 高亮 / 批注(SCOPE 里的 P3)一并出局**;电子书改为「只存不读 + 下载」 |
| 2026-10-14 | `books` 表的 `file_path`/`file_format`/`file_size` 三列拆成 `book_files` 表(v7) | 一本书要能挂多个格式(EPUB + PDF),单列表达不了 |
| 2026-10-15 | 评分统一为 **10 分制**(v8 迁移把存量 ×2) | 此前折半成 5 分制,8.9/9.0 折算后都成 4.5,与豆瓣页面对不上 |
| 2026-10-15 | **自定义字段上线**(v11:对标 calibre 的自定义列) | 让「加字段」从"改代码 + 发版"变成"在页面上加" —— 见[数据模型](#数据模型)的取舍说明 |
| 2026-10-15 | **A 组剩余数据模型完成**(v12:系列 / 标识符 / uuid / 排序键) | 补齐对标 calibre 的最后四项。**A4 出版社实体表 / A6 语言表经评估不做**(投入产出比低) |
| 2026-10-16 | **按 ISBN 添加上线**(扫码 / 精确回填 / 批量导入,对标 calibre *Add from ISBN*) | ISBN 比书名精确;扫码是网页端新增路径(calibre 无此功能);批量补录几十本时逐条结果 + 查重,不产生重复条目 |
| 2026-10-20 | **回收站上线**(v13:软删除 + 14 天保留,对标 calibre 最近删除) | 硬删除误删只能靠备份;calibre 的文件回收站不适用于规范化 SQLite,故用 `deleted_at` 墓碑保留关联数据,恢复为一条 UPDATE |
| 2026-10-20 | **CSV 导出上线**(对标 calibre Catalog → CSV) | 数据要能出得来。复用书架筛选语法;UTF-8 BOM/CRLF 兼容 Excel,保留自定义字段、阅读记录与 uuid;公式注入防护 |
| 2026-10-20 | **批量编辑上线**(对标 calibre *Edit metadata in bulk*) | 逐本整理几十本书效率低。书架多选 + 一次改状态/标签/系列/出版/评分;状态联动阅读记录,全部书事务内更新 |
| 2026-10-20 | **重复书籍扫描 + 合并上线**(对标 calibre *Merge book records*) | 手工排查重复书效率低。按 ISBN/书名/作者相似度分组,合并标签/记录/自定义字段/标识符/文件;来源永久删除,UI 二次确认 |
| 2026-10-20 | **虚拟书库上线**(v14:`saved_searches.is_virtual` + `vl:` 谓词,对标 calibre Virtual library) | 常用条件要能一键收成整个视图。复用已有序列表 + `?vl=`,一次解析出书 id 集合喂给列表/分类/统计/查重/导出,口径天然一致;递归求解带深度上限与循环检测 |
| 2026-10-20 | **书架页去控件**(移除「虚拟书库」下拉、「选择」按钮与空书架的「添加书籍」按钮) | 页内控件与地址栏/搜索面板是重复入口,还会各自状态不同步。书架只留标题与网格;多选改由长按 / Ctrl⌘+点击手势进入,书库切换只在搜索面板与 `?vl=` 两处发生 |

### 安全设计

| 面 | 措施 |
| --- | --- |
| 写接口鉴权 | **双层**:外圈 Nginx `limit_except GET HEAD + auth_basic`(浏览器弹框);里圈应用内 `src/http/middleware.auth.js` —— 非 GET/HEAD 的 `/api/*` 要求 `Authorization: Bearer <token>` 或 `X-Admin-Token` 头,恒时比较防时序侧信道;**未配置 token 时写接口一律 503(fail closed)**。读接口公开。命令行调用:`curl -H "Authorization: Bearer <token>" -X POST …` |
| 网络暴露 | 生产 Node 只绑 `127.0.0.1:3002`;云安全组不放行应用端口 |
| XSS | 所有 HTML 插值经 `esc()` 转义;Markdown 渲染结果经 `DOMPurify.sanitize()` |
| SSRF | `/api/img-proxy` 内网地址黑名单(localhost、127/8、10/8、172.16/12、192.168/16、169.254/16、IPv6 回环/ULA/链路本地、0/8) |
| 上传 | MIME 白名单(png/jpeg/gif/webp)+ 5MB 上限 + `时间戳-随机hex` 文件名,不透传原始文件名 |
| 传输 | TLS 1.2/1.3(免费 DV 单域名证书,不做 www);HTTP 80 一律 301 到 HTTPS |
| 响应头 | Nginx 统一加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: strict-origin-when-cross-origin` |
| 外链图片 | 封面 `<img>` 带 `referrerpolicy="no-referrer"` |
| 请求体 | `express.json` 限 10MB(封面 base64);电子书走 multipart,上限 80MB;Nginx `client_max_body_size 100m`(需 ≥ 应用层上限,否则超限先被 Nginx 以 413 拦下) |

---

## 目录结构

```
my-books/
├── package.json                      # 依赖(express/multer/cheerio/marked/dompurify)、启动与测试脚本
├── server.js                         # 薄入口:创建 app、挂路由、listen(不含业务规则与 SQL)
├── data-check.js                     # 数据自检脚本(库内容 + JSON/日期/枚举一致性)
├── src/
│   ├── core/                         # 纯业务规则(不依赖 express / 数据库,可独立测试)
│   │   ├── book.js                   # parseBook 校验+推导、mergeUpdate 局部更新语义、作者拆分
│   │   ├── bulk.js                   # 批量编辑的 ids/patch 校验 + 状态→阅读记录联动
│   │   ├── duplicates.js             # 书名/作者归一化 + bigram 相似度 + 重复分组
│   │   ├── merge.js                  # 标签并集 / 阅读记录合并 / 字段回填 / 合并请求校验
│   │   ├── custom_fields.js          # 自定义字段规则:定义校验、值规范化、展示文本
│   │   ├── sort_keys.js              # 排序键:titleSort(冠词移位)、authorToAuthorSort(倒装)
│   │   ├── series.js                 # 系列规则:`系列 [n]` 解析、序号规范与自动递增
│   │   ├── identifiers.js            # 标识符规则:类型归一、外链构造、展示列表
│   │   ├── query.js                  # 高级搜索语法(递归下降:括号/优先级/否定整组/匹配强度)
│   │   ├── douban.js                 # 豆瓣解析(纯函数)+ 字段映射
│   │   ├── openlibrary.js            # Open Library 解析(edition/work/author → 字段映射)
│   │   ├── isbn.js                   # ISBN 校验/归一化(校验位、ISBN-10→13、查重键 isbnKey)
│   │   ├── isbn_import.js            # 「按 ISBN 批量添加」编排(校验→查重→抓取→建档,逐条状态)
│   │   ├── ebook.js                  # 电子书格式 / 大小 / 存储名规则
│   │   ├── stats.js                  # computeStats 统计聚合
│   │   ├── csv.js                    # CSV 序列化(RFC 4180 / BOM / CRLF / 公式注入防护)
│   │   ├── sql.js                    # inClause(id 集合 → 分块 IN 片段;空集合恒不命中)
│   │   ├── fs-utils.js               # 原子写 + 受边界约束的删除
│   │   └── paths.js                  # 目录常量(唯一来源)
│   ├── db/                           # 数据访问层(只 import node: 与 core)
│   │   ├── index.js                  # 打开 books.db、PRAGMA 加固、版本化迁移(v1~v14)、种子、inTransaction
│   │   ├── seed-data.js              # 17 本示例书数据
│   │   ├── books.js                  # 书籍 CRUD + 回收站(软删除/恢复/彻底删除)+ 批量编辑,事务包裹
│   │   ├── search.js                 # 全文检索层(FTS5 trigram + BM25)+ 结构化检索 + vl: 递归求解
│   │   ├── categories.js             # 标签 / 作者归一化(重命名 / 合并 / 删除)+ 作用域内计数
│   │   ├── custom_fields.js          # 自定义字段注册表 CRUD + 取值读写
│   │   ├── identifiers.js            # 标识符读写(isbn/douban 双写 + 任意类型 + 查重索引 listIsbnIndex)
│   │   ├── book_files.js             # 一本书多格式文件登记
│   │   ├── saved_searches.js         # 保存的搜索 + 虚拟书库(is_virtual、getVirtualByName、listVirtual)
│   │   ├── catalog.js                # CSV 导出的字段组装(固定列 + 自定义字段 + 标识符 + 文件)
│   │   ├── duplicates.js             # 重复书籍扫描(在架书 + 文件格式)
│   │   ├── merge.js                  # 合并事务:字段/格式/自定义值/标识符 + 永久删除来源
│   │   ├── stats.js                  # 统计查询入口
│   ├── http/                         # HTTP 适配层(解析请求 → 调 db → 组响应)
│   │   ├── middleware.auth.js        # 写接口应用内鉴权(Bearer token,恒时比较,失败限速)
│   │   ├── middleware.vl.js          # ?vl=名字 → req.vlScope(书 id 集合;多名字取交集;失效 400)
│   │   ├── routes.books.js           # 书籍 CRUD + 自定义字段值读写
│   │   ├── routes.customFields.js    # 自定义字段管理(增删改 + 恢复)
│   │   ├── routes.categories.js      # 标签 / 作者管理
│   │   ├── routes.savedSearches.js   # 保存的搜索 + GET /api/virtual-libraries(带命中数)
│   │   ├── routes.export.js          # CSV 导出(GET /api/export.csv)
│   │   ├── routes.files.js           # 电子书上传 / 列表 / 删除
│   │   ├── routes.metadata.js        # 豆瓣元数据检索
│   │   ├── metadata-sources.js       # 元数据源网络层:豆瓣按 ISBN 直查/搜索 + Open Library 兜底(组合入口 lookupIsbn)
│   │   ├── routes.isbn.js            # ISBN 校验查重 / 按 ISBN 查元数据 / 批量添加
│   │   ├── routes.misc.js            # 封面上传 / 统计
│   │   ├── routes.notes.js           # 读书心得读写(notes-files/{id}.md)
│   │   ├── routes.proxy.js           # img-proxy 出站代理(缓存 + SSRF 防护)
│   │   └── lru.js                    # 有上限的内存缓存
├── test/                             # node:test 用例(npm test,35 个文件 442 条)
│   ├── custom-fields.test.js         # 自定义字段:规则 / 落库 / 检索 / 软删除 / 事务
│   ├── a-group-v12.test.js           # 系列 / 标识符 / uuid / 排序键(A3/A5/A7/A8)
│   ├── trash.test.js                 # 回收站:过滤矩阵 / 恢复冲突 / 彻底删除 / 过期清理
│   ├── virtual.test.js               # 虚拟书库:is_virtual / vl: 谓词 / 嵌套与循环 / 作用域收窄
│   ├── csv.test.js / catalog.test.js # CSV 序列化 / 目录字段组装
│   ├── bulk.test.js                  # 批量编辑:校验 / 状态联动 / 事务 / 标签增删
│   ├── duplicates.test.js / merge.test.js        # 查重算法 / 合并规则
│   ├── duplicates-db.test.js / merge-db.test.js  # 查重扫描 / 合并事务
│   ├── isbn.test.js / openlibrary.test.js     # ISBN 校验归一 / Open Library 字段映射
│   ├── isbn-import.test.js / isbn-lookup.test.js  # 批量添加编排 / 豆瓣+OL 查询链
│   ├── book.test.js / stats.test.js / auth.test.js
│   ├── search.test.js / search-robust.test.js / query.test.js / advanced-search.test.js
│   ├── categories.test.js / migrations.test.js / saved-searches.test.js
│   └── ebook.test.js / delete-assets.test.js / douban.test.js / fs-utils.test.js /
│       lru.test.js / metadata-cache.test.js / seed-data.test.js
├── deploy/
│   ├── ecosystem.config.js           # PM2 进程配置(主方案:3002 / 127.0.0.1 / fork)
│   ├── my-books.service              # systemd 单元(备选,与 PM2 二选一)
│   ├── nginx-helloac.top.conf        # 根域名站点(80→301 + 443 反代,含写接口口令块)
│   ├── nginx-ecook.helloac.top.conf  # ecook 子域名站点(同机共存的另一站点)
│   ├── backup-db.js                  # VACUUM INTO 安全备份(含行数对账)
│   └── update.sh                     # 一键更新:备份 → 拉代码 → 装依赖 → 重启 → 自检
├── public/
│   ├── index.html                    # 首页(页脚含备案号;外壳由 chrome.js 注入)
│   ├── shelf.html / rank.html / stats.html / tags.html / notes.html
│   ├── logo.png / logo-mark.png / add-icon.png
│   ├── css/style.css                 # Apple 风格响应式样式(单文件)
│   ├── sw.js                         # Service Worker(离线壳缓存,清单需与页面引用同步)
│   ├── vendor/html5-qrcode.min.js    # 扫码解码库(静态入库,首次扫码才懒加载)
│   └── js/
│       ├── chrome.js                 # 全站外壳注入(顶栏/弹窗/菜单/页脚)+ 旧 hash 兼容
│       ├── common.js                 # 共享逻辑:api/弹窗/表单/自定义字段/ISBN 输入与批量/搜索/滑动返回
│       ├── scanner.js                # 扫码浮层(打开摄像头 → 解 EAN-13 → 回填 ISBN)
│       ├── page-home.js / page-shelf.js / page-rank.js / page-stats.js / page-tags.js / page-notes.js
│       └── endless-gallery.js        # 首页复刻 apple.com 的双排无限轮播
├── data/                             # 运行时自动创建;.gitignore 忽略 *.db
│   ├── books.db                      # SQLite 数据库(唯一数据文件)
│   └── backup/                       # update.sh 的滚动备份(保留 10 份)
├── uploads/                          # 上传的封面图片(运行时自动创建;.gitignore 忽略)
└── books-files/                      # 上传的电子书正文(运行时自动创建;.gitignore 忽略)
```

---

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/books?q=&status=&tag=&author=&vl=&sort=` | 书籍列表;`q` 支持**高级语法**(自由词 + `tag:` / `author:` / `status:` / `rating>=n` / `series:` / `series_index>=n` / `identifier:type:value` / `format:` / `cover:true` / `date:>10daysago` / `size:>1M` / `tags:#>4` / `#自定义字段:值` / `vl:书库名` + `and`/`or`/`not` + **括号** + `=`/`~`/`^` 匹配强度),`sort` ∈ updated(默认)/created/finish/title/author/series;`vl=名字` 把整个结果收进该虚拟书库(多个 `vl=` 取交集,名字失效返回 `400 VALIDATION`)。每行附 `custom_display` 与 `series_label` |
| GET | `/api/books/trash` | 回收站列表 `{ retention_days, books: [{ id, title, author, deleted_at, days_left, cover }] }`;不包含在架书 |
| GET | `/api/books/:id` | 单本书详情(不存在或已在回收站返回 404);附 `files`、`file_formats`、`identifiers`、`identifier_list`(带外链)、`series_label`、`custom`(原始值,表单回填)、`custom_display`(展示文本) |
| GET | `/api/export.csv?q=&status=&tag=&author=&vl=&sort=` | 导出 CSV(UTF-8 BOM);筛选参数与 `/api/books` 相同(含 `vl=` 虚拟书库作用域);包含固定列与全部 `#自定义字段` 列;仅导出在架书 |
| POST | `/api/import.csv?duplicate=&automerge=&dry_run=1` | 导入 CSV。体可为 `text/csv` 裸内容,或 JSON `{csv}` / `{base64}`。`duplicate` ∈ add(默认)/ignore/add_formats_to_existing;`automerge` ∈ ignore(默认)/overwrite/new record;`dry_run=1` 只校验与查重**不写库**。逐行返回 `created`/`merged`/`duplicate`/`invalid`/`error`;**需写口令** |
| GET | `/api/series?vl=` | 系列列表:每项 `{ name, count, min_index, max_index, label }`;带 `vl=` 时只统计书库内的书 |
| GET | `/api/identifiers/duplicates` | 标识符冲突自检:同类型同值被多本书占用的情况 |
| GET | `/api/books/duplicates?vl=` | 疑似重复书籍分组 `{ groups: [{ reason, score, books }] }`;只读扫描,不落库;`vl=` 只在书库范围内找重复 |
| POST | `/api/books/merge` | 合并书籍:体 `{ targetId, sourceIds }`;目标保留标题/作者,其余字段合并;**来源永久删除**;需写口令 |
| POST | `/api/books` | 添加书籍;服务端统一校验并推导阅读记录字段;可选 `custom: { label: value }` |
| POST | `/api/books/bulk` | 批量编辑:体 `{ ids, patch }`;patch 支持 `status` / `tags_add` / `tags_remove` / `series` / `series_index` / `publisher` / `pub_year` / `rating`;只改出现的字段,事务内整体生效;最多 500 本;**需写口令** |
| PUT | `/api/books/:id` | 更新书籍;未提供的字段保留旧值;`custom` 按 label 局部更新(传空串 = 清空该字段) |
| DELETE | `/api/books/:id` | **移入回收站**(14 天内可恢复);`?purge=1` 才是彻底删除(仅限已在回收站的书,清理磁盘上的电子书与封面);**需写口令** |
| POST | `/api/books/:id/restore` | 从回收站恢复;ISBN 已被其他在架书占用时返回 `409 CONFLICT`;**需写口令** |
| POST | `/api/books/:id/file` | 上传电子书文件(multipart,≤80MB);同格式覆盖替换 |
| GET | `/api/books/:id/file` | 列出该书的电子书文件 |
| DELETE | `/api/books/:id/file?format=EPUB` | 删除某个格式的文件(磁盘 + 登记) |
| GET | `/api/custom-fields?includeDeleted=1` | 自定义字段定义列表(带 `usage` = 已填写的书籍数;`includeDeleted=1` 含软删除的) |
| POST | `/api/custom-fields` | 新建字段;体 `{ label, name, datatype, is_multiple, options }`;**需写口令** |
| PUT | `/api/custom-fields/:id` | 改字段(`name` / `options` / `display_order`);**`datatype` 与 `is_multiple` 不可改**;**需写口令** |
| DELETE | `/api/custom-fields/:id` | **软删除**(可恢复);加 `?purge=1` 才物理删除(取值随外键 CASCADE 一起清掉);**需写口令** |
| POST | `/api/custom-fields/:id/restore` | 取消软删除,恢复字段;**需写口令** |
| GET | `/api/tags?vl=` `GET /api/authors?vl=` | 归一化后的标签 / 作者列表(带引用计数);带 `vl=` 时只列书库里出现过的分类 |
| POST | `/api/tags/rename` `POST /api/tags/merge` `DELETE /api/tags/:id` | 标签重命名 / 合并 / 删除(删除仅解除分类) |
| POST | `/api/authors/rename` `POST /api/authors/merge` `DELETE /api/authors/:id` | 作者同上 |
| GET | `/api/saved-searches` | 保存的搜索列表(每项带 `is_virtual`) |
| GET | `/api/virtual-libraries` | 虚拟书库列表 `{ id, name, query, sort, count }`;`count` 是当前命中本数,名字失效 / 循环引用时为 `null`(不整套报错) |
| POST / PUT / DELETE | `/api/saved-searches` `/api/saved-searches/:id` | 保存的搜索增改删;体可带 `isVirtual`(PUT 省略时保持原值);**写需口令** |
| POST | `/api/upload` | 上传封面;JSON 体 `{ data: "data:image/png;base64,…" }`,≤5MB,返回 `{ url }` |
| GET | `/api/books/:id/notes` | 读单本书的读书心得 `{ has_notes, content, size, updated_at }`;**读接口公开** |
| PUT | `/api/books/:id/notes` | 写读书心得;体 `{ content, expected_updated_at? }`;`expected_updated_at` 与服务器现值不符回 `409 CONFLICT`;**写需口令** |
| DELETE | `/api/books/:id/notes` | 删除读书心得;**写需口令** |
| GET | `/api/img-proxy?url=` | 外链封面图片代理:同源化供 Canvas 取色(SSRF 防护,缓存 1 小时,失败重试一次) |
| GET | `/api/stats?vl=` | 统计数据 `{ total, byStatus, byYear, topTags }`(topTags 至多 12 个);`vl=` 时只统计书库内的书 |
| GET | `/api/metadata/search?q=` | 豆瓣元数据检索(书名或 ISBN),返回最多 5 个候选 |
| GET | `/api/isbn/check?isbn=` | ISBN 校验 + 归一化 + 查重:`{ input, valid, normalized, duplicate }`(`duplicate` 为已存在书的 `{id,title}` 或 null);**不落库** |
| GET | `/api/isbn/lookup?isbn=` | 按 ISBN 查元数据(豆瓣直查 → Open Library 兜底),返回 `{ status, book, source }`;**不建档**,扫码回填与批量添加共用同一条链路 |
| POST | `/api/books/from-isbn` | 按 ISBN 批量添加(体 `{ isbns, tags?, check_existing?, convert_to_13? }`,单次 ≤50 条);逐条返回 created / duplicate / invalid / not_found / blocked / error 与汇总;**需写口令** |

> 所有端点同时挂在 `/api/v1/*`(多端契约)。**检索语法错误**(未知的 `#自定义字段`、数值字段给非数字)
> 一律返回 `400 + code=VALIDATION`,不落进兜底 500 —— 让"筛选没生效"这类问题立刻可见。

vendor 静态资源:`GET /vendor/marked.umd.js`、`GET /vendor/purify.min.js`(供前端渲染 Markdown 用),
以及 `GET /vendor/html5-qrcode.min.js`(入库在 `public/vendor/`,扫码解码库,前端首次扫码才加载)。

> **线上鉴权(双层)**:写操作(`POST / PUT / DELETE` 与 `/api/upload`)受两层保护 ——
> ① Nginx Basic 口令(浏览器弹账号密码框,`curl -u admin:密码`);
> ② 应用内管理令牌:请求头带 `Authorization: Bearer <token>` 或 `X-Admin-Token`(`data/admin-token`
> 文件内容)。浏览器首次写操作会弹一次令牌输入框,之后存 localStorage 无感。
> 所有 `GET` 读接口保持公开,浏览与搜索不受影响。

---

## 数据与备份

- 书籍数据保存在 **`data/books.db` 单个文件**;上传的封面在 `uploads/`,上传的电子书在 `books-files/`
- `deploy/update.sh` 每次更新前自动备份到 `data/backup/`(各保留最近 10 份):
  - 数据库 `books-*.db`,由 `deploy/backup-db.js` 用 **`VACUUM INTO`** 生成,并校验 `integrity_check` 与 **books 表行数**(任一不符即中止更新)
  - 文件快照 `files-*/(uploads/ + books-files/)`,优先用硬链接(`cp -al`)——瞬时完成、不占额外空间;因应用写文件一律「先写临时名再原子 rename」,被替换的旧文件在快照里仍是完整旧版本
- 线上另有 cron 每日 03:30 全量打包 `data + uploads + books-files`(保留 7 份,排除 `data/backup` 避免备份套备份),见[线上运维](#线上运维)

> **⚠️ 绝不能直接 `cp data/books.db` 当备份。** 库跑在 WAL 模式(`src/db/index.js` 的 `PRAGMA journal_mode = WAL`),已提交事务可能只存在于 `books.db-wal` 里,主库文件要等检查点才更新。实测:写入 500 行后 `cp` 主文件只得到 100 行(**丢 80% 数据**),而且 `PRAGMA integrity_check` 依然报 `ok` —— 完整性校验抓不出这种残缺。
> 正确做法是 `node deploy/backup-db.js <源库> <目标>`(内部用 `VACUUM INTO`,读取含 WAL 的完整内容,产出自包含单文件)。

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
# 先做一份自包含快照 —— 直接 scp 主库文件会漏掉 WAL 里尚未检查点的事务
node deploy/backup-db.js data/books.db data/upload-snapshot.db

scp data/upload-snapshot.db root@120.53.29.226:/root/my-books/data/books.db
scp -r uploads/. root@120.53.29.226:/root/my-books/uploads/
rm -f data/upload-snapshot.db
```

> 这一步不做的话,线上打开是 17 本示例书,你在本地记的书不会出现。
> 现在传最安全(服务还没启动,不会写到一半被覆盖)。
> 服务器的 `data/books.db` 是 WAL 库,快照副本切过去后,建议把服务器上残留的
> `data/books.db-wal`、`data/books.db-shm` 一并删掉,避免旧 WAL 盖掉新数据。

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
30 3 * * * cd /root/my-books && tar -czf ~/backup-mybooks-$(date +\%F).tar.gz --exclude='data/backup' data uploads books-files && find ~ -maxdepth 1 -name 'backup-mybooks-*.tar.gz' -mtime +7 -delete
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
  30 3 * * * cd /root/my-books && tar -czf /root/backup-mybooks-$(date +\%F).tar.gz --exclude='data/backup' data uploads books-files && find /root -maxdepth 1 -name 'backup-mybooks-*.tar.gz' -mtime +7 -delete
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
