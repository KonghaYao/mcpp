/**
 * MCP Apps 常量（MCPP/mcp-apps.md §1–2）。
 */

/** 官方 Apps 扩展 id（client capabilities.extensions）。 */
export const MCP_UI_EXTENSION = "io.modelcontextprotocol/ui";

/** Apps HTML 资源的 MIME（resources/read contents[].mimeType）。 */
export const MCP_APP_HTML_MIME = "text/html;profile=mcp-app";

/** 工具 `_meta.ui.visibility` 默认值。 */
export const MCP_UI_VISIBILITY_DEFAULT = ["model", "app"] as const;

export type McpUiVisibility = "model" | "app";

/** Singleton 去重键字段（§3.1）。 */
export type SingletonInstanceKey = {
  authScope: string;
  hostConversationId: string;
  origin: string;
  appId: string;
  pageId: string;
};

/** 打开/展示 UI 时 structuredContent 推荐字段（§2.2）。 */
export type McpAppPageStructuredContent = {
  page_id: string;
  state_uri: string;
  revision: number;
  snapshot?: unknown;
};

/** 写工具常用参数（§3.4）。 */
export type McpAppWriteParams = {
  page_id: string;
  expected_revision: number;
  operation_id: string;
};

/** CAS / 幂等业务错误码（§3.4）。 */
export const MCP_APP_ERROR = {
  REVISION_CONFLICT: "mcpp.apps.revision_conflict",
  OPERATION_ID_MISMATCH: "mcpp.apps.operation_id_mismatch",
  PAGE_NOT_FOUND: "mcpp.apps.page_not_found",
  UNAUTHORIZED: "mcpp.apps.unauthorized",
} as const;
