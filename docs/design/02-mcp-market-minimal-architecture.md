# MCPM Market 极简架构

> 状态：架构设计 v1.0
> 领域基础：[`MCPM_MARKET.md`](../../MCPM_MARKET.md)
> 历史实现：[`01-mcp-market-design.md`](01-mcp-market-design.md)
>
> 本文是极简 Market 产品的实现权威；`MCPM_MARKET.md` 继续定义 NPM package、Connector、exact version 与 `mcpp` 元数据语义。涉及账号、Publisher、审核、同步、安装或市场状态时，以本文的收缩边界为准。

## 1. 已确认边界

MCPM Market 是由单一 Admin 管理的 NPM package 精选目录。

- NPM Registry 管理 package、exact version、dist-tag、artifact 和版本状态。
- Market 只记录 Admin 发布到市场的 exact version 元数据快照。
- Public Market 匿名提供 package 列表、搜索、详情和公开版本历史。
- 系统没有普通用户、Publisher、组织、RBAC、客户端安装、配置生成、审核流、自动同步或交易。
- 唯一 Admin 使用部署环境中的凭证登录。
- `Publish(package, exactVersion)` 首次创建不可变快照并自动设为 Market `latest`。
- 重复 Publish 保持幂等；已下架版本再次 Publish 时恢复原快照并设为 `latest`。
- `Unpublish` 只撤销 Market 可见性；下架当前 `latest` 时自动回退到最近发布且仍公开的版本。
- Public Market 每个 package 展示一条记录，内容来自 Market `latest` 快照。

## 2. 总体骨架

采用单应用、单 SQLite、无 Worker 的模块化单体。

- 同一 Web 应用承载 Public Market、Admin Console 和内部操作入口。
- Public Market 使用静态生成；Catalog 变化后触发受控的页面失效与再生成。
- Admin 页面动态渲染，只在预览 Publish 时访问 NPM Registry。
- 页面层直接调用 Application Service，首发不承诺稳定 HTTP API。
- SQLite 是唯一业务存储；写操作保持短事务，部署按单写实例设计。

```text
Public Static Pages ──query──> PublicCatalog
Admin Console ───────────────> AdminAuth
Admin Console ───────────────> PublicationService ──fetch──> NpmRegistry
                                      │
                                      └──write──> SQLite ──invalidate──> Public Pages
```

## 3. 模块边界

首发只保留四个代码模块：

- `AdminAuth`：读取环境凭证，处理登录、Session、退出和登录限流。
- `NpmRegistry`：按 package 与 exact version 获取、校验并规范化 NPM 元数据；不写业务表。
- `Catalog`：拥有 Package、Publication、Market latest，以及 Publish、Restore、Unpublish 的全部事务规则。
- `PublicSite`：直接查询 Catalog 核心表，生成匿名列表、搜索、详情和公开版本页。

`Catalog` 是唯一业务写模块。`PublicSite` 不访问 NPM，`NpmRegistry` 不访问 Catalog 表，页面层不直接写数据库。单一 Registry 的 base URL 和固定 `sourceId` 放在部署配置中，不建立来源管理表。

## 4. 静态页面一致性

数据库是发布事实源，静态页面是可重建缓存。

- Catalog 事务提交成功即表示 Publish、Restore 或 Unpublish 成功。
- 提交后触发相关列表页和详情页失效与再生成。
- 再生成失败不回滚 Catalog；公网可以暂时显示旧页面。
- Admin Console 应显示刷新失败，并允许重试。
- PublicSite 直接读取核心表，不维护额外公共投影表。

### 4.1 调用与页面边界

Publish 使用两次独立读取：Preview 从 Registry 读取并展示；Confirm 时服务端重新读取、规范化并写入，禁止信任浏览器回传的 metadata。

Public 页面分为：

- 首页、列表、package 详情和版本详情：静态生成。
- 任意关键词搜索：服务端动态查询 SQLite。
- Publish、Restore、Unpublish 提交后，按受影响的 package、version 和列表路径触发精确失效。

数据库提交成功就是业务操作成功；页面再生成属于可重试缓存刷新，失败不回滚 publication。NPM Registry 故障只影响 Admin 的 Preview/Confirm，Public 读路径始终使用本地快照。

