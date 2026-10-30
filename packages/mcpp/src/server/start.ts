/**
 * MCP 2026-07-28 严格模式 Server 启动入口。
 *
 * HTTP 通过 createMcpHandler 承载，每个请求创建独立 Server 实例；stdio 通过
 * serveStdio 承载，每条连接固定一个实例。两种模式均拒绝 2025-era 请求。
 */
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpServerFactory,
  type ServerEventBus,
  type ServerNotifier,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
  type StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import type { FileMount } from "../files/http.ts";
import { DEFAULT_MCPP_HTTP_HOST, DEFAULT_MCPP_HTTP_PORT } from "./defaults.ts";

export type StartMode = "http" | "stdio";

export interface StartServerOptions {
  mode?: StartMode;
  host?: string;
  port?: number;
  /** 显式 stdio transport（测试或嵌入场景注入）。 */
  transport?: StdioServerTransport;
  /** 多进程部署可注入共享事件总线。 */
  bus?: ServerEventBus;
  maxSubscriptions?: number;
  keepAliveMs?: number;
  /** 仅 HTTP 模式显式挂载文件服务；生命周期由宿主共享管理。 */
  files?: FileMount;
  onReady?: (info: { mode: StartMode; url?: string }) => void;
}

export interface StartedServer {
  mode: StartMode;
  url?: string;
  /** HTTP 模式下用于向 subscriptions/listen 发布变化通知。 */
  subscriptions?: ServerNotifier;
  stop: () => Promise<void>;
}

/** 从 argv 推断 mode：`--stdio` 即 stdio。 */
export function inferModeFromArgv(
  argv: string[],
  fallback: StartMode = "http",
): StartMode {
  return argv.includes("--stdio") ? "stdio" : fallback;
}

function createStrictHttpHandler(
  factory: McpServerFactory,
  options: StartServerOptions,
): McpHttpHandler {
  return createMcpHandler(factory, {
    legacy: "reject",
    bus: options.bus,
    maxSubscriptions: options.maxSubscriptions,
    keepAliveMs: options.keepAliveMs,
  });
}

async function runHttp(
  factory: McpServerFactory,
  options: StartServerOptions,
): Promise<StartedServer> {
  const host = options.host ?? process.env.HOST ?? DEFAULT_MCPP_HTTP_HOST;
  const port = Number(
    options.port ?? process.env.PORT ?? DEFAULT_MCPP_HTTP_PORT,
  );
  const files = options.files;
  const handler = createStrictHttpHandler(
    files ? files.wrapFactory(factory) : factory,
    options,
  );
  const bunServer = Bun.serve({
    hostname: host,
    port,
    // 上传上限之外还允许 SDK 自己限制 JSON 控制消息；未启用 files 时保持 Bun 默认值。
    ...(files
      ? { maxRequestBodySize: Math.max(files.maxFileBytes, 1024 * 1024) }
      : {}),
    fetch: (request) => {
      if (!files) return handler.fetch(request);
      const path = new URL(request.url).pathname;
      if (path === files.uploadPath) return files.fetchUpload(request);
      if (path === files.endpointPath)
        return files.fetchMcp(request, (request) => handler.fetch(request));
      return new Response(null, { status: 404 });
    },
  });
  const url = `http://${host}:${bunServer.port}${files?.endpointPath ?? "/mcp"}`;

  return {
    mode: "http",
    url,
    subscriptions: handler.notify,
    async stop() {
      bunServer.stop();
      await handler.close();
    },
  };
}

function runStdio(
  factory: McpServerFactory,
  options: StartServerOptions,
): StartedServer {
  const handle: StdioServerHandle = serveStdio(factory, {
    legacy: "reject",
    transport: options.transport,
    maxSubscriptions: options.maxSubscriptions,
  });
  return {
    mode: "stdio",
    stop: () => handle.close(),
  };
}

/** 启动仅支持 MCP 2026-07-28 的 Server。 */
export async function startServer(
  factory: McpServerFactory,
  options: StartServerOptions = {},
): Promise<StartedServer> {
  const mode = options.mode ?? inferModeFromArgv(process.argv);
  const started =
    mode === "stdio"
      ? runStdio(factory, options)
      : await runHttp(factory, options);
  options.onReady?.({ mode: started.mode, url: started.url });
  return started;
}

export async function main(
  factory: McpServerFactory,
  options?: StartServerOptions,
): Promise<void> {
  try {
    await startServer(factory, options);
  } catch (error) {
    console.error("Fatal: failed to start MCPP server", error);
    process.exit(1);
  }
}
