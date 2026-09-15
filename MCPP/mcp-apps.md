# MCP Apps 方案

[文档库首页](index.md) · 相关模块：[MCP Channel](mcp-channel.md) · [Channel SDK](channel-sdk.md) · [MCP Extension](mcp-extensions.md) · [安全与信任](security.md)

本方案为 MCP Apps 落地提供设计依据，具体 helper 由 MCPP 实现。保留两种开发模式：**Singleton App**（对话内复用少量应用实例）与 **Functional App**（按工具调用展示结果界面）；两者可以在同一 Server、同一对话中共存。

核心原则：**采用标准 MCP Apps 交付与通信方式，在 MCPP/Host 层补充实例管理、状态恢复与性能策略，不另造 Server → UI 的私有推送协议。**

> 状态：设计草案，核查日期 2026-09-14。下文的 helper、业务字段与模式名称是拟议设计，不代表已有实现，也不是 MCP Apps 的标准分类。

## 1. 协议基线与边界

### 1.1 区分三个层次

| 层次      | 本方案采用的能力                                                                                                 | 不负责什么                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 核心 MCP  | 沿用本仓库的 `2026-07-28` 基线：Tools、Resources、Subscriptions、逐请求版本与能力声明                            | 不定义对话 ID、iframe 实例、业务状态持久化                       |
| MCP Apps  | 官方 `2026-01-26` Stable 扩展；标识 `io.modelcontextprotocol/ui`；HTML 资源、工具与 UI 关联、View ↔ Host bridge | 不保证跨调用复用 View、关闭后恢复、任意 Server 事件自动投递 View |
| MCPP/Host | Singleton/Functional 策略、实例索引、状态句柄、版本控制、回收与降级                                              | 不改变 MCP 线级通知语义，不把业务字段伪装成标准字段              |

核心 MCP 的 `protocolVersion` 与 View bridge 的 `protocolVersion` 是不同链路上的版本，不能互相替代。官方 Apps 规范与示例仍包含旧核心 MCP 的 `initialize` 写法，不能直接照搬到 `2026-07-28` 的 Server 连接流程。[1][2]

### 1.2 能力发现与兼容

- **核心 MCP `2026-07-28`**：可先用 `server/discover` 发现版本和能力；每个请求按核心规范携带 `_meta` 中的 `io.modelcontextprotocol/protocolVersion` 与 `io.modelcontextprotocol/clientCapabilities`，身份信息也按该版本规范处理。不存在核心 `initialize` 握手或 `Mcp-Session-Id`。
- **Apps 扩展能力**：Host 的 client capabilities 中声明 `extensions["io.modelcontextprotocol/ui"]`，其设置包含 `mimeTypes: ["text/html;profile=mcp-app"]`。在现代核心 MCP 中随逐请求能力声明传递；旧核心版本在 `initialize.params.capabilities` 中传递。
- **View bridge**：依然使用 `ui/initialize` → 响应 → `ui/notifications/initialized`。不能因为核心 MCP 无握手，就删除 View 的初始化阶段。
- **目录稳定性**：不得照搬旧示例，为不同连接临时注册/移除 UI 工具；沿用核心 MCP 的目录规则，Host 根据能力决定是否渲染，以及如何向模型过滤工具可见性。
- **兼容旧核心协议**：如需支持 `2025-11-25` 等旧 Host，由独立适配层处理 `initialize`、旧资源订阅和传输会话；不得在 `2026-07-28` 链路发送 `resources/subscribe` 或依赖 GET SSE、`Last-Event-ID`。

上述现代核心 MCP 与 Apps 的组合需要集成验证：支持 Apps 不等于支持现代核心版本，某个 SDK helper 可用也不等于它已适配这两个版本。应锁定依赖版本并维护实测兼容矩阵，不推测某个客户端的支持情况。

## 2. 标准的工具、资源与通信模型

### 2.1 工具绑定 UI 资源

工具定义通过 `_meta.ui.resourceUri` 指向 Server 上已注册的 HTML 资源。以下仅为工具定义片段，不是完整 JSON-RPC 响应：

