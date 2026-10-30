# MCPP 文件上传扩展设计

- 日期：2026-10-30
- 状态：v1 参考实现已落地；本地 FS/HTTP 与模拟 S3 契约已验证，真实 S3/GUI 浏览器待部署验收
- 基础协议：MCP 2026-07-28
- 扩展标识：`io.mcpp/files`，扩展版本 `1`
- 存储选型：FlyDrive，默认本地文件系统，可配置 S3 兼容存储。

规范性入口见 [`MCPP/19-mcp-files.md`](../../MCPP/19-mcp-files.md)，实际 TypeScript API 见 `packages/mcpp/src/files/index.ts`；实现映射和验证结果见 §10、§11。实现提交 `5402645` 基于 `6177478`，合并时适配 main 的 `9b49fb9` 文档编号与 Market 移除结果；不恢复已删除的市场实现。

MCPP 提供统一的文件上传入口。Host 将文件上传到 MCP Server 的 `/mcp-upload`，获得 `fileId`，随后在普通 `tools/call` 参数中传递这个 ID。Server 在工具执行前校验文件，业务通过只读文件接口获取元数据和内容。

文件字节不进入模型上下文，也不装进 JSON-RPC。上传接口与 MCP Server 属于同一个服务和授权边界；本地部署不需要外部存储服务。FlyDrive 是进程内依赖，S3 是部署方可选的后端。

## 1. 已确定的设计

| 项目         | 决定                                                          |
| ------------ | ------------------------------------------------------------- |
| 上传方式     | `POST /mcp-upload`，请求体为单个文件的原始字节                |
| 工具参数     | 使用不可猜测、不可修改的 `fileId`                             |
| 文件复用     | 同一 MCP endpoint、同一授权范围内，在有效期内可被多个工具使用 |
| 能力发现     | `server/discover` 声明 `io.mcpp/files`；客户端逐请求声明支持  |
| 文件参数声明 | JSON Schema 使用本扩展的 `x-mcpp-file` 标记                   |
| 存储         | 直接使用 FlyDrive 的 `Disk` 和现成驱动                        |
| 文件索引     | 少量 JSON 元数据与文件一起保存，不额外引入数据库              |
| 业务接口     | 元数据、流式读取、受限读取、临时本地路径、内容校验钩子        |
| 性能要求     | 正常流式读写、大小限制、失败清理；不设吞吐量或延迟优化目标    |
| 首版范围     | HTTP 上传、文件引用、工具校验、到期清理                       |

首版不包含分片、断点续传、秒传、内容去重、浏览器直传 S3、公共下载接口或文件共享管理。默认单进程运行；协议身份和文件记录不依赖 MCP 会话。多实例协调不属于首版参考实现的承诺。

## 2. 与官方 MCP 草案的关系

截至上述日期，官方工作组的 [File Uploads Extension 草案](https://github.com/modelcontextprotocol/experimental-ext-file-uploads/blob/6101d34eb52b21d4b87028543ecd1fd59ed3d5df/specification/draft/file-uploads.md) 仍属于实验性扩展，[PR #1](https://github.com/modelcontextprotocol/experimental-ext-file-uploads/pull/1) 尚未合并。该版本采用结构化文件参数及 MRTR 上传请求，MRTR 扩展点仍待规范支持。

| 维度     | 官方实验草案                            | 本设计                            |
| -------- | --------------------------------------- | --------------------------------- |
| 扩展标识 | 暂定 `io.modelcontextprotocol/files`    | `io.mcpp/files`                   |
| 参数形态 | 文件元数据对象，可含 Base64 `data`      | 上传成功后的 `fileId` 字符串      |
| 调用顺序 | 工具调用 → 请求上传 → 上传 → 延续原调用 | 上传 → 获得 ID → 普通工具调用     |
| 文件标记 | `x-mcp-file`                            | `x-mcpp-file`                     |
| 文件绑定 | 与原工具调用及其参数绑定                | 与 endpoint、授权范围及有效期绑定 |
| 外部服务 | 不强制第三方存储                        | 默认完全本地运行                  |

本设计是 **MCPP 自有的可选协议扩展**，不是已经被通用 MCP Client 实现的官方上传标准。`/mcp` 继续遵循核心 JSON-RPC 语义，新增 HTTP 端点的行为由本扩展定义。普通客户端不会因为看见一个文件参数，就自动具备上传能力。

先上传再调用工具意味着：上传阶段只校验上传权限、全局限制和可独立检查的内容；工具参数中的目标目录、业务资源权限等仍在 `tools/call` 时检查。文件暂存在上传区，业务工具成功前不能把它当成已导入的业务数据。

未来适配官方扩展时，可以复用 FlyDrive 和业务只读接口；需要单独增加官方文件参数与 MRTR 流程适配，不能只替换扩展名称或把官方调用内 `id` 当成可跨工具复用的 `fileId`。

## 3. 职责边界

| 模块                    | 职责                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| Agent Host              | 取得已授权的本地文件或附件，上传字节，将返回的 ID 提供给模型或填入工具参数 |
| MCPP Client 文件 helper | 发现能力、构造上传请求、处理结果；不读取任意未授权本地路径                 |
| 上传 HTTP handler       | 鉴权、限制检查、字节计数、摘要计算、写入与提交元数据                       |
| FileService             | 文件归属、到期判断、元数据管理、只读句柄与清理                             |
| 工具包装器              | 提取文件参数，统一完成文件校验后再执行业务 handler                         |
| FlyDrive                | 文件和 JSON 元数据的存取、列举、删除，以及后端差异适配                     |
| 业务 handler            | 内容格式判断、业务规则、解析和业务数据持久化                               |

FileService 是文件生命周期与授权服务，不再定义一套 `StorageBackend`、`LocalBackend`、`S3Backend`。存储后端直接注入 FlyDrive `Disk`。

FileService 必须创建在请求级 `McpServer` factory 外部，由上传 handler 和所有工具请求共享。HTTP 无状态表示不依赖 MCP Session，不表示文件只能保存在请求内存中。

## 4. 能力发现与路由

### 4.1 Server 声明

以下是 `server/discover` 返回内容中的相关部分。其余核心字段仍按 MCP 2026-07-28 生成。

```json
{
  "capabilities": {
    "tools": {},
    "extensions": {
      "io.mcpp/files": {
        "version": 1,
        "uploadPath": "/mcp-upload",
        "maxFileBytes": 134217728,
        "defaultTtlSeconds": 86400
      }
    }
  }
}
```

| 字段                | 约束                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `version`           | 首版固定为 `1`；不认识的版本不得按 v1 猜测处理                   |
| `uploadPath`        | 同源绝对路径，不含 scheme、authority、query、fragment 或路径穿越 |
| `maxFileBytes`      | 非负安全整数；客户端预检，服务端再次强制执行                     |
| `defaultTtlSeconds` | 默认文件有效期；具体文件以返回的 `expiresAt` 为准                |

Client 在文件相关 `tools/call` 的 `params._meta` 中声明：

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    "name": "peri",
    "version": "1.0.0"
  },
  "io.modelcontextprotocol/clientCapabilities": {
    "extensions": {
      "io.mcpp/files": { "version": 1 }
    }
  }
}
```

没有服务端声明时，Client 不尝试上传，也不回退为 Base64。没有客户端声明时，普通工具照常工作；Host 不向模型提供需要此扩展的文件工具，服务端收到这类调用时使用核心协议的缺失能力错误处理。文件工具目录保持稳定，不按连接临时注册或移除工具。

能力与限制变更必须更新相关 discovery 缓存版本。文件内容、上传响应和文件授权检查不进入 MCPP Response Cache；相同 `cacheVersion` 不能跳过权限和有效期检查。

### 4.2 路由与身份范围

| MCP endpoint   | 默认上传路径          |
| -------------- | --------------------- |
| `/mcp`         | `/mcp-upload`         |
| `/project/mcp` | `/project/mcp-upload` |
| `/review/mcp`  | `/review/mcp-upload`  |

每个上传路径绑定一个明确的 MCP endpoint 和稳定的 `namespace`。共享同一 Disk 的不同 endpoint 必须使用不同 namespace。网关必须检查上传路由与 MCP 路由、Catalog 路由以及其他上传路由之间的冲突。Client 使用发现结果中的路径，并校验其属于连接配置允许的上传路由；不能让一个 Child endpoint 指向另一个 Child 的上传入口。

`/mcp-upload` 必须与对应 `/mcp` 使用同一套认证和业务身份解析，部署时将两者明确绑定为同一受保护资源。**同源本身不等于有权转发凭据**；不能把官方草案针对 MCP URI 路径的凭据规则直接套到这个兄弟路径上。

首版不允许上传重定向，不接受第三方上传 URL。远程连接使用 HTTPS；本地开发沿用 MCP 的 loopback 边界。浏览器接入复用现有 Origin/CORS 策略，并显式允许本扩展的请求头。

## 5. 上传 HTTP 契约

### 5.1 请求

```http
POST /mcp-upload HTTP/1.1
Authorization: Bearer <现有 MCP 凭据>
Content-Type: text/csv
Content-Length: 8
MCPP-Files-Version: 1
MCPP-File-Name: sample.csv
MCPP-File-Size: 8

