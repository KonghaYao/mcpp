# 8.2.1 Channel SDK：Resource 与 Command 深模块

[文档库首页](index.md) · [上一篇：MCP Channel](mcp-channel.md) · [下一篇：MCP Extension](mcp-extensions.md)

线级映射、订阅语义与 Host 消费规则见 [MCP Channel](mcp-channel.md)。本页定义 Server SDK 的跨语言架构契约；TypeScript 仅用于表达结构，不是规范核心，也不要求其他语言复制条件类型或泛型技巧。

## 设计结论

Channel 不是 MCP primitive、extension、capability 或 JSON-RPC method。SDK 核心由两个可独立实现、注册和演进的深模块组成：

| 模块 | 最小公开 Interface | 标准 MCP 映射 |
| --- | --- | --- |
| `ResourceChannel<T>` | `send()` | `resources/*`、`subscriptions/listen`、`notifications/resources/updated` |
| `CommandChannel<I, O>` | `receive()` | `tools/list`、`tools/call` |

`DuplexChannel<Out, In, Result>` 只是应用层组合，不增加事务语义。Tool result 与 Resource event 相互独立；SDK **MUST NOT** 暗示二者原子完成或因果上等价。

`ChannelManager` MAY 作为注册与生命周期 façade 存在，但授权、持久化、路由和 MCP transport 必须位于独立 seam 后。删除 Manager 时，这些复杂度应回到内部模块而不是扩散给业务调用方。

```text
MCP Resource Adapter                 MCP Tool Adapter
         │                                  │
         └───────────┬──────────────────────┘
                     ▼
             Immutable Binding Catalog
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
 Publish Coordinator      Command Coordinator
        │                         │
 Authorization Policy     Authorization Policy
        │                         │
 Journal + Outbox         Command Ledger
        │                         │
 Outbox Dispatcher        Application Handler
        │
 Subscription Gateway
```
依赖方向固定为 Adapter → Coordinator → Policy / Journal / Ledger port；存储 Adapter **MUST NOT** 依赖 MCP request、transport credential、`TrustedSubject` 或 SDK façade 类型。

## 绑定身份与 Schema

每个方向拥有独立、不可变的绑定身份。一个顶层 `schemaVersion` 不足以描述 outbound payload、Tool input 与 Tool output，禁止继续将它们合并为同一版本。

```ts
type ChannelId = string;
type BindingId = string;
type BindingGeneration = string;
type SchemaDigest = `sha256:${string}`;
type EventId = string;   // canonical UUIDv7；Server publisher SDK 生成。
type CommandId = string; // canonical UUIDv7；Client SDK 生成，重试时原样复用。
type JsonSchema202012<T = unknown> = Readonly<Record<string, unknown>>;
interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

type BindingIdentity = Readonly<{
  channelId: ChannelId;
  bindingId: BindingId;
  direction: "resource" | "command";
  generation: BindingGeneration;
  schemaDigest: SchemaDigest;
}>;
interface ResourceBindingSpec<T> {
  identity: BindingIdentity & { direction: "resource" };
  title: string;
  description: string;
  resourceUri: string;
  mode: "state" | "event-log";
  payloadSchema: JsonSchema202012<T>;
  envelopeSchema: JsonSchema202012<ResourceSnapshot<T>>;
  durability: "durable" | "process-local";
  retention: { maxEvents?: number; maxAgeMs: number; maxBytes?: number };
  eventIdempotencyHorizonMs: number;
}
interface CommandBindingSpec<I, O> {
  identity: BindingIdentity & { direction: "command" };
  title?: string;
  description: string;
  toolName: string;
  messageSchema: JsonSchema202012<I>;
  businessResultSchema: JsonSchema202012<O>;
  toolInputSchema: JsonSchema202012<CommandInput<I>>;
  toolOutputSchema: JsonSchema202012<CommandOutcome<O>>;
  annotations: McpToolAnnotations;
  durability: "durable" | "process-local";
  idempotencyHorizonMs: number;
}
```
不变量：

- `bindingId` 在 Server 内稳定唯一；`generation` 标识不可变 wire contract，不是软件版本或隐式协商机制；
- `schemaDigest` 是对按固定字段顺序组成的 input/output schema bundle 执行 RFC 8785 + SHA-256 的结果；bundle 不含 title/description，`$ref` 按原始 schema JSON 参与计算；
- 任何 schema、字段语义或兼容性发生变化都 MUST 使用新 generation 和新 `resourceUri` / `toolName`；同名绑定不得并存多个 generation；
- 滚动升级期间，共享同一 binding 的实例 MUST 支持完全相同的 generation 与 schemaDigest；handler 部署代际另行 fencing；
- Catalog 必须按 generation 不可变。替换 binding 时使用 `REGISTERED → DRAINING → RETIRED`，不能原地改变 handler 语义；
- payload、完整 envelope 和业务结果均使用 JSON Schema 2020-12；`tools/list.outputSchema` MUST 等于完整 `toolOutputSchema`。

