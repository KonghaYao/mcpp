import {
  MissingRequiredClientCapabilityError,
  type McpRequestContext,
  type McpServer,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { FileError, fileErrorResponse } from "./errors.ts";
import {
  defaultUploadPath,
  MCPP_FILES_EXTENSION,
  validateUploadPath,
  type FileScope,
} from "./protocol.ts";
import type { FileService } from "./service.ts";

/** 通用路由只依赖此结构，不能静态导入 FlyDrive 或 Node 文件系统。 */
export interface FileMount {
  readonly endpointPath: string;
  readonly uploadPath: string;
  readonly namespace: string;
  readonly maxFileBytes: number;
  wrapFactory(factory: McpServerFactory): McpServerFactory;
  fetchUpload(request: Request): Promise<Response>;
  fetchMcp(
    request: Request,
    next: (request: Request) => Promise<Response>,
  ): Promise<Response>;
}

export interface FileMountOptions {
  endpointPath: string;
  uploadPath?: string;
  /** 验证现有认证及相应操作权限，返回稳定身份；上传与 MCP 必须共用此映射。 */
  resolveScope: (
    request: Request,
    operation: "upload" | "mcp",
  ) => FileScope | Promise<FileScope>;
  /** 显式浏览器 Origin 白名单；[] 禁止所有带 Origin 的请求。无 Origin 的原生客户端仍需认证。 */
  allowedOrigins: readonly string[];
  allowCredentials?: boolean;
}

const mountedEndpoints = new WeakMap<FileService, string>();
const scopedRequests = new WeakMap<Request, FileScope>();
export function fileScopeFor(context: McpRequestContext): FileScope {
  const scope = context.requestInfo && scopedRequests.get(context.requestInfo);
  if (!scope) throw new FileError("UNAUTHENTICATED");
  return scope;
}

const fileTools = new WeakMap<McpServer, Set<string>>();
export function markFileTool(server: McpServer, name: string): void {
  let names = fileTools.get(server);
  if (!names) {
    names = new Set();
    fileTools.set(server, names);
  }
  names.add(name);
}

const allowedHeaders = [
  "authorization",
  "content-type",
  "mcpp-files-version",
  "mcpp-file-name",
  "mcpp-file-size",
  "mcpp-file-sha256",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
];

async function controlMessage(request: Request): Promise<unknown> {
  const reader = request.clone().body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1024 * 1024) throw new FileError("INVALID_UPLOAD_REQUEST");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createFileMount(
  fileService: FileService,
  options: FileMountOptions,
): FileMount {
  const endpointPath = validateUploadPath(options.endpointPath);
  const uploadPath = validateUploadPath(
    options.uploadPath ??
      fileService.options.uploadPath ??
      defaultUploadPath(endpointPath),
  );
  if (endpointPath === uploadPath) throw new Error("MCP 与上传路径不能相同");
  const mounted = mountedEndpoints.get(fileService);
  if (mounted && mounted !== endpointPath)
    throw new Error("同一文件服务不能挂载到多个 MCP endpoint");
  mountedEndpoints.set(fileService, endpointPath);
  if (!Array.isArray(options.allowedOrigins))
    throw new Error("必须显式配置 allowedOrigins");
  const origins = new Set(options.allowedOrigins);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
      throw new Error("Origin 必须是精确的 HTTP(S) origin");
  }
  const scopes = scopedRequests;
  const envelopes = new WeakMap<Request, unknown>();
  const scopeFor = (request: Request): FileScope => {
    const scope = scopes.get(request);
    if (!scope) throw new FileError("UNAUTHENTICATED");
    return scope;
  };

  function cors(request: Request): Headers {
    const headers = new Headers({
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    const origin = request.headers.get("Origin");
    if (origin && !origins.has(origin)) throw new FileError("UPLOAD_FORBIDDEN");
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      if (options.allowCredentials)
        headers.set("Access-Control-Allow-Credentials", "true");
    }
    return headers;
  }

  async function protectedFetch(
    request: Request,
    operation: "upload" | "mcp",
    next: () => Promise<Response>,
  ): Promise<Response> {
    let headers: Headers;
    try {
      headers = cors(request);
    } catch (error) {
      return fileErrorResponse(error);
    }
    let response: Response;
    try {
      if (request.method === "OPTIONS") {
        const method = request.headers.get("Access-Control-Request-Method");
        const requested = (
          request.headers.get("Access-Control-Request-Headers") ?? ""
        )
          .split(",")
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean);
        if (
          !request.headers.has("Origin") ||
          !method ||
          !["POST", ...(operation === "mcp" ? ["GET", "DELETE"] : [])].includes(
            method,
          ) ||
          requested.some((h) => !allowedHeaders.includes(h))
        )
          throw new FileError("UPLOAD_FORBIDDEN");
        headers.set(
          "Access-Control-Allow-Methods",
          operation === "upload" ? "POST" : "POST, GET, DELETE",
        );
        headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
        headers.set(
          "Vary",
          "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        );
        return new Response(null, { status: 204, headers });
      }
      const scope = await options.resolveScope(request, operation);
      fileService.assertScope(scope);
      if (
        operation === "mcp" &&
        request.headers.get("Mcp-Method") === "tools/call"
      ) {
        // SDK 会消费原始 Request；仅对 JSON 控制消息保留副本，绝不复制上传流。
        try {
          envelopes.set(request, await controlMessage(request));
        } catch (error) {
          if (error instanceof FileError)
            throw error; /* 格式错误继续由 MCP SDK 分类。 */
        }
      }
      scopes.set(request, scope);
      response = await next();
    } catch (error) {
      response = fileErrorResponse(error);
    }
    // Request 由 WeakMap 持有，响应流可能早于工具执行完成返回；不能提前删除身份。
    for (const [key, value] of headers) response.headers.set(key, value);
    return response;
  }

  return {
    endpointPath,
    uploadPath,
    namespace: fileService.namespace,
    maxFileBytes: fileService.maxFileBytes,
    wrapFactory(factory) {
      return async (context) => {
        // stdio 不挂文件能力，也不启动上传 listener。
        if (!context.requestInfo) return factory(context);
        const request = context.requestInfo;
        scopeFor(request);
        const server = await factory(context);
        const protocol = "server" in server ? server.server : server;
        protocol.registerCapabilities({
          extensions: {
            [MCPP_FILES_EXTENSION]: fileService.capability(uploadPath),
          },
        });
        // SDK 高层会吞掉缺失能力异常。当前请求若命中文件工具，仅替换其协议拒绝分支；
        // 正常调用及普通工具仍使用 SDK 原来的 handler、schema 校验与结果投影。
        if (
          request.headers.get("Mcp-Method") === "tools/call" &&
          fileTools
            .get(server as McpServer)
            ?.has(request.headers.get("Mcp-Name") ?? "")
        ) {
          const body = envelopes.get(request) as {
            params?: { _meta?: Record<string, unknown> };
          };
          const capabilities = body?.params?._meta?.[
            "io.modelcontextprotocol/clientCapabilities"
          ] as
            | { extensions?: Record<string, { version?: unknown }> }
            | undefined;
          if (capabilities?.extensions?.[MCPP_FILES_EXTENSION]?.version !== 1) {
            const protocol = "server" in server ? server.server : server;
            protocol.setRequestHandler("tools/call", async () => {
              throw new MissingRequiredClientCapabilityError({
                requiredCapabilities: {
                  extensions: { [MCPP_FILES_EXTENSION]: { version: 1 } },
                },
              });
            });
          }
        }
        return server;
      };
    },
    fetchUpload(request) {
      if (new URL(request.url).pathname !== uploadPath)
        return Promise.resolve(new Response(null, { status: 404 }));
      return protectedFetch(request, "upload", () =>
        fileService.handleUpload(request, { scope: scopeFor(request) }),
      );
    },
    fetchMcp(request, next) {
      return protectedFetch(request, "mcp", () => next(request));
    },
  };
}
