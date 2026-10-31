# My Books · Liquid Glass 实施报告

> **2026-10-31 后续更新**：设计系统统一与详情重构已覆盖本报告的控件、登录页与弹窗章节，
> 登录页彩虹背景已删除，按钮改为统一 control token。当前状态以
> [`LIQUID-GLASS-UNIFICATION.md`](LIQUID-GLASS-UNIFICATION.md) 为准；本报告保留
> 折射引擎、性能与 Glass Lab 的原始记录。

- 日期：2026-10-31
- 分支：`feat/liquid-glass-design-system`
- 基线：`8acd1843c188b7a5aebbf02819a41dd6300ce2c2`（远端 `main` 同日核对无新提交）
- 范围：Web 管理端的导航 / 浮层 / 控件；未改后端 API、数据库与同步协议
- 运行方式：仅本地临时演示库与 headless CDP 截图；未部署、未触碰生产站点或真实书库
- 许可：项目仍为 GPL-3.0-only；新增的 SDF 思路来源为 MIT，声明见
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) 与
  [`public/vendor/liquid-glass/LICENSE`](../public/vendor/liquid-glass/LICENSE)

## 1. 结果摘要

本次把原先压平的 Apple 扁平控件层升级为统一的 Liquid Glass 体系：

- **Chromium（Chrome / Edge）**：小控件与浮层使用真实的 SVG
  `feDisplacementMap` + `backdrop-filter`，采样浏览器实时合成的背景。边缘可见
  真实弯折、轻微红/青色散与镜面高光；滚动、背景移动、菜单开合都会实时跟随。
- **Safari / iOS / Firefox**：明确降级为磨砂（blur + saturate + 边缘高光），
  **没有背景形变，也没有用克隆背景冒充折射**。
- 无反射/低性能环境：纯色档；尊重 `prefers-reduced-motion`、
  `prefers-reduced-transparency`，并提供用户手动档位。
- 书封、表格、书名、作者、阅读信息、统计卡片等**内容层保持实体**，不加模糊或折射。

独立验证页：[`public/glass-lab.html`](../public/glass-lab.html)（`/glass-lab.html`），
可用 `?glass=full|frost|solid` 强制档位。

## 2. 基线、审计与变量

### 2.1 基线与测试

| 阶段 | tests | pass | fail | 说明 |
| --- | ---: | ---: | ---: | --- |
| 实施前基线 | 548 | 546 | 2 | 两个失败均为 Windows 临时目录 EPERM（`public-check`），既有基线 |
| 当前源码 | 548 | 546 | 2 | 玻璃测试与截图已按你的要求从仓库移除；仍只有同两个已知 EPERM |

`npm run check:public`：通过。开发期曾用 13 个玻璃测试与 headless CDP 截图验证；
这些文件按要求不纳入本次提交，Glass Lab 仍保留用于手工验证。

本机 Bash 没有 Node/npm 在 PATH 中，测试和脚本通过 Qoder 自带的
Electron-as-node 运行（`ELECTRON_RUN_AS_NODE=1`）；CI 仍可直接用 `npm test`。

### 2.2 `--glass-*` 使用情况

保留在 `public/css/style.css`，没有把 `--card` 改成透明：

| 变量 | 状态 |
| --- | --- |
| `--glass-fill` / `-fill-hover` | 使用中（`.btn` / `.icon-btn` / `.seg` 等） |
| `--glass-edge` / `-edge-hover` | 使用中 |
| `--glass-text` / `--glass-sheen` | 使用中 |
| `--glass-spec` / `--glass-spec-hover` | 使用中，但值均为 `0 0 0 0`（压平占位） |
| `--glass-lift` / `--glass-lift-hover` | 使用中，但值均为 `0 0 0 0`（压平占位） |
| `--glass-fill-on` | 已定义、未引用 |
| `--glass-ring` | 已定义、未引用 |

新体系不复用这些旧占位值，统一使用 `public/css/liquid-glass.css` 的 `--liquid-*`；
旧 `.btn` / `.icon-btn` 的既有扁平外观保持，避免一次改遍所有内容层控件。

### 2.3 关键源码审计

- 全站外壳由 `public/js/chrome.js` 注入；页面脚本统一 defer，加载顺序为
  `chrome → base/api/cover/select/modal/overlay → common → liquid-glass → page/shelf`。