队列容量、enqueue timeout、并发数和执行 timeout 是有限的部署策略，但不是 binding 身份。它们属于 `ResourceRuntimePolicy` / `CommandRuntimePolicy`，可按节点和租户调整；SDK 必须拒绝无界配置。

## 可信身份与授权 Grant

MCP Adapter 从可信 transport 建立 `TrustedSubject`。它是 SDK 内部创建、不可序列化且业务代码不可构造的 opaque handle，不得从 Tool arguments、metadata、webhook payload 或反序列化 DTO 恢复。Client arguments 中的 tenant、principal、topic、room 或 scope 不构成身份事实。`TrustedSubject` 只引用身份，不授予权限；Policy 每次调用都必须解析当前 identity / revocation state。跨请求长期保存只允许显式 service identity，不得保存用户请求期认证快照。

Policy 不返回布尔值，而返回有期限、带策略代际的 Grant。Coordinator 验证 Grant 后只把稳定的分区键和视图键传给存储；Router 与 Resource read 必须消费同一授权视图。

```ts
interface TrustedSubject {
  // 仅在业务调用方、Adapter 与 Policy seam 内可见；不得进入持久化接口或日志。
  readonly opaqueSubject: unknown;
}
interface PayloadMetadata {
  encodedBytes: number;
  schemaDigest: SchemaDigest;
}
interface GrantBase {
  decisionId: string;
  policyEpoch: string;
  tenantPartition: string;
  expiresAt: string;
}
interface PublishGrant extends GrantBase {
  journalPartition: string;
  audienceKey: string;
}
interface ReadGrant extends GrantBase {
  journalPartition: string;
  viewKey: string;
  cursorDomain: string;
  allowedAudienceKeys: readonly string[];
}
interface InvokeGrant extends GrantBase {
  deduplicationScope: string;
}
interface ChannelAuthorizationPolicy<T, I> {
  authorizePublish(input: {
    subject: TrustedSubject;
    binding: BindingIdentity;
    target: PublishTarget;
    payloadMetadata: PayloadMetadata;
  }): Promise<PublishGrant>;
  authorizeRead(input: {
    subject: TrustedSubject;
    binding: BindingIdentity;
  }): Promise<ReadGrant>;
  authorizeInvoke(input: {
    subject: TrustedSubject;
    binding: BindingIdentity;
    command: CommandInput<I>;
  }): Promise<InvokeGrant>;
}
```
`audienceKey`、`viewKey` 和 `deduplicationScope` 是 Policy 产生的 opaque partition key，不得包含 token、cookie 或可直接记录的 principal。`deduplicationScope` 必须在整个 idempotency horizon 内对同一副作用权限域稳定，不能因 token refresh、policy epoch 或诊断 pseudonym 轮换而变化；不同租户或主体不得碰撞。若必须迁移 scope，相同 `(bindingId, generation, commandId)` 必须返回 scope conflict，不能按新命令执行。返回任何旧 terminal result 前仍须通过当前授权。授权撤销通过 `policyEpoch`、Grant 到期或 revocation signal 收敛；过期 Grant 不得继续用于 send、read、dispatch 或 handler 启动。

## ResourceChannel：提交事实与失效调度

### 公开 Interface

```ts
interface PublishTarget {
  // 业务目标选择器，不是授权结果；具体字段由应用定义。
  readonly selector: unknown;
}
interface SendRequest<T> {
  publisher: TrustedSubject;
  eventId: EventId;
  target: PublishTarget;
  payload: T;
  causationId?: string;
  correlationId?: string;
}
interface CommitReceipt {
  eventId: EventId;
  bindingGeneration: BindingGeneration;
  resourceVersion: string;
  committedAt: string;
  deduplicated: boolean;
}
interface ResourceChannel<T> {
  readonly spec: Readonly<ResourceBindingSpec<T>>;
  send(request: SendRequest<T>): Promise<CommitReceipt>;
}
```
Receipt 只证明 Resource 事实已经提交，不证明 notification 已送达、Client 已读取或业务已处理。公开 Receipt MUST NOT 返回匹配订阅者数量、在线状态或 sink 队列统计；这些数据不稳定且可能泄露租户活动。

