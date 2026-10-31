# My Books · Liquid Glass 设计系统统一与交互重构

- 日期：2026-10-31
- 分支：`feat/liquid-glass-design-system`
- 基线：`9560750`（`feat: 全站液态玻璃设计系统与实时折射`）
- 范围：仅 Web 前端（`public/**`、`test/**`、`docs/**`）
- 未改动：`server.js`、`src/**`、数据库 schema、同步协议、上传/元数据/搜索/藏书集等后端逻辑
- 未部署：没有写入生产站点或真实书库；所有交互与截图均在一次性演示库上完成
- 前置报告：折射引擎原理、Glass Lab 与性能基线见 [`LIQUID-GLASS.md`](LIQUID-GLASS.md)，本报告覆盖其后的设计系统统一与详情重构

## 1. 结果摘要

- 全站从「扁平 Apple + Tomo 暖米色 + 玻璃演示」混合状态，收敛为一套冷白 Liquid Glass：页面 `#f5f5f7`、内容 `#ffffff`、次级 `#f2f2f5`、文字 `#1d1d1f/#6e6e73`、交互色 `#0066cc`。
- 书架暖色变量、登录页彩虹/网格/光环全部移除；登录页改为中性白卡片。
- 保留并继续使用真实 SVG `feDisplacementMap` 折射引擎（Full / Frost / Solid 三档不变），仅把参数收敛到克制范围：折射 12、色散 0.12、饱和度 140%、小控件透明度 0.72–0.82。
- 新增一套 control / selected tokens，统一 `.btn`、`.btn-primary`、`.btn-ghost`、`.icon-btn`、`.seg`、`.sel-trigger`、`.wb-circle`、`.wb-view`、`.wb-layout-seg`、`.wb-inline-ok`、`.wb-action` 等控件；选中态不再使用黑底或纯蓝实底。
- 新增共享详情组件 `public/js/book-details.js`：书架 Inspector、全站右侧抽屉、手机底部 Sheet 共用同一份内容与逻辑；旧 `#detailModal` 及重复样式已删除。
- 双击书架书卡改为打开「编辑全部」；单击仍选中并打开 Inspector；Ctrl/⌘、Shift 多选、Enter、Escape 层级、移动端下滑与遮罩关闭均保留。
- 最终自动化：`npm test` **556 / 556 通过，0 失败**；`npm run check:public` 通过。
- 最终浏览器回归：6 个视口无横向溢出；详情/编辑/收藏集/状态/模式切换全部通过；页面控制台无未捕获错误。

## 2. 源码与文件清单

### 新增

| 文件 | 作用 |
| --- | --- |
| `public/js/book-details.js` | 统一书籍详情组件（464 行）：渲染、快捷编辑、标签/分类/文件、状态/评分/阅读记录、抽屉与手机 Sheet 行为 |
| `test/glass-engine.test.js` | 3 个引擎单测：档位解析、几何分桶、滤镜注册表复用/释放 |
| `test/ui-unification.test.js` | 5 个静态回归：冷白 token、克制玻璃参数、统一按钮 token、单一详情组件、资源版本接线 |
| `docs/liquid-glass-unification/before/*.png` | 11 张修改前截图 |
| `docs/liquid-glass-unification/after/*.png` | 10 张修改后截图 |
| `docs/LIQUID-GLASS-UNIFICATION.md` | 本报告 |

### 修改

