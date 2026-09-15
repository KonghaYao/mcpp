/**
 * ResourceForApps —— 挂载 Apps HTML 模板与 mcpp:// 页面状态 Resource（MCPP/mcp-apps.md §2.1、§6）。
 */
import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { McppCache, type McppCacheScope } from "../cache.ts";
import { DEFAULT_MCPP_CACHE_TTL_MS } from "../server/defaults.ts";
import { MCP_APP_HTML_MIME } from "./constants.ts";
import type { AppPageStore } from "./page-store.ts";
import { buildAppHtmlResourceContent } from "./register.ts";
import { isUiResourceUri, parseAppStateUri } from "./uri.ts";

export type AppHtmlTemplate = {
  uri: string;
  html: string;
  name?: string;
  description?: string;
  listInCatalog?: boolean;
  csp?: {
    resourceDomains?: string[];
    connectDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
};

export interface ResourceForAppsOptions {
  /** ui:// HTML 模板（内存注册）。 */
  htmlTemplates: AppHtmlTemplate[];
  /** Singleton 页面状态；提供时注册 mcpp://apps/pages/{pageId}/state。 */
  pageStore?: AppPageStore;
  origin?: string;
  cacheScope?: McppCacheScope;
  authorizationContext?: string;
  ttlMs?: number;
  cacheVersion?: string;
  cache?: McppCache;
}

function firstVar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** 注册 Apps HTML 与可选的业务状态 Resource。 */
export function ResourceForApps(
  server: McpServer,
  options: ResourceForAppsOptions,
): void {
  const {
    htmlTemplates,
    pageStore,
    origin = "mcpp-apps",
    cacheScope = "private",
    authorizationContext,
    ttlMs = DEFAULT_MCPP_CACHE_TTL_MS,
    cacheVersion,
    cache,
  } = options;

  if (cacheScope === "private" && !authorizationContext) {
    throw new Error(
      "MCPP private App resource cache requires an opaque authorization context",
    );
  }

  const templatesByUri = new Map(htmlTemplates.map((t) => [t.uri, t] as const));
  for (const t of htmlTemplates) {
    if (!isUiResourceUri(t.uri)) {
      throw new Error(`Invalid Apps HTML uri: ${t.uri}`);
    }
  }

  const cacheKey = (method: string, params?: unknown) => ({
    origin,
    method,
    params,
    authorizationContext,
  });

  server.registerResource(
    "app-html",
    new ResourceTemplate("ui://{+path}", {
      list: async () => ({
        resources: htmlTemplates
          .filter((t) => t.listInCatalog !== false)
          .map((t) => ({
            uri: t.uri,
            name: t.name ?? t.uri,
            description: t.description ?? "MCP App HTML template",
            mimeType: MCP_APP_HTML_MIME,
            size: new TextEncoder().encode(t.html).length,
          })),
      }),
    }),
    {
      title: "MCP App HTML",
      description: "HTML5 UI template for MCP Apps (text/html;profile=mcp-app)",
    },
    async (uri, variables) => {
      const path = firstVar(variables.path as string | string[] | undefined);
      const href = uri.href;
      const template = templatesByUri.get(href);
      if (!template) {
        if (!isUiResourceUri(href)) {
          throw new ResourceNotFoundError(href, "Invalid Apps UI resource URI");
        }
        throw new ResourceNotFoundError(
          href,
          `Apps HTML template '${href}' not registered`,
        );
      }
      if (path && !href.endsWith(path) && href !== `ui://${path}`) {
        // template var may differ from href; trust registered map key
      }

      const key = cacheKey("resources/read", { uri: href });
      type Content = ReturnType<typeof buildAppHtmlResourceContent>;
      const cached = cache?.get<Content>(key, { cacheVersion });
      const content =
        cached ??
        buildAppHtmlResourceContent({
          uri: template.uri,
          html: template.html,
          csp: template.csp,
        });
      if (!cached) {
        cache?.set(key, content, {
          scope: cacheScope,
          ttlMs,
          cacheVersion,
          resourceUri: href,
        });
      }
      return { contents: [content] };
    },
  );

  if (!pageStore) return;

  server.registerResource(
    "app-page-state",
    new ResourceTemplate("mcpp://apps/pages/{pageId}/state", {
      list: undefined,
    }),
    {
      title: "MCP App page state",
      description: "Authoritative Singleton page snapshot (JSON)",
    },
    async (uri, variables) => {
      const pageId = firstVar(
        variables.pageId as string | string[] | undefined,
      );
      const parsed = parseAppStateUri(uri.href);
      if (!parsed || parsed.pageId !== pageId) {
        throw new ResourceNotFoundError(
          uri.href,
          "Invalid App state resource URI",
        );
      }
      const record = pageStore.readSnapshot(pageId);
      if (!record) {
        throw new ResourceNotFoundError(
          uri.href,
          `App page state '${uri.href}' not found`,
        );
      }
      const text = JSON.stringify({
        page_id: record.pageId,
        revision: record.revision,
        schemaVersion: record.schemaVersion,
        snapshot: record.snapshot,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text,
          },
        ],
      };
    },
  );
}
