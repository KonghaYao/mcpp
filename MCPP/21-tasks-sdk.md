# Tasks SDK 接口与部署边界

[文档库首页](01-index.md) · [MCP Tasks 规范](20-mcp-tasks.md) · [参考实现](17-reference-implementation.md)

导出：`@peri-code/mcpp/tasks`，根入口同时导出。实现等级为 Tier 1，wire 校验使用 commit `b3d28aceaa6d49f5f92258e3d06b61ad6f111e84` 原样发布 JSON 快照，由 SDK 公开 AJV provider 编译；npm `core/v2` 只提供类型与附加投影。SDK 2.0 本身的现代 Tasks runtime 缺失，因此 `TasksServer` 仅在公开 `connect(Transport)` 边界分流已注册的任务工具与三个 `tasks/*` 方法；普通工具、资源、目录和 discover 仍由原 SDK 处理。不使用私有 SDK 字段、monkey patch 或旧 receiver。

## 1. 应用级组合

```ts
import { z } from "zod";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { TaskService, TasksServer } from "@peri-code/mcpp/tasks";

const tasks = new TaskService({ namespace: "production/reports" });

// 此 WeakMap 由应用认证中间件填写，绝不由请求 _meta 或原始 header 直接赋值。
const principals = new WeakMap<Request, { ownerPartition: string }>();

const handler = createMcpHandler(
  (context) => {
    const server = new TasksServer(
      { name: "reports", version: "1" },
      {
        service: tasks,
        context,
        resolveScope: ({ request }) => {
          const principal = request && principals.get(request);
          return principal
            ? { namespace: tasks.namespace, owner: principal.ownerPartition }
            : undefined;
        },
      },
    );
    server.registerTaskTool(
      "report",
      {
        inputSchema: z.object({ title: z.string() }),
        outputSchema: z.object({ title: z.string() }),
        authorize: async (args, scope) => {
          // 在这里使用应用授权逻辑校验参数、文件、资源和业务权限。
        },
      },
      async (args, ctx) => {
        await ctx.report("正在生成");
        await ctx.setBusinessRef({ jobId: "application-job-reference" });
        // 将 ctx.signal 传给实际执行器；只有确认停止并清理完成才返回 cancelled。
        return {
          kind: "result",
          result: {
            resultType: "complete",
            content: [{ type: "text", text: args.title }],
            structuredContent: { title: args.title },
          },
        };
      },
    );
    server.registerTool("plain", {}, async () => ({ content: [] }));
    return server;
  },
  { legacy: "reject" },
);
```

认证中间件须在调用 `handler.fetch(request)` 前完成验证并填入对应 Request 的可信 principal；以上代码不实现认证。也可显式使用经验证的 `handler.fetch(request, { authInfo })` 输入，但 SDK 的 authInfo 只是透传，不代表自动验证 OAuth，`clientId` 也不必然是最终用户。

`TasksServerOptions.resolveScope` 每次任务 RPC 和任务工具调用都会执行。它只接收 transport 的可信宿主上下文，不把客户端 `_meta.owner` 暴露为授权输入。HTTP 的 `context` 来自 factory；stdio 可在可信进程/连接配置闭包中返回 scope。已有 `startServer(factory)` 和 `serveStdio(factory, { legacy: "reject" })` 调用方式不变，factory 返回 `TasksServer` 即可。已有普通 McpServer 不会自动拥有 Tasks。

共享 TaskService/Store MUST 在请求 factory 外创建。请求 product.close 不调用 TaskService.close，也不 abort 后台执行。Serverless 必须另有运行保障，不能把请求后的普通 Promise 当作可靠外部执行器。

## 2. TaskStore

```ts
interface TaskScope {
  namespace: string;
  owner: string;
}
interface TaskKey extends TaskScope {
  taskId: string;
}
interface TaskRecord {
  key: TaskKey;
  revision: number;
  snapshot: DetailedTask;
  cancelRequestedAt?: string;
  businessRef?: JsonValue;
}
interface TaskStore {
  create(record: TaskRecord): Promise<void>;
  get(key: TaskKey): Promise<TaskRecord | undefined>;
  compareAndSet(
    key: TaskKey,
    expectedRevision: number,
    next: TaskRecord,
  ): Promise<"updated" | "conflict" | "not_found">;
  delete(key: TaskKey, expectedRevision: number): Promise<boolean>;
}
```

- create 是原子仅插入，revision 必须为 1，成功即查询可见；冲突不得覆盖。
- get、create、CAS 均复制隔离，不允许修改已返回对象绕过提交。
- CAS 要求 next 完整 key 和 snapshot.taskId 匹配，revision 恰为 expected + 1；服务发生 conflict 时重新读取。
- delete 必须匹配 revision；TaskService 只对到期终态调用。
- `taskKey()` 使用三元数组 JSON 编码，避免拼接分隔符碰撞。
- 内部 key、revision、businessRef、cancelRequestedAt 不投影到 wire。

