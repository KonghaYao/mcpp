# MCPP Files：可选文件上传扩展

[文档库首页](index.md) · [MCP Extension](mcp-extensions.md) · [MCP Tools](mcp-tools.md)

本主题是 `io.mcpp/files` v1 的协议入口。不改变 MCP 2026-07-28 的 JSON-RPC、认证或无会话语义；二进制上传操作属于 **MCPP 自有可选扩展**，不是官方实验文件扩展的实现。设计背景及完整验收矩阵见[设计稿 03](../docs/design/03-mcpp-file-upload-design.md)。本主题不改变既有章节和条款编号。

## 能力与路由

Server MUST 在 `server/discover` 的 `capabilities.extensions` 中声明：

```json
{
  "io.mcpp/files": {
    "version": 1,
    "uploadPath": "/project/mcp-upload",
    "maxFileBytes": 134217728,
    "defaultTtlSeconds": 86400
  }
}
```

`uploadPath` MUST 为无 scheme、authority、query、fragment 和路径穿越的同源绝对路径。默认 `/mcp` 对应 `/mcp-upload`，`/project/mcp` 对应 `/project/mcp-upload`。Host MUST 同时检查该路径已获当前 endpoint 的凭据转发授权；同源不等于自动批准。服务端 MUST 拒绝上传与 MCP、Catalog、其他上传路由冲突；共享 Disk 的不同 endpoint MUST 使用不同 namespace。

Client MUST 在文件工具调用的 `params._meta["io.modelcontextprotocol/clientCapabilities"].extensions` 中声明 `"io.mcpp/files": { "version": 1 }`。未知版本不得猜测。未声明能力的文件调用 MUST 返回核心缺失客户端能力错误 `-32021`；普通工具不受影响。Host 未支持扩展时 MUST NOT 将文件工具提供给模型。工具目录不因客户端能力变化而临时注册或移除。

Server MUST 将能力、路径、限制和文件工具 schema 纳入 discovery 缓存版本；文件内容、上传响应、授权及 TTL 校验 MUST NOT 被 MCPP Response Cache 跳过。stdio MUST NOT 自动启用上传 listener 或声明不存在的 HTTP 上传能力。

## 上传契约

Host 向发现的路径发送 `POST`，正文 MUST 为单个文件的原始字节，不是 JSON、Base64 或 multipart。每次 POST 产生独立 ID，不提供幂等键、断点续传、去重或自动重试。

| 请求头               | 约束                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `MCPP-Files-Version` | 必填，固定 `1`                                                       |
| `Content-Type`       | 必填，声明 MIME；未知时 `application/octet-stream`，不代表内容已验证 |
| `MCPP-File-Name`     | 必填，`encodeURIComponent` 编码 UTF-8 显示名称，只解码一次           |
| `MCPP-File-Size`     | 必填，非负十进制安全整数，允许空文件                                 |
| `MCPP-File-Sha256`   | 可选，小写 64 位十六进制，提供则 MUST 校验                           |
| `Content-Length`     | 由 HTTP 栈设置；存在时 MUST 与声明和实际大小一致                     |
| `Content-Encoding`   | 只允许缺省或 `identity`                                              |