a,b
1,2
```

示例正文使用 LF 换行，最后一行也有 LF，共 8 字节。浏览器由运行时设置 `Content-Length`，Client helper 不手工设置浏览器禁止的请求头。

| 字段                 | 必填           | 语义                                                     |
| -------------------- | -------------- | -------------------------------------------------------- |
| 认证信息             | 按现有部署要求 | 与对应 MCP endpoint 使用相同身份，不新增上传账户         |
| `MCPP-Files-Version` | 是             | 固定 `1`                                                 |
| `Content-Type`       | 是             | 声明的 MIME；未知时为 `application/octet-stream`         |
| `MCPP-File-Name`     | 是             | `encodeURIComponent` 编码的 UTF-8 显示文件名；只解码一次 |
| `MCPP-File-Size`     | 是             | 原始字节数，十进制非负安全整数；允许 `0`                 |
| `MCPP-File-Sha256`   | 否             | 原始字节的 SHA-256，小写 64 位十六进制；提供则必须校验   |
| `Content-Length`     | 由 HTTP 栈决定 | 存在时必须与声明大小及实际读取大小一致                   |

请求体只有文件字节，不使用 JSON、Base64 或 `multipart/form-data`。不接受非 identity 的 `Content-Encoding`，避免大小和摘要出现不同解释。传输层可分块发送，但发送前必须知道文件总大小；未知大小的源由 Host 先计量或暂存。

文件名解码后默认最多 255 个 UTF-8 字节，不允许控制字符、NUL、`/`、`\`、`.` 或 `..`。它只用于显示，不参与存储路径构造。文件的租户、所有者、存储 key、有效期不由上传请求指定。

这是本扩展定义的二进制 HTTP 操作，不是核心 MCP JSON-RPC POST。因此不伪造 `Mcp-Method`、JSON-RPC ID 或请求体 `_meta`；扩展版本由 `MCPP-Files-Version` 明确表达。

### 5.2 成功响应

只有文件写入成功、大小与可选客户端摘要匹配、完整元数据提交成功后，才返回 `201 Created`。

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

响应设置 `Content-Type: application/json` 和 `Cache-Control: no-store`。其中 `size` 与 `sha256` 来自服务端读取的实际字节；`mimeType` 是规范化后的客户端声明，**不表示已验证真实格式**。文件路径、bucket、存储 key、凭据不出现在响应中。

`fileId` 使用 `f_` 加 128 位密码学随机数的无填充 base64url 编码，字符串格式为 `^f_[A-Za-z0-9_-]{22}$`。它是定位符，不是 bearer 授权凭证。不得复用已失效的 ID，也不得覆盖同一 ID 的文件内容。

### 5.3 重试与不确定结果

v1 的 POST 不提供幂等键。每次重新上传生成新 ID，即使内容相同也如此。

- 请求在提交前失败：不返回可用 ID，残留文件进入清理流程。
- 服务端提交完成但响应丢失：Client 得到“结果未知”，不得把本地生成的 ID 当成成功结果。
- 重新发送文件可能生成一个重复副本，旧副本由有效期清理；Client helper 默认不自动重发 POST。
- 上传成功后工具调用失败：可继续使用同一个未过期 ID，不必重新上传。
- 工具调用响应丢失：遵循业务工具自身的幂等语义，文件 helper 不自动重放工具。

这些行为避免为第一版增加幂等数据库，同时明确网络异常下的结果边界。

## 6. 工具声明与业务接口

### 6.1 文件参数 Schema

```json
{
  "name": "analyze_csv",
  "description": "分析已上传的 CSV 文件",
  "inputSchema": {
    "type": "object",
    "properties": {
      "fileId": {
        "type": "string",
        "pattern": "^f_[A-Za-z0-9_-]{22}$",
        "description": "当前服务器上传接口返回的文件 ID",
        "x-mcpp-file": {
          "maxBytes": 8388608,
          "accept": ["text/csv", ".csv"]
        }
      }
    },
    "required": ["fileId"],
    "additionalProperties": false
  }
}
```

`maxBytes` 是工具接受的实际文件大小上限，缺省使用 Server 上限。`accept` 只供文件选择和前置提示，不能凭扩展名或声明 MIME 判定内容安全。JSON Schema 本身也不会执行文件系统或存储校验。

v1 支持顶层字符串文件参数，以及顶层数组的字符串 `items` 标记；文件数组必须定义有限 `maxItems`。文件标记出现在 `$ref`、条件分支或其他首版不支持的位置时，工具注册失败，不能静默忽略。普通字符串参数不会被误当成文件。

工具调用仍是普通 MCP 请求：

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "analyze_csv",
    "arguments": {
      "fileId": "f_Q5dS1lIRqUufLOwLcCdTQg"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "peri",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": {
          "io.mcpp/files": { "version": 1 }
        }
      }
    }
  }
}
```

