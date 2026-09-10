# MCPM Market：NPM 元数据投影与专家团队模型

> 状态：权威设计 v1.0
> 日期：2026-09-04
> 依赖：[MCP Registry](MCP_REGISTRY.md)、[MCPP](MCPP/index.md)、NPM-compatible Registry
> 取代：[`docs/design/01-mcp-market-design.md`](docs/design/01-mcp-market-design.md) 中与本文冲突的 MCPM 资产、发布与元数据模型

## 1. 决策摘要

MCPM Market 采用以下统一模型：

- **Connector 是市场唯一的可发布、审核、版本化与安装资产。**
- **一个 Connector 对应一个 NPM package**，稳定身份为 `(sourceId, packageName)`。
- **一个 Connector 版本对应一个 NPM package exact version**。
- 一个 Connector 版本可以声明零个或多个 Agent；包含 Agent 时，市场将它展示为**专家团队**。
- Agent 是 Connector 版本中的成员，不是独立安装包，也不拥有独立发布版本。
- 用户安装专家团队或普通连接器，本质上都是安装同一个 Connector package。
- NPM-compatible Registry 是 package、版本、tarball、integrity、所有权与 MCPP 分发元数据的唯一权威。
- MCPM 只读取 NPM Packument，保存市场治理数据与可重建查询投影；**不得下载、解压或扫描 tarball**。

```text
NPM Source
└── Connector package                       identity: (sourceId, packageName)
    └── Package version                     identity: exact version
        ├── MCPP market metadata
        ├── Agent[0..n]                     专家团队成员
        ├── MCP server declarations
        └── dist.tarball / dist.integrity   由 NPM 持有

MCPM Market
├── Connector 市场身份与治理
├── NPM 版本元数据的可重建投影
├── Scenario ↔ Connector 策展关系
└── 用户安装与授权事实
```

## 2. 领域语言

### 2.1 Connector

Connector 是一个符合 MCPP 分发约定的 NPM package，也是 MCPM 唯一的资产聚合根。

以下行为只针对 Connector：

- 创建市场条目；
- 关联和验证 NPM package；
- 同步 package version；
- 提交审核、上架和下架；
- 安装、升级和卸载；
- 配置和授权。

MCPM 不建立独立的 Expert package、Expert release 或 Expert installation。

### 2.2 专家团队与 Agent

某个 Connector 版本声明至少一个 Agent 时，该 Connector 在专家市场中表现为专家团队。团队详情展示其中的 Agent 成员。

```text
Connector @ 1.4.0
├── Agent: financial-analyst
├── Agent: industry-researcher
└── Agent: report-editor
```

规则：

- 一个版本可以声明多个 Agent；
- `agent.id` 在同一 package 的相邻版本中 SHOULD 保持稳定；
- Agent 的名称、摘要或成员数量可以随 package version 变化；
- Agent 不可脱离 Connector 单独安装；
- 安装单位始终是整个 Connector exact version；
- 没有 Agent 的 Connector 仅出现在连接器市场；有 Agent 的 Connector 可以同时出现在专家市场和连接器市场。

### 2.3 Scenario

Scenario 是 MCPM 拥有的市场策展实体，例如“投资分析”或“工程开发”。Scenario 与 Connector 是多对多关系，不进入 NPM package 的身份或版本语义。

场景关系默认挂在 Connector 稳定身份上，因此发布新版本不要求重新分类。若未来某版本不再适用某场景，MCPM 可通过审核状态或显式版本覆盖处理，不改变基础关系。

## 3. 两个系统的权威边界

### 3.1 NPM-compatible Registry

NPM 侧拥有以下权威事实：

- package name、scope 与 owner/access；
- exact version、SemVer 与 dist-tags；
- publish、deprecate 与 unpublish 状态；
- package metadata 与 Packument；
- `package.json#mcpp` 分发元数据；
- tarball URL、integrity、shasum；
- Registry 提供的 package size、unpacked size、file count 等可选统计；
- token、组织、团队和 package 权限。

MCPM 不复制 NPM 的上传协议、Artifact 存储、版本算法、ACL 或 Token 系统。

### 3.2 MCPM Market

MCPM 拥有以下权威事实：

