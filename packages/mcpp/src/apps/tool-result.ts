/**
 * 工具结果 helper：文本回退 + structuredContent（MCPP/mcp-apps.md §2.2）。
 */
import type { McpAppPageStructuredContent } from "./constants.ts";

export type McpAppToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: McpAppPageStructuredContent | Record<string, unknown>;
  isError?: boolean;
};

/** 打开/展示 Singleton 页面时的标准 structuredContent。 */
export function buildShowPageStructuredContent(input: {
  pageId: string;
  stateUri: string;
  revision: number;
  snapshot?: unknown;
}): McpAppPageStructuredContent {
  return {
    page_id: input.pageId,
    state_uri: input.stateUri,
    revision: input.revision,
    ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
  };
}

/** 始终附带可读文本摘要（Host 不支持 Apps 时仍可用）。 */
export function buildShowPageToolResult(input: {
  pageId: string;
  stateUri: string;
  revision: number;
  snapshot?: unknown;
  summary?: string;
}): McpAppToolResult {
  const structured = buildShowPageStructuredContent(input);
  const text =
    input.summary ??
    `Page ${input.pageId} (revision ${input.revision}). State: ${input.stateUri}.`;
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

/** Functional 展示：仅当次调用快照。 */
export function buildFunctionalToolResult(input: {
  summary: string;
  structured?: Record<string, unknown>;
}): McpAppToolResult {
  return {
    content: [{ type: "text", text: input.summary }],
    ...(input.structured ? { structuredContent: input.structured } : {}),
  };
}

export function buildAppToolErrorResult(message: string): McpAppToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