| 文件 | 版本 | 主要改动 |
| --- | --- | --- |
| `public/css/style.css` | v112 | 冷白基色与 control/selected tokens；统一按钮/分段/下拉/图标按钮；`--glass-*` 别名指向新 token；共享 `.bd-*` 详情样式；删除旧 `.detail-*` 与首页实底按钮覆写 |
| `public/css/liquid-glass.css` | v3 | 玻璃参数收敛；侧栏/Inspector/菜单/顶栏按类型分级；移除登录彩虹场景与低 tint 账号规则；选中态引用 selected tokens |
| `public/css/shelf-workbench.css` | v36 | 书架三栏冷白化；控件改用 control tokens；移除黑/蓝实底选中；删除 Inspector 旧单书详情样式；手机 Inspector 遮罩与安全区 |
| `public/js/book-details.js` | v1 | 见上 |
| `public/js/shelf/inspector.js` | v37 | 改为挂载 `BookDetails`；保存后刷新网格/Inspector/facets；删除约 280 行重复渲染逻辑 |
| `public/js/common.js` | v43 | 删除旧详情模板；`openDetail` 改用 `BookDetails`；全站抽屉编辑保存后回到并刷新详情 |
| `public/js/chrome.js` | v38 | `#detailModal` 替换为 `#bookDetailModal` + `#bookDetailHost` |
| `public/js/modal.js` | v2 | 关闭时派发 `modals-closed`；Escape 保留选择菜单优先级 |
| `public/js/select.js` | v3 | 触发器/菜单材质标记，不改变原生选择逻辑 |
| `public/js/shelf/main.js` | v37 | 双击改为「编辑全部」；Escape 顺序：菜单 → 侧栏/Inspector/选择；遮罩关闭 Inspector |
| 8 个页面 HTML | — | 冷白/版本更新；`shelf.html` 增加详情宿主、遮罩、玻璃设置与 `seg--track`；全站加载 `book-details.js` |
| `public/sw.js` | v169 | SHELL_ASSETS 增补 `book-details.js`，CSS/JS 版本同步，旧缓存清理 |
| `docs/LIQUID-GLASS.md` | — | 顶部注明旧报告的控件/登录页/弹窗章节已被本报告覆盖 |

### 未改动

- 后端与数据：`server.js`、`src/**`、`data/**`、SQLite schema、`SYNC_PROTOCOL.md`
- 折射引擎：`public/js/liquid-glass.js`、`public/vendor/liquid-glass/**`、`public/glass-lab.html` 的场景与 FPS 工具
- 内容层 DOM：书封、卡片、表格、统计卡片、阅读内容、复杂表单

## 3. 各阶段改动说明

### 阶段 1 · 审计

确认三套 CSS 的职责与冲突点：`style.css` 同时承担品牌、旧详情与按钮；`shelf-workbench.css` 有一套 Inspector 单书详情；`liquid-glass.css` 有登录彩虹与暖色面板。详情入口实际有两套：`chrome.js` 注入的 `#detailModal` + Inspector 自绘。书架还保留 Tomo 暖米白（`#f6f5f2` / `#f7f6f3`）。按钮选中态混用黑底、纯蓝实底、白色浮起三种。

### 阶段 2 · Tokens 与材质

- `style.css :root` 新增 `--canvas/--surface/--surface-2`、`--control-*`、`--selected-*`、圆角与交互色；旧的 `--glass-*` 只作为别名，不再维护第二套值。
- 所有页面背景改为 `var(--canvas)`；书架侧栏为 `--surface-2`，主区为 `--surface`；细线用低对比中性分隔线。
- `liquid-glass.css` 的 token 改为：透明度 0.76、模糊 12px、饱和 140%、折射 12、色散 0.12；小控件按类型覆盖（搜索 0.92、顶栏 0.78、菜单 0.88、大面板白 tint 0.84），不改变真实折射链路。
- 内容层（封面、输入框、表格、统计、阅读正文）保持实体，不挂 `data-glass`。

### 阶段 3 · 统一按钮与选中态

- `.btn` / `.icon-btn` / `.sel-trigger` / `.wb-circle` / `.wb-view` / `.wb-action` 共用中性半透明玻璃底、细亮边、轻阴影、深色文字与 hover/active/focus/disabled 状态。
- `.seg--track` 作为分段轨道；`.seg button.active` 与 `.wb-layout-seg button.active` 为「更亮、略抬起的玻璃滑块 + 深色文字 + 蓝色底边标记」，不再整块蓝/黑。
- `.btn-primary` 仍是同一玻璃材质，只把文字/图标与描边转为蓝色；危险操作用同一系统的红色 tint。
- 下拉选项 `.sel-option.on` 采用 selected tokens + 蓝色勾选，不再实底蓝。

### 阶段 4 · BookDetails 统一详情

- `BookDetails.create(host, options)` 负责渲染与事件委托；宿主提供 `loadBook / patchBook / loadCollections / onClose / onEdit / onDelete / onChanged`，默认实现走现有 API。
- 支持：状态分段、评分、系列、出版信息、ISBN/豆瓣/标识符、简介、阅读记录、标签增删、藏书集增删/新建、电子书文件、自定义字段、编辑全部/读书心得/移入回收站。
- 桌面：右侧抽屉 + 幕布；手机 ≤819px：底部 Sheet + grabber 下滑关闭 + 遮罩关闭；关闭保留书架滚动与选中。
- Escape 顺序：详情内收藏集弹层 → 搜索/选择菜单 → Inspector/抽屉；任一时刻只有一个详情界面。
- 全量编辑仍使用 `#bookModal`（新增/编辑同一表单、全部字段与文件不变）；保存后通过 `onSaved` 回到并刷新详情；批量编辑与 ISBN 批量添加未合并。