- Connector 的市场身份和 Publisher 管理关系；
- package 关联验证状态；
- 审核、上架、下架、暂停和推荐状态；
- 场景分类、运营排序、市场封面与宣传文案；
- NPM 元数据的同步状态和可重建查询投影；
- 用户或工作区的安装版本；
- Connector 授权状态与外部凭据引用；
- 市场操作审计。

MCPM 不在页面请求链路中访问 tarball，也不以自身数据库覆盖 NPM 元数据中的 Agent 或 Server 事实。

## 4. `package.json#mcpp` 分发元数据

`plugin.json` 采用 Agent Plugin 1.0.0 closed schema，不允许加入任意顶层字段。MCPM 所需的轻量市场投影因此放在 NPM `package.json` 的 `mcpp` 字段中。

`package.json#mcpp` 是 NPM 分发元数据，不取代 `plugin.json`、`mcp.json` 或 MCP 运行时能力发现。

示例：

```json
{
  "name": "@acme/investment-team",
  "version": "1.4.0",
  "description": "投资研究专家团队",
  "keywords": ["mcpp", "investment", "data-analysis"],
  "mcpp": {
    "schemaVersion": 1,
    "displayName": "投资研究专家团队",
    "summary": "连接市场数据，完成财报与行业研究",
    "agents": [
      {
        "id": "financial-analyst",
        "name": "财报解读顾问",
        "description": "分析财务指标、业务结构与风险信号"
      },
      {
        "id": "industry-researcher",
        "name": "行业研究员",
        "description": "整理行业格局、竞争变化与关键趋势"
      }
    ],
    "servers": [
      {
        "id": "market-data",
        "transport": "stdio",
        "runtime": "client-local"
      }
    ]
  }
}
```

### 4.1 必要约束

- `schemaVersion` MUST 存在，首版值为 `1`；
- `agents` MAY 缺省或为空数组；
- `agent.id` MUST 在当前版本内唯一且稳定；
- `agents` 只包含市场展示与安装前决策需要的轻量描述；
- `servers` 只包含安装前需要的能力摘要，不取代包内 `mcp.json`；
- `mcpp` MUST NOT 包含 Secret、Token、Authorization Header、用户配置值或图片 Base64；
- 完整 Prompt、大型 Schema、知识库和运行时文件 MUST NOT 放入 Packument 元数据；
- 完整 Agent 指令和可执行内容保留在 package tarball 中，仅由安装端在安装或运行时读取。

若目标 NPM-compatible Registry 默认不保留自定义 `package.json` 字段，则该 Registry 实现 MUST 显式支持 `mcpp` 字段进入版本 Packument；否则该 Source 不满足 MCPM Metadata Projection 能力要求。

## 5. 发布与同步流程

Publisher 不向 MCPM 上传压缩包。

```text
1. Publisher 在 MCPM 创建 Connector
2. 选择 NPM Source，并填写 packageName
3. MCPM 验证 Publisher 对 package 的维护权
4. Publisher 使用标准 npm publish 发布版本
5. NPM Registry 保存 tarball 与 package metadata
6. MCPM 通过 webhook、主动同步或定时对账读取 Packument
7. MCPM 校验 versions[exactVersion].mcpp
8. MCPM 保存版本与 Agent 查询投影
9. Publisher 补充场景、封面和运营文案
10. 提交市场审核并上架
```

MCPM 同步器只允许执行 Registry Metadata 请求：

```text
GET {registry}/{encodedPackageName}
```

同步器读取：

```text
versions[version].mcpp
versions[version].dist.integrity
versions[version].dist.tarball
versions[version].dist.unpackedSize   // 可选
versions[version].dist.fileCount      // 可选
时间、deprecated 与 dist-tags
```

`dist.tarball` 只作为安装端定位信息投影；MCPM 同步器 MUST NOT 请求该 URL。

## 6. 投影与持久化规则

MCPM 可以保存 Packument 的查询投影，但投影必须能够从 NPM 完整重建，且不得成为第二份 package 定义权威。

最小稳定关系：

```text
connectors
  UNIQUE (source_id, package_name)

connector_releases
  UNIQUE (connector_id, exact_version)

connector_release_agents
  PRIMARY KEY (release_id, agent_id)

scenarios
connector_scenarios
  PRIMARY KEY (connector_id, scenario_id)
```

建议投影字段：