### 4.2 依赖与调用约束

- `Catalog` 独占业务表写入及 Publish、Restore、Unpublish、latest 回退规则。
- UI route 不直接访问 Repository，不自行组织事务。
- 模块间使用进程内 typed service 调用，不引入内部 HTTP 或事件总线。
- `NpmRegistry` 只返回规范化的 exact-version metadata，不读取或写入 Catalog。
- `PublicSite` 只查询 Catalog，不访问 NPM Registry。
- Application use case 在 Catalog 事务提交后显式调用 `PublicSite.invalidate()`；刷新失败不回滚发布，只返回警告并记录错误。
- 源码按 `admin-auth`、`npm-registry`、`catalog`、`public-site` 四个业务模块组织，框架 route 仅负责输入输出适配。

## 5. 运行边界

- 首发限定为单应用实例，SQLite 位于持久化存储；不支持多实例共享数据库文件。
- Admin 使用短时无状态签名 HttpOnly Cookie；轮换 `SESSION_SECRET` 可使现有会话全部失效。
- NPM Preview 与 Confirm 均设置短超时并快速失败；失败不落库，由 Admin 手动重试。
- 静态页面刷新失败时，Admin Console 显示“数据已发布但页面未刷新”，并提供显式重试入口。
- 页面刷新重试只重建公共页面，不重复 Publish，也不修改 publication 或 `latest`。

## 6. 总体模块图

```text
Web Application（单实例）
├── AdminAuth
│   └── 环境凭证、签名 Session、登录限流
├── NpmRegistry
│   └── exact-version 查询、校验与 metadata 规范化
├── Catalog
│   └── Publication、不可变快照、可见性与 Market latest
└── PublicSite
    └── 静态列表/详情、动态搜索与页面失效

Persistence
└── SQLite

External
└── 单一 NPM-compatible Registry（仅 Admin 操作时访问）
```

总体骨架到此封口；下一步只细化 `Catalog` 发布模型。

## 7. Catalog 发布模型

### 7.1 模型

`MarketPackage` 是 `(sourceId, packageName)` 的稳定聚合；`Publication` 是 Admin 将一个 NPM exact version 纳入市场的记录。

```text
MarketPackage
├── id
├── sourceId
├── packageName
├── latestPublicationId?
├── createdAt
└── updatedAt

Publication
├── id
├── packageId
├── exactVersion
├── metadataJson
├── metadataDigest
├── firstPublishedAt
├── publishedAt
├── unpublishedAt?
├── createdAt
└── updatedAt
```

建议约束：

```text
UNIQUE MarketPackage(sourceId, packageName)
UNIQUE Publication(packageId, exactVersion)
FOREIGN KEY latestPublicationId -> Publication.id
CHECK latestPublicationId 所属同一 package（由事务规则保证并测试）
CHECK publishedAt >= firstPublishedAt
CHECK unpublishedAt IS NULL 表示当前公开
```

`metadataJson` 保存经过校验和规范化的版本快照，不保存完整 Packument。`metadataDigest` 对规范化 JSON 计算，用于诊断和幂等验证，不作为 artifact integrity。

### 7.2 快照内容

快照只保留公共展示需要的 NPM 事实：

- `name`、`version`、`description`、`keywords`；
- `mcpp.schemaVersion`、`displayName`、`summary`、`agents`、`servers`；
- `dist.integrity`、`dist.tarball` 及 Registry 已提供的可选大小字段；
- `deprecated` 与 NPM 发布时间（若 Registry 提供）；
- 生成 NPM 外链所需的规范化 package identity。

快照不保存：

- 其他版本、dist-tags 或 owner/ACL；
- tarball 内容；
- NPM Token、Authorization header、Cookie；-未知扩展字段；
- Prompt、Secret、用户配置和图片 Base64。

首次 Publish 后快照不可变。Market 不提供 refresh；相同 exact version 的 Registry metadata 后来变化时，既有快照不被覆盖。

### 7.3 Market latest

`latestPublicationId` 只是公共列表和详情的默认展示指针，不是 NPM dist-tag，也不改变 package 的版本事实。

不变量：