```json
{
  "name": "mcp_show_ui",
  "description": "打开已有页面，并返回可独立阅读的页面摘要",
  "inputSchema": {
    "type": "object",
    "properties": { "page_id": { "type": "string" } },
    "required": ["page_id"],
    "additionalProperties": false
  },
  "_meta": {
    "ui": {
      "resourceUri": "ui://pages/editor-v1.html",
      "visibility": ["model", "app"]
    }
  }
}
```

- `mcp_show_ui` 是示例业务工具名，不是标准 MCP 方法；实际调用仍为 `tools/call`。
- `ui://pages/editor-v1.html` 是 HTML 模板标识，不是网络地址或业务实例 ID。
- Host 使用 `resources/read` 获取 HTML；对应 `contents[]` 项的 `mimeType` 为 `text/html;profile=mcp-app`，正文使用 `text` 或 base64 `blob`，内容为有效 HTML5。
- 不应将工具结果中的 embedded resource 或 `resource_link` 当作 Apps UI 绑定的替代机制；标准绑定在**工具定义**的 `_meta.ui` 中。
- UI-only 资源可以不出现在 `resources/list` 中，但工具声明的 URI 必须可读。
- 新代码使用嵌套 `_meta.ui`，不新增已弃用的 `_meta["ui/resourceUri"]` 写法。[1]

### 2.2 数据职责

| 位置                         | 本方案约定                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| 工具结果 `content`           | 始终提供有意义的文本摘要；无 UI 时也能理解结果、状态句柄及下一步                                  |
| 工具结果 `structuredContent` | 结构化业务结果，例如 `page_id`、`state_uri`、`revision`、首屏快照；声明 `outputSchema` 时必须匹配 |
| 工具/资源 `_meta.ui`         | 仅放标准 UI 关联、可见性、安全与展示配置                                                          |
| 工具结果 `_meta`             | 附加元数据，不充当秘密存储；MCPP 自有键遵循仓库命名空间约定                                       |
| 独立状态 Resource            | 提供后续可读取的权威业务状态；与 HTML 模板分开缓存和订阅                                          |

不要依赖某一 Host 对 `structuredContent` 是否进入模型上下文的处理。Apps 规范的数据传递建议与核心工具消费方式存在差异；需要模型知道的事实同时给出精简文本，任何可能进入 View 的字段都不得含凭据。`_meta` 不是加密或授权边界。

### 2.3 通信拓扑与初始化

```text
Agent / 用户
    │
    ▼
Host ── 核心 MCP：tools/call、resources/read、subscriptions/listen ── MCP Server
    │
    └── Apps JSON-RPC over postMessage ── Sandbox Proxy ── View
```

1. Host 发现工具的 UI 关联，读取 HTML；工具执行与 UI 加载可并行。
2. Web Host 创建与 Host 不同 origin 的 Sandbox Proxy，再加载内层 View，并实施 CSP 与 sandbox 限制。
3. View 发起 `ui/initialize`，Host 返回版本、`hostCapabilities` 与 `hostContext`；View 发送 `ui/notifications/initialized`。
4. Host 等 View 就绪后再投递工具数据；即使工具先完成，也必须缓冲结果，不能丢掉首屏数据。
5. Host 可以先发送 `ui/notifications/tool-input-partial`，随后发送完整 `ui/notifications/tool-input`，再交付 `ui/notifications/tool-result`；取消则处理 `ui/notifications/tool-cancelled`。
6. View 后续通过 Host 代理的 `tools/call` 或 `resources/read` 交互，并按实际响应刷新界面。SDK 的 `app.callServerTool()` 是 `tools/call` 的封装，不是另一个线级方法。

View 应在连接前注册结果、取消等处理器。部分输入仅用于加载提示或预览，不可触发写操作。Host 暴露 `serverTools`、`serverResources` 等 bridge 能力后，View 才启用对应交互。[1][3]

