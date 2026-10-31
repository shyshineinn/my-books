# Liquid Glass 位移贴图来源

`public/js/liquid-glass.js` 是 My books 自研的无依赖实现。圆角矩形 SDF
（中心无位移、边缘朝法线方向弯折）生成位移贴图的思路与参数组织方式改编自：

- 项目：[tomagranate/liquid-glass](https://github.com/tomagranate/liquid-glass)
- 包名：`@tomagranate/liquid-glass`（MIT）
- 本文所依据的上游代码：`src/core/liquid-glass.ts` 中的
  `generateDisplacementMap` / `sdfRoundRect`（2026-10-31 拉取的 main）
- 许可：[MIT](LICENSE)，版权归上游作者 Tom 所有

本项目的实现差异：

- 不复制任何上游构建产物或 npm 依赖；用原生 JavaScript 重写贴图生成与滤镜构建。
- 只把 SVG 滤镜接到 `backdrop-filter` 上（Chromium），因此折射的是实时背景，
  不克隆 DOM、不复制整页背景图；WebKit/Firefox 只回退磨砂，不伪装折射。
- 位移贴图是静态的，不使用 `feTurbulence` 循环动画；滤镜按几何分桶复用并做引用计数。
- 色散由三条通道的轻微位移差合成；其余高光/阴影由 CSS 完成。

MIT 与项目的 GPL-3.0-only 兼容；重新分发时请保留本目录的 `LICENSE` 和
仓库根目录的 `THIRD_PARTY_NOTICES.md`。
