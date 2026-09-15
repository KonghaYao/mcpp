/**
 * Catalog 存储的白名单快照：NPM 精确版本或 HTTP 内容寻址版本。
 * 原始 Packument 与 MCP 响应均不得进入 Catalog。
 */
export type SnapshotAgent = {
  id: string;
  name: string;
  description: string | null;
};

export type SnapshotSkill = {
  uri: string;
  name: string;
  description: string | null;
};

export type SnapshotTool = {
  name: string;
  description: string | null;
  /** 有界标准 schema；仅允许本地引用，不保存 default/examples 或扩展字段。 */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | boolean;
};

export type SnapshotResource = {
  uri: string;
  name: string;
  description: string | null;
  mimeType?: string;
  size?: number;
};

export type SnapshotResourceTemplate = Omit<
  SnapshotResource,
  "uri" | "size"
> & {
  uriTemplate: string;
};

export type SnapshotPrompt = {
  name: string;
  description: string | null;
  arguments: { name: string; description: string | null; required: boolean }[];
};

export type SnapshotCapabilities = Partial<
  Record<"tools" | "resources" | "prompts", Record<string, boolean>>
>;

export type SnapshotServer = {
  id: string;
  transport: string;
  runtime: string | null;
  /** 已通过 HTTP 源安全校验的公开地址，不含鉴权信息。 */
  endpoint?: string;
};

export type NormalizedPackageVersion = {
  name: string;
  version: string;
  description: string | null;
  keywords: string[];
  displayName: string | null;
  summary: string | null;
  agents: SnapshotAgent[];
  /** Package-level Skills discovery metadata. Absent on legacy snapshots. */
  skills?: SnapshotSkill[];
  servers: SnapshotServer[];
  tools?: SnapshotTool[];
  resources?: SnapshotResource[];
  resourceTemplates?: SnapshotResourceTemplate[];
  prompts?: SnapshotPrompt[];
  capabilities?: SnapshotCapabilities;
  sourceKind?: "http";
  serverInfo?: Record<string, string>;
  integrity: string | null;
  /** Recorded for provenance only. Never requested and never rendered. */
  tarballUrl: string | null;
  unpackedSizeBytes: number | null;
  fileCount: number | null;
  deprecated: string | null;
  publishedAt: string | null;
};

export type PackageVersionRef = {
  sourceId: string;
  packageName: string;
  exactVersion: string;
};

export type PublicationPreview = {
  ref: PackageVersionRef;
  metadata: NormalizedPackageVersion;
  metadataJson: string;
  metadataDigest: string;
};