1. 指针为空，或指向同一 package 的公开 Publication；
2. package 只要存在公开 Publication，指针就不得为空；
3. 新 Publish 或 Restore 成功后，目标 Publication 成为 latest；
4. Unpublish 非 latest 不移动指针；
5. Unpublish latest 时，回退到 `publishedAt DESC, id DESC` 的第一条公开 Publication；
6. 没有公开 Publication 时清空指针，整个 package 从 Public Market 隐藏。

### 7.4 命令语义

`preview(packageName, exactVersion)`：

- 规范化 package name 和 exact SemVer；
- 从固定 Registry 获取 Packument，并精确选择 `versions[exactVersion]`；
- 校验并返回只读 Preview；
- 不创建任何业务记录。

`publish(packageName, exactVersion)` 在 Confirm 时重新读取 Registry：

- 从未存在：创建 Package（若需要）和不可变 Publication，自动设为 latest；
- 已存在且公开：严格幂等，返回既有记录，不刷新快照、不改时间、不移动 latest；
- 已存在且下架：恢复原记录，保留快照和 `firstPublishedAt`，更新 `publishedAt`、清空 `unpublishedAt` 并设为 latest。

`unpublish(packageName, exactVersion)`：

- 目标公开：设置 `unpublishedAt`；必要时执行 latest 回退；
- 目标已下架：幂等返回；
- 目标不存在：返回 `PUBLICATION_NOT_FOUND`；
- 不删除 Package 或 Publication。

`retryPublicRefresh(packageName)` 不是 Catalog 命令。它只让 `PublicSite` 重新生成受影响页面，不修改 Catalog。

### 7.5 事务与并发

Confirm 的 Registry 请求必须在事务外完成。写入使用 SQLite `BEGIN IMMEDIATE`：

```text
fetch + normalize（无事务）
→ BEGIN IMMEDIATE
→ 重新查询 Package/Publication 当前状态
→ 执行 Publish/Restore/幂等分支
→ 校验并写 latest
→ 写 AdminOperation
→ COMMIT
→ 触发 PublicSite.invalidate
```

即使只有一个 Admin，也必须依赖数据库唯一约束和事务内重查，不依赖按钮禁用防并发。两个相同 Publish 并发时最多创建一条 Publication；后到请求读取既有记录并按幂等分支返回。

所有时间由服务端生成 UTC ISO-8601。排序使用 `publishedAt` 后再使用稳定 `id`，不得只依赖毫秒时间。

### 7.6 操作记录

保留轻量 `AdminOperation`：

```text
AdminOperation
├── id
├── action: publish | restore | unpublish
├── packageId
├── publicationId
├── occurredAt
└── requestId
```

幂等 no-op 不新增操作记录。操作记录与 Catalog 变化在同一事务写入；它用于诊断和追溯，不发展为通用审核系统。

## 8. NpmRegistry 模块

`NpmRegistry` 是固定 Registry 的只读防腐层。它不拥有业务状态，也不暴露通用 URL fetch 能力。

### 8.1 输入与输出

输入只有规范化后的：

```ts
{
  sourceId: string;
  packageName: string;
  exactVersion: string;
}
```

输出是 `NormalizedPackageVersion`，字段与 7.2 的快照白名单一致。Catalog 只接收该类型，不接收原始 Packument 或浏览器提交的 JSON。

首发固定一个 `sourceId` 和 Registry base URL。package name 必须按 scoped/unscoped NPM name 规则校验后整体 URL encode；调用方不能传协议、host、path 或 query，从结构上阻断 SSRF。

### 8.2 获取流程

```text
GET {registryBase}/{encode(packageName)}
→ 限制重定向（默认禁止跨 origin）
→ 检查 HTTP 状态和 Content-Type
→ 限制响应体字节数
→ 解析 JSON
→ 精确读取 versions[exactVersion]
→ 验证 name/version 与请求一致
→ 校验 mcpp schemaVersion 及有界结构
→ 白名单规范化
→ 生成稳定 JSON 与 SHA-256 digest
```

不得请求 `dist.tarball`，也不得探测 package 中的文件。

### 8.3 不可信输入限制

实现必须集中定义并测试以下上限：