### Journal、cursor 与 Resource 内容

```ts
interface ResourceEvent<T> {
  eventId: EventId;
  occurredAt: string;
  causationId?: string;
  payload: T;
}
interface RetentionGap {
  reason: "retention";
  earliestAvailableCursor: string;
}

type ResourceSnapshot<T> =
  | {
      mode: "state";
      generation: BindingGeneration;
      resourceVersion: string;
      present: boolean;
      state?: T;          // present=true 时存在；T 自身可以合法为 null。
      tombstone?: boolean;
      updatedAt?: string;
    }
  | {
      mode: "event-log";
      generation: BindingGeneration;
      cursorDomain: string;
      headCursor: string;
      nextPageUri?: string;
      gap?: RetentionGap;
      events: readonly ResourceEvent<T>[];
    };
```
- `nextPageUri` 是 Server 生成的分页 Resource URI；Client 只可原样传给下一次 `resources/read`，不得解析或拼接 cursor；每页必须重新授权；
- URI 内的 opaque cursor 必须绑定 `bindingId + generation + cursorDomain`，不是 capability 或授权凭证，不得含 token、principal 或其他凭据；
- 多 audience 的授权合并视图必须拥有自己的稳定 cursor domain。禁止把多个 scope 内各自递增的裸 `sequence` 合并后交给一个 cursor；
- 授权过滤导致的不可见事件不得表现为 retention gap，也不得通过序号差泄露其他主体活动；
- State 合法组合为未初始化 `(present=false, tombstone=false)`、当前值 `(true, false)`、已删除 `(false, true)`；`(true, true)` 非法，且 present=true 时 state 字段必须存在，即使值为 JSON null；
- event 幂等键为 `(bindingId, generation, journalPartition, eventId)`；outbound digest 对影响 Resource 事实的规范化 payload、target 与关联字段执行 RFC 8785 + SHA-256。

Resource retention 与 event 幂等 tombstone retention 相互独立。`eventId` 的 UUIDv7 时间戳加 `eventIdempotencyHorizonMs` 定义幂等到期点；tombstone 不得提前删除。Server 拒绝 horizon 外或超出允许未来时钟偏差的 eventId，不能将其静默当作新事件；同键同 digest 返回原 CommitReceipt，同键不同 digest 返回幂等冲突。

### 原子提交与 outbox

一次 durable `send()` 的线性化点是 Journal 与 invalidation outbox 的同一事务提交：

```text
BEGIN
  validate generation / schema / size / PublishGrant
  reserve (bindingId, generation, journalPartition, eventId, digest)
  replace state or append event
  advance resourceVersion / cursor
  insert invalidation outbox(bindingId, generation, resourceUri, partition)
COMMIT  ← send() 的事实提交线性化点
```
- 存储失败 MUST NOT 产生 updated notification；
- commit 成功后，outbox dispatcher MUST 最终重新调度失效信号，进程在 commit 后、enqueue 前崩溃不得永久丢失 invalidation；
- 实现 MAY 使用事务表、CDC、durable broker 或等价机制，但“仅提交后遍历本进程 sink”不满足 durable Profile；
- outbox 只保存 URI、generation、resourceVersion 和分区 metadata，不应复制业务 payload；
- notification 允许重复、合并和重排；它仍只是 stale signal，不能成为 exactly-once delivery 或业务 acknowledgment。

Process-local Profile 可以不提供 durable outbox，但必须公开声明：进程重启或 Router 丢失会要求 Client 重新 listen + read，且不能声称持久失效调度。

### 订阅状态机

```text
REQUESTED
  → AUTHORIZED
  → ATTACHED_WITH_OUTPUT_GATE
  → ACK_ENQUEUED_AS_FIRST_MESSAGE
  → ACTIVE
  → LAGGED | REVOKED | CANCELLED | CLOSED
```
不变量：

1. 固化 filter 与 `ReadGrant` 后，先 attach 有界 sink，并关闭输出 gate；
2. acknowledgment 必须作为该 sink 第一条输出入队，然后打开 gate；
3. attach 至打开 gate 期间的 updated signal 暂存于有界 gate；溢出即关闭订阅，Client 重新 listen + read；
4. Client 收到 acknowledgment 后执行 baseline `resources/read`；因为 sink 已 attach，该读取之后的更新不会落入 ack/read/attach 窗口；
5. 授权撤销或 Grant 过期后，Router 停止投递并关闭订阅；
6. 每个 sink 使用有界队列，慢消费者不得阻塞全局生产者。

