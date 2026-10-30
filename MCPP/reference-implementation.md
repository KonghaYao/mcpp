# 附录 A：本仓库参考实现

[文档库首页](index.md) · [上一篇：一致性要求](conformance.md) · [下一篇：术语](glossary.md)

本仓库以两层结构落地 MCPP（即 1.1「项目身份」的实现示例）：

- [`packages/mcpp`](../packages/mcpp)：规范行为即代码的 SDK——skills 扫描/摘要/资源挂载（`ResourceForSkills`，第 3.4 双通道投影参考实现）、`ResourceForAgents`、MCP Apps Server 侧 helper（`ResourceForApps`、`AppPageStore` 等，见 [mcp-apps.md](mcp-apps.md) §6）、双模式启动（stdio + streamable HTTP）、默认 `127.0.0.1:8457`、`createGateway` 聚合与只读 Server Catalog（第 3.7–3.7.1）、`plugin.json`/`mcp.json` 校验。
- [`examples/plugins/monorepo`](../examples/plugins/monorepo)：聚合上层（monorepo 拓扑，第 3.7）——单一 HTTP 出口包含 `/catalog/mcp`、`/openspec/mcp` 与根路径 HTML + CDN Catalog demo；Catalog 仅解析静态 Child endpoint，不提供安装或下发。`openspec/skills` 打包第三方 OpenSpec 技能集（通道 A 素材），由子 server 投影为 `skill://` 资源（通道 B）。
- [`examples/plugins/.mcp.json`](../examples/plugins/.mcp.json)：MCP 客户端级配置（`streamable-http` 指向聚合出口），与第 3.3 的插件级 `mcp.json` 同构——客户端把插件的便携 `mcp.json` 映射到自身原生 MCP 配置。

## 可选文件上传扩展

`packages/mcpp/src/files/` 实现 [MCPP Files](mcp-files.md)：`service.ts` 管理真实 FlyDrive Disk、固定记录、TTL、并发与清理；`upload.ts` 流式计数及 SHA-256 后提交 ready；`handle.ts` 提供有界只读流、内容读取及临时副本；`tool.ts` 注册文件 schema、统一预检与 validator；`http.ts` 绑定稳定业务 scope、Origin/CORS、发现及缺失能力错误；`client.ts` 为浏览器兼容的独立 HTTP helper。

`startServer` 与 `GatewayRoute.files` 精确分流上传，禁止经只读 fallback；未启用 files 时不静态引入 Node FS、FlyDrive 或 AWS。`createMcppServerFactory` 可合并额外 extensions，并保留缓存能力；文件授权和 TTL 每次重检。服务端入口 `@peri-code/mcpp/files` 使用可选 peer `flydrive@2.2.0`，客户端入口 `@peri-code/mcpp/files/client` 不加载服务端依赖。AWS SDK 仅为 S3 应用的显式依赖及仓库测试依赖。

最小示例运行 `bun packages/mcpp/src/files/example.ts`；本机匿名演示不是生产认证模板。`files.test.ts` 验证真实 FS 和真实 Bun HTTP JSON-RPC、失败及生命周期、Blob/CORS 与 browser bundle；`s3.test.ts` 使用真实 S3Driver 加模拟 AWS Command 响应，不能当作真实 S3 服务实测。实现和完整验收记录见[设计稿 03](../docs/design/03-mcpp-file-upload-design.md)。单进程 namespace 管理是首版边界，未宣称跨实例引用与清理协调。

`lifecycle.test.ts` 将独立验证 Check 6–10 转为阻塞后端回归：超时不释放未决额度、关闭等待真实 settle、迟到 ready 加故障标记失败后的重启拒绝、成功后 pending 删除失败仍可恢复，以及启动/HEAD/队列/metadata 的及时取消。`s3.test.ts` 同时断言真实 FlyDrive 2.2.0 原生 signal 只进入 Command input、不成为 AWS abortSignal；参考实现不伪称远端取消。内部记录 v2 增加 committed pending 确认（键不变、wire v1 不变），最后确认未决报告结果未知，不将失败文件凭内存状态发布。不可取消后端或业务回调永不完成时，`close()` 也不假完成。

**待办标记**（通往完整 MCPP conforming）：

- 为聚合上层补齐插件清单 `plugin.json`（对应 3.2）；
- 实现 `skills/list` / `skills/get` / `directoryRead`（对应 S4/S5）与 `io.mcpp/*` 编排字段解析（对应 A7）；
- 为 `packages/mcpp` 实现第 8.2 节 `ChannelManager` / `Channel` / `ChannelStore`、`send()` / `receive()`、标准 `subscriptions/listen` sink 与 `tools/call` dispatcher 适配、有界背压及 Durable Event Log / inbound 幂等 conformance 测试；不得引入 Claude/vendor Channel 线级扩展；
- 为 `packages/mcpp` 补充 NPM keyword / manifest Store projection、dist-tag 版本解析证据、MCP JSON、Worker Isolate `WorkerOrchestrator` adapter、Deployment 状态机、Mono Server MCP 透明路由及 source 环境变量重定向（见 [`MCP_REGISTRY.md`](../MCP_REGISTRY.md)）。