**Server 不能直接对 iframe 发送 Apps 消息。** Server 的核心 MCP 通知先到 Host；是否更新缓存、刷新 View 或触发 Agent turn，是不同的决策。

### 2.4 工具可见性与模型上下文

- `_meta.ui.visibility` 默认 `['model', 'app']`。UI 专用刷新/表单工具可用 `['app']`，Host 不得将其加入模型的工具列表。
- 不含 `app` 的工具，Host 必须拒绝 View 调用；不得因为工具名相同就路由到其他 origin，尤其不得跨 Server 调用 app-only 工具。
- 可见性不是授权。Server 仍须校验每次工具调用和资源读取的身份、ACL 与业务参数，敏感写入沿用 Host 的批准流程。
- UI 刷新不自动等于新一轮模型推理。确需让模型在后续轮次知道 UI 选择时，使用 `ui/update-model-context` 提交精简上下文；用户明确要求继续对话时才考虑 `ui/message`，均由 Host 按策略处理。

## 3. 两种开发模式

| 维度          | Singleton App                              | Functional App                                   |
| ------------- | ------------------------------------------ | ------------------------------------------------ |
| 适用场景      | 编辑器、长期看板、持续操作的工作区         | 图表、查询结果、单次表单、报告卡片               |
| 展示策略      | 同一作用域和业务句柄聚焦已有实例           | 每个工具调用具有独立展示记录                     |
| 状态来源      | Server 权威状态，View 保存临时展示状态     | 默认工具结果快照；交互时可再访问 Server          |
| Host 额外能力 | 需要 MCPP 实例注册与恢复策略               | 普通 Apps Host 即可承载基本模式                  |
| 历史语义      | 历史消息保留当时摘要，入口可以打开当前页面 | 默认保留当次结果，不随实时状态静默改写           |
| 资源约束      | 复用受限数量的活跃实例，空闲时可回收       | 按需挂载，不把展示记录数量等同于存活 iframe 数量 |

### 3.1 Singleton App：身份与状态分离

Singleton 是**作用域内单例**，不是整个应用进程只有一个 iframe。建议按以下键去重：

```text
(auth_scope, host_conversation_id, origin, app_id, page_id) → 当前挂载实例
```

| 字段               | 所有者与用途                                                |
| ------------------ | ----------------------------------------------------------- |
| `origin`           | Host 分配的 Server 来源标识，不使用 Server 自报名称作为身份 |
| `app_id`           | 应用类型，例如页面编辑器；MCPP 业务标识                     |
| `page_id`          | Server 签发的业务状态句柄，显式随工具参数传递               |
| `view_instance_id` | Host 每次挂载生成的临时 ID；重建时可改变                    |
| `resource_uri`     | HTML 模板 URI，通常多个页面共用                             |
| `state_uri`        | 可读取的业务状态资源，例如 `mcpp://apps/pages/p_123/state`  |
| `revision`         | 同一页面状态的单调递增版本；不是 HTML 版本或缓存 TTL        |

以上字段及 URI 示例是 MCPP 应用契约，不是 MCP 保留字段。`page_id` 不可当作访问凭据：每次读取或写入仍须授权。

- **Server 持久化**：以租户/所有者与 `page_id` 索引业务状态、revision、schemaVersion、保留期限。Server 不维护浏览器对象，也不必知道 Host 私有对话 ID。
- **Host 持久化**：保存授权作用域内的 origin、对话与页面关联、模板版本、展示模式和最近版本；不持久化 iframe、bridge、订阅连接对象。
- **View 临时状态**：选中项、滚动位置、未提交输入。需要恢复的草稿须明确保存策略，不能只寄希望于关闭回调或 sandbox localStorage。

### 3.2 Singleton App：打开与更新流程

