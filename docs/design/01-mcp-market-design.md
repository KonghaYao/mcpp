# MCPM 目录与治理控制面设计

> 状态：历史实施基线；市场资产、NPM 元数据与专家团队模型已被 [`MCPM_MARKET.md`](../../MCPM_MARKET.md) 取代
> 日期：2026-08-26
>
> 本文仍用于说明当前 `packages/mcp-market` 的既有实现。新功能设计与迁移目标以 [`MCPM_MARKET.md`](../../MCPM_MARKET.md) 为唯一权威；若两者冲突，以新文档为准。

## 1. 边界

MCPM 是 MCP 配置目录和治理控制面。它保存 backend 的不透明定位信息以及 MCP Stdio 配置，不托管、传输、解析或代理任何 artifact，也不请求 backend。它不验证 dependency、lifecycle script、entry file、integrity 或代码安全。

Admin 的首次批准表达的是信任 Publisher 创建的 Item 和目录条目，不表示 MCPM 扫描或认证了 artifact 或 command。后续 revision 在已激活 Item 下自动发布。

## 2. 核心模型

- `backend_registries`：Admin 维护的 `slug`、展示信息、状态和可选展示外链模板；MCPM 不按 backend 类型适配。
- `publishers` 与 `api_keys`：Publisher 稳定 slug 与单向 hash token 分离。明文 token 只在创建时返回；Publisher suspended 时 token 不可用。
- `mcp_items`：稳定 `slug`、Publisher、backend 和展示字段；状态为 `pending`、`active`、`archived`、`suspended`。
- `mcp_item_revisions`：不可变 exact SemVer、opaque `backendLocator`、单个 `serverDefinition` 和可选 `envSchema`。
- `mcp_item_latest`：唯一 latest 指针，可由 Publisher 显式回滚。
- review/status/latest event 与 `audit_logs`：记录治理和发布变化，禁止写入 token、Authorization header 或环境变量实际值。

`serverDefinition` 必须是 `{ command: string, args?: string[], env?: Record<string,string> }`；MCPM 不执行或评估 command。`envSchema` 只做 object/null、大小和少量顶层形状检查。`backendLocator` 只做 JSON 类型、深度和大小检查。Backend item URL 仅为展示外链，locator 必须安全 URL encode，MCPM 不请求该 URL。

## 3. API

统一前缀 `/api/v1`，响应带 `x-request-id`，错误为 `{ error: { code, message, details } }`。

匿名 Public API：

- `GET /backends`
- `GET /items`、`GET /items/:slug`
- `GET /items/:slug/revisions`、`GET /items/:slug/revisions/:version`
- `GET /items/:slug/config`、`GET /items/:slug/revisions/:version/config`

Public 仅展示 active Item、published revision 和 active backend 列表；Item 被 archive/suspend/pending 时统一按不存在处理。Config 使用 Item slug 生成 `config.mcpServers[item.slug]`，同时返回 backend 和 opaque locator。

Publisher 使用 `Authorization: Bearer mcpm_...`：创建 Item+首版、修改展示字段、提交后续 revision、切换 latest、archive/restore、管理自己的 API Key。Item 与首版必须在同一 `BEGIN IMMEDIATE` 事务内创建；首版 pending，后续 revision 在 active Item 上立即 published。

Admin 使用 bearer secret：管理 backend、Publisher、API Key、首次 approve/reject，以及 Item suspend/restore。Approve 只改变首次 revision 与 Item 状态并写事件；不进行 backend/artifact 请求或安全扫描。

## 4. 事务与状态

- `pending → active` 只允许 Admin 首次 approve，同时设置首版 latest。
- `active ↔ archived` 由 Publisher 操作；archive 不删除历史。
- `pending|active|archived → suspended` 由 Admin 操作，保存 `suspended_from_status`，restore 后恢复原状态。
- 后续 revision 是单事务插入、published、更新 latest、写 latest event。
- rollback 只能指向同 Item 的 published revision，提交顺序而非 SemVer 最大值决定 latest。

不存在 upstream publish、retry、reconcile、job、operation 或 compensating transaction；所有请求均可在 SQLite 内完成。

## 5. Schema 与验证边界

新鲜开发库只执行 `migrations/0001_directory.sql`，不迁移旧 demo 数据，也不提供旧 API compatibility view。旧的 NPM gateway、流式 tar、integrity 与 jobs 技术债因职责删除而关闭。

MCPM 仅校验 JSON 可解析、字段类型/长度、global slug、exact SemVer、展示 URL、tags、Stdio 结构和有限 env schema 形状。不校验 locator 可达性、artifact 存在性、package、tar/gzip、hash、dependency、lifecycle、可执行入口、command 安全性或完整 JSON Schema draft。

## 6. 测试与部署边界

单元/集成测试应覆盖 validation、API key、状态转换、latest 约束、匿名投影和首次信任流程。测试不需要网络、Verdaccio、NPM token、tarball fixture 或后台 worker。`examples/mcp-registry` 保留为历史独立 prototype，不是 MCPM reference implementation；MCPM 无前端，仅提供 API。