```text
connector_releases
├── exact_version
├── integrity
├── tarball_url
├── metadata_digest
├── package_size_bytes?       可选
├── unpacked_size_bytes?      可选
├── file_count?               可选
├── deprecated_message?
├── metadata_json
└── synced_at

connector_release_agents
├── release_id
├── agent_id
├── display_name
├── description
└── sort_order
```

`connector_release_agents` 是为列表、搜索和详情页服务的派生投影。删除后可以从 `connector_releases.metadata_json` 或 NPM Packument 重建。

MCPM 自有的市场文案必须使用明确的 `marketing_*` 字段，不能静默覆盖 NPM 投影字段。例如：

```text
NPM:  agent.name              功能事实
MCPM: marketing_headline      运营包装
```

## 7. 版本与安装

Connector 市场条目可以跟踪 dist-tag，但一次安装必须固定 exact version 与 integrity：

```text
latest
  → 安装时解析为 1.4.0
  → 保存 resolved_version = 1.4.0
  → 保存 integrity = sha512-...
```

NPM 的 `latest` 后续移动时，现有安装不得静默升级。升级必须重新解析目标版本，并向用户展示以下变化：

- 新增、删除或重命名的 Agent；
- Server 或 Transport 变化；
- 新增配置项或授权范围；
- Deprecated 或不可用状态。

旧 Release 和 Agent 投影不得因新版本发布而原地修改。

## 8. 大包与性能边界

由于 MCPM 不下载或解压 tarball，包体积不会进入市场浏览请求链路。列表、搜索和详情只读取 MCPM 的轻量投影。

MCPM 可使用 NPM Metadata 中已有的大小统计实施市场策略，但不得为了补齐缺失统计而下载 tarball：

- Registry 提供统计：保存并展示；
- Registry 不提供统计：字段保持未知；
- 不得把“未知”解释为 `0` 或“已验证”；
- 大包警告或硬限制应由 NPM Registry、安装端或 Dynamic Host 执行。

大型模型、向量索引、视频、数据集和知识库不应内嵌在 `mcpp` 元数据中。

## 9. 安全要求

- MCPM MUST NOT 保存 NPM Token 明文；
- MCPM MUST NOT 保存 Connector 的 OAuth Token、API Key 或 Secret 明文；
- Publisher API Key、NPM package access 与最终用户 Connector 授权是三个独立安全域；
- MCPM 对 `mcpp` 的校验只证明元数据结构合法，不证明 tarball 安全；
- 市场审核不得宣称 MCPM 已扫描、执行或认证 Artifact；
- Packument 和 `mcpp` 均视为不可信输入，必须限制响应大小、嵌套深度、数组长度与文本长度；
- 所有外部 URL 必须经过协议和长度校验，禁止在日志中记录凭据。

## 10. 产品投影规则

```text
专家市场
  WHERE 当前可见 Release 的 agents.length > 0
  卡片展示 Connector 专家团队
  详情展示 Agent 成员
  安装动作安装整个 Connector

连接器市场
  展示所有可安装 Connector
  可提供“含专家团队”筛选标记
  安装动作安装整个 Connector
```

两个市场视图共享同一 Connector ID、Release、安装状态与审核状态，不创建两份资产记录。

## 11. 非目标

本文不定义：

- 新的 MCP 专属包上传协议；
- MCPM 自有 Artifact 存储；
- MCPM tarball 下载、解包或源码扫描；
- 与 NPM 并行的版本和 dist-tag 系统；
- 独立的 Expert 发布、版本或安装模型；
- 独立的 Skill 市场一级资产；
- 完整 Agent Prompt 的市场数据库镜像；
- Connector Secret 的数据库存储实现。

## 12. 一致性要求

实现满足本文需要同时满足：

1. 同一 `(sourceId, packageName)` 在 MCPM 中最多对应一个 Connector；
2. 同一 Connector exact version 最多对应一个 Release 投影；
3. Agent 必须归属于具体 Release，不能脱离 Connector 版本存在；
4. 专家团队和连接器视图共享同一安装单位；
5. MCPM 的市场请求和同步任务均不下载 tarball；
6. NPM Metadata 变化后，MCPM 投影可被删除并完整重建；
7. 安装固定 exact version 与 integrity，不跟随 dist-tag 静默漂移；
8. NPM 功能事实和 MCPM 运营字段具有明确且不重叠的写入权。
