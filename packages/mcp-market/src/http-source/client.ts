import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { AppError } from "../errors.ts";
import { exceedsDepth } from "../npm-registry/normalize.ts";
import type {
  SnapshotTool,
  SnapshotResource,
  SnapshotResourceTemplate,
  SnapshotPrompt,
  SnapshotCapabilities,
  SnapshotSkill,
} from "../npm-registry/types.ts";
import {
  normalizeTool,
  normalizeServerInfo,
  normalizeResource,
  normalizeResourceTemplate,
  normalizePrompt,
  normalizeCapabilities,
  record,
} from "./normalize.ts";

export type HttpDiscovery = {
  tools: SnapshotTool[];
  resources: SnapshotResource[];
  resourceTemplates: SnapshotResourceTemplate[];
  prompts: SnapshotPrompt[];
  skills: SnapshotSkill[];
  capabilities: SnapshotCapabilities;
  serverInfo: Record<string, string>;
};
import { safeText } from "./normalize.ts";

export type HttpProtocol = "2025" | "2026-07-28";

export type HttpClientOptions = {
  allowLoopback?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
};

/** 保守 IPv4 公网策略；拒绝 IPv6（包括映射地址）及保留/特殊用途网段。 */
export const isPublicAddress = (address: string): boolean => {
  if (isIP(address) !== 4) return false;
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
};

export const validateEndpoint = (
  value: string,
  allowLoopback = false,
): string => {
  try {
    safeText(value, 1024);
    const url = new URL(value);
    const decodedPath = decodeURIComponent(url.pathname);
    safeText(decodedPath, 1024);
    if (
      url.username ||
      url.password ||
      value.includes("?") ||
      value.includes("#") ||
      /[\\\s]/.test(value) ||
      /(?:token|secret|password|api[_-]?key|authorization)/i.test(decodedPath)
    )
      throw new Error();
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (local && allowLoopback && ["http:", "https:"].includes(url.protocol))
      return url.href;
    if (
      local ||
      !["http:", "https:"].includes(url.protocol) ||
      url.hostname.includes(":") ||
      (isIP(url.hostname) && !isPublicAddress(url.hostname)) ||
      !/^[a-z0-9.-]+$/.test(url.hostname)
    )
      throw new Error();
    return url.href;
  } catch {
    throw new AppError("INVALID_INPUT", "HTTP 源地址不符合安全策略");
  }
};

const abortable = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(new AppError("HTTP_SOURCE_UNAVAILABLE"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });

/** DNS 只解析一次，后续请求连接同一已校验 IP，同时保留 Host / TLS 身份校验。 */
const targetOf = async (
  endpoint: string,
  allowLoopback: boolean,
  signal: AbortSignal,
  resolve: (hostname: string) => Promise<string[]>,
) => {
  const original = new URL(validateEndpoint(endpoint, allowLoopback));
  const local =
    allowLoopback && ["localhost", "127.0.0.1"].includes(original.hostname);
  const addresses = local
    ? ["127.0.0.1"]
    : isIP(original.hostname)
      ? [original.hostname]
      : await abortable(resolve(original.hostname), signal);
  if (!addresses.length || (!local && !addresses.every(isPublicAddress)))
    throw new AppError("HTTP_SOURCE_UNAVAILABLE");
  const target = new URL(original);
  target.hostname = addresses[0]!;
  return { original, target };
};

const protocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26"];

const rpcResult = (
  value: unknown,
  id: number,
): Record<string, unknown> | null => {
  const message = record(value);
  if (message.jsonrpc !== "2.0") throw new AppError("METADATA_INVALID");
  // 不回应服务端请求，不执行工具；只接受当前请求的结果。
  if (message.id !== id) return null;
  if (
    message.error !== undefined ||
    message.result === undefined ||
    message.method !== undefined
  )
    throw new AppError("HTTP_SOURCE_UNAVAILABLE");
  return record(message.result);
};

