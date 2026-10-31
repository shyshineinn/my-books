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

网页可额外传稳定的 `device_key`：同一浏览器重复登录会替换旧会话，避免设备列表堆积；
不传时行为不变，安卓客户端无需修改。
成功响应包含 `token` 与 `expires_at`；网页同时获得 HttpOnly Cookie。
客户端将设备令牌放在 `Authorization: Bearer <device-token>`，不要放在 URL 或日志中。
新接入使用独立设备会话，不在客户端内置旧版管理员令牌。
登录失败通常为 401，尚未初始化为 503；初始化只能在服务器终端进行。
浏览器跨站请求还受来源检查约束。

## 书目与同步

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/books` | 筛选后的书目数组，供网页浏览 |
| GET | `/api/home/feed` | 首页专用精选（featured/grid/gallery），避免全库传输 |
| GET | `/api/rank/feed` | 榜单专用（总数、已读数、重读榜） |
| GET | `/api/books/:id` | 书目详情，含附件（含持久化 SHA-256）、标识符、心得状态和自定义字段 |
| POST | `/api/books` | 创建书目；至少提供非空 `title` |
| PATCH | `/api/books/:id` | 局部修改书目 |
| PUT | `/api/books/:id` | 兼容网页的书目更新接口 |
| DELETE | `/api/books/:id` | 默认软删除至回收站 |
| GET | `/api/books/trash` | 回收站 |
| POST | `/api/books/:id/restore` | 恢复回收站书目 |
| GET | `/api/sync/books` | 完整同步视图，拒绝筛选和分页参数 |
| GET | `/api/sync/changes?cursor=...` | 协议 3 增量视图；首次省略游标 |
| GET | `/api/sync/reading/:id` | 安卓阅读数据与独立版本，始终要求会话 |
| PUT | `/api/sync/reading/:id` | 条件提交阅读数据，旧版本返回 409 |
| GET | `/api/sync/state` | 私有资料、设置与书架快照及独立版本 |
| PUT | `/api/sync/state` | 使用 `library_id`、`expected_revision`、`data` 条件提交快照 |
| PUT | `/api/sync/state/assets/:sha256.ext` | 二进制上传同步资源，最多 64 MiB，校验内容 SHA-256 |
| GET/HEAD | `/api/sync/state/assets/:sha256.ext` | 私有资源，支持强 ETag、SHA-256 与 Range/If-Range |

### 书目分页

`GET /api/books` 默认仍返回筛选后的完整数组，旧客户端不受影响。需要分页时传：

- `size`：每页条数，1~200 的十进制整数；
- `start`：起始偏移，默认 0，非负十进制整数，只在带 `size` 时生效。

分页响应仍是**数组**，总数放在响应头 `X-Total-Count`，并带
`Cache-Control: private, no-store`。`start` 越过末页返回空数组，`X-Total-Count`
仍是真实总数。非法参数返回 400 `VALIDATION`。排序末尾带 `id` 次级键，
因此相同时间戳的书跨页不会重复或遗漏。

```http
GET /api/books?status=done&sort=title&start=60&size=60
X-Total-Count: 173
```

常用筛选参数：`status=wish|reading|done`；`tag`（精确标签）；`author`（作者子串）；
`series`（系列名精确、大小写不敏感）；`collection=<id>`（手动藏书集成员）；`vl`
（虚拟书库作用域）。筛选与 `q` 按 AND 组合，非法 `collection` 返回 400。

### 检索排序

带 `q` 的自由词检索：省略 `sort` 或写 `sort=relevance` 时按 BM25 相关度排序；
显式传 `sort=title|author|series|finish|created|updated` 时，显式排序覆盖相关度。
含 `#字段`、布尔或否定的结构化检索始终按 `sort` 或默认 `updated` 排序。

自定义字段：数值字段支持 `#页数:>=300`（基于 `value_num` 索引）；布尔字段接受
`#重读:true` / `#重读:false` / `1` / `0`；枚举字段精确匹配。

首页和榜单使用专用 feed，不再拉取全库：

```http
GET /api/home/feed?grid=4&ent=16   -> {featured, grid[], gallery[]}
GET /api/rank/feed?size=8          -> {total, done, reread[]}
```

`grid`/`ent`/`size` 会被夹到合理范围；未传时使用 4/16/8。响应带
`Cache-Control: private, no-store`。

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
新客户端优先使用协议 3；增量为空不能推断删除。无效游标返回 `410 CURSOR_RESET`，
重新获取完整视图后继续做书库身份与版本检查。Web 端定位为管理端，阅读数据接口服务安卓多设备。

阅读数据 PUT 请求：

```json
{"library_id":"library-from-sync","expected_uuid":"book-uuid","expected_revision":0,"data":{"positions":[],"bookmarks":[],"notes":[],"reading_records":[],"tombstones":[]}}
```

成功响应包含 `book_id`、`book_uuid`、阅读 `revision` 与实际保存的 `data`。
阅读版本独立于书目版本；冲突响应的 `current` 是阅读数据，不是书目详情。
负载字段、删除与合并语义见 [同步协议](SYNC_PROTOCOL.md)。