- Packument 响应字节数和 JSON 嵌套深度；
- package name、description、keyword、URL 和普通文本长度；
- keywords、agents、servers 数组长度；
- 每个 Agent/Server 字段长度；
- `mcpp` 允许字段集合；
- 请求连接超时与总超时。

超过上限即拒绝 Preview/Publish，不做截断后发布，避免 Admin 预览与最终快照含义不一致。所有文本按纯文本保存和渲染，不接受 HTML。

### 8.4 错误分类

```text
PACKAGE_NOT_FOUND          Registry 无该 package
VERSION_NOT_FOUND          exact version 不存在
REGISTRY_UNAVAILABLE       网络、超时或 5xx
REGISTRY_RATE_LIMITED      429，可向 Admin 显示 Retry-After
METADATA_TOO_LARGE         响应或字段超过限制
METADATA_INVALID           JSON、name/version 或 mcpp 结构非法
UNSUPPORTED_SCHEMA_VERSION mcpp.schemaVersion 不支持
```

错误只返回安全摘要、`requestId` 和可重试建议；不回显响应体、请求 header 或环境配置。Preview/Confirm 失败均不写业务表，也不后台重试。

### 8.5 Preview 与 Confirm

Preview 用于人工确认展示内容；Confirm 必须再次获取并规范化。若两次内容不同，以 Confirm 时读取的内容为写入候选，并在提交前向 Admin 明确提示“元数据已变化，需重新确认”，不得静默发布与先前预览不同的快照。

为此 Preview 返回 `metadataDigest`；Confirm 接收该 digest（不接收 metadata），重新读取后比较：

- digest 相同：继续 Catalog 事务；
- digest 不同：返回新的 Preview 与 `PREVIEW_CHANGED`，不落库；
- 已公开版本的幂等 Publish：可在访问 Registry 前由 Catalog 快速返回，避免无意义外部请求；
- 已下架版本的 Restore：使用既有不可变快照，不访问 Registry。

## 9. PublicSite 模块

`PublicSite` 是 Catalog 的匿名只读投影与页面缓存边界。它不拥有业务表、不访问 Registry，也不推断 NPM 当前状态。

### 9.1 页面与路由语义

```text
/                         静态首页与最新 package 摘要
/market                   静态 package 列表
/market/:packageSlug      静态 package 详情（默认 Market latest）
/market/:packageSlug/v/:version
                          静态公开版本详情
/search?q=...             动态服务端搜索
```

`packageSlug` 是 Market 的 URL-safe 标识，不作为领域身份；领域查询始终回到 `(sourceId, packageName)`。首发将规范化 package name 的 UTF-8 字节编码为无 padding 的 base64url，并加 `p-` 前缀；该算法可逆、无冲突且不受代理对 `%2F` 的处理影响，不另存可编辑 slug。

公开规则：

- package 的 `latestPublicationId` 为空时，列表、搜索和详情统一按不存在处理；
- 版本页只允许访问 `unpublishedAt IS NULL` 的 Publication；
- 被下架版本返回 404，不泄露其 metadata；
- package 详情卡片和标题始终来自 latest 快照；
- 版本历史按 `publishedAt DESC, id DESC` 展示当前公开版本；
- `deprecated` 只按快照展示，不额外解释为 Market 下架。

### 9.2 专家团队投影

不创建独立 Expert 实体或表：

```text
latest snapshot agents.length > 0
→ 以专家团队方式展示 Connector 与 Agent 成员

latest snapshot agents.length = 0
→ 以普通 Connector 方式展示
```

版本切换可能改变投影类型，这是 latest 快照变化的自然结果。历史版本的 Agent 只属于各自 Publication。

### 9.3 列表与搜索

每个 package 在列表与搜索中最多一条，读取 `MarketPackage.latestPublicationId` 对应快照。首发直接使用 SQLite 查询，不维护 Elasticsearch、向量索引或第二张公共投影表。

搜索字段：

- package name；
- `displayName`、`summary`、description；
- keywords；
- Agent id、name、description；
- Server id、transport、runtime。

