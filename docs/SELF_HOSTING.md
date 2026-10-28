# 自部署：网页管理与安卓阅读

本阶段提供单管理员、多设备会话。默认书目、心得、封面和正文均需登录。
家庭多用户、阅读位置/标注的服务端同步与增量同步尚未包含。

## Docker

```sh
git clone https://github.com/shyshineinn/my-books.git
cd my-books
cp .env.example .env
docker compose up -d --build
docker compose exec my-books npm run setup
```

按提示创建管理员（密码至少 12 字符），访问 `http://localhost:3000/login`。
安卓端在「设置 → 第三方服务 → My books → 配置服务器」输入同一账号。
局域网或公网访问应通过反向代理提供 HTTPS，并设置 `MYBOOKS_PUBLIC_URL` 为实际外部地址；
默认只绑定宿主机回环地址。反代不在宿主机上时，按网络结构显式调整端口绑定。

`mybooks-data` 卷包含数据库、封面、正文、心得与授权文件，升级时保留该卷。
Compose 从 `.env` 读取端口 `MYBOOKS_PORT`、`MYBOOKS_PUBLIC_URL` 和 `MYBOOKS_PUBLIC_READ`；
容器内固定使用 `/data`，不会使用示例中的本地 `MYBOOKS_STORAGE_DIR`。
管理员初始化在服务器终端执行，不开放远程抢注入口；重复执行不会覆盖账号。
自动化环境可用 `npm run setup -- --password-stdin` 从标准输入读取密码，
用户名通过 `MYBOOKS_ADMIN_USERNAME` 指定。

## 本地运行

推荐 Node.js 24。Node 不会自动加载 `.env`，初始化与服务必须使用同一套存储配置：

```sh
npm ci
cp .env.example .env
node --env-file=.env scripts/setup-admin.js
node --env-file=.env server.js
```

PowerShell 可用 `Copy-Item .env.example .env`。
已有 `.env` 时保留自己的配置，不要用示例覆盖。
不使用配置文件时，可以设置系统环境变量后执行 `npm run setup` / `npm start`。
可用 `MYBOOKS_STORAGE_DIR` 指定持久化根目录，目录下分别为
`data/`、`uploads/`、`books-files/`、`notes-files/`。
未指定时沿用项目目录，不迁移或覆盖现有文件。
新库默认不添加示例书；仅当显式 `MYBOOKS_SEED_DEMO=true` 且库文件不存在时播种。

## 反向代理与已有部署脚本

通用代理模板见 [nginx.example.conf](../deploy/nginx.example.conf)，默认回源到本机 3000；
公网使用前配置 HTTPS，再将 `MYBOOKS_PUBLIC_URL` 设为外部 HTTPS 地址。
不要给私有附件配置 `Cache-Control: public`，也不要用 Nginx 的公开静态目录绕过应用鉴权。

`deploy/update.sh` 和 `deploy/ecosystem.config.js` 保留为现有 PM2 部署使用，
包含特定路径与端口，不是开箱即用的通用安装器。代理配置请使用上述通用模板。
尤其 `update.sh` 按项目内 `data/` 等目录备份，不支持任意 `MYBOOKS_STORAGE_DIR`；
使用外部存储或 Docker 卷时应按实际存储位置备份，不能直接照搬该脚本。

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
