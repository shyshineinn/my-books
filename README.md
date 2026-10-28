# My books

个人自部署图书管理系统，提供网页书库与配套安卓客户端。单管理员、多设备，默认私有访问。

[部署指南](docs/SELF_HOSTING.md) · [API](docs/API.md) · [同步说明](docs/SYNC_PROTOCOL.md) · [参与贡献](CONTRIBUTING.md)

## 功能

- 书目管理、搜索、标签、自定义字段与阅读统计。
- 电子书上传下载、封面和 Markdown 读书心得。
- CSV 导入导出、重复书合并与回收站恢复。
- 设备登录、安卓书目同步与版本冲突保护。

## 开始使用

克隆本仓库后，在项目目录执行：

```sh
cp .env.example .env
docker compose up -d --build
docker compose exec my-books npm run setup
```

首次配置后访问 `http://localhost:3000/login`。已有 `.env` 时不要覆盖。
Node.js 安装、公网接入、备份和升级见[部署指南](docs/SELF_HOSTING.md)。
自建后端暂不支持阅读位置、书签和标注同步。

## 许可证

[GPLv3](LICENSE) · [第三方及上游声明](THIRD_PARTY_NOTICES.md) · [安全报告](SECURITY.md)