首发使用 SQLite FTS5；其表仅是可重建技术索引，不是业务事实。Catalog 事务同步更新索引，搜索结果只返回当前 latest，默认排序为文本相关度、`publishedAt DESC`、package name。若运行环境缺少 FTS5，Ready 检查失败，不静默退化到无界 `LIKE` 查询。

搜索必须限制 query 长度、分页大小和执行时间；空 query 返回普通列表第一页。用户输入只作为绑定参数，不拼接 SQL 或 FTS 表达式。

### 9.4 静态生成与失效

静态页面是 Catalog 的缓存，不是发布事实源。Catalog 事务提交后，由 application use case 调用：

```ts
PublicSite.invalidate({
  packageId,
  packageSlug,
  affectedVersions,
  listChanged: true,
});
```

失效范围：

- 首页和 Market 列表；
- package 详情；-本次 Publish/Restore/Unpublish 涉及的版本页；-框架支持的 Catalog cache tag。

搜索页动态读取 SQLite，不需要失效。若静态刷新失败，返回 `catalogChanged: true, publicRefresh: "failed"`；Admin 可调用同一个 invalidate 操作重试。重试必须幂等且不写业务表。

为避免误导，使用 `public_refresh_attempts` 保存每个 package 最近的刷新结果，Admin Console 同时显示数据库状态和页面状态。该表属于运行记录，不进入 Publication 状态机：

```text
PublicRefreshAttempt
├── id
├── packageId
├── requestedAt
├── completedAt?
├── outcome: succeeded | failed
├── errorCode?
└── requestId
```

不得保存完整异常栈或页面内容。

### 9.5 降级行为

- Registry 故障：公共页面不受影响；
- SQLite 暂时不可用：已生成静态页继续服务，动态搜索和未缓存页面失败；
- 页面再生成失败：继续服务旧静态版本；
- FTS 索引损坏：列表/详情仍可用，搜索返回暂不可用并允许重建索引；
- latest 指针异常：查询拒绝展示该 package，并触发错误告警，不自行猜测版本。

## 10. AdminAuth 与 Admin Console

### 10.1 鉴权模型

系统只有一个逻辑 Admin，不建立用户表、角色表或权限系统。部署配置至少包含：

```text
MCPM_ADMIN_USERNAME
MCPM_ADMIN_PASSWORD_HASH
MCPM_SESSION_SECRET
```

禁止保存或配置明文密码。启动时校验 password hash 格式和 Session secret 强度，不满足要求则拒绝启动。日志和错误不得输出配置值。

登录成功后签发短时、无状态、签名且带过期时间的 Session Cookie；payload 只包含固定 subject、签发时间、过期时间和 session version。Cookie 使用 `HttpOnly`、`Secure`、`SameSite=Strict` 和限定 Path。退出通过清除 Cookie 实现；轮换 secret 或 session version 可整体失效。

所有 Admin mutation：

- 必须验证 Session；
- 必须校验同源请求并使用 CSRF token；
- 仅接受预期 Content-Type；
- 使用 request ID；
- 设置 `Cache-Control: no-store`；
- 禁止被静态缓存或 CDN 缓存。

登录端点按 IP 与固定用户名组合限流；失败响应不区分用户名不存在或密码错误。应用只信任明确配置的反向代理转发头。

### 10.2 Admin 页面

Admin Console 只需三个页面/区域：

```text
/login
/admin                   已发布 package 与 latest 状态
/admin/publish           package + exact version 的 Preview/Confirm
/admin/packages/:slug    版本、Publish/Restore/Unpublish 与刷新状态
```

核心流程：

1. Admin 输入 package name 与 exact version；
2. 服务端调用 `NpmRegistry.preview`；
3. 页面显示将要公开的完整规范化字段、digest 和风险免责声明；
4. Admin Confirm 只提交 identity、version、preview digest 和 CSRF token；
5. 服务端重新获取 metadata；若 digest 变化，停止并要求重新确认；
6. Catalog 事务完成后刷新公共页面；
7. 页面分别显示“Catalog 已更新”和“Public 页面刷新结果”。

Unpublish 必须展示目标 package/version；下架 latest 时预览自动回退目标。Restore 明确提示将使用首次 Publish 的不可变快照，不重新读取 NPM。

高影响操作使用普通确认页或明确按钮即可，不引入双人审批。UI 不允许自由编辑 metadata JSON。