const readResult = async (
  response: Response,
  id: number,
  budget: { remaining: number },
  signal: AbortSignal,
): Promise<Record<string, unknown>> => {
  const type = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    !response.ok ||
    !response.body ||
    !["application/json", "text/event-stream"].includes(type ?? "")
  ) {
    await response.body?.cancel();
    throw new AppError("HTTP_SOURCE_UNAVAILABLE");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const parse = (text: string) => {
    const value: unknown = JSON.parse(text);
    if (exceedsDepth(value, 16)) throw new AppError("METADATA_TOO_LARGE");
    return rpcResult(value, id);
  };
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (value) {
        budget.remaining -= value.byteLength;
        if (budget.remaining < 0) throw new AppError("METADATA_TOO_LARGE");
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      if (type === "text/event-stream") {
        // 同时接受 LF / CRLF / CR，包括跨 chunk 的 CRLF。
        const boundary = /(?:\r\n|\r(?!\n)|\n){2}/;
        let match: RegExpExecArray | null;
        while ((match = boundary.exec(buffer))) {
          const event = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = event
            .split(/\r\n|\r|\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          const result = parse(data);
          if (result) return result;
        }
      }
      if (done) {
        if (type === "application/json") {
          const result = parse(buffer);
          if (result) return result;
        }
        throw new AppError("METADATA_INVALID");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

export class HttpMcpClient {
  constructor(
    readonly options: HttpClientOptions = {},
    readonly resolve: (hostname: string) => Promise<string[]> = resolve4,
  ) {}

  async listTools(endpoint: string): Promise<SnapshotTool[]> {
    return (await this.discover(endpoint, "2025")).tools;
  }

  async discover(endpoint: string, mode: HttpProtocol): Promise<HttpDiscovery> {
    const timeout = Math.max(20, this.options.timeoutMs ?? 8000);
    const deadline = AbortSignal.timeout(timeout);
    // 给 DELETE 留出有界时间；总流程（包括 DNS 和清理）受 deadline 限制。
    const signal = AbortSignal.timeout(
      Math.max(1, timeout - Math.min(250, timeout / 4)),
    );
    let session: string | null = null;
    let protocol: string | null = mode === "2026-07-28" ? mode : null;
    let target: Awaited<ReturnType<typeof targetOf>> | undefined;
    const budget = { remaining: this.options.maxBytes ?? 1024 * 1024 };
    const send = (method: string, body: unknown, requestSignal = signal) => {
      if (!target) throw new AppError("HTTP_SOURCE_UNAVAILABLE");
      const headers: Record<string, string> = {
        Host: target.original.host,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      };
      if (session) headers["Mcp-Session-Id"] = session;
      if (protocol) headers["MCP-Protocol-Version"] = protocol;
      if (mode === "2026-07-28" && body !== undefined) {
        const rpc = record(body);
        headers["Mcp-Method"] = String(rpc.method);
        body = {
          ...rpc,
          params: {
            ...record(rpc.params ?? {}),
            _meta: {
              "io.modelcontextprotocol/protocolVersion": mode,
              "io.modelcontextprotocol/clientInfo": {
                name: "mcpm-catalog",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        };
      }
      const hostname = target.original.hostname;
      return fetch(target.target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal,
        redirect: "error",
        proxy: "",
        keepalive: false,
        tls: {
          serverName: hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (
            _hostname: string,
            certificate: Parameters<typeof checkServerIdentity>[1],
          ) => checkServerIdentity(hostname, certificate),
        },
      });
    };
    try {
      target = await targetOf(
        endpoint,
        this.options.allowLoopback ?? false,
        signal,
        this.resolve,
      );
      let capabilities: Record<string, unknown>;
      let serverInfo: Record<string, string>;
      if (mode === "2026-07-28") {
        const discovered = await readResult(
          await send("POST", {
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: {},
          }),
          1,
          budget,
          signal,
        );
        capabilities = record(discovered.capabilities);
        serverInfo = normalizeServerInfo(
          record(discovered._meta)["io.modelcontextprotocol/serverInfo"],
        );
      } else {
        const response = await send("POST", {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: protocolVersions[0],
            capabilities: {},
            clientInfo: { name: "mcpm-catalog", version: "1.0.0" },
          },
        });
        const receivedSession = response.headers.get("Mcp-Session-Id");
        if (receivedSession !== null) {
          if (!/^[\x21-\x7e]{1,256}$/.test(receivedSession)) {
            await response.body?.cancel();
            throw new AppError("METADATA_INVALID");
          }
          session = receivedSession;
        }
        const initialized = await readResult(response, 1, budget, signal);
        if (
          typeof initialized.protocolVersion !== "string" ||
          !protocolVersions.includes(initialized.protocolVersion)
        )
          throw new AppError("METADATA_INVALID");
        protocol = initialized.protocolVersion;
        serverInfo = normalizeServerInfo(initialized.serverInfo);
        capabilities = record(initialized.capabilities);
        const notification = await send("POST", {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        await notification.body?.cancel();
        if (notification.status !== 202)
          throw new AppError("HTTP_SOURCE_UNAVAILABLE");
      }
      const offered = normalizeCapabilities(capabilities);
      let nextId = 2;
      const list = async <T>(
        method: string,
        field: string,
        normalize: (value: unknown) => T,
        identity: (value: T) => string,
      ): Promise<T[]> => {
        const items: T[] = [];
        const identities = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < (this.options.maxPages ?? 20); page++) {
          const id = nextId++;
          const result = await readResult(
            await send("POST", {
              jsonrpc: "2.0",
              id,
              method,
              params: cursor === undefined ? {} : { cursor },
            }),
            id,
            budget,
            signal,
          );
          const values = result[field];
          if (!Array.isArray(values)) throw new AppError("METADATA_INVALID");
          if (items.length + values.length > 256)
            throw new AppError("METADATA_TOO_LARGE");
          for (const value of values) {
            const item = normalize(value);
            const key = identity(item);
            if (identities.has(key)) throw new AppError("METADATA_INVALID");
            identities.add(key);
            items.push(item);
          }
          if (result.nextCursor === undefined)
            return items.sort((a, b) =>
              identity(a) < identity(b)
                ? -1
                : identity(a) > identity(b)
                  ? 1
                  : 0,
            );
          if (
            typeof result.nextCursor !== "string" ||
            !result.nextCursor ||
            result.nextCursor.length > 1024 ||
            cursors.has(result.nextCursor)
          )
            throw new AppError("METADATA_INVALID");
          cursor = result.nextCursor;
          cursors.add(cursor);
        }
        throw new AppError("METADATA_TOO_LARGE");
      };
      const tools = offered.tools
        ? await list("tools/list", "tools", normalizeTool, (item) => item.name)
        : [];
      const resources = offered.resources
        ? await list(
            "resources/list",
            "resources",
            normalizeResource,
            (item) => item.uri,
          )
        : [];
      const resourceTemplates = offered.resources
        ? await list(
            "resources/templates/list",
            "resourceTemplates",
            normalizeResourceTemplate,
            (item) => item.uriTemplate,
          )
        : [];
      const prompts = offered.prompts
        ? await list(
            "prompts/list",
            "prompts",
            normalizePrompt,
            (item) => item.name,
          )
        : [];
      const skills = resources
        .filter((item) =>
          /^skill:\/\/[^/]+\/SKILL\.md$/.test(decodeURIComponent(item.uri)),
        )
        .map(({ uri, name, description }) => ({ uri, name, description }));
      return {
        serverInfo,
        capabilities: offered,
        tools,
        resources,
        resourceTemplates,
        prompts,
        skills,
      };
    } catch (error) {
      // 底层异常可能包含 URL、session 或远端正文，只传递固定错误码。
      const code =
        error instanceof AppError ? error.code : "HTTP_SOURCE_UNAVAILABLE";
      throw new AppError(code);
    } finally {
      if (session && target) {
        try {
          const response = await send("DELETE", undefined, deadline);
          await response.body?.cancel();
        } catch {
          /* 清理失败不能覆盖读取结果，也不暴露远端异常。 */
        }
      }
    }
  }
}