显示名称最多 255 UTF-8 字节，MUST 拒绝控制字符、NUL、`/`、`\`、`.` 和 `..`。名称不得参与存储 key 构造。请求不得指定 owner、namespace、存储位置或有效期。上传不携带伪造的 `Mcp-Method`、JSON-RPC ID 或 `_meta`。

只有 payload、实际大小、SHA-256、可选全局内容校验及 ready 元数据提交全部成功，才返回 `201`、`Content-Type: application/json`、`Cache-Control: no-store`：

```json
{
  "fileId": "f_Q5dS1lIRqUufLOwLcCdTQg",
  "name": "sample.csv",
  "mimeType": "text/csv",
  "size": 8,
  "sha256": "492d5ea496056f1a6a6592241032fab764c321596317930b4fa0e1e8bc3b7470",
  "createdAt": "2026-10-30T10:00:00.000Z",
  "expiresAt": "2026-10-31T10:00:00.000Z"
}
```

`fileId` MUST 为 `f_` 加 128 位密码学随机数的无填充 base64url 编码，满足 `^f_[A-Za-z0-9_-]{22}$`，不得覆盖或重用。ID 只是定位符，不是 bearer 凭证。响应不得含内部 key、磁盘路径、bucket、scope 或凭据。

错误体为 `{ "error": { "code": "FILE_TOO_LARGE", "message": "文件超过允许的大小", "retryable": false } }`。稳定分类：400 元数据/版本，401 身份，403 权限/Origin，413 超限，415 编码，422 长度/摘要/内容，408 超时，429 并发/额度，503 存储。连接断开时不保证收到错误体。响应丢失、网络错误、异常成功响应或后端不确定错误 MUST 按结果未知处理；`retryable` 不表示 POST 幂等。helper 不自动重发，也不自动重放工具。

## 文件工具

顶层字符串文件参数使用 `x-mcpp-file`，可含非负 `maxBytes` 与仅供选择提示的 `accept`。顶层数组可标记字符串 `items`，但 MUST 有有限 `maxItems`。标记出现在嵌套对象、`$ref` 或条件分支等不支持位置时 MUST 注册失败，不能静默忽略。普通字符串不视作文件。

```ts
const inputSchema = z.object({
  fileId: z
    .string()
    .regex(/^f_[A-Za-z0-9_-]{22}$/)
    .meta({
      "x-mcpp-file": { maxBytes: 8388608, accept: ["text/csv", ".csv"] },
    }),
});
```

工具包装器 MUST 在业务 handler 前完成本次 **所有** 文件的参数提取、ID 检查、已验证 scope、namespace、ready 完整性、未过期、payload 存在、实际大小和内容 validator 校验。任意文件失败，handler 不执行；中途失败释放已取得引用。MIME 和后缀不是内容安全判断。业务资源权限仍需单独检查，上传授权不等于导入或覆盖授权。

文件错误返回 `resultType: "complete"`、`isError: true`，结构化 `error.code`、`parameter` 和 `retryable`。不存在、其他 scope 和过期统一为 `FILE_UNAVAILABLE`；存储故障为 `FILE_STORAGE_UNAVAILABLE`，不得伪装成不存在。内容拒绝为 `FILE_REJECTED`，大小超限为 `FILE_TOO_LARGE`。

`ctx.files.require(id)` 只接受本次已声明并校验的 ID。`UploadedFile.info` 只读；`open()` 返回独立可取消 Web Stream；`peek(n)` 最多 64 KiB；`bytes({ maxBytes })` 同时检查元数据及实际读取；累计读取预算覆盖重复读取。`withLocalPath` 创建权限受限的临时副本，修改副本不改变正式对象，结束或取消时清理。请求结束后句柄失效，关闭遗留流，业务不得获得 Disk 或正式存储路径。

## 持久化、恢复及授权

FileService MUST 位于请求级 server factory 外部。存储直接注入 FlyDrive `Disk`；默认使用 FSDriver，S3 仅替换 Disk，禁用 ACL 的 bucket 使用 `supportsACL: false`，对象私有、不返回预签名 URL。FS `visibility: "private"` 不是目录访问控制，部署方 MUST 禁止静态暴露并限制目录权限。

固定 key 为 `uploads/{namespaceHash}/{fileId}/pending.json`、`payload` 和 `ready.json`。namespace 由部署配置产生，ownerScope 来自宿主稳定身份解析，不得来自原始 token、session、任意请求参数或自报身份头。上传与 MCP MUST 共用同一身份验证和权限映射；合法 token 刷新后同一身份应可复用。匿名本地部署也必须显式指定 scope。

顺序为 receiving pending → 流式计数/SHA-256/`Disk.putStream` → 检查后端长度与内容 → ready 候选写入确认 → 将 pending 改写为 committed（绑定 ready 原始 JSON 的 SHA-256）→ 尝试删除 pending。内部记录使用 `schemaVersion: 2`，wire 仍为 v1，不增加固定键。MUST 只有在正向持久确认成功后才返回 201。恢复时完整 v2 ready 必须与不存在的 pending（正常提交后清理）或摘要匹配的 committed pending 相配；原始 receiving pending、损坏确认及旧 v1 记录 MUST 保守拒绝，不能自动删除 pending 将迟到 ready 发布。

ready 写入期间超时/取消，不得再开始确认；因此故障标记无法写入也不会误发布。最终 committed 确认写入一旦发出可能不可撤回，超时/取消 MUST 返回 503 `UPLOAD_RESULT_UNKNOWN`，其后可能完成提交；不得把它说成确定取消成功。真正已确认后 pending 删除失败或未决不撤销成功，201 可先返回，后台清理仍被追踪。跨对象事务、原子 rename 和任意故障下的确定提交结果均不作保证。

调用方取消/截止 MUST 覆盖启动扫描等待、锁队列、exists/metadata 与工具读取等待；取消等待不等于底层结束。全局和 per-scope 上传额度 MUST 保留到实际 worker、Disk Promise、输入取消及提交后清理均结束。FlyDrive 2.2.0 S3Driver 不传 AWS `send` 的 `abortSignal`，传 options.signal 只会进入 Command input；本实现不据此伪称后端取消，也不修改驱动或绕过 Disk。上传停止输入但等待真实 Disk 完成，防止 putStream 因输入 error 先于内部 send/write 结束而释放额度。`close()` MUST 等待所有已启动扫描、队列、存储和不协作回调；不可取消操作永不 settle 时关闭保持 pending，由部署方配置存储超时/停机策略，不得在未关闭时重用 namespace。响应未知的成功副本按 TTL 回收。

默认上限 128 MiB，TTL 24 小时，上传截止 10 分钟，每 scope 4 并发，全服务 16 并发，每调用最多 64 文件及全局单文件上限的 8 倍累计读取，清理周期 1 小时，未完成宽限期为上传截止后 1 小时。代理与 Bun body limit 必须相容。到期立即拒绝新调用，活动引用可完成；获取引用和清理按文件串行协调。启动和周期扫描回收过期 ready、超期 pending 和损坏孤儿，失败保留可重试证据。参考实现只承诺单进程 namespace 管理，不承诺多实例协调。

Origin 白名单必须显式配置；预检允许扩展头并检查请求头及方法。无 Origin 的原生客户端仍需身份验证。远程使用 HTTPS，本地仅在受控 loopback 范围使用 HTTP，不允许重定向或第三方上传地址。

## SDK 接入与验证边界

- 服务端：`@peri-code/mcpp/files`，可选 peer `flydrive@2.2.0`；客户端：`@peri-code/mcpp/files/client`，不引入 FlyDrive、Node FS 或 AWS SDK。根入口和未启用 files 的 Worker gateway 不静态引入文件服务。
- 用 `createFileMount(fileService, { endpointPath, resolveScope, allowedOrigins })` 绑定授权和路由，传给 `startServer(..., { files })` 或 `GatewayRoute.files`；`fileScopeFor(requestContext)` 将已验证身份绑定到 `registerFileTool`。宿主负责 `fileService.close()`。
- 最小可运行示例：`bun packages/mcpp/src/files/example.ts`。示例仅绑定 `127.0.0.1`，显式匿名 scope，拒绝所有带 Origin 的请求；生产必须提供业务认证及目录隔离。
- SDK 2.0.0 的高层工具捕获异常；文件挂载仅为当前缺失能力的文件请求安装公开低层 `tools/call` 拒绝分支，保留核心 `-32021`，正常请求继续使用 SDK 分发。请勿绕过挂载直接对外服务文件工具。
- 回归测试包含真实 FlyDrive FS、真实 Bun HTTP JSON-RPC、S3Driver + 模拟 AWS Command 服务契约、Blob/CORS、失败与取消及 browser bundle 隔离。真实 S3 服务、真实 GUI 浏览器和多实例部署不属于这些测试的实测结论。完整记录见[设计稿验收](../docs/design/03-mcpp-file-upload-design.md#11-正向验收)。
