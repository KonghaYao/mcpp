/**
 * Server 注册 helper（MCPP/mcp-apps.md §2.1、§6）。
 */
import type { McpUiVisibility } from "./constants.ts";
import { MCP_APP_HTML_MIME, MCP_UI_VISIBILITY_DEFAULT } from "./constants.ts";
import { isUiResourceUri } from "./uri.ts";

export type McpAppUiMeta = {
  resourceUri: string;
  visibility?: readonly McpUiVisibility[];
  csp?: {
    resourceDomains?: string[];
    connectDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
};

export type McpAppToolDefinitionInput = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  ui?: McpAppUiMeta;
  /** 无 UI 绑定的纯业务工具 */
  bindUi?: boolean;
};

/** 校验并生成标准 `_meta.ui`（嵌套写法，§2.1）。 */
export function buildToolUiMeta(ui: McpAppUiMeta): Record<string, unknown> {
  if (!isUiResourceUri(ui.resourceUri)) {
    throw new Error(`Invalid Apps UI resourceUri: ${ui.resourceUri}`);
  }
  const visibility = ui.visibility ?? MCP_UI_VISIBILITY_DEFAULT;
  const payload: Record<string, unknown> = {
    resourceUri: ui.resourceUri,
    visibility: [...visibility],
  };
  if (ui.csp && Object.keys(ui.csp).length > 0) {
    payload.csp = ui.csp;
  }
  return { ui: payload };
}

/** 构造带 Apps 绑定的工具注册用 descriptor 片段。 */
export function defineAppTool(input: McpAppToolDefinitionInput): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
} {
  const { name, description, inputSchema, ui, bindUi = true } = input;
  if (bindUi) {
    if (!ui) throw new Error(`Apps tool '${name}' requires ui metadata`);
    return {
      name,
      description,
      inputSchema,
      _meta: buildToolUiMeta(ui),
    };
  }
  return { name, description, inputSchema };
}

export type AppHtmlResourceInput = {
  uri: string;
  html: string;
  name?: string;
  description?: string;
  listInCatalog?: boolean;
  csp?: McpAppUiMeta["csp"];
};

/** Apps HTML 资源 contents[] 项（§2.1）。 */
export function buildAppHtmlResourceContent(input: AppHtmlResourceInput): {
  uri: string;
  mimeType: string;
  text: string;
  _meta?: Record<string, unknown>;
} {
  if (!isUiResourceUri(input.uri)) {
    throw new Error(`Invalid Apps HTML uri: ${input.uri}`);
  }
  if (!input.html.trim()) {
    throw new Error("Apps HTML body must be non-empty");
  }
  const item: {
    uri: string;
    mimeType: string;
    text: string;
    _meta?: Record<string, unknown>;
  } = {
    uri: input.uri,
    mimeType: MCP_APP_HTML_MIME,
    text: input.html,
  };
  if (input.csp && Object.keys(input.csp).length > 0) {
    item._meta = { ui: { csp: input.csp } };
  }
  return item;
}