## CommandChannel：Tool wire 与 Command Ledger

### 完整 wire envelope

```ts
interface CommandInput<I> {
  commandId: CommandId;
  bindingGeneration: BindingGeneration;
  message: I;
  correlationId?: string;
  replyToEventId?: EventId;
}

type CommandOutcome<O> =
  | { status: "completed"; result: O; deduplicated: boolean }
  | { status: "failed"; safeErrorCode: string; deduplicated: boolean }
  | { status: "in-progress" }
  | { status: "delivery-unknown"; safeErrorCode: string }
  | { status: "idempotency-expired"; safeErrorCode: string };
type StoredCommandOutcome<O> =
  | { status: "completed"; result: O }
  | { status: "failed"; safeErrorCode: string };
type HandlerCompletion<O> = StoredCommandOutcome<O>;
interface ExecutionContext {
  commandId: CommandId;
  bindingGeneration: BindingGeneration;
  serverTraceId: string;
  receivedAt: string;
  subject: TrustedSubject;
  signal: AbortSignal;
}

type ReceiveHandler<I, O> = (
  input: CommandInput<I>,
  context: ExecutionContext,
) => Promise<HandlerCompletion<O>>;
```
`toolOutputSchema` MUST 描述完整 `CommandOutcome<O>`，不能只描述 `O`。`deduplicated` 由 Coordinator 按本次调用是否命中已有 terminal record 派生，MUST NOT 写入不可变 ledger outcome；首次完成返回 false，重放结果返回 true。映射规则：

- `completed` 与幂等 `in-progress` 是 `isError: false` 的 Tool structured result；
- `failed`、`delivery-unknown` 与 `idempotency-expired` 使用 `isError: true`；unknown 的安全错误信息必须禁止 Host 用新 commandId 自动重试；
- schema、未知 Tool、无效 generation 等无法执行请求的情况使用相应 protocol error；
- `delivery-unknown` 必须显式返回，不得伪装为普通可重试错误；
- 最小核心只支持同步终态。异步任务必须另行绑定标准 MCP Task，或一个具有独立 schema、授权、retention 与终态的 operation Resource；不能在 Command outcome 中只返回一个无查询契约的 `operationId`。

### Canonical digest 与幂等期限

幂等键为：

```text
(bindingId, bindingGeneration, InvokeGrant.deduplicationScope, commandId)
```
`requestDigest` 使用 RFC 8785 JSON Canonicalization Scheme 对完整 `CommandInput` 规范化，以 UTF-8 编码后计算 SHA-256，并表示为小写 `sha256:{hex}`。所有可能影响 handler 的字段都必须进入 digest；不得依赖语言运行时对象键顺序、默认浮点格式或 Unicode 的偶然序列化行为。SDK MUST 拒绝不能按该 profile 无损规范化的输入，并发布跨语言共享测试向量。

terminal ledger record 必须保留到 `expiresAt = UUIDv7 timestamp + idempotencyHorizonMs`；`now >= expiresAt` 即过期。`commandId` 必须是 Client SDK 生成的 canonical UUIDv7，重试时原样复用；Server 校验 variant、版本、编码和时间戳范围，但它不构成授权凭证。非终态记录不得因容量或年龄 retention 被淘汰。Server 先检查时间：已过期则返回 `idempotency-expired`，在 horizon 内却无记录时才允许视为首次调用；超出允许未来时钟偏差时拒绝为无效输入。接近到期才首次抵达的命令仍可执行，建立 record 后 MUST 至少保留到该次执行取得 terminal outcome；过期拒绝不允许 Host 自动换新 commandId 重放同一业务动作。

### Command Ledger 状态机

```text
ABSENT
  → RESERVED(lease, owner, fence)
  → STARTED(fence)
  → COMPLETED | FAILED | DELIVERY_UNKNOWN

RESERVED -- handler 未开始且 lease 过期 --> 可安全释放并重新占位
STARTED  -- timeout / cancel / crash --> DELIVERY_UNKNOWN
DELIVERY_UNKNOWN -- 显式业务 reconciliation --> COMPLETED | FAILED
```
最小持久化 port：