便携快照最多 8 MiB，先上传资源，再条件提交引用它的状态；响应为 `library_id`、`revision`、`data`。
版本冲突返回 `409 CONFLICT` 及 `current`，客户端重新合并后提交。所有 `/api/sync/state` 接口始终要求设备会话，
公开书库模式也不会公开个人资料。协议 3 增量头的 `portable_sync` 与 `portable_revision` 声明能力及当前状态版本。
书籍身份通过 `data.bookIdentities` 的 `mybooks-ID → UUID` 对照校验；逐本阅读内容继续走阅读接口，禁止混入便携快照。

### 手动藏书集

藏书集是独立分组，不修改书目元数据，也不推进 `revision`；删除分组不会删书。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/collections?vl=` | 返回 `[{id,name,count}]`，可按虚拟书库收窄计数 |
| POST | `/api/collections` | `{name}` 新建，名称大小写不敏感唯一，重名 409 |
| PUT | `/api/collections/:id` | `{name}` 重命名 |
| DELETE | `/api/collections/:id` | 删除分组，书目保留 |
| POST | `/api/collections/:id/books` | `{ids:[]}` 批量加入，幂等，单次最多 1000 本 |
| DELETE | `/api/collections/:id/books` | `{ids:[]}` 批量移除 |

书目详情响应中的 `collections` 字段给出该书所属分组。回收站里的书不计入分组计数；
恢复后原有关系仍然保留。安卓同步协议不包含藏书集。

### CSV 导入导出

`GET /api/export.csv` 接受与 `/api/books` 相同的筛选参数（含 `collection=<id>`、`vl`），
返回固定列 + 自定义字段；`collections` 列是所属手动藏书集名称，多个用逗号连接。
`POST /api/import.csv` 首行必须是表头，至少包含 `title` / `书名`；支持 `collections` /
`collection` / `藏书集` 列（逗号、顿号、分号分隔），导入时按名称自动创建藏书集并加入，
重复成员幂等。`duplicate=ignore` 跳过的行不会改动藏书集；`dry_run=1` 仍只预览不写库。
新建或合并书籍与藏书集归属在同一事务中提交，非法藏书集名称会整本回滚。

### 作者、标签与系列列表

`GET /api/authors`、`GET /api/tags` 与 `GET /api/series` 默认（不带参数）仍返回全量数组，
兼容既有页面与工具。传入任一筛选/分页参数后，响应仍是数组，但匹配总数放在 `X-Total-Count`：

| 参数 | 说明 |
| --- | --- |
| `q` | 名称子串，`%`/`_` 按字面量匹配；最多 200 字 |
| `limit` | 返回条数，1~200，默认 200 |
| `offset` | 起始偏移，非负整数 |
| `vl` | 虚拟书库作用域，同其他分类接口 |

```http
GET /api/authors?q=王&limit=80
X-Total-Count: 34
```

筛选与分页路径只统计在架书，排除 0 本作者/标签；作者与系列按名称排序，标签按引用数排序。
系列项仍带 `min_index`/`max_index`/`label`。非法 `limit`/`offset` 返回 400 `VALIDATION`。

标签/作者的 `rename`、`merge`、`delete` 写操作默认仍附带最新全量列表；大库管理端可带
`?with_list=0`，只返回 `{ok:true,...}`，再按搜索/分页自行拉取。

## 附件与心得

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/books/:id/file` | 返回 `files` 列表（含 `sha256` 与 `download_url`） |
| POST | `/api/books/:id/file` | multipart 字段 `file`，上传电子书，单文件上限 80 MiB |
| DELETE | `/api/books/:id/file?format=EPUB` | 按格式删除该书的附件 |
| GET | `/books-files/:path` | 兼容旧客户端的静态路径，不校验摘要；新客户端不要使用 |
| GET | `/api/books/:id/files/:fileId/content?uuid=...` | 强 ETag、SHA-256 和 Range/If-Range 正文续传；已登记摘要与实际文件不一致时返回 `409 FILE_INTEGRITY` |
| GET | `/api/books/:id/notes` | 返回 `has_notes`、`content`、`size`、`updated_at` |
| PUT | `/api/books/:id/notes` | JSON 的 `content` 与可选的 `expected_updated_at` 保存心得 |
| DELETE | `/api/books/:id/notes` | 删除心得 |

文件上传与心得写入有各自的请求规则，不应假定书目的版本条件自动适用于全部写接口。
下载仍要发送认证；不要在反代中把附件目录改成绕过应用的公开静态目录。
新客户端下载使用详情文件项的 `download_url`，不得将设备令牌拼入 URL。
206 必须核对 Content-Range 与验证器；文件替换导致 200 时应重新写入，不能追加旧片段。

## 错误处理

业务错误通常为 JSON 的 `error`（说明）与 `code`（程序判断）。
400 表示参数错误，401/403 需要处理认证或来源问题，404 表示资源不存在，
409 表示冲突，429 应降低重试频率。代理和网络故障不一定返回 JSON，客户端应保留本地数据。
正文摘要不一致返回 `409 FILE_INTEGRITY`，需重新上传该格式文件后再下载。