```text
1. Host 完成核心能力发现，确认 Apps 与资源读取能力。
2. Agent 调用 mcp_show_ui(page_id=p_123)。
3. Server 鉴权并返回文本摘要 + {page_id, state_uri, revision, snapshot}。
4. MCPP Host 查询实例索引：存在则聚焦，不存在则按标准 Apps 流程挂载。
5. View 首次获得工具结果后渲染快照；后续读取 state_uri 校准当前状态。
6. Agent 调用 mcp_example_update_tool(page_id=p_123, expected_revision=7, operation_id=...)。
7. Server 完成业务事务，产生 revision=8，再使状态资源失效并发送资源更新通知。
8. Host 收到通知后使 state_uri 缓存 stale；活跃引用按 Channel 规则重新读取。
9. View 通过标准 resources/read / 刷新工具取得新版状态，再更新现有界面。
```

`mcp_example_update_tool` 若只修改已有页面，可不绑定 UI 资源，避免普通 Host 为每次修改再生成一张 UI 卡片。`mcp_show_ui` 对既有页面应为幂等打开；创建页面应使用单独的业务工具，避免重试打开时重复创建。

MCPP Host 的复用策略来自本地应用注册配置与上述业务结果契约，不为此增加未登记的 Apps capability 或私有 JSON-RPC method。普通 Apps Host 不理解该策略时，可以仍按每次调用展示 UI；业务结果必须保持可用。

### 3.3 “推送到 UI”的实际落点

必须把 **Server → Host 失效通知** 与 **Host → View 状态刷新** 分开设计：

- Server 声明 `resources.subscribe: true`，Host 用 `subscriptions/listen` 的 `notifications.resourceSubscriptions` 订阅 `state_uri`。
- `notifications/resources/updated` 只是 URI 失效提示，不携带完整状态；`notifications/resources/list_changed` 是目录变化，不能代替内容更新。
- 先处理 `notifications/subscriptions/acknowledged`，检查确认的过滤器是否包含所需 URI；未获支持时降级读取，不能把请求已发出当作订阅成功。通知按 `_meta["io.modelcontextprotocol/subscriptionId"]` 关联原订阅，stdio 上尤其不能按全局消息顺序猜测归属。
- 订阅确认后读取一次状态；通知到达时合并重复读取，读取期间的新失效不能被旧响应覆盖。断连后重建订阅并重新读取，不依赖通知重放。HTTP 取消时关闭对应 SSE 流，stdio 使用关联请求 ID 的 `notifications/cancelled`。[4][5]
- 标准 Apps bridge 并不保证把这些通知自动转发给 View，也没有通用的 `ui/state-changed` 方法。

**第一阶段采用可移植的拉取刷新**：View 在可交互期间提供刷新按钮，并可使用有上限、退避、页面隐藏时暂停的 `resources/read` 轮询；没有 `serverResources` 时，使用 app-only 的只读刷新工具。MCPP Host 可利用订阅维护共享 Resource Cache，但遵循 TTL、私有缓存隔离与失效规则；读取不得返回已知 stale 数据。

因此该阶段的后台实时性受刷新间隔限制，不能声称“资源通知一到 iframe 就即时更新”。如果产品要求零轮询低延迟，需要另行核实并确定 Host → View 的标准兼容桥接契约与目标 Host 支持，再提升为后续交付范围。

不得把任意状态广播伪装成新的 `ui/notifications/tool-input` / `tool-result`：这些消息有工具调用生命周期语义。也不得用私有 Channel 通知、日志通知、`host-context-changed` 或未经批准的 WebSocket 绕开现有 [MCP Channel](mcp-channel.md) 约束。

### 3.4 一致性、幂等与恢复

- 写工具携带 `expected_revision` 和 `operation_id`。Server 原子检查版本、提交状态并记录去重结果；去重键至少按授权作用域、页面和操作 ID 隔离。
- 相同操作 ID 与相同请求重试返回原结果；相同操作 ID 携带不同内容应拒绝。版本冲突返回可识别的业务错误，先重读再由用户/调用方决定重试，不静默覆盖。
- JSON-RPC request ID 用于请求关联，不是业务幂等键。取消、超时或断连不证明写入未发生；查明操作结果前不可无条件重复写入。
- 通知可能丢失、合并或乱序。首版读取全量快照，以 revision 去重；只有明确收益后才引入含 `base_revision` 的增量更新，基线不匹配立即回退全量读取。
- 通知在持久化提交后发送。需要可靠获知后台变更时可采用事务 outbox 补偿通知，但状态资源仍是权威，不将 MCP 通知承诺为可靠事件日志。
- 用户重新打开对话：重新鉴权和发现 Server → 加载关联记录 → 挂载新 View → 重建订阅 → 读取当前状态。跨 Host 恢复需要额外的数据同步与授权设计，不是默认能力。
- 普通关闭仅释放 View 与引用；删除业务页面必须是独立的显式操作。过期、删除或权限撤销后展示可理解状态，不自动创建同名新页面冒充恢复。