### 阶段 5 · 页面适配

- **书架**：单击选中并开 Inspector；双击打开完整编辑；Ctrl/⌘ 与 Shift 保留；Enter 走同一编辑规则；手机单击打开底部 Sheet；Inspector 在 ≤1180px 变右侧浮层、≤819px 变底部 Sheet，带遮罩与安全区； Inspector 内容滚动，不遮底栏。
- **全站**：首页、榜单、统计、分类、心得点击书籍走同一 `BookDetails` 抽屉；登录页去彩虹；分类页按钮统一；顶栏/搜索/菜单保持原有交互与动画。
- **模式切换**：自动/完整/柔和/关闭四档，切换前后主区与顶栏宽度不变（实测 1184 / 1134px）。

### 阶段 6 · 清理与版本

- 删除旧详情 DOM/样式、Inspector 重复单书渲染、暖色变量、登录彩虹、黑/蓝实底选中、重复按钮覆写。
- 资源版本：style v112、liquid v3、shelf v36、chrome v38、common v43、modal v2、select v3、main/inspector v37、book-details v1、SW `v169`。
- 静态测试校验页面与 SW 版本一致，避免缓存半更新。

## 4. 被合并或删除的重复组件

| 原组件 | 处理 |
| --- | --- |
| `#detailModal` + `#detailBody` + `.detail-*`（`chrome.js` / `common.js` / `style.css`） | 删除；由 `#bookDetailModal` + `BookDetails` 取代 |
| Inspector 自绘单书详情（`.wb-meta`、`.wb-chip*`、`.wb-collection-pop`、`.wb-files`、`.wb-inspector-status` 等） | 删除；Inspector 直接挂载 `BookDetails`，仅保留多选面板样式 |
| `openDetail()` 的旧模板字符串与事件绑定 | 保留同名兼容入口，内部改为 `BookDetails.create`，其他页面无需改调用点 |
| `.seg button.active` 纯蓝实底、`.wb-view button.active` 黑底、`.wb-layout-seg button.active` 黑底 | 合并为 selected 玻璃滑块 |
| `.sel-option.on` 纯蓝实底 | 合并为 selected 玻璃 + 蓝勾 |
| 首页 CTA 实底蓝/描边覆写 | 删除，回归统一 `.btn-primary` |
| 登录页彩虹渐变、双层网格、光环伪元素、低 tint 账号玻璃 | 删除；改为中性白背景 + 静态白色账号卡片（磨砂，不假装折射） |
| 书架暖米白 `--wb-canvas/--wb-panel` 与 `rgb(247 246 243)` | 改为冷白 tokens |
| `.wb-search` 的厚重白底/强阴影、`.wb-search-close` 独立外观 | 合并为 control 玻璃，保留布局与 44px 触控尺寸 |

## 5. 详情交互（最终行为）

| 操作 | 行为 |
| --- | --- |
| 书架单击 | 选中书卡 + 打开 Inspector（`BookDetails`） |
| 书架双击 | 打开完整编辑 `#bookModal`；不再打开旧详情 |
| Ctrl/⌘ 点击、Shift 点击 | 多选逻辑保持不变 |
| Enter | 与双击一致，打开完整编辑 |
| Escape | 先关详情内弹层/菜单，再关 Inspector 或抽屉；每层只关最上层 |
| 移动端单击书卡 | 底部 Sheet；下滑 grabber 或点遮罩关闭；关闭保留滚动 |
| Sheet「编辑全部」 | 打开 `#bookModal`；保存后回到并刷新详情 |
| 全站其他页面点击书籍 | 右侧抽屉（手机为底部 Sheet），内容与 Inspector 完全一致 |
| 详情内快捷修改状态/评分/标签/分类 | 局部 PATCH，刷新 Inspector、网格与 facets；冲突时重载 |

## 6. 修改前后界面截图

截图目录：`docs/liquid-glass-unification/`。修改前来自一次性演示库；修改后同样使用一次性种子库。登录页修改前为「服务器未初始化」状态，因此只能对比背景与卡片材质，表单字段以修改后截图为准。