## 11. Application Service 契约

框架 route 只负责解析输入、鉴权、调用 typed service 和映射输出。建议核心契约：

```ts
interface NpmRegistryService {
  preview(input: PackageVersionRef): Promise<PublicationPreview>;
}

interface CatalogCommandService {
  publish(input: PublishCommand): Promise<PublicationChange>;
  unpublish(input: UnpublishCommand): PublicationChange;
}

interface CatalogQueryService {
  listPublic(input: PublicListQuery): PublicPackagePage;
  searchPublic(input: PublicSearchQuery): PublicPackagePage;
  getPublicPackage(slug: string): PublicPackageDetail | null;
  getPublicVersion(slug: string, version: string): PublicVersionDetail | null;
  getAdminPackage(slug: string): AdminPackageDetail | null;
}

interface PublicSiteService {
  invalidate(input: PublicInvalidation): Promise<PublicRefreshResult>;
}
```

`ApplicationService.confirmPublish` 负责编排 Registry、Catalog 和 PublicSite，但不拥有它们的数据：

```text
读取当前 Publication
├── 已公开：返回幂等结果
├── 已下架：Catalog.restore → PublicSite.invalidate
└── 不存在：Registry.preview → 比较 digest
               ├── changed：返回 PREVIEW_CHANGED
               └── same：Catalog.publish → PublicSite.invalidate
```

Catalog 返回结构化变化集，包括旧/新 latest 和受影响版本；PublicSite 不重新推导业务变化。

错误在应用边界映射为稳定 code：

```text
UNAUTHENTICATED
FORBIDDEN_ORIGIN
INVALID_INPUT
PACKAGE_NOT_FOUND
VERSION_NOT_FOUND
METADATA_INVALID
METADATA_TOO_LARGE
UNSUPPORTED_SCHEMA_VERSION
PREVIEW_CHANGED
PUBLICATION_NOT_FOUND
REGISTRY_UNAVAILABLE
REGISTRY_RATE_LIMITED
CATALOG_CONFLICT
PUBLIC_REFRESH_FAILED
INTERNAL_ERROR
```

Public 404 不区分 package 不存在、无公开版本或请求版本已下架。

## 12. 数据库与迁移

SQLite 开启：

```text
foreign_keys = ON
journal_mode = WAL
busy_timeout = 5000
synchronous = NORMAL
```

业务迁移建立 `market_packages`、`market_publications`、`admin_operations`、`public_refresh_attempts` 和 FTS5 技术索引。所有迁移单调追加，不修改已执行 migration；生产启动前备份数据库。

推荐索引：

```text
market_packages(source_id, package_name) UNIQUE
market_publications(package_id, exact_version) UNIQUE
market_publications(package_id, unpublished_at, published_at DESC)
admin_operations(occurred_at DESC)
```

删除行为不进入首发 API。外键默认 `RESTRICT`，避免误删 Package 级联销毁历史。

数据库一致性检查应验证：latest 指向同 package 的公开 Publication；有公开版本的 package 必须有 latest；没有公开版本的 package 必须没有 latest。启动时只检查 schema 和数据库可读写，不自动修复业务数据；异常进入告警，由维护命令显式处理。

## 13. 安全边界

- Packument、`mcpp`、description、keywords 与 URL 一律视为不可信输入；严格白名单、限长并以纯文本输出。
- HTML 模板默认转义，禁止直接注入 snapshot HTML；外链只允许 `https:`，开发环境例外必须显式配置。
- Registry base URL 只能来自启动配置；请求 package path 由校验后的 name 生成，禁止任意 URL 代理。
- 不下载、不解压、不请求 tarball；不执行 package command 或 lifecycle script。
- 不声称 Market 对代码、依赖或 artifact 做过安全认证。
- Snapshot 中出现疑似 secret 字段、Authorization header 或 data URL 时拒绝发布，而非脱敏后继续。
- Admin Cookie、密码 hash、Session secret、Registry 凭证不得进入日志、审计、错误响应或快照。
- Public 和 Admin 响应分别设置合理 CSP；Admin 禁止第三方脚本，Public 图片源使用白名单或本地代理策略。若做图片代理，必须是独立的受限 image fetcher，不能复用 Registry 客户端。
- 所有 SQL 使用参数绑定；所有状态转换在 Catalog 内完成。
- Publish/Unpublish 请求需要 CSRF、防重放的表单 nonce 或幂等语义；幂等不替代 CSRF。