`MemoryTaskStore` 不依赖文件、数据库或网络。相同 Store 对象在进程内共享准入锁与记账。活动记录的单结果预留和总预算上限绑定首次准入配置，后续其他 service 的 get/report/sweep 不会下调；共存记录采用其中最保守的总预算上限，不能通过第二个低预留 service 挤占已承诺结果空间。同一 endpoint 的请求仍 MUST 共享同一个 TaskService；共享 Store 不共享运行控制器，跨 service 的取消必须通过业务 onCancel 路由，不能假装 abort 其他 service 的执行。自定义 Store 应自行保证跨进程一致性、全局 quota 和业务扫描；服务只能核算本进程已知记录，不能发现重启前未知历史，也不提供执行器租约或 fencing。业务直接写 Store 必须维护自身预算，不能绕过服务写入后宣称全局配额受控。

## 3. TaskService

```ts
const service = new TaskService({
  namespace: "stable-endpoint",
  store: new MemoryTaskStore(), // 可省略
  pollIntervalMs: 2000,
  terminalRetentionMs: 24 * 60 * 60 * 1000,
  limits: {
    maxActiveTasks: 128,
    maxRecords: 2048,
    maxResultBytes: 256 * 1024,
    maxStoredBytes: 64 * 1024 * 1024,
  },
  onCancel: async (record) => {
    // 核实业务执行所有权，再向 record.businessRef 指向的 job 投递取消。
    // 必须幂等；收到意图不等于任务已经 cancelled。
  },
  onExecutionError: (error) => {
    // 仅固定错误摘要；由应用报警并安排受信恢复，不记录结果、scope 或凭据。
  },
});
```

| API                                                      | 契约                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `start(scope, options, execute)`                         | 原子记录可见后调用 execute 一次，不等待业务完成返回句柄                                         |
| `adopt(scope, options, executionPromise)`                | 接管同一个已启动 Promise，支持快速已完成结果；不会再执行业务                                    |
| `get(scope, taskId)`                                     | 实时读取完整快照，授权分区不可见统一 Unknown task                                               |
| `requestCancel(scope, taskId)`                           | 先存意图，再通知本地 signal / onCancel，不写 cancelled                                          |
| `report(scope, taskId, message)`                         | 受信更新 working 的说明，保留 createdAt，增加 revision                                          |
| `setBusinessRef(scope, taskId, json)`                    | 受信业务引用更新；终态后拒绝，受预算约束                                                        |
| `settle(scope, taskId, outcome)`                         | CAS 提交终态；相同结果幂等，不同结论拒绝                                                        |
| `waitForIdle()`                                          | 等待应用持有的执行 Promise；保存失败以 AggregateError 报告                                      |
| `close()`                                                | 同步停止新执行准入，取消并等待未转交前台执行；已提交任务仍按业务策略等待，不擅自终止外部 job    |
| `startForeground(execute)`                               | 业务开始前同步登记独立控制器与 Promise；已关闭 service 立即拒绝，包含原执行 finally 的完成事实  |
| `discardForeground(execution)`                           | 对未转交前台执行发出 abort，并等待其 Promise 清理完成                                           |
| `promoteForeground(scope, options, execution, validate)` | 只接管本 service 登记的前台执行；任务记录和执行器登记成功后在锁内转移所有权；失败先清理，不重跑 |

`TaskStartOptions` 是 `{ statusMessage?, businessRef? }`。execute 的 `TaskExecutionContext` 提供 `{ key, signal, report, setBusinessRef }`，signal 独立于请求。outcome 是以下三种之一：

```ts
type TaskOutcome =
  | { kind: "result"; result: CallToolResult }
  | { kind: "error"; error: JsonRpcError }
  | { kind: "cancelled"; message?: string };
```

最终工具结果必须为 `resultType: "complete"`。业务 isError 保持 completed；普通抛错转为不含内部错误详情的 failed。可信业务可使用 `TaskError` 或显式 error outcome 提供已脱敏的协议错误，不能放入 token、stack 或连接字符串。结果超限与不可序列化结果改为明确 failed，不做截断。Store 故障仍可能阻止终态持久化：服务不谎报成功，通过固定诊断回调和 waitForIdle 暴露，由业务核实后 settle 重试。

低层受信入口为 `service.adopt(scope, options, alreadyRunningPromise, controller?)`；可选 controller 必须是原执行实际使用的控制器，缺省时由 onCancel 路由取消。工具不能从 `complete` 任意返回 adopt 句柄：必须使用下节绑定本次调用的 foreground start/promote，以保证权限、能力、原执行身份及最终 outputSchema。登记失败不重放执行，适配器会 abort 原控制器；执行器负责落实停止与清理。

预算按 UTF-8 JSON 字节计算，活动任务预留单结果、终态头部和取消意图空间。report/businessRef 增长也经过总预算。创建准入不会删除未过期终态；到期清理由读取和新准入惰性触发，不使用按查询续期的缓存。

## 4. 任务工具注册

`registerTaskTool(server, name, config, execute)` 等价于 `server.registerTaskTool(...)`。config 使用 Zod inputSchema，可选 outputSchema、title、description、annotations、\_meta、authorize 和 startOptions。