| 场景 | 修改前 | 修改后 |
| --- | --- | --- |
| 桌面书架 | [before/shelf-desktop.png](liquid-glass-unification/before/shelf-desktop.png) | [after/shelf-desktop.png](liquid-glass-unification/after/shelf-desktop.png) |
| 书架 Inspector | [before/shelf-inspector.png](liquid-glass-unification/before/shelf-inspector.png) | [after/shelf-inspector.png](liquid-glass-unification/after/shelf-inspector.png) |
| 完整编辑弹窗 | [before/edit-sheet.png](liquid-glass-unification/before/edit-sheet.png) | [after/edit-sheet.png](liquid-glass-unification/after/edit-sheet.png) |
| 旧详情弹窗 / 新详情抽屉 | [before/detail-modal.png](liquid-glass-unification/before/detail-modal.png) | [after/detail-drawer.png](liquid-glass-unification/after/detail-drawer.png) |
| 手机书架 390×844 | [before/shelf-mobile.png](liquid-glass-unification/before/shelf-mobile.png) | [after/shelf-mobile.png](liquid-glass-unification/after/shelf-mobile.png) |
| 手机详情 Sheet | [before/shelf-mobile-detail.png](liquid-glass-unification/before/shelf-mobile-detail.png) | [after/shelf-mobile-detail.png](liquid-glass-unification/after/shelf-mobile-detail.png) |
| 横屏书架 932×430 | [before/shelf-landscape.png](liquid-glass-unification/before/shelf-landscape.png) | [after/shelf-landscape.png](liquid-glass-unification/after/shelf-landscape.png) |
| 首页 | [before/home.png](liquid-glass-unification/before/home.png) | [after/home.png](liquid-glass-unification/after/home.png) |
| 首页旧详情 / 新抽屉 | [before/home-detail.png](liquid-glass-unification/before/home-detail.png) | [after/detail-drawer.png](liquid-glass-unification/after/detail-drawer.png) |
| 分类管理 | [before/tags.png](liquid-glass-unification/before/tags.png) | [after/tags.png](liquid-glass-unification/after/tags.png) |
| 登录页 | [before/login.png](liquid-glass-unification/before/login.png) | [after/login.png](liquid-glass-unification/after/login.png) |

## 7. 自动化测试结果

### 7.1 测试套件

```text
npm test                 556 tests / 556 pass / 0 fail   (23.5s)
npm run check:public     pass — 198 text files checked, 27 binary/large skipped
```

新增 8 个测试全部通过：

- `glass-engine.test.js`（3）：Full 只在 Chromium 解析；几何按尺寸分桶、参数受 token 限制；滤镜注册表复用、引用计数归零释放、ID 不冲突。
- `ui-unification.test.js`（5）：冷白 token 且无暖色/彩虹；玻璃参数克制且保留 `feDisplacementMap`；按钮/分段只使用 control token 且无黑蓝实底；只存在一套 `BookDetails` 且旧 `#detailModal` 已移除；页面/SW 版本与脚本顺序一致。

### 7.2 浏览器交互回归（CDP，最终版本）

| 检查 | 结果 |
| --- | --- |
| 双击书卡 | `editOpen: true`，`detailSheetOpen: false`，旧 `#detailModal` 不存在 |
| Inspector 快捷状态 | 想读 → 在读 → 想读，按钮态与列表同步 |
| Inspector 编辑保存 | 标题更新到 Inspector 与网格；保存后无残留弹窗；Inspector 保持打开 |
| 全站抽屉编辑保存 | 保存后抽屉重新打开并显示新标题 |
| Escape 层级 | 先关收藏集弹层，Inspector 仍开；再按一次关闭 Inspector |
| 收藏集新建 | 新建后 chip 出现，弹层关闭 |
| 抽屉 Escape / 遮罩 | 两种方式均关闭 |
| 手机 Sheet | 高 742.7px；关闭钮 44×44；grabber 36×4；内容可滚动；滚到底操作按钮可见；下滑关闭；无横向溢出 |
| 模式切换 | frost 0 滤镜、solid 0、full 5 滤镜 / 8 折射面、auto 5；主区 1184、顶栏 1134 全程不变 |

### 7.3 视口