- 书架是独立三栏布局：`shelf.html` + `shelf-workbench.css` + `js/shelf/*.js`；
  固定定位的顶部工具栏、底栏、侧栏、Inspector、菜单、批量条互有层级关系。
- 搜索浮层由 `overlay.js` 控制高度/可见性过渡；之前若把 `.lg-surface` 的通用
  transition 直接挂到它上面，会覆盖 `style.css` 的开合动画，所以搜索浮层**只吃
  CSS 材质，不挂 `data-glass`**。
- 侧栏/Inspector 有自己的抽屉/滑入 transform 过渡；玻璃层额外恢复了这两组节奏，
  只让底色/阴影参与玻璃过渡。
- 书架排序是原生 `<select>` 被 `select.js` 增强成 `.sel-trigger + .sel-menu`；
  玻璃只加在增强后的外层触发器/菜单上，不往原生 `<select>` 内注入 DOM。

## 3. 引擎选择与真实性验证

### 3.1 候选

| 方案 | 结论 |
| --- | --- |
| [@tomagranate/liquid-glass](https://github.com/tomagranate/liquid-glass)（MIT） | 采用其**圆角矩形 SDF 位移贴图**思路；上游主要折射“背景副本”，本项目改为 Chromium 实时 `backdrop-filter`，不复制背景 |
| [@dpawlikowski/liquid-glass](https://github.com/dpawlikowski/liquid-glass)（MIT，0.3.0） | 用于验证 SVG 滤镜可以放进 `backdrop-filter`；未采用其 `feTurbulence` 动画与静态 scene 复制层 |
| [liquid-glass-react](https://github.com/rdev/liquid-glass-react)（MIT） | React-only，不引入前端框架，未采用 |

没有 npm 运行时依赖、没有 CDN、没有构建步骤；浏览器直接加载
`public/js/liquid-glass.js` + `public/css/liquid-glass.css`。

### 3.2 真实折射的证据

1. 隔离探针确认 Chromium 的 `backdrop-filter: url(#filter)` 会执行
   `feOffset` 与 `feDisplacementMap`，不是只解析 CSS。
2. Glass Lab 用高对比棋盘格 / 彩色网格 / 移动色块 / 书封验证：
   - 边缘线条出现可见弯折；
   - 中心保持清晰；
   - 边缘出现轻微红/青色散；
   - 背景横向移动时玻璃内图案同步更新；
   - 悬停/按压只改变高光与缩放，不移动文字；
   - 磨砂对照无背景形变。

截图已按你的要求从仓库移除；运行 `/glass-lab.html?glass=full` 与
`?glass=frost` 可在本机现场对比完整折射与磨砂降级。

### 3.3 降级原则

- 只有 `CSS.supports(backdrop-filter, url(...))` 且不是 WebKit/Firefox 时才进入
  Full；**不把 CSS.supports 当作唯一证据**，还要求浏览器家族与 Lab 实测通过。
- Safari / iOS / Firefox → Frost：`blur + saturate + 边缘高光/色散描边`，
  不复制背景、不生成位移贴图。
- 无 `backdrop-filter` → Solid：近实色，文字/按钮始终可用。
- `prefers-reduced-transparency: reduce` → Solid；`saveData`、≤2GB 内存、
  ≤2 核 → Frost；`prefers-reduced-motion` → 不播放任何玻璃动画/过渡。

## 4. 渲染架构

### 4.1 分层，但不注入 DOM

每个玻璃控件不需要额外子节点；材质由宿主元素自身的
`background-color / background-image / box-shadow / border / backdrop-filter` 完成：

| 逻辑层 | 实现 |
| --- | --- |
| `GlassRefractionLayer` | 宿主的 `backdrop-filter: url(#filter) blur() saturate()` |
| `GlassTintLayer` | 宿主的半透明底色 + 斜向 sheen |
| `GlassHighlightLayer` | inset 白色顶边、左右红/青边缘、外阴影 |
| `GlassContent` | 宿主原本的子节点/语义不变 |

因此没有装饰层，不存在 `pointer-events`、`aria-hidden`、Tab 序、事件委托或点击穿透
被改写的风险；也没有克隆页面 DOM。

### 4.2 位移贴图与滤镜

- 圆角矩形 SDF 生成位移场：中心 128（无位移），边缘沿法线朝外弯折，形成透镜
  边缘；贴图外侧留 10% 中性区，滤镜区域扩到 120% 以便采样边缘外的背景。
- R/G 通道编码 x/y 位移；色散用三次不同强度的 `feDisplacementMap` + 通道合成。
- 贴图是**静态**的，没有 `feTurbulence` 循环；滚动/动画由浏览器实时 backdrop 采样
  自动跟随，不需要逐帧同步。
- 滤镜按 `宽×高×圆角×深度×强度×色散×DPR` 分桶复用；引用计数归零即删除
  `<filter>` 节点。相同几何的控件共享一份贴图（书架实测 5 个滤镜覆盖 8 个折射面）。
- 同时最多 14 个折射面（≤560px 视口 10 个）；菜单隐藏、面滚出视口或降级时立即
  释放滤镜，避免节点/监听器增长。

### 4.3 生命周期

- `ResizeObserver` 处理尺寸变化/旋转/DPR 变化；`MutationObserver` 处理动态菜单、
  Inspector collection pop、动态新增的书卡控件；`IntersectionObserver` 只给可见面
  挂滤镜。
- `destroy()` 清理 Resize/Intersection/Mutation observers、resize/media 监听、
  全部滤镜引用、SVG defs 宿主和 `<html>` 上的档位属性。
- 重复 `start()` / `scan()` 幂等；滤镜 ID 由页内序列生成，不冲突；单元测试覆盖
  重复初始化、尺寸变化、销毁、共享、降级与 URL 强制档位。

## 5. 设计系统

`public/css/liquid-glass.css` 的统一 tokens：

```css
--liquid-tint / --liquid-opacity / --liquid-blur / --liquid-saturation
--liquid-refraction / --liquid-chroma / --liquid-rim-light / --liquid-shadow
--liquid-radius / --liquid-duration
```

另有 `--liquid-shadow-soft`、`--liquid-shadow-hover`、`--liquid-chroma-red/cyan`、
`--liquid-edge`、`--liquid-sheen` 等辅助值。所有新玻璃表面复用这套变量；旧组件
的局部圆角、字号、布局不被统一变量覆盖。`--card` 未被改写，表格/卡片/输入框
仍是不透明内容层。

用户设置：**书架 → 右上视图设置 → 玻璃效果：自动 / 完整 / 柔和 / 关闭**。
选择写入 `localStorage['mybooks.glass.mode']`，全站生效；`?glass=full|frost|solid`
可用于截图/排障。若浏览器不支持所请求的档位，或当前环境自动回退到磨砂/纯色，
菜单里会显示实际档位说明，不会假装效果存在。

## 6. 接入范围

### 书架（重点）

- 顶部 `wb-brand`、圆钮、搜索胶囊、视图切换、排序触发器：Full 折射 + hover 高光 +
  active 轻微缩放；移动端保持 44px 触摸区。
- `wb-brand-menu` / `wb-layout-menu` / collection pop / 自定义选择菜单：玻璃面板，
  保持 z-index、外部点击、Escape、键盘、滚动、边缘定位。
- 侧栏 / Inspector：低成本磨砂材质，文字/元数据/封面保持清晰；不做大面板折射。
- `wb-card-cover`、书名、作者、表格、阅读信息：完全不动。
- 新增 collection pop 的外部点击与 Escape 关闭（原实现缺少这两个行为，属任务书
  第 9 步的交互要求；关闭后 Inspector 仍保持打开）。

### 全站

- 顶栏：常态玻璃；搜索/菜单/导航下拉展开时恢复原有的透明或 `#fafafc` 不透明态，
  不覆盖 Apple 的动画节奏。
- 搜索浮层：整屏磨砂 + 边缘高光；不挂 `.lg-surface`，保留原有高度/可见性动画。
- 添加/编辑弹窗：磨砂弹窗面板 + 模糊幕布；输入控件保持白底。
- 首页：导航玻璃；画廊 dotnav 只加一层磨砂/边缘高光，不改尺寸、圆点节奏和
  播放/暂停语义；这是为兼容此前 apple.com 1:1 验证做的有意折中。
- 登录页：增加柔和彩色光斑、双层网格与光环背景；账号卡片是低 tint、低模糊的**真实折射玻璃**（Chromium），
  边缘可见背景线条/光环的弯折；输入框与按钮仍保持不透明白底，保证登录可用性。
- 分类/统计/榜单/心得：导航/控件玻璃；内容卡片、榜单行、统计面板保持实体。

## 7. 验证

### 7.1 自动化

```bash
npm test                 # 本机无 npm 时用 Electron-as-node 跑 scripts/test.js
npm run check:public
```

- 结果：当前仓库 548 tests / 546 pass / 2 fail（同基线 EPERM）；`check:public` 通过。
- 开发期曾用 13 个玻璃测试（分级策略、几何分桶、滤镜注册表复用/计数、重复
  start/scan、尺寸变化、销毁清理、Safari/减少透明度降级、reduced-motion、
  静态接线与版本一致性）和 headless CDP 截图验证；按你的要求，这些测试文件
  与截图未纳入本次提交，Glass Lab 可继续手工验证。

### 7.2 浏览器与视口

Headless CDP（Chrome 156 / Edge 156）实测：

- Chrome 与 Edge 均进入 Full：Lab 边缘弯折、中心清晰、色散可见；
- 强制 Frost / Solid：无滤镜节点、无背景形变；
- 模拟减少透明度：自动 Solid，滤镜 0；减少动态：静态折射保留、过渡关闭；
- 页面控制台无未捕获错误（`window.__pageErrors` 为空）。

视口检查（书架）：390×844、768×1024、932×430、1024×768、1440×900、1920×1080：
均无横向溢出；移动端菜单/Inspector 落在视口内；触控控件为 44px 级别。
截图已按你的要求从仓库移除，可用本机浏览器在对应尺寸复现。

交互回归（CDP）：

- 排序菜单打开 → 玻璃滤镜 → 选择“书名” → URL `?sort=title`、菜单关闭、滤镜回到基線；
- 品牌菜单打开后链接可命中、Escape 关闭；
- 搜索「三体」→ URL `?q=三体&sort=title`、结果 2 本、浮层关闭；
- Inspector 打开/关闭、collection pop 打开、外部点击/Escape 关闭、滤镜无泄漏；
- 玻璃档位四档切换、`localStorage` 持久化；
- 菜单 8 次开合后滤镜数从 5 回到 5，无增长。

### 7.3 性能

Headless Chromium，非真机认证，仅作为相对基线：

| 场景 | 无节流 | 4× CPU 节流 |
| --- | ---: | ---: |
| Lab 滚动 + 10 个玻璃组件 | ~162.9 FPS | ~150.8 FPS |
| Lab 滚动 + 20 个玻璃组件 | ~163.1 FPS | ~153.2 FPS |
| 书架滚动（8 个折射面 / 5 个滤镜） | ~159.5 FPS | ~125.7 FPS |

> 数值高于 60 是因为 headless 合成器不受真实屏幕垂直同步限制；它只能说明相对
> 开销没有失控，不能替代真机 FPS。实际应用仍保留 14/10 个折射面上限、隐藏即释放、
> 低内存/省流量自动磨砂与用户手动关闭。

## 8. 已知限制与未实测

- **真实折射在 WebKit/Safari/iOS/Firefox 不可用**：目标浏览器只有磨砂降级；
  没有在真实 Safari/Firefox/iOS 上跑截图。本机为 Windows，Firefox/Safari 不在环境内。
- 没有用 Playwright；使用 Chrome DevTools Protocol 自带 headless 截图与像素检查。
- 软键盘、真实移动 GPU、iOS 旋转/安全区只在模拟视口验证，未在物理设备上认证。
- 顶栏/画廊 dotnav 的玻璃化是有意折中：顶栏展开态保留 Apple 的透明/`#fafafc`，
  dotnav 只加磨砂与高光，不改尺寸、圆点和暂停语义。若要求严格 1:1 Apple 或要求
  dotnav 也真实折射，需要重新确认取舍。
- Full 档依赖 Chromium 对 `backdrop-filter: url()` 的实现；当前验证覆盖
  Windows Chrome/Edge 156。没有做运行时像素探针，浏览器若未来回归会通过
  `CSS.supports + 家族门禁` 无法完全自动识别；届时会退到磨砂视觉但不会伪造折射。
- 大面板（侧栏、Inspector、搜索浮层、弹窗）优先可读性与性能，使用磨砂而非实时
  折射；只有浮在内容上方的小控件/菜单进入 Full 折射。

## 9. 回滚

**用户层面（无需改代码）**：书架 → 视图设置 → 玻璃效果 → “柔和”或“关闭”。
选择持久化，全站生效；刷新不丢失。

**源码层面**：玻璃系统是增量层，后端/数据库没有迁移。

1. 删除新增文件：
   `public/css/liquid-glass.css`、`public/js/liquid-glass.js`、
   `public/glass-lab.html`、`public/glass-lab-scene.svg`、
   `public/vendor/liquid-glass/`、`docs/LIQUID-GLASS.md`。
   玻璃测试与截图已按要求不在仓库中。
2. 撤销页面 `<link ... liquid-glass.css>`、`<script ... liquid-glass.js>`，
   以及 `shelf.html` 上的 `data-glass` / `data-glass-trigger` / 玻璃效果设置行。
3. 撤销 `chrome.js` 的 `data-glass="bar"`、`select.js` 的 trigger/menu glass 标记、
   `main.js` 的玻璃设置与 Escape 分支、`inspector.js` 的 collection pop 玻璃标记与
   外部关闭监听、`sw.js` 的 CACHE_VERSION/清单条目。
4. 恢复 `THIRD_PARTY_NOTICES.md` 中 Liquid Glass 段落。
5. 若已经提交，使用 `git revert <该提交>`；不要回滚本次工作区中与玻璃无关的
   导入/CSV 既有改动。

本工作区在你开始前已存在未提交的导入/CSV 改动；本次没有覆盖、删除或提交它们，
也没有创建 git commit。

## 10. 后续可改进

- 在真实 Safari/Firefox/iOS/Android 上跑一轮截图与 FPS，必要时把 Full 门禁改成
  运行时像素探针。
- 给全站加一个更显眼的“玻璃效果”设置入口（目前只在书架视图设置里）。
- 低端 Chromium 自动关闭色散三通道（保留单通道折射），进一步压低合成成本。
- 对播放视频/Canvas 背景引入 WebGL 纹理后端（当前不涉及）。
- 若未来要让侧栏/Inspector 也折射，需要单独验证大面积 `backdrop-filter` 在移动端
  的真实合成预算，而不是直接打开。

## 11. 文件清单

**新增（玻璃相关）**

- `public/css/liquid-glass.css`
- `public/js/liquid-glass.js`
- `public/glass-lab.html`
- `public/glass-lab-scene.svg`
- `public/vendor/liquid-glass/LICENSE`
- `public/vendor/liquid-glass/README.md`
- `docs/LIQUID-GLASS.md`

**修改（玻璃接入）**

- `THIRD_PARTY_NOTICES.md`
- `public/index.html`、`public/shelf.html`、`public/rank.html`、`public/stats.html`、
  `public/tags.html`、`public/notes.html`、`public/login.html`
- `public/js/chrome.js`、`public/js/select.js`
- `public/js/shelf/inspector.js`、`public/js/shelf/main.js`
- `public/sw.js`

> 工作区在本次开始前已存在与玻璃无关的导入 / CSV 未提交改动（`src/**`、
> 若干 `test/*.test.js`、`scripts/bench-migrations.js`、`test/import-custom-http.test.js`）。
> 本次没有覆盖、删除、提交或回滚这些改动；上面列出的文件中也有些在开始时已有
> 改动，本次只在其上追加玻璃接入。

**未改动**

- 后端/数据库/同步协议：`server.js`、`src/**`、`data/**`
- 既有内容层样式：`public/css/style.css`、`public/css/shelf-workbench.css`
- 书封/卡片/表格的 DOM 与布局

## 12. 复现命令

```bash
# 安装依赖
npm ci

# 全部测试（Windows 本机用 Electron-as-node 也等价）
npm test

# 源码公开性检查
npm run check:public

# 独立玻璃实验页（开发服务器启动后）
# http://127.0.0.1:<port>/glass-lab.html?glass=full
# http://127.0.0.1:<port>/glass-lab.html?glass=frost
# http://127.0.0.1:<port>/glass-lab.html?glass=solid
```

玻璃 Lab 中的按钮、菜单、压力条与 FPS 仅用于开发验证；它没有加入导航，也没有
注册额外的 Service Worker。