### 3.5 Functional App

Functional 不意味着“无状态”或“纯函数”。它表示**一份工具调用结果对应一份展示记录**，界面仍可以有局部交互。

1. 保存当次输入、输出、工具身份、HTML 模板版本与业务结果版本，而不是保存运行中的 iframe。
2. 首屏从当次 `tool-result` 恢复；重新展示历史记录时不自动重跑原工具，尤其不可重跑写工具。
3. 默认显示历史快照。若提供“刷新为最新”，应明确区分当时结果与当前状态，避免历史记录被静默改写。
4. 大结果通过资源引用分页/按需读取；要求长期历史重现时，业务层保存不可变快照或版本资源，并定义保留期限。
5. 同一模板可以复用构建产物与缓存，但不能把不同调用的交互状态放进同一个未隔离的实例。

## 4. Host 生命周期与性能

建议把展示记录与挂载状态分开，内部状态机为：

```text
registered → loading → initializing → ready → tearing_down → disposed
                  └── 失败/超时 → error → 用户重试
```

- 视口外优先保留文本摘要/占位符；进入视口或用户展开时才挂载。对并发初始化、存活 iframe、HTML 大小与刷新频率设可配置上限。
- 活跃 Singleton、正在编辑或执行操作的 View 优先保留；不要为节省内存无提示丢弃未保存草稿。
- 主动销毁已初始化 View 前发送 `ui/resource-teardown`。它虽然在规范文字中有 notification 表述，线级示例是带 ID、需要响应的请求；Host 应有等待超时，随后释放 bridge、监听器、定时器和订阅引用。
- 崩溃、进程退出不保证 teardown 成功；持久化不能只在 teardown 时进行。
- 同一 origin、授权作用域和 `state_uri` 的多个展示共享订阅并计数引用；最后一个活跃引用释放后取消订阅。暂停轮询不代表删除业务状态。
- 模板版本与业务 `schemaVersion` 分离。升级后不兼容的历史结果应迁移或降级文本，不把新 View 强行绑定到旧数据。
- 支持 Host 的主题、尺寸变化和标准 CSS variables；没有相关上下文时使用自身默认样式。不要假设 fullscreen、pip 或固定宽高一定可用。

## 5. 前端 HTML 应该如何构建

**协议要求是交付 HTML5 与正确的 Apps bridge 行为，不强制使用某个框架、构建工具或 SDK。** MCPP 推荐将官方 `@modelcontextprotocol/ext-apps` 的 View SDK 一并打包，减少手写握手、消息关联与生命周期处理；这属于工程默认值，而不是 MCP MUST。

### 5.1 轻前端：多入口、单文件产物

```text
public/
  index.html
  admin.html
  page.html
src/
  index.ts
  admin.ts
  page.ts
dist/
  index.html
  admin.html
  page.html
```

- 每个入口构建为可独立加载的 HTML，内联必要 JS/CSS；每份产物注册一个稳定且可版本化的 `ui://` URI。
- Bun 可以作为候选构建工具，但要验证最终 JS/CSS 是否确实内联；不能把“构建了 HTML 入口”等同于“生成单文件 HTML”。官方 quickstart 展示了 Vite + `vite-plugin-singlefile` 路径。[3]
- 对发布产物检查裸模块导入、相对脚本路径、动态 import、字体和图片引用；不能只验证开发服务器能运行。
- 单文件方案不依赖浏览器访问 MCP Server 的 HTTP 地址，可用于 stdio Server，也更容易跨 Host 部署。

