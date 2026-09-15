import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import { MCP_APP_ERROR } from "./constants.ts";
import { validateAppHtml, validateAppHtmlEntries } from "./build.ts";
import { AppPageStore, hashWritePayload } from "./page-store.ts";
import {
  buildAppHtmlResourceContent,
  buildToolUiMeta,
  defineAppTool,
} from "./register.ts";
import { ResourceForApps } from "./ResourceForApps.ts";
import {
  singletonInstanceKey,
  shouldFocusExistingSingleton,
} from "./singleton.ts";
import { buildShowPageToolResult } from "./tool-result.ts";
import {
  appStateUri,
  isValidPageId,
  parseAppStateUri,
  uiResourceUri,
} from "./uri.ts";

describe("apps uri", () => {
  test("uiResourceUri and appStateUri", () => {
    expect(uiResourceUri("pages/editor-v1.html")).toBe(
      "ui://pages/editor-v1.html",
    );
    expect(appStateUri("p_123")).toBe("mcpp://apps/pages/p_123/state");
    expect(parseAppStateUri("mcpp://apps/pages/p_123/state")).toEqual({
      pageId: "p_123",
    });
    expect(isValidPageId("p_123")).toBe(true);
    expect(isValidPageId("../evil")).toBe(false);
  });
});

describe("apps register", () => {
  test("defineAppTool with nested _meta.ui", () => {
    const tool = defineAppTool({
      name: "mcp_show_ui",
      description: "Open page",
      inputSchema: {
        type: "object",
        properties: { page_id: { type: "string" } },
        required: ["page_id"],
      },
      ui: { resourceUri: uiResourceUri("page.html") },
    });
    expect(tool._meta).toEqual(
      buildToolUiMeta({ resourceUri: "ui://page.html" }),
    );
  });
});

describe("apps page store", () => {
  test("CAS and operation_id dedup", () => {
    const store = new AppPageStore({ authScope: "tenant-a" });
    store.createPage({ pageId: "p1", snapshot: { title: "A" } });
    const hash = hashWritePayload({ title: "B" });

    const ok = store.commitWrite({
      pageId: "p1",
      expectedRevision: 1,
      operationId: "op-1",
      requestHash: hash,
      nextSnapshot: { title: "B" },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.record.revision).toBe(2);

    const dup = store.commitWrite({
      pageId: "p1",
      expectedRevision: 1,
      operationId: "op-1",
      requestHash: hash,
      nextSnapshot: { title: "B" },
    });
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.deduplicated).toBe(true);

    const conflict = store.commitWrite({
      pageId: "p1",
      expectedRevision: 1,
      operationId: "op-2",
      requestHash: hashWritePayload({ title: "C" }),
      nextSnapshot: { title: "C" },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe(MCP_APP_ERROR.REVISION_CONFLICT);
    }
  });
});

describe("apps singleton key", () => {
  test("registry focus", () => {
    const key = {
      authScope: "u1",
      hostConversationId: "c1",
      origin: "http://localhost/mcp",
      appId: "editor",
      pageId: "p1",
    };
    const registry = new Map<string, unknown>();
    expect(shouldFocusExistingSingleton(registry, key)).toBe(false);
    registry.set(singletonInstanceKey(key), {});
    expect(shouldFocusExistingSingleton(registry, key)).toBe(true);
  });
});

describe("apps build", () => {
  test("validate bundled html", () => {
    const html = "<!DOCTYPE html><html><body>ok</body></html>";
    expect(validateAppHtml(html).ok).toBe(true);
    expect(
      validateAppHtmlEntries([{ templatePath: "index.html", html }]).ok,
    ).toBe(true);
  });
});

describe("ResourceForApps", () => {
  test("registers html and state templates", () => {
    const server = new McpServer({ name: "apps-fixture", version: "1" });
    const store = new AppPageStore({ authScope: "test" });
    store.createPage({ pageId: "p1", snapshot: { n: 1 } });

    ResourceForApps(server, {
      htmlTemplates: [
        {
          uri: uiResourceUri("page.html"),
          html: "<!DOCTYPE html><html></html>",
        },
      ],
      pageStore: store,
      cacheScope: "public",
    });

    expect(
      buildShowPageToolResult({
        pageId: "p1",
        stateUri: appStateUri("p1"),
        revision: 1,
      }).structuredContent,
    ).toMatchObject({ page_id: "p1" });

    expect(
      buildAppHtmlResourceContent({
        uri: uiResourceUri("page.html"),
        html: "<!DOCTYPE html><html></html>",
      }).mimeType,
    ).toBe("text/html;profile=mcp-app");
  });
});