发送到 `/mcp` 时照常携带核心 HTTP headers，包括版本、`Mcp-Method: tools/call` 和 `Mcp-Name: analyze_csv`。

### 6.2 服务端校验顺序

工具包装器必须在业务 handler 执行前，检查本次调用中**全部**文件参数：

1. 校验工具参数及文件 ID 格式，取得已经验证的业务授权范围。
2. 读取完整文件元数据，检查 endpoint namespace 与文件归属。
3. 检查文件已提交、未过期、对应对象可用，大小符合全局和工具限制。
4. 执行业务注册的文件内容校验函数；任何一个文件不通过，整个工具 handler 不执行。
5. 将通过检查的文件句柄放入本次调用的 `ctx.files`，随后执行业务逻辑。

上传权限和业务操作权限分别检查。拿到合法文件 ID 不代表可以把文件导入任何项目、覆盖任何文档或替他人执行操作。

### 6.3 TypeScript 接口

以下契约已由参考实现提供；`registerFileTool` 的 `inputSchema` 使用仓库已有 Zod 4，并将 `.meta({ "x-mcpp-file": ... })` 原样投影为 JSON Schema。宿主通过 `createFileMount` 共用上传与 MCP 的 `resolveScope`，工具绑定 `scope: () => fileScopeFor(requestContext)`。

```ts
interface FileScope {
  key: string; // 经业务身份验证的稳定授权范围，不是客户端传入值
}

interface UploadedFileInfo {
  fileId: string;
  name: string;
  mimeType: string; // 客户端声明，不是内容验证结论
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

interface UploadedFile {
  readonly info: Readonly<UploadedFileInfo>;
  open(): Promise<ReadableStream<Uint8Array>>;
  peek(maxBytes: number): Promise<Uint8Array>;
  bytes(options: { maxBytes: number }): Promise<Uint8Array>;
  withLocalPath<T>(use: (path: string) => Promise<T>): Promise<T>;
}

interface ToolFileContext {
  require(fileId: string): Promise<UploadedFile>;
}

type FileValidator = (
  file: UploadedFile,
  context: { signal: AbortSignal },
) => Promise<void>;
```

上传 handler 由宿主先验证 Request，再调用拟新增的 `fileService.handleUpload(request, { scope })`。工具侧从 MCP 请求上下文得到同义的 `FileScope`，传入包装器。两条入口必须复用同一身份映射规则；`FileScope.key` 写入内部记录的 `ownerScope`，每次访问重新验证。匿名本地模式也使用部署方显式指定的 scope，不能从任意请求参数推导。

接口语义：

- `require` 只接受本次工具参数中声明并授权的文件 ID，不能借此枚举同一存储中的其他对象。
- `open` 每次返回独立、可取消的只读流；对外使用 Web Stream，FileService 内部适配 FlyDrive 的 Node Readable。
- `peek` 最多读取指定字节数，默认实现限制为 64 KiB；业务可检查文件头，但文件头识别不能替代完整解析。
- `bytes` 先检查元数据，再在读取过程中强制执行上限；不允许无上限地把文件读入内存。
- `withLocalPath` 为依赖文件路径的解析器创建临时副本，回调结束后在 `finally` 中清理。不能直接暴露正式存储路径，回调修改临时文件不改变原文件。
- 句柄只在当前工具执行期间有效；请求结束或取消后关闭未消费完的流并释放临时文件。
- 不直接把 FlyDrive 的 `Disk` 或完整文件对象交给业务，避免绕过授权或直接删除、覆盖文件。

建议提供 `registerFileTool` 包装现有 `server.registerTool`。Schema 中的 `x-mcpp-file` 是大小与选择提示的唯一声明源；内容 validator 作为服务端代码注册，不序列化到 wire。

```ts
// 使用示意；definition.inputSchema 使用 Zod 4，完整可运行版本见 files/example.ts。
registerFileTool(
  server,
  {
    definition: csvToolDefinition,
    validators: {
      fileId: async (file) => {
        if (file.info.size === 0) throw new FileValidationError();
        // 完整的 CSV 语法、列数等规则由所选解析器检查。
      },
    },
    async handler(args, ctx) {
      const file = await ctx.files.require(args.fileId);
      const data = await file.bytes({ maxBytes: 8 * 1024 * 1024 });
      return analyzeCsv(data);
    },
  },
  { fileService, scope },
);
```

业务解析器对压缩包展开大小、图片尺寸、行数等自身资源消耗负责；上传字节上限不能代替这些业务约束。

## 7. FlyDrive 接入与持久化

### 7.1 依赖和配置

新增入口为 `@peri-code/mcpp/files`；客户端纯 HTTP helper 放在 `@peri-code/mcpp/files/client`。文件服务及 FlyDrive 不从现有根入口静态加载，客户端入口不能引用 FlyDrive、Node 文件系统或 AWS SDK。

FlyDrive 作为文件服务入口的可选 peer dependency；启用上传的应用显式安装。只有配置 S3 的应用才额外安装 AWS SDK 两个依赖。这样已有 MCPP 使用者不会因为不用的上传功能自动引入云存储依赖。

```ts
import { Disk } from "flydrive";
import { FSDriver } from "flydrive/drivers/fs";

const disk = new Disk(
  new FSDriver({
    location: "/var/lib/mcpp/files",
    visibility: "private",
  }),
);

// createFileService 已由 @peri-code/mcpp/files 提供。
const fileService = createFileService({
  disk,
  namespace: "project-mcp",
  uploadPath: "/project/mcp-upload",
  maxFileBytes: 128 * 1024 * 1024,
  ttlSeconds: 24 * 60 * 60,
});
```