### 5.2 重前端：先考虑单文件，再按需拆资产

复杂前端可以使用 React、Vue 等框架，但框架选择与 Singleton/Functional 模式无关。只有产物体积、缓存复用或媒体需求确实要求拆分时，再增加外部资产服务：

1. 入口依然是通过 `resources/read` 返回的 HTML，不直接将 `_meta.ui.resourceUri` 改成 HTTP 页面地址；直接嵌入任意外部站点不是该 Stable 版本的基础交付方式。
2. JS、CSS、字体等使用浏览器可访问的明确 HTTPS 地址，并在资源内容项的 `_meta.ui.csp.resourceDomains` 中声明对应来源。
3. 需要 `fetch`/XHR/WebSocket 的来源声明到 `connectDomains`；嵌套 iframe 使用 `frameDomains`；如需修改 base URI，再配置 `baseUriDomains`。Host 可以进一步收紧，App 要处理被拒绝的情况。
4. CSP 允许不等于网络可达、CORS 通过或认证成功。`ui://` 是资源标识，不是资产 URL 的 HTTP base；`/assets/app.js` 不会自动解析到 MCP Server。
5. MCP endpoint 不天然等于静态站点。远程 Host 不保证能访问本机 localhost；stdio Server 也不天然具有 HTTP 服务。资产可以由独立服务承载，不把 MCP 的传输部署方式绑定为前端部署方式。
6. 资产采用内容哈希和保留策略，保证历史模板引用仍可加载。非敏感静态资产与私有业务数据分离；不在脚本、URL 查询参数或 HTML 中放 Server token。

### 5.3 安全要求

- 所有 View 运行在受限 sandbox 中；Web Host 按 Apps 规范使用异源 Sandbox Proxy。不能只把不可信 HTML 注入 Host DOM。
- Host 校验 `postMessage` 的来源窗口、预期 origin/沙箱来源策略、JSON-RPC schema 和实例绑定；不能仅凭消息里的 `page_id` 或 request ID 路由。
- CSP 由 Host 实施，不因页面自行声明就信任。默认拒绝未声明的外部访问；camera、microphone、geolocation、clipboardWrite 等权限均需申请并检测实际授予结果。
- 优先经 Host bridge 访问业务工具和资源，不把 Host/Server 的认证凭据交给 View。
- HTML、资源正文和工具结果都是不可信内容；业务文本使用安全渲染，不拼入可执行脚本或未经处理的 HTML。
- Host 清晰展示应用来源、权限与危险操作确认。审计仅记录必要的方法、时延、结果状态与脱敏关联信息，不记录 token、完整私有状态或未脱敏表单。

## 6. MCPP helper 的建议职责

以下为模块职责草案，不提前承诺导出函数名；可以封装官方 SDK，但不复制另一套 Apps 线级协议。

| 模块                | 输入/输出                                     | 责任                                                                    |
| ------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Server 注册 helper  | 工具定义、HTML 产物、CSP → 标准 Tool/Resource | 校验 URI/MIME/绑定关系、保留文本回退；复用官方注册能力                  |
| Server 状态 helper  | `page_id`、状态 schema、存储与授权回调        | 快照读取、revision、CAS 与业务幂等；复用 Channel 的标准资源失效机制     |
| Host App Registry   | 本地应用配置、调用记录、业务句柄 → 展示记录   | 模式选择、Singleton 去重、Functional 历史索引；默认按 origin 与授权隔离 |
| Host Bridge Adapter | HTML、工具输入/结果、Host 上下文              | 官方 Apps bridge、安全代理、就绪前缓冲、清理、核心协议版本适配          |
| View helper         | 初始工具结果、状态 URI、bridge 能力           | 渲染数据校验、标准读取/工具调用、刷新退避、错误与取消状态               |
| 构建 helper         | 多 HTML 入口、资产清单 → 发布产物             | 单文件默认、外部依赖检查、模板版本与 CSP 清单校验                       |

