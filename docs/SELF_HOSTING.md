# 自部署：网页管理与安卓阅读

本阶段提供单管理员、多设备会话。默认书目、心得、封面和正文均需登录。
家庭多用户、阅读位置/标注的服务端同步与增量同步尚未包含。

## Docker

```sh
docker compose up -d --build
docker compose exec my-books npm run setup
```

按提示创建管理员（密码至少 12 字符），访问 `http://localhost:3000/login`。
安卓端在「设置 → 第三方服务 → My books → 配置服务器」输入同一账号。
局域网或公网访问应通过反向代理提供 HTTPS，并设置 `MYBOOKS_PUBLIC_URL` 为实际外部地址；
默认只绑定宿主机回环地址。反代不在宿主机上时，按网络结构显式调整端口绑定。

`mybooks-data` 卷包含数据库、封面、正文、心得与授权文件，升级时保留该卷。
管理员初始化在服务器终端执行，不开放远程抢注入口；重复执行不会覆盖账号。
自动化环境可用 `npm run setup -- --password-stdin` 从标准输入读取密码，
用户名通过 `MYBOOKS_ADMIN_USERNAME` 指定。

## 本地运行

```sh
npm ci
npm run setup
npm start
```

可用 `MYBOOKS_STORAGE_DIR` 指定持久化根目录，目录下分别为
`data/`、`uploads/`、`books-files/`、`notes-files/`。
未指定时沿用项目目录，不迁移或覆盖现有文件。
新库默认不添加示例书；仅当显式 `MYBOOKS_SEED_DEMO=true` 且库文件不存在时播种。

## 现有站点升级

- 先保存数据库一致性备份及上述所有目录，再更新代码。
- 现有 `ADMIN_TOKEN` 和 `data/admin-token` 仍有效，可在网页登录页交换为独立设备会话。
- **未配置管理员或旧令牌时，写入会被拒绝**，不再依赖 Nginx 是否保护写接口。
- 如需保持公开浏览，显式设置 `MYBOOKS_PUBLIC_READ=true`；写入仍需登录。
- 设备会话有效期 30 天；在 `/login` 查看、逐个撤销设备。密码不保存在客户端。
- 使用反代时配置 `MYBOOKS_PUBLIC_URL=https://你的域名`，启用 Secure cookie。
  只有确定代理网络可信时才配置 `MYBOOKS_TRUST_PROXY`（例如 `loopback`），
  不应无条件信任公网传入的转发头。
- 旧安卓安装包不能通过内置令牌自动适配私有模式，请使用带服务器登录设置的新版本。

## 数据保护与验证

备份必须包含数据库的一致性快照、附件、心得与 `data/auth.json`。
授权文件含密码哈希及设备令牌摘要，备份也应私有保存。
恢复到新的存储目录后验证登录、书目、文件下载和心得；不能只验证数据库能打开。
跨越数据结构升级回退时，应同时恢复匹配版本的数据库与程序。

`npm test` 把所有默认存储隔离到临时目录，验证鉴权、设备撤销、私有文件和已有业务规则。
开发时不把真实书库、授权文件、Cookie 或 APK 签名配置提交到仓库。