默认强制异步，必须先声明 Tasks 能力。`mode: "complete"` 与 `complete(args, scope)` 提供不强制 Tasks 的同步结果；`mode: "foreground"` 在进入业务前检查 Tasks 能力，允许超时后转移同一执行。`complete` 第三个参数提供本次调用专有的 start/promote：

```ts
server.registerTaskTool(
  "build",
  {
    inputSchema: z.object({}),
    outputSchema: z.object({ success: z.boolean() }),
    mode: () => "foreground",
    complete: async (args, scope, foreground) => {
      const execution = foreground.start(async (signal) => {
        // 在真实执行器中使用 signal；这里只展示单次执行结果。
        return {
          kind: "result",
          result: {
            resultType: "complete",
            content: [],
            structuredContent: { success: true },
          },
        };
      });
      const outcome = await Promise.race([
        execution.outcome,
        new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
      ]);
      if (outcome?.kind === "result") return outcome.result;
      return foreground.promote(execution);
    },
  },
  async () => {
    throw new Error("前台分支不会重新调用后台执行器");
  },
);
```

start 每次调用只能启动一次，并立即由 TaskService 持有运行所有权，不是请求局部的裸 Promise。promote 只接受本次 start 的执行对象，不接受任意 taskId/句柄；任务记录与运行器成功登记后才原子转移所有权。句柄不经过最终 outputSchema，原 Promise 的最终结果仍校验。

handler 抛错、非法返回、伪造句柄、最终 outputSchema 不匹配及任务准入失败均经过统一 finally：abort 未转交执行，并等待业务自己的 finally 清理后才返回 RPC 错误。若已 start 的执行尚未完成，complete 不得直接返回普通结果，必须等待它完成或 promote；否则同样拒绝并清理。complete 返回后的上下文不能延迟启动新工作。

TaskService.close 同步停止新前台准入，取消尚未转交的前台执行并等待清理；与 promote 竞争时，已经进入任务原子创建的交接由同一锁完成，关闭继续等待原 Promise 与终态保存，不丢运行所有权。已提交的后台任务保持原取消策略，不因请求关闭自动取消。waitForIdle 同时等待前台和后台执行。忽略 AbortSignal 或永不完成的业务不能被 JS 强停，close/错误 RPC 会继续等待，不谎报清理完成；部署方需自行管理执行超时和外部进程停止。

参数与授权先于执行，缺能力时 start/complete 尚未执行；服务关闭后 start 在调用业务前拒绝。纯同步 complete 不得背后启动未托管任务。

核心 envelope 的 clientInfo、clientCapabilities、logLevel、progressToken 和 tools/call params 使用 SDK 公开 Standard Schema 校验。Tier 1 不签发 MRTR requestState，因此任务工具的任何回传 requestState 都以 -32602 拒绝；普通 SDK 工具的合法 requestState/verifier 不受影响。

Tier 1 的 tasks/update 使用官方 schema 验证 inputResponses，再实时 get 验证授权和存在性，不修改 revision 或记录业务处理事实。未知任务不会按普通 Unknown tool 策略重建或 replay。

## 5. 轻量 Host helper

`TaskPoller` 不调用原工具；宿主收到句柄后执行 `register(binding, handle)`，然后 `observe(binding, signal)`。binding 含 endpoint、可信 authorizationContext、远端 taskId、initiatorContext，不能保存 token。注入：

- `get(binding, signal)`：宿主的原始 MCP 请求协调器，返回完整 GetTaskResult（必须有 `resultType: "complete"`，不能只返回 DetailedTask）；helper 使用固定发布快照校验。调用 tasks/get 时填本次能力、协议元数据及 HTTP 路由头；客户端 SDK 2.0 的 modern era gate 不原生支持任务方法，不能只调用其高层 request 假装已兼容。
- `deliver(binding, task)`：现有可信 inbox / UI 入口；失败重试同一终态，不重新 get 原工具结果或 replay tools/call。
- `blocked(binding, inputRequiredTask)`：通知宿主需 Tier 2 处理；`snapshot(binding)` 可读取复制后的完整请求。
- `unavailable(binding)`：本地状态不可确认提示，不生成远端 failed。

立即读取、单远端任务在途查询、建议间隔、5 秒默认请求超时、有界退避和进程内交付去重均有 harness 测试。超时后若 transport 不响应 signal，观察器不会再叠加查询；实际 transport 应及时完成取消。observe 的 signal 只停止本地观察，不发远端 cancel；在途查询返回后如已停止，不再启动 deliver/blocked，仍保留已经确认的终态供显式恢复交付。已经进入的业务 deliver 无法撤销。当前单次 get 最多等待其配置超时。`forget` 只释放本地空闲绑定，跨重启去重和持久化 inbox 仍由宿主负责。

## 6. 未实现面

不实现 Tier 2 输入处理、Tasks 状态订阅、数据库驱动、历史扫描、重跑、检查点、恢复调度、执行器 fencing、Peri inbox 产品或自动 OAuth。受信 report/settle 可以供业务恢复器使用，但这不构成已经实现 T17 业务恢复。HTTP/stdio 兼容层、协议与工具测试以及 Host harness 的实际覆盖见 [T01–T17](16-conformance.md)。