本地目录不挂静态 HTTP 路由，目录权限由部署方限制。[FlyDrive 文档](https://flydrive.dev/docs/services/fs) 明确说明 FSDriver 的 `visibility` 本身不控制本地文件如何被对外服务，因此不能只设置 `private` 就宣称完成访问控制。

S3 配置只替换 `Disk`，业务接口和 wire 不变。对象保持私有；禁用 ACL 的 bucket 或不支持 ACL 的兼容服务配置 `supportsACL: false`，由 bucket policy 控制访问。所有上传字节仍经过 MCPP Server，不返回预签名地址。

FlyDrive 官方定位为 Node ESM 库；参考实现固定 `flydrive@2.2.0`（Node >= 24 声明）并记录 lockfile，已在 Bun 1.4.3 / macOS 上验证真实 FS 和真实 S3Driver 的模拟 AWS 服务契约。尚未连接真实 S3，也未在 CI 的 Bun 1.4.0 上实测；类型兼容不等于运行时验证，此服务端入口不承诺 Cloudflare Workers 部署。

### 7.2 文件记录

每个上传使用三个由服务端生成的 key。`namespaceKey` 为配置 namespace 的稳定编码或摘要，不能使用未经处理的请求字段。

| Key                                            | 内容                                    | 写入时机                                             |
| ---------------------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| `uploads/{namespaceKey}/{fileId}/pending.json` | 接收状态及绑定 ready 摘要的持久提交确认 | 正文前写 `receiving`；ready 写入确认后写 `committed` |
| `uploads/{namespaceKey}/{fileId}/payload`      | 原始文件字节                            | 流式接收期间                                         |
| `uploads/{namespaceKey}/{fileId}/ready.json`   | 完整候选 FileRecord                     | 全部校验通过后，持久确认之前                         |

```ts
interface FileRecord extends UploadedFileInfo {
  schemaVersion: 2;
  namespace: string;
  ownerScope: string;
  payloadKey: string;
}
```

FileService 通过固定 key 直接读取 `ready.json`，不为一次工具调用扫描目录。`ownerScope` 来自已经验证的业务身份，例如租户与用户的稳定组合；不能使用客户端任意 header、原始 token 或 MCP session ID。token 刷新后，只要业务身份与权限仍然相同，既有文件应继续可用。

默认要求 namespace、ownerScope 同时匹配。需要工作区内共享时，由业务身份解析器在确认成员权限后提供工作区级 scope；ID 本身不授予共享权限。

### 7.3 写入和可见性

1. 完成认证、Origin、版本、声明大小、文件名与额度预检，生成随机 ID，写入 `pending.json`（`schemaVersion: 2`、`state: "receiving"`，含创建时间、截止、namespace、ownerScope 和 payloadKey）。启动扫描等待也计入上传截止，并在任何存储等待前占用额度。
2. 将请求流连接到 FlyDrive `putStream`，途中计算实际大小和 SHA-256；向后端提供已声明的长度与 MIME。
3. 超限、断流、超时或不匹配时停止输入；若 Disk 操作不可取消，继续追踪并等待它 settle，不因 HTTP 已返回释放额度。FlyDrive 2.2.0 的 `putStream` 会在输入 error 时先于内部写入完成而 reject，因此计数/摘要失败通过终止输入并保留错误处理，不把早退 Promise 当作后端已结束。
4. 等待 payload 底层写入成功，再检查对象实际长度；运行可选全局内容 validator。
5. 写入完整 `ready.json` 候选记录，并等待 Disk 确认。若此阶段超时/取消，不再启动任何提交确认；原始 receiving pending 与迟到 ready 的组合始终不可读，包括重启之后。不依赖失败后第二次补写 failed 标记。
6. 再次检查截止/取消，随后将 pending 改写为 `state: "committed"`，包含 `fileId`、`namespace` 以及该 ready 原始 JSON 的 SHA-256（`readySha256`）。只有此持久确认成功才算提交并返回 201。该最后写入发出后可能不可撤回，等待时超时/取消返回 503 `UPLOAD_RESULT_UNKNOWN`，而非宣称未提交；后端迟到成功可能产生可恢复文件。
7. 尝试移除 pending。此时已经提交，清理失败或未决不撤销成功；HTTP 可先返回 201，但清理仍占用上传额度且由 close 等待。

恢复条件：完整合法的 v2 ready 与不存在的 pending（仅正常确认后清理可删除 pending），或完整合法的 v2 ready 与正确绑定其摘要的 committed pending。原始 receiving pending、损坏/不匹配的确认、旧 `schemaVersion: 1` 均保守拒绝，超宽限后回收；不自动迁移或发布旧记录。wire 扩展版本仍为 1，内部记录版本改为 2。

这修正了原“ready 单写即提交”的决定：在仅使用三个固定键、不假设原子 rename/跨对象事务、同时容忍不可取消迟到写入的条件下，必须保存可恢复的正向确认。pending 改写中断时保守视为未提交；无法确认最后确认写入结果时明确报告未知，不凭内存状态伪造确定性。返回 201 仅表示 Disk 已确认候选及持久确认写入，不额外承诺跨机器事务或硬件持久性。

取消约束：上传、工具启动等待、锁队列及 metadata 存储等待都能及时结束调用方等待；真实后端/业务 worker 继续追踪，取消后的 worker 在每次 await 后检查信号，不得再启动后续操作。FlyDrive 2.2.0 FSDriver 的 `signal` 透传不等于 S3Driver 支持取消：真实 S3Driver 将未知 options 放进 Command input，却用 `client.send(command)` 而非 `send(command, { abortSignal })`。参考实现不把无效 signal 塞入 S3 Command，不改 node_modules、不绕过 Disk；停止输入并等待真实 Promise 完成。全局/per-scope 额度一直保留到该 worker（含输入取消和提交后清理）结束。

`fileService.close()` 停止接收新工作、通知输入/句柄取消，等待启动扫描、队列、存储、业务回调和临时资源真正完成。不可取消的后端或不协作 handler 永不 settle 时，close 也保持 pending；不提供假成功或强杀后端保证。部署方需要自己的存储网络超时与停机策略，不能在 close 未完成时重用同一 namespace。

### 7.4 生命周期与清理

默认有效期 24 小时，可由服务端配置调整。工具调用不自动续期，也不把临时上传转成永久业务文件。需要长期保存时，业务工具负责把内容纳入自己的持久化对象和权限体系。

到期以服务端时间为准：新工具调用立即拒绝；物理回收允许延后。已经取得有效句柄的正在执行调用可完成读取，单进程引用计数保证清理任务跳过这些对象，调用结束或取消后释放引用。同一文件的有效期检查、获取引用和开始清理需要串行协调，避免“检查成功后、增加引用前”被回收；多文件预检中途失败也必须释放已经取得的引用。

FileService 在启动恢复和周期任务中执行以下清理：

- 有已确认的 v2 ready 且未过期：保留 payload；可以清理 committed pending，清理失败继续可读。
- 有已确认 ready 且已过期、无活动引用：回收文件与元数据。
- 原始 receiving pending 与候选 ready 并存：不可用，不得自动删除 pending 将其发布；超过截止与宽限期、无活动操作后整体回收。
- 只有 pending、超过上传截止时间及宽限期、无活动写入：回收残留。
- 元数据缺失或损坏的对象：仅在超过宽限期且排除活动写入后回收，不能误删正在发布的文件。
- 删除失败：保留足以重试的记录或由下一次前缀扫描发现孤儿；不得把存储错误解释成“已清理”。

扫描只发生在清理阶段，普通读写使用确定 key。首版可使用 FlyDrive 的前缀列举能力；不为常规规模引入额外索引数据库。

参考实现只允许一个进程管理同一 namespace 的写入与清理。S3 后端本身不代表具备多实例协调；如果以后需要多个实例共同服务，必须补充跨进程活动引用、清理互斥和共享额度管理，不能沿用进程内引用计数宣称完成。

## 8. Host 如何让 Agent 使用

客户端接口已由 `createFileClient` 提供，内部处理上传能力发现与 HTTP 契约：

```ts
interface FileUploadSource {
  name: string;
  mimeType: string;
  size: number;
  body: ReadableStream<Uint8Array> | Uint8Array | Blob;
}

interface McppFileClient {
  upload(
    source: FileUploadSource,
    options?: { signal?: AbortSignal },
  ): Promise<UploadedFileInfo>;
}
```

Host 将 helper 绑定到一个已经配置的 MCP endpoint 和认证提供者。它可以从用户附件上传，也可以暴露本地 helper tool，例如 `mcpp_upload_file({ server, localPath })`。这里的本地 tool 由 Host 持有，它在自身文件访问权限内打开路径，再上传字节；远端 Server 不能通过一个字符串读取 Agent 的本地文件。

Host 保存 `(endpoint, authorization scope, fileId)` 的关联，并向模型返回文件 ID、名称、大小和有效期。模型调用远端工具时只传 ID；不把本地路径、字节或认证信息塞进参数。用户切换身份或 endpoint 后不能复用原关联。

Host 可以把“选附件 → 上传 → 调用工具”包装为一次用户操作。只有选择了目标 Server 并满足既有文件发送授权策略后才上传，不因为文件参数描述文字出现了一个路径就自动读取它。

## 9. 错误和运行边界

上传失败使用 HTTP 状态码和统一 JSON 错误体：

```json
{
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "文件超过服务器允许的大小",
    "retryable": false
  }
}
```

| HTTP 状态 | 错误码示例                                                    | 处理                                 |
| --------- | ------------------------------------------------------------- | ------------------------------------ |
| 400       | `INVALID_UPLOAD_REQUEST`、`UNSUPPORTED_FILES_VERSION`         | 修正元数据或版本                     |
| 401       | `UNAUTHENTICATED`                                             | 使用现有 MCP 认证流程                |
| 403       | `UPLOAD_FORBIDDEN`                                            | 上传权限或 Origin 不满足             |
| 413       | `FILE_TOO_LARGE`                                              | 拒绝并停止接收                       |
| 415       | `UNSUPPORTED_CONTENT_ENCODING`                                | 使用未压缩的原始字节                 |
| 422       | `FILE_SIZE_MISMATCH`、`FILE_DIGEST_MISMATCH`、`FILE_REJECTED` | 内容或声明不匹配，不提交文件         |
| 408       | `UPLOAD_TIMEOUT`                                              | 终止当前上传；重新发起可能产生新文件 |
| 429       | `UPLOAD_LIMIT_REACHED`                                        | 并发或额度受限；可带 `Retry-After`   |
| 503       | `FILE_STORAGE_UNAVAILABLE`                                    | 后端故障；不能据此推断旧请求未提交   |

连接已经断开时，不保证 Client 能收到错误体。`retryable` 仅表示故障可能恢复，不表示 POST 幂等或授权自动重试。

工具侧文件不可用或内容不符合规则，返回 `resultType: "complete"`、`isError: true` 的工具结果，并提供稳定的结构化错误码与参数位置。不存在、不属于当前 scope、已过期统一为 `FILE_UNAVAILABLE`，避免通过错误差异查询其他用户文件。大小不符或业务格式拒绝可返回 `FILE_TOO_LARGE`、`FILE_REJECTED`。存储故障使用 `FILE_STORAGE_UNAVAILABLE`，不能伪装成文件不存在。

| 默认参数          | 建议值                | 说明                         |
| ----------------- | --------------------- | ---------------------------- |
| 单文件上限        | 128 MiB               | 部署方可改，发现结果必须一致 |
| 文件有效期        | 24 小时               | 长任务可配置更长时间         |
| 单次上传截止时间  | 10 分钟               | 包含接收与提交阶段           |
| 同 scope 并发上传 | 4                     | 全服务并发上限也需配置       |
| 清理周期          | 1 小时                | 到期拒绝访问不等待清理       |
| 未完成文件宽限期  | 超过上传截止后 1 小时 | 同时要求无活动写入           |

反向代理、Bun HTTP body limit、FileService 上限必须一致。正常路径不把完整文件先转成 Buffer，不提供无大小限制的读取 API。日志只记录请求 ID、内部文件 ID、字节数、耗时与错误码，不记录 token、文件字节或敏感业务内容。

## 10. 与现有 MCPP 的结合点

源码历史基线：[KonghaYao/mcpp，commit 6177478](https://github.com/KonghaYao/mcpp/tree/6177478061ab164a4f24ad585e4a99f6b0c64229)。实现提交为 `5402645`，当前规范路径按 main 的编号规则列在下表；参考实现包含 `files/protocol.ts`、`errors.ts`、`service.ts`、`upload.ts`、`handle.ts`、`http.ts`、`tool.ts`、`client.ts`、`index.ts`、`example.ts` 与三组回归测试。

| 现有位置                                      | 需要形成的最终行为                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `MCPP/01-index.md`、`MCPP/02-introduction.md` | 新增文件上传主题；明确核心协议保持原义，二进制端点由可选扩展规定       |
| `MCPP/13-mcp-extensions.md`                   | 登记 `io.mcpp/files` 的发现、版本和最低实现面                          |
| `MCPP/08-mcp-tools.md`                        | 引用 `x-mcpp-file` 与工具执行前校验要求                                |
| 新增 `MCPP/19-mcp-files.md`                   | 本文协议条款的权威入口，避免散落在实现 README                          |
| 新增 `packages/mcpp/src/files/`               | FileService、上传 handler、文件工具包装器和客户端 helper               |
| `packages/mcpp/src/server/start.ts`           | 显式分发上传路由与核心 MCP 路由；不把二进制请求送入 `createMcpHandler` |
| `packages/mcpp/src/gateway.ts`                | 每条 GatewayRoute 可绑定文件服务；统一检查精确路径冲突                 |
| `packages/mcpp/src/server/cache.ts`           | 合并扩展声明时保留已有 cache capability；文件状态不进入响应缓存        |
| `packages/mcpp/package.json`                  | 增加独立子入口和可选依赖声明，保护现有根入口与客户端构建               |

基线 `startServer` 直接将 Request 交给 MCP handler；实现已按精确路径先分流上传。Gateway 通过 `GatewayRoute.files` 具名挂载并检查冲突，不把写上传藏进只读 `fallback`。`createFileMount` 显式配置 `resolveScope` 和 `allowedOrigins`；没有默认任意 scope。

现有 `createMcppServerFactory` 每次 HTTP 请求创建独立 Server，文件服务应在外部共享，再按请求绑定已验证 scope。注册文件工具时合并 `capabilities.extensions`，不得覆盖已有的 Skills、Apps 或 Cache 声明。

stdio 模式继续使用现有文件访问机制；首版不在 stdio 自动开启 HTTP listener，也不声明一个实际不存在的上传端点。通用 Worker 路由保留原行为，只有配置并能运行文件服务的部署才声明上传能力。

## 11. 正向验收

以下是完整验收条件，不缩减为 local only。当前自动化验证区分真实 FS/HTTP、真实 S3Driver 加模拟服务契约与未实测部署环境；实际结果记录在本节表后。

| 场景                 | 必须满足                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| 本地完整流程         | 发现能力 → 上传 → 得到 ID → 工具读取，字节与 SHA-256 一致                    |
| S3 完整流程          | 只替换 Disk 配置，同一客户端流程和业务接口可用                               |
| 空文件与二进制       | 空文件可上传，二进制逐字节保真；工具可独立拒绝空文件                         |
| 文件复用             | 同 scope 的两个工具使用同一 ID，无需二次上传                                 |
| 重启恢复             | 重启后未过期 ready 文件仍可用，pending 不会被当成完成文件                    |
| 身份与 endpoint 隔离 | 换用户、租户或 Child endpoint 后不能使用原 ID；合法 token 刷新不误伤         |
| 长度与摘要           | 提前超限、实际超限、少传、多传、摘要不符均不得发布可用文件                   |
| 中断与提交失败       | 断流、磁盘满、S3 失败、ready 写入失败均无伪成功；残留可被回收                |
| 响应丢失             | 客户端报告结果未知；重传副本不会触发业务工具或覆盖旧文件                     |
| 内容判断             | 伪 MIME、改后缀等不能绕过业务 validator；文件失败时业务 handler 未执行       |
| 多文件调用           | 任一文件校验失败，不执行业务；数组数量与累计读取受限                         |
| 生命周期             | 到期立即拒绝新调用；活动读取与清理不冲突；取消释放流和临时副本               |
| 浏览器上传           | File/Blob、Unicode 文件名、CORS 预检及取消行为符合契约                       |
| 无扩展兼容           | 普通 MCP tools 正常；不会凭空开启上传、旧握手或额外 stdio 服务               |
| Bun 与依赖隔离       | 所选 FlyDrive 发行版在 Bun 下通过 FS/S3 基本场景；仅导入 client 不加载云 SDK |
| 基本资源表现         | 并发限制生效；上传内存不随完整文件大小线性堆积；临时数据可清理               |

### 11.1 本次验证记录

环境：macOS、Bun 1.4.3、MCP Server SDK 2.0.0、FlyDrive 2.2.0、AWS SDK 3.1147.0。初轮 446 pass 并不证明可交付；独立验证报告判定 FAIL，额外探针发现 F1–F3，下面的修复和复验记录替代初轮生命周期结论。所有命令前台完成，不把后台任务启动当成通过。

| 验收面                             | 实际证据与范围                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本地完整链路、复用、空文件、二进制 | 真实 FlyDrive FS；真实 Bun HTTP listener 经 client Blob 上传并 tools/call；两个工具复用同一 ID；字节和 SHA-256 一致                                                |
| S3 完整流程                        | 真实 S3Driver、真实 AWS Command，替换 Disk 后经相同 gateway/discover/client/tools/call 流程；远端响应为内存模拟，不是真实 S3 服务                                  |
| 重启及身份隔离                     | 新建 FileService 从同 Disk 恢复 ready；其他 scope/namespace 统一不可用；请求身份映射复用测试，未接真实 OAuth/租户系统                                              |
| 长度、摘要、中断和提交故障         | 提前/实际超限、少传/多传、Content-Length、摘要、输入断流、putStream 故障、ready 部分写、迟到写入、删除失败重试；磁盘满/S3 故障为故障注入，不是实际填满磁盘或云故障 |
| 响应丢失                           | 完成上传后模拟响应丢失，helper 只发一次 POST；重传生成不同 ID，未触发业务 handler                                                                                  |
| 内容、多文件                       | validator 检查实际文件头；数组任一失败均阻止业务；不支持标记位置注册失败；中途失败释放引用，累计读取受限                                                           |
| 生命周期                           | 到期立即拒绝；活动引用阻止清理；正式对象与临时副本隔离，句柄结束失效；取消关闭操作并清理临时副本                                                                   |
| 浏览器契约                         | Bun 的 Blob/Unicode、CORS 预检、Origin 拒绝和 AbortSignal 回归；client browser bundle 成功，无 FlyDrive/Node FS/AWS；未运行真实 GUI 浏览器                         |
| 无扩展兼容                         | 普通工具不要求文件声明；缺失文件能力为真实线级 -32021；stdio 未声明 files 且无额外 listener；未启用 files 的 gateway 可 browser bundle                             |
| 资源边界                           | 全服务和 per-scope 并发分别验证；16 MiB 按 64 KiB 块写真实 FS，观察未消费输入不超过 4 块，ready 确认前不可读；这是有界缓冲回归，不是 RSS/性能基准                  |
| 最小示例                           | 独立子进程运行 example.ts，经 discover → upload → inspect_file 后 SIGTERM；退出码 0，临时存储目录已移除                                                            |

验证命令（均在 `/Users/mino/code/mcpp-files`）：

```sh
bun test
# F1–F3 修复后：464 pass，0 fail，31 files
bun test packages/mcpp/src/files
# F1–F3 修复后：52 pass，0 fail，3 files
bun test packages/mcpp/src/server/cache.test.ts
# 6 pass，0 fail
bun run --cwd packages/mcpp typecheck
bun run typecheck
# 根命令检查 packages/mcp-market，不替代 MCPP 包独立检查
```

改动的 TypeScript/JSON/Markdown 文件使用 `bunx prettier --check` 检查；`git diff --check` 检查空白错误。lockfile 检查确认原有依赖的版本、integrity 和依赖元数据均未变，只新增文件功能依赖；安装器将既有空 registry 字段填为当前 registry URL。

仍待部署验收：真实 S3/兼容服务与 bucket policy、真实 GUI 浏览器/代理 CORS、实际业务认证、CI Bun 1.4.0、物理磁盘满及进程级 RSS。多实例引用/清理协调不属于 v1 承诺。未搜索或输出任何凭据，也未将模拟服务结果写成真实云端实测。

### 11.2 独立验证 F1–F3 修复记录

独立报告 `.peri/plans/verification-report.md` 的 verdict 为 FAIL；原 446 项测试未覆盖真实未决资源和迟到提交恢复，不能用其绿色结果宣称可交付。本次由同一实现 owner 修复，报告本身未修改，等待同一验证者复测。

| 缺陷 / 原探针    | 修复与同场景证据                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 / Check 7     | 上传 receipt 与真实 worker 分离，额度跟随后者直到 settle。原四次阻塞写入探针变为 `[408,429,429,429]`，outstanding/peak 均为 1；gate 未释放时 close 保持 pending，释放后 outstanding 为 0。新增 per-scope 独立测试。                                                        |
| F1 / Check 8     | 真实 Disk/S3Driver/AWS Command 测试阻塞 pending 和 payload 两类 PUT，均为 `[408,429,429]`、一个未决 PUT、close 未提前返回。另有原生 signal 探针确认 Command input 有 signal 而 send options 无 abortSignal；取消后 send 不 settle。服务不再传无效 signal，不伪装远端取消。 |
| F2 / Check 9     | 真实 Disk/FS 与原报告内存 driver 两种注入：ready 写入前 408、当时无 ready、failed 标记写入不可用、释放迟到 ready 后，同进程与重启均为 FILE_UNAVAILABLE。旧 receiving pending 不会被启动扫描改成成功。                                                                      |
| F2 / 成功分支    | committed 正向确认成功后 pending delete 失败，201 与同 Disk 重启读取 `[7]` 保留；delete 阻塞时 HTTP 201 可先返回但 close 必须等待。最后 committed 写入未决时报告 UPLOAD_RESULT_UNKNOWN，迟到确认可能产生可读文件，不说成已取消。                                           |
| F3 / Check 6、10 | 启动扫描、碰撞 exists、payload metadata、工具 exists/metadata/锁队列/getStream 分别阻塞。25ms 上传截止不等待 gate；工具取消不等待 gate，返回 FILE_CANCELLED 而非 FILE_UNAVAILABLE；底层仍阻止 close，释放后不会继续发新存储操作。                                          |
| 取消后的业务     | 不协作业务回调、临时副本回调与流仍被 close 追踪；取消只提前结束等待，不把后台资源算作结束。回调必须协作或最终 settle，才能完成关闭。                                                                                                                                       |

原 Check 6、7、9、10 的 stdin 探针已重放（Check 7 将“await close 后 release”改成先观察 close 未完成、再 release，避免正确实现下死锁）：

```text
Check 6: configuredTimeoutMs=25, settledBeforeStorageRelease=true, status=408
Check 7: statuses=[408,429,429,429], outstandingWrites=1, peakWrites=1, closeReturned=false
Check 7: outstandingWritesAfterClose=0
Check 9: statusBeforeReadyWrite=408, readyExistedAtResponse=false
sameProcess=FILE_UNAVAILABLE
afterRestart=FILE_UNAVAILABLE
Check 10: settledAfter50MsBeforeStorageRelease=true, errorCode=FILE_CANCELLED
```

新增 `lifecycle.test.ts`（15 项）以及真实 S3Driver 新增 3 项契约测试；修复后 files 共 52 pass，全量 464 pass。MCPP 与根 typecheck 通过；服务端 bun、client browser、gateway browser 三个内存构建通过。格式和 diff 检查执行于改动文件。不把这些结果当作独立 verifier 已给 PASS；真实 S3、GUI 浏览器、生产代理和认证等部署限制仍见 §11.1。

内部存储状态修正见 §7.3：三个键不变，记录 v2；旧 v1 记录拒绝并按宽限清理，不自动迁移。最后提交确认未决是不可避免的不确定结果边界；不可取消后端永不 settle 时额度及 close 持续等待，部署需设置存储网络超时，不强行声称安全释放资源。

### 11.2.1 F1-R / R6 异步输入取消额度修复

后续独立复核确认 F2/F3 和 F1 存储分支通过，但 R6 发现 HTTP catch 单独追踪的 `body.cancel()` 未被持有额度的 worker 等待。`verification-report.md` 和 `verification-recheck-report.md` 保持原样；以下是实现方的限定修复记录，不替代独立验证结论。

`service.ts` 对尚未取得 reader 的取消共用一个 Promise，由 HTTP catch 启动、worker finally 等待完成后才归还全局/per-scope 额度。缓存 Promise 先于底层 cancel 调用建立，避免同步重入重复取消；已锁定/消费的正文继续由 `receiveUpload` 持有 reader 并在 finally 等待取消，`upload.ts` 同样先缓存再调用 reader.cancel。HTTP 截止仍只结束 receipt 等待，不等待清理。取消阶段不改变既有提交状态或 FlyDrive 后端取消边界。

新增 5 项 R6 回归：pending 写入期间超时、pending 写入失败、reader 前预检失败、取得 reader/转换 Node stream 后超时，以及 pending 先结束但 close 仍须等待异步输入取消。每项验证取消不重复、取消完成前额度不归还；取消完成后可再次成功上传。

真实 FlyDrive Disk + 报告原内存 driver 的 R6 stdin 探针重放（仅将旧“锁定错误状态”的断言改为期望 429/0）：

```text
{"limit":1,"firstStatus":408,"inputCancellationFinished":false,"nextUploadStatus":429,"nextPayloadWrites":0}
{"closeReturnedBeforeInputCancellation":false}
{"inputCancellationFinishedAfterRelease":true,"closeReturnedAfterInputCancellation":true}
```

本轮前台命令与结果（`/Users/mino/code/mcpp-files`）：

```sh
bun test packages/mcpp/src/files
# 57 pass，0 fail，3 files
bun run --cwd packages/mcpp typecheck
bun test
# 469 pass，0 fail，31 files
bun run typecheck
bunx --no-install prettier --check packages/mcpp/src/files/service.ts packages/mcpp/src/files/upload.ts packages/mcpp/src/files/lifecycle.test.ts docs/design/03-mcpp-file-upload-design.md
git diff --check
```

两级类型检查、改动文件格式和 diff 检查通过。§11.1/§11.2 的 464/52 是上一轮修复记录，本轮结果如上。仍需同一验证 owner 复核 R6 及必要回归；不额外声称真实 S3、GUI 浏览器、生产代理或真实网络输入的实测。不可取消后端/输入清理永不 settle 时额度及 close 继续等待，既定边界不变。

### 11.3 工作区交付边界

桌面草案已真正移动到主仓库 `docs/design/03-mcpp-file-upload-design.md`，桌面源已不存在。实现已提交为 `5402645`（`feat/mcpp-files-extension`，原始基线 `6177478`）；随后正常合并到 main，并在 merge 中保留 `9b49fb9` 的文档编号、Market 移除和现有 Apps 改动，不重排已有 01–18 规范。

主区原始草案在合并前完整移动备份到 `/var/folders/fl/_w0l1wpd2892_p6w4rn_p6n40000gn/T/mcpp-upload-draft-6eu0xvry/03-mcpp-file-upload-design.md`，移动前后 SHA-256 均为 `0cbd7cbaf99d5ac223c85f4c7a7a78cc60c690e1252a7574633bbc0fb4f6c745`。主区对应路径现保存已跟踪的更新设计稿；原始内容没有被覆盖或删除。

此前外部提交前后的初始状态重建 hash 不一致是历史观察，不据此改写主线；本次合并前已核对 main 仅有原始草案未跟踪、index 为空。经用户明确授权后才暂存、提交并正常 merge；不 amend/rebase/reset/stash，不跳 hooks、不改 Git 配置、不推送。files 与 tasks worktree 均保留，tasks 未触碰。独立验证报告留在 files worktree 的本地 ignore 目录，不纳入产品提交。

### 11.4 合并主线后的验证与适配

用户在独立验证 PASS 后明确授权提交和合并。实现提交 `5402645` 已创建；main 的 `9b49fb9` 含文档统一编号与 Market 移除，merge 保留这些结果以及现有 Apps 代码，不携入 tasks 分支。本次将文件主题编号为 `MCPP/19-mcp-files.md`，条款迁入 `01-index`、`16-conformance` 等编号文档，删除 merge 产生的旧无编号副本；原有 01–18 不重排，相关本地链接检查无断链。

在主区 `/Users/mino/code/mcpp` 按最终 manifest 执行 `bun install`，锁文件无 Market workspace、无不可达依赖、无既有依赖版本变化。根 `typecheck` 现指向 MCPP 包；不再把旧分支的 Market 检查作为主线要求。默认示例 `.mcpp-files/` 加入 ignore，避免用户本地上传数据进入源码提交。

```sh
bun test packages/mcpp/src/files
# 57 pass，0 fail，3 files
bun test
# 124 pass，0 fail，19 files
bun run --cwd packages/mcpp typecheck
bun run typecheck
```

主线全量 124 与 files 分支历史 469 的差额来自主线已删除的 Market 测试，不是上传用例减少。主区真实 FS smoke 以示例子进程完成 discover → Blob 原始字节上传 → inspect_file → 磁盘 payload/摘要/v2 record 检查 → 同目录重启复用；两次子进程均退出 0，临时目录已清理。服务端 bun、client browser、gateway browser 三个内存构建均通过。改动文件 Prettier、工作区与暂存区 diff 空白检查通过；提交执行现有 lint-staged hook，不跳过 hooks。

本地目录配置与安全边界见 [MCPP Files 本地文件夹使用](../../MCPP/19-mcp-files.md#本地文件夹使用)。FlyDrive 本地 FS 可用；真实 S3、GUI 浏览器、生产代理及认证的未实测边界不变。

## 12. 参考来源

1. [MCP 2026-07-28 Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)：`server/discover` 与能力发现。
2. [MCP 当前 Versioning 规范](https://modelcontextprotocol.io/specification/draft/basic/versioning)：逐请求元数据与扩展协商。
3. [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http)：核心请求格式、header 与无会话语义。
4. [官方文件扩展固定草案](https://github.com/modelcontextprotocol/experimental-ext-file-uploads/blob/6101d34eb52b21d4b87028543ecd1fd59ed3d5df/specification/draft/file-uploads.md)：文件参数、MRTR 上传及授权目标规则。
5. [FlyDrive Getting Started](https://flydrive.dev/docs/getting_started)、[Disk API](https://flydrive.dev/docs/disk_api)：ESM、Disk 和流式读写接口。
6. [FlyDrive FSDriver](https://flydrive.dev/docs/services/fs)、[S3Driver](https://flydrive.dev/docs/services/s3)：后端配置、依赖及访问控制边界。
7. [FlyDrive package.json](https://github.com/flydrive-js/core/blob/2.x/package.json)、[S3 driver](https://github.com/flydrive-js/core/blob/2.x/drivers/s3/driver.ts)：本次查看的运行时声明及流写入实现。
8. [MCPP 扩展规范](https://github.com/KonghaYao/mcpp/blob/6177478061ab164a4f24ad585e4a99f6b0c64229/MCPP/mcp-extensions.md)、[Gateway](https://github.com/KonghaYao/mcpp/blob/6177478061ab164a4f24ad585e4a99f6b0c64229/packages/mcpp/src/gateway.ts)、[Server start](https://github.com/KonghaYao/mcpp/blob/6177478061ab164a4f24ad585e4a99f6b0c64229/packages/mcpp/src/server/start.ts)：历史 `6177478` 的规范与实现参照；当前规范入口为 [19-mcp-files.md](../../MCPP/19-mcp-files.md)。