| 视口 | 横向溢出 | Inspector 区域 | 详情可滚动 | 关闭钮 |
| --- | --- | --- | --- | --- |
| 390×844 | 无 | 8–382 × 122–780（底部 Sheet） | 是 | 44×44 |
| 768×1024 | 无 | 8–760 × 320–960（底部 Sheet） | 是 | 44×44 |
| 932×430 | 无 | 592–924 × 8–356（右侧浮层，底部让出 74px 给底栏） | 是 | 44×44 |
| 1024×768 | 无 | 684–1016 × 8–694 | 是 | 32×32 |
| 1440×900 | 无 | 1100–1432 × 8–892 | 是 | 32×32 |
| 1920×1080 | 无 | 1580–1912 × 8–1072 | — | 32×32 |

所有页面 `window.__pageErrors` 为空。

## 8. 浏览器视觉差异与已知限制

- **Chromium / Edge（Windows，Chrome 156）**：唯一进入 Full 实时折射的家族；书架实测 18 个玻璃面、8 个折射面、5 个共享滤镜。滚动、菜单开合、背景变化实时跟随。
- **Safari / iOS / Firefox**：按设计只走 Frost（blur + saturate + 边缘高光），没有背景形变，也没有克隆背景冒充折射。本机为 Windows，未在真实 Safari/Firefox/iOS 上截图；档位选择由单测覆盖（WebKit/Firefox UA、reduced transparency、saveData）。
- **无 backdrop-filter**：自动 Solid，文字与控件始终可用。
- **减少动态/透明度**：`prefers-reduced-motion` 关闭玻璃过渡；`prefers-reduced-transparency` 自动 Solid。
- **未实机验证**：真实移动 GPU、iOS 安全区/旋转、软键盘顶起、Safari 实机渲染。当前仅在 headless Chromium 的模拟视口与触摸事件中验证。
- **Headless 截图不是真机色彩**：合成器与 DPR 模拟会让透明度、模糊和高光看起来略强/略弱；不能替代真机验收。
- **横屏 932×430**：Inspector 高度为 348px，底部预留 74px 给底栏；操作区需要滚动才能看到，但可滚动且可点击。若希望横屏直接看到全部操作，需要单独调整该断点的面板高度。
- **玻璃搜索钮**：小控件为 78% 白 + 实时模糊，滑过深色书封时会透出背景色块，这是真实材质而非渲染错误；不接受透底可切到「柔和」或「关闭」。
- **Full 档依赖 Chromium 对 `backdrop-filter: url()` 的实现**：当前用 `CSS.supports` + 浏览器家族门禁，不做运行时像素探针；若未来浏览器回归，只会退回磨砂，不会伪造折射。
- **静态截图对比限制**：登录页修改前为未初始化状态；修改后为已初始化表单，只能对比背景与卡片材质。

## 9. 回滚方案

**用户层面（无需改代码）**：书架 → 视图设置 → 玻璃效果 → 「柔和」或「关闭」，即时生效并持久化，全站同步。

**源码层面**：本次没有后端、数据库或同步协议迁移，回滚只涉及静态资源。

当前分支改动尚未提交，可直接：

```bash
git restore public/css/style.css public/css/liquid-glass.css public/css/shelf-workbench.css \
  public/js/chrome.js public/js/common.js public/js/modal.js public/js/select.js \
  public/js/shelf/inspector.js public/js/shelf/main.js \
  public/index.html public/shelf.html public/rank.html public/stats.html public/tags.html \
  public/notes.html public/login.html public/glass-lab.html public/sw.js
git restore docs/LIQUID-GLASS.md
rm public/js/book-details.js test/glass-engine.test.js test/ui-unification.test.js
rm -rf docs/liquid-glass-unification docs/LIQUID-GLASS-UNIFICATION.md
```

若已提交，使用 `git revert <提交>`，不要改写历史或强制推送。回滚后如仍希望已访问过的客户端刷新缓存，把 `public/sw.js` 的 `CACHE_VERSION` 再递增一次（当前 `v169`）。

**注意**：不要用回滚去覆盖工作区中与本次无关的既有改动；回滚前先 `git status` 确认范围。

## 10. 复现命令

```bash
# 全部测试（本机 Git Bash 未把 node 加进 PATH 时使用绝对路径）
"C:/Program Files/nodejs/node.exe" scripts/test.js
"C:/Program Files/nodejs/node.exe" scripts/check-public.mjs

# 或在 Node 已在 PATH 的环境
npm test
npm run check:public

# 手工验证
# 1) 启动本地演示库（不要指向真实 data/）
# 2) 浏览器打开 /shelf 与 /glass-lab.html?glass=full|frost|solid
```

本报告中的交互回归使用一次性种子库 + Chrome DevTools Protocol headless 完成；未使用 Playwright，未访问生产服务器。