## 14. 可用性、备份与恢复

首发运行假设：单区域、单应用实例、单 SQLite 写者。Public 静态资源可由 CDN 缓存；Admin 路由和动态搜索直达应用。

### 14.1 健康检查

```text
/health/live   只证明进程事件循环可服务
/health/ready  检查配置有效、migration 完成、SQLite 可读写
```

Ready 不实时请求 Registry，避免上游故障导致整个 Market 摘除。Registry 可用性只体现在 Admin Preview/Confirm。

### 14.2 备份

- 使用 SQLite 在线备份能力或经过验证的 snapshot 方案，不直接复制正在写入的主文件；
- 定期备份数据库并加密存放，保留策略由部署环境确定；
- 每次 schema migration 前执行一次可恢复备份；
- 定期做恢复演练，验证 Package、Publication、latest 和操作记录；
- 静态页面与 FTS 索引不需要备份，可从业务表重建。

### 14.3 故障恢复

- 应用崩溃：由进程管理器重启，SQLite 通过 WAL 恢复；
- 数据库损坏：停止写入，从最近备份恢复，再重建静态页面和 FTS；
- Registry 故障：禁止新 Publish，既有公共目录继续工作；
- 静态缓存丢失：从 Catalog 全量重新生成；
- Session secret 轮换：Admin 重新登录，不影响 Catalog。

首发不承诺零停机 migration 或多区域灾备。

## 15. 可观测性

每个请求生成或接收合法 `x-request-id`，响应回传该值。结构化日志只记录：

- request ID、route 名、结果 code、耗时；
- Catalog action、package ID、publication ID；
- Registry 请求的 source ID、状态分类和耗时；
- 页面失效路径类别和结果；-登录成功/失败计数，不记录密码、Cookie 或完整请求体。

关键指标：

```text
admin_login_attempt_total{outcome}
registry_request_total{outcome}
registry_request_duration
catalog_command_total{command,outcome}
public_refresh_total{outcome}
public_search_duration
public_request_total{route,status}
```

关键告警：

- SQLite ready 失败或磁盘空间不足；
- latest 不变量检查失败；
- 连续 Public 刷新失败；
- Registry 请求持续失败或限流；
- Admin 登录失败短时异常增多。

日志中的 package name 可以记录，但任何外部 metadata 文本只记录 digest、长度和错误字段路径，不记录原始内容。

## 16. 测试与验收

### 16.1 Catalog 单元与集成测试

必须覆盖：

- 首次 Publish 创建 Package/Publication 并设 latest；
- 相同公开版本重复 Publish 完全幂等；
- Restore 保留 snapshot 和 firstPublishedAt，更新时间并设 latest；
- Unpublish 非 latest 不移动指针；
- Unpublish latest 自动回退，排序相同时由 id 稳定决胜；
- 最后一个公开版本下架后清空 latest，Public 查询返回不存在；
- 并发相同 Publish 最多一条 Publication；
- Catalog 变化与 AdminOperation 原子提交；
- 事务失败不留下半写入或悬空 latest；
- page refresh 失败不回滚 Catalog。

属性测试或表驱动测试应覆盖任意 Publish/Restore/Unpublish 序列后，latest 三条不变量始终成立。

### 16.2 NpmRegistry 契约测试

使用本地 HTTP fixture，不访问真实网络：

- scoped/unscoped package URL encoding；
- exact version 选择；
- Preview/Confirm digest 一致与变化；
- 404、429、5xx、超时、非 JSON、超大响应；
- name/version 不匹配；
- 不支持的 schemaVersion；
- 超长文本、过深 JSON、过长数组、重复 Agent id；-恶意 URL、HTML 文本、secret-like metadata；-证明测试期间从未请求 tarball URL。

### 16.3 PublicSite 测试

