# 附录 A：本仓库参考实现

[文档库首页](01-index.md) · [上一篇：一致性要求](16-conformance.md) · [下一篇：术语](18-glossary.md)

本仓库以两层结构落地 MCPP（即 1.1「项目身份」的实现示例）：

- [`packages/mcpp`](../packages/mcpp)：规范行为即代码的 SDK——skills 扫描/摘要/资源挂载（`ResourceForSkills`，第 3.4 双通道投影参考实现）、`ResourceForAgents`、MCP Apps Server 侧 helper（`ResourceForApps`、`AppPageStore` 等，见 [14-mcp-apps.md](14-mcp-apps.md) §6）、双模式启动（stdio + streamable HTTP）、默认 `127.0.0.1:8457`、`createGateway` 聚合与只读 Server Catalog（第 3.7–3.7.1）、`plugin.json`/`mcp.json` 校验。
- [`examples/plugins/monorepo`](../examples/plugins/monorepo)：聚合上层（monorepo 拓扑，第 3.7）——单一 HTTP 出口包含 `/catalog/mcp`、`/openspec/mcp` 与根路径 HTML + CDN Catalog demo；Catalog 仅解析静态 Child endpoint，不提供安装或下发。`openspec/skills` 打包第三方 OpenSpec 技能集（通道 A 素材），由子 server 投影为 `skill://` 资源（通道 B）。
- [`examples/plugins/.mcp.json`](../examples/plugins/.mcp.json)：MCP 客户端级配置（`streamable-http` 指向聚合出口），与第 3.3 的插件级 `mcp.json` 同构——客户端把插件的便携 `mcp.json` 映射到自身原生 MCP 配置。

## Tasks Tier 1 已实现面

`packages/mcpp/src/tasks/` 提供 `TaskStore`、复制隔离的 `MemoryTaskStore`、应用共享的 `TaskService`、`TasksServer/registerTaskTool` 和轻量 `TaskPoller`。公开 `connect(Transport)` 边界兼容 SDK 2.0 缺少的现代 Tasks runtime；只接管已登记任务工具与 `tasks/get / update / cancel`，普通 tools/resources/discover 保持 SDK 处理。HTTP 和 stdio 均有真实 transport 混用测试。

协议校验使用固定 commit 的完整发布 JSON 快照与公开 SDK AJV provider；`@modelcontextprotocol/ext-tasks@0.2.2/core/v2` 仅提供类型与附加投影，不使用旧 receiver；单结果及总字节预算、取消意图 CAS、可信 scope、终态幂等、自定义 Store、前台执行接管和 Host 去重均有测试。使用与部署说明见 [Tasks SDK](20-tasks-sdk.md)，T01–T17 实际覆盖见 [一致性要求](16-conformance.md)。

不实现 Tier 2 补充输入、Tasks subscription、数据库与恢复算法、执行器 fencing 或 Peri inbox 产品；业务可通过受信 report/settle 核实并终结历史任务，但这不是 T17 恢复功能实现。内存任务跨请求而非跨重启；自定义 Store 的全局配额、扫描与执行存活由业务负责。

**待办标记**（通往完整 MCPP conforming）：

- 为聚合上层补齐插件清单 `plugin.json`（对应 3.2）；
- 实现 `skills/list` / `skills/get` / `directoryRead`（对应 S4/S5）与 `io.mcpp/*` 编排字段解析（对应 A7）；
- 为 `packages/mcpp` 实现第 8.2 节 `ChannelManager` / `Channel` / `ChannelStore`、`send()` / `receive()`、标准 `subscriptions/listen` sink 与 `tools/call` dispatcher 适配、有界背压及 Durable Event Log / inbound 幂等 conformance 测试；不得引入 Claude/vendor Channel 线级扩展；
- 为 `packages/mcpp` 补充 NPM keyword / manifest Store projection、dist-tag 版本解析证据、MCP JSON、Worker Isolate `WorkerOrchestrator` adapter、Deployment 状态机、Mono Server MCP 透明路由及 source 环境变量重定向（见 [`02-mcp-registry.md`](../02-mcp-registry.md)）。
