/**
 * MCP Apps URI 构造与校验（MCPP/mcp-apps.md §2.1、§3.1）。
 */

const UI_URI_RE = /^ui:\/\/[\w./-]+$/;
const PAGE_ID_RE = /^[\w-]{1,128}$/;
const APP_ID_RE = /^[\w-]{1,64}$/;

/** 业务页面状态句柄是否合法（不是访问凭据）。 */
export function isValidPageId(pageId: string): boolean {
  return PAGE_ID_RE.test(pageId);
}

export function isValidAppId(appId: string): boolean {
  return APP_ID_RE.test(appId);
}

/** HTML 模板资源 URI，例如 `ui://pages/editor-v1.html`。 */
export function uiResourceUri(templatePath: string): string {
  const normalized = templatePath.replace(/^\/+/, "");
  if (!/^[\w./-]+$/.test(normalized) || normalized.includes("..")) {
    throw new Error(`Invalid UI template path: ${templatePath}`);
  }
  return `ui://${normalized}`;
}

export function isUiResourceUri(uri: string): boolean {
  return UI_URI_RE.test(uri);
}

/** 可读取的业务状态资源，例如 `mcpp://apps/pages/p_123/state`。 */
export function appStateUri(pageId: string): string {
  if (!isValidPageId(pageId)) throw new Error(`Invalid page_id: ${pageId}`);
  return `mcpp://apps/pages/${pageId}/state`;
}

export function parseAppStateUri(uri: string): { pageId: string } | undefined {
  const m = /^mcpp:\/\/apps\/pages\/([\w-]{1,128})\/state$/.exec(uri);
  if (!m) return undefined;
  return { pageId: m[1]! };
}
