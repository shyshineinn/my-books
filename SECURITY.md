# 安全报告

当前维护本仓库主分支。生产部署建议跟进修复；数据库升级前先做完整备份。

请通过仓库的 **Security → Advisories → Report a vulnerability** 私下报告：
[后端安全报告入口](https://github.com/shyshineinn/my-books/security/advisories/new)。
该入口需要仓库所有者先在 GitHub 启用 Private vulnerability reporting。
若入口不可用，可提交仅请求私下联系方式的 Issue，不要附漏洞细节、复现攻击或真实数据。

报告请包含受影响版本或提交、复现条件、影响和已脱敏的最小样例。
不要提交真实账号密码、设备令牌、Cookie、书库数据库、私钥或含凭据的完整日志。
维护者尚未承诺固定响应时间。

部署配置、普通功能问题请使用 Issue。凭据泄漏后应先撤销/轮换凭据，再处理仓库记录；
仅增加 `.gitignore` 或删除当前文件不会移除 Git 历史中的内容。