- 列表和搜索每个 package 只有一条 latest 记录；
- 含 Agent 与无 Agent 的自适应展示；
- 下架版本及无 latest package 统一 404；
- 历史版本只列公开记录；-搜索参数绑定、长度和分页限制；
- Publish/Restore/Unpublish 产生准确失效集合；
- 旧静态页在 SQLite 或再生成故障时仍可服务；
- 所有不可信文本均转义，外链协议被限制。

### 16.4 AdminAuth 与 UI 测试

- 正确/错误凭证、过期或篡改 Cookie、secret/session version 轮换；
- CSRF、Origin、Content-Type 与 no-store；
- 登录限流和代理 IP 信任边界；
- Confirm 不接受浏览器 metadata，只接受 digest；
- PREVIEW_CHANGED 要求重新确认；
- Unpublish latest 正确预览回退目标；
- 页面刷新失败明确区分于 Catalog 写入失败；
- Restore 明确使用旧快照。

### 16.5 发布验收

首发上线前必须满足：

1. `bun test` 全部通过；
2. `bun run --cwd packages/mcp-market typecheck` 通过；
3. `prettier --check` 通过；
4. 全新数据库可一次迁移完成；
5. 从生产结构备份可恢复并通过 latest 一致性检查；
6. Registry 不可用时既有 Public 静态页仍可访问；
7. 日志抽检不存在密码、Cookie、Authorization、Secret 或完整外部 metadata；
8. Publish → 公开、Publish 新版 → latest 移动、Unpublish latest → 自动回退的端到端路径通过。

## 17. 实施顺序

1. 新建 Catalog migration 与 Repository，先用测试锁定不变量；
2. 实现 `CatalogCommandService` 和只读查询；
3. 实现有界 `NpmRegistryService` 与本地契约测试；
4. 实现 AdminAuth、Preview/Confirm、Unpublish/Restore；
5. 实现 Public 列表、详情、版本页和动态搜索；
6. 接入静态生成失效、失败记录与手动重试；
7. 补齐 CSP、CSRF、限流、结构化日志和健康检查；
8. 完成迁移、备份恢复和端到端验收。

旧 `packages/mcp-market` 是历史实现，不做兼容迁移。新鲜开发库只执行新的极简 Catalog migration；旧 Publisher、API Key、Backend、Item/Revision API 与数据不进入新架构。具体实现时应删除旧职责，而不是在旧状态机上叠加分支。

## 18. 架构决策摘要

| 决策     | 选择                      | 主要理由                         |
| -------- | ------------------------- | -------------------------------- |
| 产品     | Admin 管理的 NPM 精选目录 | 删除双边市场和安装平台复杂度     |
| 部署     | 单应用、单实例            | 匹配单 Admin 和 SQLite           |
| 存储     | SQLite + WAL              | 低频写入、事务简单               |
| 外部源   | 配置中的单一 Registry     | 无需来源 CRUD，身份保留 sourceId |
| 发布     | exact version 不可变快照  | 可复现、读路径不依赖 Registry    |
| latest   | Market 展示指针           | 不复制 NPM dist-tag 系统         |
| 下架     | Market 可见性撤销         | 不修改 NPM 版本事实              |
| 内容     | 全部来自 NPM 白名单快照   | 不建设运营内容模型               |
| Public   | 列表/详情静态，搜索动态   | SEO、可用性与任意查询兼顾        |
| 模块通信 | 进程内 typed service      | 不引入内部 HTTP/消息总线         |
| 鉴权     | 环境凭证 + 签名 Cookie    | 单 Admin、无账号生命周期         |
| 异步处理 | 无 Worker                 | 失败由 Admin 显式重试            |
| API      | 内部接口优先              | 首发无外部 API 契约需求          |

## 19. 明确非目标

首发不实现：普通用户或 Publisher 账号、RBAC、组织、多 Registry 管理、package 认领、审核流、运营文案、Scenario、收藏、评论、举报、交易、安装记录、MCP Client 适配、配置生成、自动同步、webhook、定时任务、Worker、tarball 下载与扫描、代码安全认证、实时 NPM 状态镜像、公共写 API或多实例水平扩展。

后续需求只有在证明超出当前边界后才新增模块；不得提前以空表、空状态或通用事件框架预埋。
