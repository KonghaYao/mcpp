# 11. 一致性要求（Conformance）

[文档库首页](01-index.md) · [上一篇：安全与信任](15-security.md) · [下一篇：参考实现](17-reference-implementation.md)

条款上下文与主题入口见 [文档地图](01-index.md#文档地图)。

## 11.1 Server / Skill 作者

| #   | 要求                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | [MCP Skills](07-mcp-skills.md)：Skill 目录 MUST 含根级 `SKILL.md`，frontmatter 至少 `name` + `description`，目录名 == `name`                                                                                                                                                                                      |
| S2  | [MCP Skills](07-mcp-skills.md)：skill 资源 URI MUST 遵循 `skill://{prefix/}{name}/{path}` 且末段 == `name`；SKILL.md 恒可寻址                                                                                                                                                                                     |
| S3  | [MCP Skills](07-mcp-skills.md)：SKILL.md 资源 `mimeType` SHOULD 为 `text/markdown`，`name`/`description` 取自 frontmatter                                                                                                                                                                                         |
| S4  | [MCP Skills](07-mcp-skills.md)：声明 skills 扩展者 MUST 实现 `skills/list`（空/局部列表合法）与 `skills/get`（未知 URI 返回 -32602）                                                                                                                                                                              |
| S5  | [MCP Skills](07-mcp-skills.md)：`skills/list` 与 `skills/get` 条目中，`frontmatter` MUST 与 SKILL.md 逐字一致；`resources` 存在时 MUST 完整、含 SKILL.md、逐文件 `sha256:{hex}` digest                                                                                                                            |
| S6  | [MCP Skills](07-mcp-skills.md)：list 结果 MUST 确定性顺序；SHOULD 携带 `ttlMs`/`cacheScope`                                                                                                                                                                                                                       |
| S7  | [MCP Tools](08-mcp-tools.md)：工具名遵守第 6.1 字符规则；`description` 写清适用场景与约束                                                                                                                                                                                                                         |
| S8  | [MCP Tools](08-mcp-tools.md)：状态型工具使用显式句柄，句柄过期错误以 `isError: true` 表述恢复方式                                                                                                                                                                                                                 |
| S9  | [MCP Skills](07-mcp-skills.md)：frontmatter 的 `io.mcpp/` 字段仅使用本文档登记项；未知字段不阻塞                                                                                                                                                                                                                  |
| S10 | [MCP Skills](07-mcp-skills.md)：目录服务者的 skill 内相对路径 MUST 按 skill 根解析（含嵌套目录文件）                                                                                                                                                                                                              |
| S11 | [Agent Plugin](04-agent-plugin.md)：以 MCPP 插件形态分发其实现 / 技能者 MUST 按 Agent Plugin 1.0.0 布局组织（`plugin.json` + `skills/` + `mcp.json`），`name` 遵守第 3.2 约束；该要求仅适用于采用插件分发路径的发布者，对不采用该形态的 server / host 不作此要求                                                  |
| S12 | [MCP Mono Server](05-mcp-mono-server.md)：各子端点为独立 MCP endpoint 与 origin，路径 MUST 明确可审计；端点间不得静默互访；stdio 不支持该形态                                                                                                                                                                     |
| S13 | [MCP Registry](06-mcp-registry.md)：Store MUST 由 NPM keyword / manifest 动态投影且不建定义表；NPM MUST 是 dist-tag 与版本权威；Dynamic Host MUST 使用 Worker Isolate orchestrator；Mono Server MUST 透明转发 MCP 到 active Worker；NPM source MUST 直接路由且仅允许环境变量重定向；stdio MUST 保持 Client-local  |
| S14 | [Server Catalog](05-mcp-mono-server.md)：声明 `io.mcpp/server-catalog` 者只列出当前调用者可连接的已挂载 Child MCP；`id ↔ endpointPath` 唯一稳定且可审计；`resolve` 仅返回同 authority 的相对路径并校验 `entryDigest`；MUST NOT 下发、安装、启动、provision 或代理能力                                            |
| S15 | [MCP Agents](07-mcp-skills.md)：URI MUST 为 `agent://{prefix/}{name}/agent.md`，frontmatter 至少含一致的 `name` / `description`；Server Cache Version MUST 覆盖其目录元数据与内容变化                                                                                                                             |
| S16 | [MCP Channel](11-mcp-channel.md)：Channel 出站 MUST 只映射为标准 Resource Subscription：`resources.subscribe`、`subscriptions/listen`、`notifications/resources/updated` 与 `resources/read`；MUST NOT 使用 vendor Channel capability 或 notification                                                             |
| S17 | [MCP Channel](11-mcp-channel.md)：`ChannelManager` / `Channel.send` MUST 先原子提交 Resource 事实、后向已授权且已订阅 sink 投递失效信号；存储失败不得通知，慢消费者不得造成无界队列或阻塞全局生产者                                                                                                               |
| S18 | [MCP Channel](11-mcp-channel.md)：Event Log Channel MUST 具有稳定 `eventId`、scope 内单调 `sequence`、明确 durability / retention 与 gap 语义；定向投递及 `resources/read` MUST 使用一致或更严格的租户和 principal 授权视图                                                                                       |
| S19 | [MCP Channel](11-mcp-channel.md)：双向 / 入站 Channel MUST 以 `tools/list` / `tools/call` 映射 `receive()`，公开唯一 Tool name、JSON Schema 2020-12 input/result 与准确 side-effect annotations；MUST NOT 直接读取 transport 或增加私有 receive method                                                            |
| S20 | [MCP Channel](11-mcp-channel.md)：入站执行 MUST 在 handler 前完成 transport 身份授权和 `(channelId, authorization context, commandId)` 原子幂等占位；相同键不同 digest 必须拒绝，handler 可能产生副作用后的超时 / 断线 MUST NOT 自动重放，并收敛到原结果、in-progress 或 delivery-unknown                         |
| S21 | [Channel SDK 接口](12-channel-sdk.md)：ChannelSpec MUST 声明稳定身份、方向、schemaVersion、授权、观测策略及有限 payload / result / timeout / concurrency / queue / retention；duplex 必须同时拥有 Resource 与 Tool binding，单向 Channel 不得暴露不属于其方向的 API                                               |
| S22 | [MCPP Files](19-mcp-files.md)：声明 `io.mcpp/files` 者 MUST 实现 v1 同源原始字节上传、发现限制、稳定 FileScope 与 endpoint namespace 隔离，拒绝路由冲突；缺失客户端能力返回核心 `-32021`；stdio 不自动声明上传                                                                                                    |
| S23 | [MCPP Files](19-mcp-files.md)：MUST 在 handler 前完成全部文件归属、ready、TTL、大小及内容 validator 检查；文件错误结构化且不泄露归属；不缓存授权、文件字节或上传响应                                                                                                                                              |
| S24 | [MCPP Files](19-mcp-files.md)：MUST 流式计数/SHA-256、校验 Content-Length 与实际长度、ready 候选及持久 committed 确认后才成功；未决操作保留额度且 close 等待真实 settle，取消覆盖启动/队列/元数据等待；迟到 ready 不可凭原始 pending 重启发布，最后确认未决报告结果未知；TTL 与活动引用串行协调，不承诺多实例协调 |

## 11.2 Agent / Host

| #   | 要求                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | [核心模型](03-core-model.md)：Discover 只摄入元数据；Evaluate 不加载正文；Consume 才读取                                                                                                                                            |
| A2  | [核心模型](03-core-model.md)：SKILL.md 正文 MUST NOT 无条件全量注入；references 等按需懒加载                                                                                                                                        |
| A3  | [核心模型](03-core-model.md)：per-origin 命名空间；host-assigned 标签标识 server，不依赖 `serverInfo.name`                                                                                                                          |
| A4  | [核心模型](03-core-model.md)：同名技能/工具跨 origin MUST NOT 静默遮蔽或替换                                                                                                                                                        |
| A5  | [MCP Skills](07-mcp-skills.md)：Skill 加载 MUST 校验 digest 与 frontmatter 一致性；失败即弃用，可经 `skills/get` 刷新重试                                                                                                           |
| A6  | [MCP Skills](07-mcp-skills.md)：空/局部 `skills/list` 不得判定「无 Skill」；URI 可直接读                                                                                                                                            |
| A7  | [MCP Skills](07-mcp-skills.md)：宣称 `io.mcpp/skill-orchestration` 时，依赖不可用 / 依赖环 MUST NOT 静默跳过，须可观测报告缺口与环路径；加载 / 排序算法属 Agent 层策略，不作协议规定                                                |
| A8  | [安全与信任](15-security.md)：阅读 Skill 时携带 origin 标记；模型有权且仅依赖此标记决策                                                                                                                                             |
| A9  | [安全与信任](15-security.md)：远端 Skill 批准必须内容绑定、逐 Skill、改集即撤销；MCP origin 的 `allowed-tools` 忽略                                                                                                                 |
| A10 | [MCP Resources](09-mcp-resources.md)：按 `ttlMs`/`cacheScope` 消费与失效通知属 SHOULD（依赖 MCP Caching 规范就绪，以 MCP 官方为准）；`resources/updated` 后 MUST 立即标为 stale，并在活跃引用 / 下次使用时重取                      |
| A11 | [Resource 使用](10-resource-usage.md)：MRTR `input_required` 必须暂停 → 用户决策 → 原请求重发；禁止代答                                                                                                                             |
| A12 | [MCP Tools](08-mcp-tools.md)：执行错误回传模型自纠；协议错误有限重试；无界重试禁止                                                                                                                                                  |
| A13 | [安全与信任](15-security.md)：远端 Skill 缓存不进本地 skill 发现路径，断开后仍按 MCP 对待                                                                                                                                           |
| A14 | [Agent Plugin](04-agent-plugin.md)：插件加载顺序 REQUIRED 为 manifest → skills/ → mcp.json → 连接 server，失败按隔离规则处理                                                                                                        |
| A15 | [MCP Skills](07-mcp-skills.md)：技能命令化时，命令名 MUST 可追溯到归属 origin；注入 MUST 携带 origin 来源标记                                                                                                                       |
| A16 | [核心模型](03-core-model.md)：跨 server 能力的呈现 MUST 可追溯到归属 origin；实现策略（分区、前缀、注入集）属 Agent 层                                                                                                              |
| A17 | [核心模型](03-core-model.md)：Agent 消歧 MUST NOT 静默遮蔽 / 替换任何来源的能力，能力消失或冲突悬而未决时必须可观测（A4）                                                                                                           |
| A18 | [Resource 使用](10-resource-usage.md)：超大 / 机密载荷 MUST 引用优先，不内嵌 JSON-RPC；载荷引用短期有效、不留日志、不入上下文摘要；谁创建谁清理                                                                                     |
| A19 | [MCP Tools](08-mcp-tools.md)：目录元数据入索引，定义按命中注入；零候选时如实报告，MUST NOT 杜撰工具                                                                                                                                 |
| A20 | [MCP Registry](06-mcp-registry.md)：Agent 只消费交付的 `mcpServers` 配置，不调用 Store 搜索或详情 API；`streamable-http` 按 URL 连接，`stdio` 按 `command` / `args` 参数数组启动；两者均独立执行 MCP initialize                     |
| A21 | [MCP Resources](09-mcp-resources.md)：fresh 且键 / scope / 身份匹配时直接返回且不发请求；协商缓存只在强缓存未命中、重连初始化或显式 refresh 时比较 `cacheVersion`，版本变化不得给旧内容续鲜                                         |
| A22 | [MCP Agents](07-mcp-skills.md)：发现只摄入元数据；激活时校验 URI / frontmatter / digest 并取得 content-bound 批准；最终工具与能力 MUST 收敛为父级可委派能力、宿主策略、用户批准和配置请求的交集，远端配置不得覆盖本地定义或自行提权 |
| A23 | [MCP Channel](11-mcp-channel.md)：订阅确认后建立读取基线；updated 只使缓存 stale，必须以 `resources/read` 事实为准；断线后重新 `subscriptions/listen + read`，不得假设 session 或 `Last-Event-ID` 恢复                              |
| A24 | [MCP Channel](11-mcp-channel.md)：按 `eventId` 幂等并用 `sequence` 检测缺口；不得把 notification enqueue / 接收等同于业务处理确认，也不得因更新信号自动绕过批准、权限或启动 Agent turn                                              |
| A25 | [MCPP Files](19-mcp-files.md)：Host MUST 检查服务端 v1 能力及当前 endpoint 获准的上传路径，复用既有认证与显式发送授权；不读取任意本地路径、不回退 Base64、不自动重发 POST 或工具；响应丢失报告结果未知，关联按 endpoint 和身份隔离  |

> **依赖就绪状态**：conformance 表中引用未定稿基建的条款（尤以 A10 依赖 MCP Caching 规范）在该基建尚未落地前按 SHOULD / 前瞻性占位解释，不构成当前 MUST 义务；待对应规范（MCP 或 SEP 正式版）就绪后，本表在下一次版本对齐。版本与上游职责边界见[引言](02-introduction.md)。其余 MUST 依 BCP 14 生效。

## 11.3 判定

- 全部 MUST 项满足 —— conforming；
- 任一 MUST 项不满足（约定职责内）—— non-conforming，互操作不保证；
- SHOULD / RECOMMENDED 项满足与否需在实现说明中声明。

## 11.4 Tasks 分级与参考实现覆盖

只有声明官方 Tasks 扩展的实现才承担以下 Tasks MUST。Tier、Memory/持久化部署、可选订阅三者独立；capability 始终严格 `{}`。规范见 [MCP Tasks](20-mcp-tasks.md)，接口见 [Tasks SDK](21-tasks-sdk.md)。下表的「覆盖」是当前仓库测试范围，不代表数据库恢复或 Peri inbox 产品已实现。

| 编号 | 要求                                                                              | 等级        | 当前覆盖                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01  | 普通结果与扁平任务句柄正确分流；示例通过 0728 schema，outputSchema 只校验最终结果 | Tier 1 MUST | `schema.test.ts` 直接读取规范示例，用固定发布 JSON 完整 $defs 校验；另检查 npm 差异；`server.test.ts` 真实 HTTP/stdio、普通工具/资源/discover 混用 |
| T02  | 本次能力缺失返回 -32021；强制异步工具在执行前拒绝                                 | Tier 1 MUST | `server.test.ts` 每请求声明、严格空 capability、真正 JSON-RPC 错误与零执行                                                                         |
| T03  | 返回 taskId 后立即跨 HTTP 请求查询可见                                            | Tier 1 MUST | `service.test.ts` 原子可见；`server.test.ts` 请求级 Server 共享 service                                                                            |
| T04  | 工具仅执行一次；响应丢失、登记或轮询失败不得触发重放                              | Tier 1 MUST | Service 单次启动/接管、HTTP 断流与丢弃响应、Poller 不拥有原 call 且失败只查询/重交付                                                               |
| T05  | 前台转后台只接管原执行，快速完成不丢终态                                          | Tier 1 MUST | `service.test.ts` adopt；`regressions.test.ts` 真实 HTTP/stdio 同步完成与超时 promote、最终校验、登记失败不重跑                                    |
| T06  | 正常和 isError 结果 completed；协议执行错误 failed                                | Tier 1 MUST | `service.test.ts` 完整结果/错误语义、异常脱敏；集成测试最终 outputSchema                                                                           |
| T07  | 重复取消安全，ACK 不提前 cancelled，完成竞争不覆盖终态                            | Tier 1 MUST | 意图先存再 abort、清理确认、completed 获胜、外部回调失败与重试                                                                                     |
| T08  | endpoint/owner 隔离，get/update/cancel 每次授权；订阅不可越权确认                 | Tier 1 MUST | 三种方法真实 HTTP 隔离、伪造 \_meta 无效；真实 subscriptions/listen 不确认 taskIds，当前不提供任务订阅                                             |
| T09  | 迟到写入不覆盖终态，相同业务入口终态去重                                          | Tier 1 MUST | Service CAS/冲突/幂等；Poller 按 endpoint+scope+taskId+initiator 去重并重试相同交付                                                                |
| T10  | 不删除活动任务或未到期终态，满载先拒绝后执行                                      | Tier 1 MUST | TTL、查询不续期、总记录/活动并发容量、UTF-8/预留预算、report/businessRef 上限                                                                      |
| T11  | 默认 Memory 同一进程跨请求共享，重启不伪装恢复                                    | Tier 1 MUST | `server.test.ts` HTTP 共享；`service.test.ts` 新 Memory 不存在旧任务                                                                               |
| T12  | 可注入与数据库无关的 TaskStore                                                    | Tier 1 MUST | 四操作代理 Store、CAS 冲突重读、受信历史任务 report/settle                                                                                         |
| T13  | update 兼容 ACK 不写业务输入事实，Host 暴露 input_required                        | Tier 1 MUST | 官方 inputResponses 校验与 revision 不变；Poller 保留完整请求并 blocked                                                                            |
| T14  | 订阅先授权后 ACK、先存后通知、断流回读、有界背压                                  | 可选订阅    | 未实现，不声明覆盖                                                                                                                                 |
| T15  | 输入请求、部分/重复响应、拒绝及超时推进                                           | Tier 2      | 未实现                                                                                                                                             |
| T16  | 输入与取消/完成竞争不重复执行，请求 key 永不复用                                  | Tier 2      | 未实现                                                                                                                                             |
| T17  | 声明业务恢复时，重启核实原 job、不重跑且不丢取消意图                              | 业务选配    | 仅提供受信接口与取消意图记录；无真实持久化/恢复算法，不声明完成                                                                                    |

测试入口：`bun test packages/mcpp/src/tasks`。`transport.test.ts` 是兼容接入的运行验证；`service.test.ts`、`server.test.ts`、`poller.test.ts`、`regressions.test.ts` 与 `schema.test.ts` 验证实际 Tier 1 流程。当前 Host helper 只保证进程内绑定/交付去重；跨重启可靠投递仍由业务负责。

---