```ts
interface StartedToken {
  reservationId: string;
  fence: string;
  ownerGeneration: string;
  executionDeadline: string;
}
interface CommandLedger<O> {
  reserve(input: {
    key: {
      bindingId: BindingId;
      generation: BindingGeneration;
      deduplicationScope: string;
      commandId: CommandId;
    };
    requestDigest: string;
    owner: string;
    leaseUntil: string;
  }): Promise<
    | { state: "reserved"; reservationId: string; fence: string }
    | { state: "terminal"; outcome: StoredCommandOutcome<O> }
    | { state: "in-progress" }
    | { state: "delivery-unknown"; safeErrorCode: string }
    | { state: "idempotency-expired"; safeErrorCode: string }
  >;
  markStarted(input: {
    reservationId: string;
    fence: string;
    handlerGeneration: string;
    ownerGeneration: string;
    executionDeadline: string;
  }): Promise<
    | { state: "started"; token: StartedToken }
    | { state: "stale-fence" | "expired" | "terminal" }
  >;
  releaseBeforeStart(input: {
    reservationId: string;
    fence: string;
  }): Promise<void>;
  finish(input: {
    started: StartedToken;
    terminal: "completed" | "failed";
    encodedOutcome: Uint8Array;
  }): Promise<"stored" | "stale-fence">;
  markDeliveryUnknown(input: {
    started: StartedToken;
    safeErrorCode: string;
  }): Promise<void>;
}
```
Store Adapter 必须以 CAS / fencing 实现合法转换：`markStarted()` 只有返回 `started` 后才可调用 handler；旧 worker、过期 lease 或已经进入 `DELIVERY_UNKNOWN` 的 handler 不能覆盖新状态。STARTED record 必须持久保存 `ownerGeneration + executionDeadline` 或等价 owner lease；deadline 到期或 owner 被确认失效后，Ledger 必须最终原子转为 `DELIVERY_UNKNOWN`，具体可由 sweeper、owner monitor 或 recovery worker 完成，但不得转回 RESERVED。unknown 后到达的完成结果只能进入显式 reconciliation 流程。

Command Coordinator 的顺序固定为：

1. Adapter 建立 `TrustedSubject`，校验完整 input schema、generation、大小和 Tool 可见性；
2. 在创建 reservation 前完成 admission control；无 receiver、正在 drain、队列满或并发上限已达时直接拒绝，不污染 commandId；
3. 取得 `InvokeGrant`，计算 canonical digest，原子 reserve；相同键不同 digest 返回 idempotency conflict；
4. 已有 terminal outcome 时返回原结果；已有 `RESERVED` / `STARTED` 时返回稳定 `in-progress`；
5. 在真正调用 handler 前以 CAS 执行 `RESERVED → STARTED`，该转换是“handler 可能产生副作用”的线性化点；
6. handler 返回后先校验并持久化 terminal outcome，再返回 Tool result；
7. handler 启动后的 timeout、cancel、disconnect 或进程故障不得自动重放，收敛为 `delivery-unknown` 或进入显式 reconciliation；
8. SDK 只保证 command ledger 的 at-most-once dispatch。外部副作用若要求更强语义，业务下游也必须接受同一 commandId，或使用业务事务 / outbox。

### `receive()` 与生命周期

```ts
interface ReceiveRegistration {
  stopAccepting(): Promise<void>;
  drain(deadline: string): Promise<"drained" | "deadline-exceeded">;
  close(): Promise<void>;
}
interface CommandChannel<I, O> {
  readonly spec: Readonly<CommandBindingSpec<I, O>>;
  receive(handler: ReceiveHandler<I, O>): ReceiveRegistration;
}
```
receiver 唯一性、并发限制和 handler generation 的作用域必须声明为整个 deployment，而不是单个 `ChannelManager` 进程。多实例实现 MAY 使用 leader、lease、共享 Catalog 或一致性路由，但必须保证：

- 同一 binding generation 不会因滚动部署同时执行语义不同的 handler；
- `stopAccepting()` 先阻止新 admission，再由 `drain()` 等待已 STARTED 调用；
- drain deadline 后仍未终止的 STARTED 调用进入 `delivery-unknown`，不得由新实例自动重放；
- `close()` 释放本地资源，但不能删除 durable ledger、未派发 outbox 或仍在 retention 内的 Resource 事实。

## 独立相关事件，而非 `context.reply()`

核心 Interface 不提供 `ReceiveContext.reply()`。相关事件由应用显式持有另一个 `ResourceChannel` 并调用 `send()`：

