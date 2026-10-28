# 接入 API

这是供配套客户端接入的核心接口说明，不是全部管理接口的枚举。
基地址是部署地址，例如 `https://books.example.com`；下列路径不带域名。
正文、封面、心得与书目默认需要登录，`GET /healthz` 和认证状态可用于服务探测。

## 认证

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/auth/status` | 返回 `service`、`auth_version`、`initialized`、`public_read` |
| POST | `/api/auth/login` | 使用账号密码换取独立设备会话 |
| GET | `/api/auth/me` | 检查当前会话 |
| GET | `/api/auth/devices` | 查看设备会话 |
| DELETE | `/api/auth/devices/:id` | 撤销设备会话 |
| POST | `/api/auth/logout` | 撤销当前会话 |

登录请求使用 JSON：

```json
{"username":"your-admin-name","password":"your-own-password","device_name":"Android phone"}
```

成功响应包含 `token` 与 `expires_at`；网页同时获得 HttpOnly Cookie。
客户端将设备令牌放在 `Authorization: Bearer <device-token>`，不要放在 URL 或日志中。
新接入使用独立设备会话，不在客户端内置旧版管理员令牌。
登录失败通常为 401，尚未初始化为 503；初始化只能在服务器终端进行。
浏览器跨站请求还受来源检查约束。

## 书目与同步

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/books` | 筛选后的书目数组，供网页浏览 |
| GET | `/api/books/:id` | 书目详情，含附件、标识符、心得状态和自定义字段 |
| POST | `/api/books` | 创建书目；至少提供非空 `title` |
| PATCH | `/api/books/:id` | 局部修改书目 |
| PUT | `/api/books/:id` | 兼容网页的书目更新接口 |
| DELETE | `/api/books/:id` | 默认软删除至回收站 |
| GET | `/api/books/trash` | 回收站 |
| POST | `/api/books/:id/restore` | 恢复回收站书目 |
| GET | `/api/sync/books` | 完整同步视图，拒绝筛选和分页参数 |

新客户端对书目的 PATCH、PUT、DELETE 应携带读取时的 `expected_uuid` 和
`expected_revision`，不要用手机时间决定谁覆盖谁。PATCH 示例：

```json
{"title":"修改后的书名","expected_uuid":"uuid-from-server","expected_revision":7}
```

版本或身份冲突返回 409、`code: "CONFLICT"` 和 `current` 书目。
客户端应保留本地修改并提示选择，不能把冲突当作普通网络错误反复覆盖。
旧客户端的 `expected_updated_at` 仍兼容；为了兼容，服务端并未强制所有旧请求携带版本。

同步应使用 `/api/sync/books` 的完整视图和明确删除记录，不能用 `/api/books` 的
筛选结果推断删除。响应验证、书库身份与删除事件语义见 [同步协议](SYNC_PROTOCOL.md)。
当前没有增量游标、阅读位置或标注同步 API。

## 附件与心得

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/books/:id/file` | 返回 `files` 列表 |
| POST | `/api/books/:id/file` | multipart 字段 `file`，上传电子书，单文件上限 80 MiB |
| DELETE | `/api/books/:id/file?format=EPUB` | 按格式删除该书的附件 |
| GET | `/books-files/:path` | 下载文件列表给出的相对路径 |
| GET | `/api/books/:id/notes` | 返回 `has_notes`、`content`、`size`、`updated_at` |
| PUT | `/api/books/:id/notes` | JSON 的 `content` 与可选的 `expected_updated_at` 保存心得 |
| DELETE | `/api/books/:id/notes` | 删除心得 |

文件上传与心得写入有各自的请求规则，不应假定书目的版本条件自动适用于全部写接口。
下载仍要发送认证；不要在反代中把附件目录改成绕过应用的公开静态目录。

## 错误处理

业务错误通常为 JSON 的 `error`（说明）与 `code`（程序判断）。
400 表示参数错误，401/403 需要处理认证或来源问题，404 表示资源不存在，
409 表示冲突，429 应降低重试频率。代理和网络故障不一定返回 JSON，客户端应保留本地数据。
