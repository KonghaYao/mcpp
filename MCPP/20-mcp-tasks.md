# MCP Tasks：Tier 1 基础执行

[文档库首页](01-index.md) · [SDK 接口](21-tasks-sdk.md) · [一致性要求](16-conformance.md)

MCPP 复用官方 `io.modelcontextprotocol/tasks`，基于 MCP `2026-07-28`。规范报文以 ext-tasks commit `b3d28aceaa6d49f5f92258e3d06b61ad6f111e84` 的发布快照为准：[规范](https://github.com/modelcontextprotocol/ext-tasks/blob/b3d28aceaa6d49f5f92258e3d06b61ad6f111e84/specification/2026-07-28/tasks.md)、[schema](https://github.com/modelcontextprotocol/ext-tasks/blob/b3d28aceaa6d49f5f92258e3d06b61ad6f111e84/schema/2026-07-28/schema.ts)。本仓库以该 commit 的完整 `schema.json` 原样快照为校验依据，通过 SDK 公开 `AjvJsonSchemaValidator` 编译；快照及 Apache-2.0 许可证位于 `packages/mcpp/src/tasks/vendor/`。固定 `@modelcontextprotocol/ext-tasks@0.2.2/core/v2` 仅用于 TS 类型与附加投影，不替代发布 JSON，不使用旧 receiver。

## 1. 范围与等级

| 能力                                         | Tier 1                              | Tier 2 / 业务选配 |
| -------------------------------------------- | ----------------------------------- | ----------------- |
| 普通工具结果与任务句柄、查询、取消、终态交付 | MUST                                | 继承              |
| `working / completed / failed / cancelled`   | MUST                                | 继承              |
| `tasks/update`                               | MUST；无待答 key 时校验、忽略并 ACK | 处理实际待答输入  |
| Server 产生 `input_required`                 | MUST NOT                            | Tier 2            |
| Host 遇到外部 `input_required`               | MUST 保留请求并暴露 blocked         | Tier 2 交互处理   |
| `notifications/tasks` 订阅                   | MAY，本实现不提供                   | 独立可选能力      |
| 可注入 TaskStore、默认 Memory                | MUST                                | 继承              |
| 持久化、重启恢复、重跑、fencing              | 不内置                              | 业务自行实现      |

Tier 不进入 wire capability。Memory 与业务持久化是部署选择，和 Tier 等级独立。不承诺 exactly-once，不要求数据库或外部队列。

## 2. 协议协商与 endpoint

Server 在 `server/discover` 声明 `capabilities.extensions["io.modelcontextprotocol/tasks"]: {}`，不得添加 `tier`、`durable`、`resume` 或 `input` 设置。客户端每次相关请求都 MUST 声明，不得复用上一请求的能力：

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    "extensions": { "io.modelcontextprotocol/tasks": {} }
  }
}
```

该对象放在 `params._meta`，其余核心身份元数据沿用 MCP。必须异步的工具在未协商时 MUST 在执行前返回 JSON-RPC `-32021`，错误数据为 `{"requiredCapabilities":{"extensions":{"io.modelcontextprotocol/tasks":{}}}}`。工具可显式提供同步分支，但不能先启动后台工作再拒绝。

所有方法使用原 MCP endpoint，不增加任务专用 URL，也不实现旧 `tasks/list`、`tasks/result`、`notifications/tasks/status`。

| 方法           | params                   | 成功 result                                  |
| -------------- | ------------------------ | -------------------------------------------- |
| `tools/call`   | `name, arguments`        | 普通结果或扁平 `CreateTaskResult`            |
| `tasks/get`    | `taskId`                 | `resultType: "complete"` 与完整 DetailedTask |
| `tasks/update` | `taskId, inputResponses` | `{ "resultType": "complete" }`               |
| `tasks/cancel` | `taskId`                 | `{ "resultType": "complete" }`               |

HTTP 的三个任务方法 MUST 携带匹配的 `Mcp-Method` 和等于 `params.taskId` 的 `Mcp-Name`；这些头只是路由元数据，不是认证，也不提供跨实例 task locator。协议版本与核心请求 framing 由 MCP transport 验证；兼容层额外验证 Tasks 路由头。

## 3. 报文与结果分流

任务句柄是扁平结构，不是 `result.task`：

```json
{
  "resultType": "task",
  "taskId": "t_example_01",
  "status": "working",
  "createdAt": "2026-10-30T03:00:00Z",
  "lastUpdatedAt": "2026-10-30T03:00:00Z",
  "ttlMs": null,
  "pollIntervalMs": 2000
}
```

查询完成任务：

```json
{
  "resultType": "complete",
  "taskId": "t_example_01",
  "status": "completed",
  "createdAt": "2026-10-30T03:00:00Z",
  "lastUpdatedAt": "2026-10-30T03:00:04Z",
  "ttlMs": 86404000,
  "pollIntervalMs": 2000,
  "result": {
    "resultType": "complete",
    "content": [{ "type": "text", "text": "命令执行完成" }],
    "isError": false
  }
}
```

上例省略 JSON-RPC 外壳。`tasks/get` 外层的 `resultType: "complete"` 只表示查询完成；任务可能仍是 `working`，必须按 `status` 判断。创建基座 MUST NOT 携带终态 result/error。原工具 `outputSchema` 校验最终业务 `structuredContent`，不校验任务句柄。业务 `isError: true` 保持原工具结果并进入 `completed`；协议执行错误进入 `failed + error { code: integer, message, data? }`。

DetailedTask 的 `input_required` 变体必须保留完整 `inputRequests` 请求 map，不能只保存文本。Tier 1 不产生该状态。`tasks/update` 的 responses 仅接受上游 CreateMessageResult、ListRootsResult、ElicitResult 格式；无待答 key 或已满足 key 均忽略，ACK 不记录业务输入已处理事实。

## 4. 执行与终态不变量

1. MUST 先校验授权、参数、能力和容量，原子创建 `working` 记录，成功后才启动执行。返回句柄时同一身份立即查询必须可见。
2. 任务执行由应用生命周期持有，Promise 完成、异常与保存故障均受管理。HTTP 请求关闭、取消或断流 MUST NOT 取消任务。
3. 前台转后台只接管原执行 Promise，不重新调用业务。登记失败时原执行器明确决定原工作的存续，不启动补偿副本。
4. `working` 可更新说明，或提交 `completed / failed / cancelled`。终态先 CAS 保存；相同终态和相同结果重复提交幂等成功，不同结论或迟到 report MUST 拒绝。
5. 结果超限 MUST 明确保存为 `failed`，不截断结构化结果或谎报成功。Store 故障须显式报告，不能伪装已持久化；业务恢复器可核实后重试受信 `settle`。

任务服务和 Store MUST 放在请求级 Server factory 外，跨请求共享；Task signal 与 HTTP request signal 独立。Memory 只保证同一存活进程，不能把断线解释为远端任务失败，也不能把旧 `working` 记录解释为允许重跑。

## 5. 取消

取消顺序为「原子记录 `cancelRequestedAt` → AbortSignal 或幂等业务 onCancel → 执行器报告事实」。ACK 不是 `cancelled`，触发 signal 不代表清理完成。只有执行器确认停止并完成清理，才可提交 `cancelled`。取消与完成竞争时实际先提交的终态生效；正常完成仍可获胜，已终态取消只 ACK 不改变结论。

没有本地取消句柄时 MUST 通过业务回调投递；未配置回调则明确报错，不假装取消成功。回调失败保留取消意图并返回协议错误，重复请求可重试。MCPP 不承诺撤销已发生的副作用。

## 6. 存储、TTL 与预算

完整身份是 `{ namespace, owner, taskId }`，namespace 是稳定 endpoint 命名空间，owner 由可信授权映射提供，不存 token、不默认把 `clientId` 当最终用户，也不相信客户端 `_meta` 中的 owner。

默认 Memory 采用复制隔离、revision CAS。新记录 revision 为 1；CAS 成功加一。替换 Store 不会恢复执行 Promise、外部 job、取消句柄或业务所有权；扫描、全局配额、租约与恢复算法由业务实现。

| 设置                  | 默认值           |
| --------------------- | ---------------- |
| `pollIntervalMs`      | 2000             |
| 活动 `ttlMs`          | null             |
| `terminalRetentionMs` | 24 小时          |
| 活动任务 / 总记录     | 128 / 2048       |
| 单结果 / 总序列化预算 | 256 KiB / 64 MiB |

终态 `ttlMs = terminalAt - createdAt + terminalRetentionMs`。只删除已到期终态；不驱逐活动任务或承诺保留的结果。查询不续期。预算按 UTF-8 JSON 序列化字节计量，不等于 JS 堆内存；准入预留结果和终态头部空间，report 与 businessRef 不能绕过总预算。

## 7. Host 观察和交付

Host MUST 保存 `{ endpoint, authorizationContext, remoteTaskId, initiatorContext }`，不得依赖 MCP Session。任务登记失败、响应丢失、查询失败、状态未知都不得自动重放原 `tools/call`。

登记后立即 get；每个远端任务最多一个在途查询，尊重建议间隔，错误使用有界退避。默认单次查询超时 5 秒，不是任务执行超时。取消 ACK 后继续观察，结束本地等待不等于取消远端任务。已知终态保留在本地，交付失败重试同一结果；同一发起上下文去重。跨 Host 重启的绑定与 inbox 去重由业务持久化。

Tier 1 Host 遇到外部 `input_required` MUST 暴露 blocked 并保留完整请求，不自动回答、重跑、伪装 working 或擅自取消。参考 `TaskPoller` 是可注入 transport 的轻量实现，不是 Peri inbox 产品。

## 8. 权限、缓存与模块边界

未知、过期、其他 owner 统一返回 `-32602` Unknown task；格式错误也为 `-32602`，内部故障为无 stack、凭据的 `-32603`。每次 get/update/cancel 均重新解析可信 scope，不得因 Cache Version 相等跳过授权或实时读取。TaskStore 不是通用 Response Cache。

Channel 业务出站只走 Resource Subscription；可选 Tasks 状态通知使用标准 `notifications/tasks`，不是 Resource 失效提示，不要求转成 Resource。启用订阅时须逐项授权、先提交后通知、ACK 后回读、断流重建与有界背压；本 Tier 1 实现不提供订阅，也不确认 taskIds。

任务结果和 statusMessage 是不可信工具数据，不提升成系统指令。大文件、完整日志通过已有资源引用交付；Tasks 不另建文件传输。任务开始前授权文件并保证执行所需副本可用，任务 TTL 不延长文件 TTL。Mono Server 每个 Child endpoint 使用独立 namespace。
