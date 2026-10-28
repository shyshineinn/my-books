# 第三方组件与来源

后端项目代码采用 [GPL-3.0-only](LICENSE)。下列组件继续按各自许可证提供，
项目许可证不取代第三方版权声明。用户导入的图书、封面、心得不属于源码许可范围。

## Node.js 依赖

版本以 `package-lock.json` 为准，安装后的许可证保存在各包目录中。
重新分发包含 `node_modules` 的归档或容器时，应保留这些文件和间接依赖的许可声明。

| 直接依赖 | 当前锁定版本 | 包声明的许可 |
| --- | --- | --- |
| express | 4.21.2 | MIT |
| multer | 2.0.2 | MIT |
| cheerio | 1.1.2 | MIT |
| marked | 18.0.11 | MIT |
| dompurify | 3.4.14 | MPL-2.0 OR Apache-2.0 |

前端通过 `/vendor/marked.umd.js` 和 `/vendor/purify.min.js` 提供安装包中的文件，
上游内嵌的许可头需要保留。依赖升级时请一并核查许可证与通知文件。

## 本地打包的扫码库

- 文件：`public/vendor/html5-qrcode.min.js`
- 项目：[html5-qrcode](https://github.com/mebjas/html5-qrcode)，作者 Minhaz 与贡献者。
- 版本：2.3.8；与发布包 `html5-qrcode@2.3.8/html5-qrcode.min.js` 的 SHA-256 一致：
  `660b12437b1d747e3e68b8be0685c08cb728140110ad213f167b14b66f8b1d8e`。
- 许可证：[Apache-2.0 全文](public/vendor/html5-qrcode.LICENSE)，
  [上游原文](https://github.com/mebjas/html5-qrcode/blob/v2.3.8/LICENSE)。
- 此构建包含 ZXing 解码实现；相关上游项目为 [zxing-js/library](https://github.com/zxing-js/library)。

## 安卓来源

配套安卓改版基于 [Huangder/Lumi_Books](https://github.com/huangder/Lumi_Books)。
安卓的 GPLv3 与字体、图标、渲染组件声明保留在其仓库的 `LICENSE` 和
`app/src/main/assets/licenses/` 中，不由本文件替代。