核心 MCP `2026-07-28` 的请求元数据、`resultType`、Resource 响应的 `ttlMs`/`cacheScope` 等仍按核心规范生成；不得假定旧 Apps 示例的返回对象就是完整现代线级响应。Host 负责处理核心版本的控制流程并向 View 交付可消费的最终业务结果，不能简单盲转不兼容 envelope。

模板和业务资源复用现有 [MCPP Cache](mcp-resources.md)；业务资源通常为 private，HTML 只有在完全不含用户数据时才允许共享缓存。不要在 App helper 内再建一个不受授权隔离与失效通知约束的缓存体系。

## 7. 落地阶段与验收

### 阶段一：标准 Apps 最小闭环

- 完成工具与 HTML 资源注册、MIME/CSP 校验、纯文本回退。
- 采用单文件 HTML；在目标 Host 实测首次渲染、UI 调用工具、读取资源、取消与 teardown。
- 优先实现 Functional 展示；验证 UI 晚于工具返回时仍能收到首次结果。
- 锁定核心 MCP、Apps、SDK 与 Host 版本，记录哪些组合通过，而不是只写“支持 MCP Apps”。

### 阶段二：可恢复的 Singleton

- 引入作用域内实例索引、持久业务句柄、revision/CAS/幂等与状态 Resource。
- 使用标准 Subscriptions 更新 Host 缓存，View 采用手动/有界轮询刷新。
- 加入懒加载、实例回收、草稿保存策略与断连后全量恢复。

### 阶段三：经验证后再增强

- 仅在明确目标 Host 的前提下设计低延迟 Host → View 刷新方式，并补齐标准兼容性证明。
- 按实测瓶颈引入外部资产、增量快照、历史迁移；不将跨 Host 恢复或任意外部页面嵌入视为基础能力。

### 最低验收矩阵

| 场景                                  | 预期结果                                           |
| ------------------------------------- | -------------------------------------------------- |
| Host 不支持 Apps                      | 工具仍返回有意义文本，核心业务不依赖 UI            |
| Host 支持 Apps、不支持 MCPP Singleton | 可以按每次调用展示，不宣称必然复用                 |
| 同对话重复打开同一页面                | MCPP Host 聚焦既有展示；重复打开不重复创建业务页面 |
| 不同用户/对话/origin 有相同 `page_id` | 不复用错误实例、不串缓存、不越权                   |
| 两个并发写入/断连重试                 | 版本冲突可识别，同一操作不重复执行                 |
| 通知丢失、乱序或订阅断开              | 重读/重建订阅后收敛，不依赖消息重放                |
| UI 未就绪、工具取消或失败             | 正确交付缓冲结果或取消/错误状态，不长期卡在加载中  |
| 重开对话或重新挂载历史卡片            | 重新鉴权；恢复页面或结果，不重跑写工具             |
| 大量历史卡片                          | 存活 iframe 数量受限，活动操作和草稿不被静默丢弃   |
| CSP 拒绝、权限撤销、资产不可达        | 展示可理解的失败与文本回退，不放宽权限绕过限制     |

## 8. 参考依据

以下为本次实际核查的官方来源；Apps 版本目录位于 `main` 分支，实施时还应锁定 SDK/规范快照并复核类型定义。

1. [MCP Apps Stable 2026-01-26 规范（SEP-1865）](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)：UI 资源、工具关联、bridge、生命周期、安全与能力声明。
2. [MCP 2026-07-28 Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)：无状态请求、发现机制、订阅替代、取消会话及 SSE 重放、响应 envelope 变化。
3. [MCP Apps 官方 Quickstart](https://apps.extensions.modelcontextprotocol.io/api/documents/quickstart.html)：SDK helper、View 连接、工具调用与单文件构建实践；不是额外协议要求。
4. [MCP 2026-07-28 Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)：资源能力、读取、缓存与资源变更通知。
5. [MCP 2026-07-28 Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)：订阅确认、关联、取消与断连处理。