```ts
commands.receive(async (input, context) => {
  const result = await execute(input.message, context.signal);
  await events.send({
    publisher: context.subject,
    eventId: result.eventId,
    target: result.target,
    payload: result.event,
    causationId: input.commandId,
  });
  return { status: "completed", result: result.toolResult };
});
```
该 `send()` 是独立事务：成功提交的 Resource event 不会因 Tool response、ledger finish 或连接随后失败而回滚。`causationId` SHOULD 指向 commandId；事件不能代表 Tool 已成功完成。若业务要求“结果与事件原子提交”，应用必须在自身事务/outbox 中完成，SDK 不得制造跨模块事务假象。

## 最小 Manager façade 与语言适配

```ts
interface DuplexChannel<Out, In, Result> {
  outbound: ResourceChannel<Out>;
  inbound: CommandChannel<In, Result>;
}
interface ChannelManager {
  registerResource<T>(spec: ResourceBindingSpec<T>): ResourceChannel<T>;
  registerCommand<I, O>(spec: CommandBindingSpec<I, O>): CommandChannel<I, O>;
  describe(bindingId: BindingId): Readonly<Record<string, unknown>> | undefined;
  retire(identity: BindingIdentity, deadline: string): Promise<void>;
  close(deadline: string): Promise<void>;
}
```
这里省略了 Policy、Journal、Ledger、Outbox、Dispatcher 与 runtime policy 的注入形态；它们是实现内部 seam，不属于业务调用 Interface。注册时返回的 typed handle 是唯一恢复静态类型的入口。字符串 lookup 只能返回 erased descriptor；禁止 `manager.channel<CallerChosenType>(id)` 让调用方以任意泛型伪造注册时类型。

Rust enum、Java sealed interface、Go 的独立 outbound/inbound interface、Python Protocol 等都可表达同一行为。TypeScript SDK MAY 额外提供判别联合或 `registerDuplex()` convenience façade，但它们不是跨语言一致性要求，也不得扩大核心 Interface。

## 可观测性与审计

- 日志与 metrics 只使用 Server 生成的 `serverTraceId`、bindingId、generation、结果分类、大小、时延和安全错误码；
- Client 提供的 `correlationId` 默认不得进入日志或 metric label；确需关联时必须限制长度并使用可轮换 keyed hash；
- token、cookie、`TrustedSubject`、principal 明文、payload、Tool arguments、Resource 正文与敏感 URI query 不得进入日志；
- tenant / subject 诊断标识必须为不可逆、可轮换 pseudonym；
- subscriber cardinality、在线状态与 audience 命中数只可进入权限受控且低基数的内部 telemetry，不得返回业务调用方；
- 必须记录状态转换类别和 fence 冲突，以诊断 outbox、lag、ledger 与 reconciliation，但不得记录 encoded outcome 正文。

## 一致性测试面

SDK Profile 至少提供以下共享故障测试：

1. Journal commit 前崩溃不产生通知；commit 后、dispatch 前崩溃仍最终重新调度；
2. sink attach、ack、baseline read 之间更新不丢失；gate 溢出后强制重新 listen + read；
3. 相同 eventId / commandId 同 digest 收敛，不同 digest 冲突；
4. reserve 后、start 前崩溃可安全释放；start 后崩溃不自动重放；
5. timeout 后旧 handler 的 finish 被 fence 拒绝，只有 reconciliation 可结束 unknown；
6. authorization epoch 变化后旧 Grant 不能继续 read、dispatch 或 invoke；
7. retention gap、授权过滤和 cursor domain 不相互混淆；
8. 新旧 binding generation 滚动部署不会交叉解释 schema；
9. terminal tombstone 到期返回 `idempotency-expired`；
10. Tool `outputSchema` 对所有 `CommandOutcome` 分支均可验证。

## 与相邻规范的同步要求

本重构确立以下新事实源，后续修订 [MCP Channel](mcp-channel.md) 与 [一致性要求](conformance.md) 时必须同步：

- `ResourceChannel` / `CommandChannel` 取代方向条件类型和统一 `ChannelStore`；
- opaque cursor domain 取代跨 `DeliveryScope` 的裸 `afterSequence`；
- durable send 要求 Journal + invalidation outbox 原子提交；
- 订阅必须先 attach gated sink，再输出 acknowledgment；
- `CommandOutcome` 是 Tool 的完整 output schema；
- Command Ledger 增加 `RESERVED → STARTED`、lease、fence、CAS、unknown reconciliation 与 idempotency horizon；
- `context.reply()` 移出核心，相关事件通过独立 `ResourceChannel.send()` 发布；
- queue、timeout、concurrency 属有限 runtime policy，不属于稳定 binding identity。
