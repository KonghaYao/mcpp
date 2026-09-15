import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  HttpMcpClient,
  isPublicAddress,
  validateEndpoint,
} from "../../src/http-source/client.ts";
import { normalizeTool } from "../../src/http-source/normalize.ts";
import "../support/no-network.ts";

export const tool = (name = "lookup") => ({
  name,
  description: "查询公开数据",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
});

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const fixture = (
  handler: (request: Request) => Response | Promise<Response>,
) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/mcp`;
};
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const init = {
  protocolVersion: "2025-03-26",
  capabilities: { tools: {} },
  serverInfo: { name: "mock", version: "1" },
};
const json = (id: number, result: unknown, session = false) =>
  Response.json(
    { jsonrpc: "2.0", id, result },
    {
      headers: session ? { "Mcp-Session-Id": "test-session" } : {},
    },
  );
const client = (options: ConstructorParameters<typeof HttpMcpClient>[0] = {}) =>
  new HttpMcpClient({ allowLoopback: true, ...options });

for (const transport of ["json", "sse"] as const) {
  test(`${transport}：协商协议、session、分页、只读方法和 DELETE`, async () => {
    const calls: string[] = [];
    const endpoint = fixture(async (request) => {
      if (request.method === "DELETE") {
        expect(request.headers.get("Mcp-Session-Id")).toBe("test-session");
        expect(request.headers.get("MCP-Protocol-Version")).toBe("2025-03-26");
        calls.push("DELETE");
        return new Response(null, { status: 405 });
      }
      const rpc = (await request.json()) as {
        id: number;
        method: string;
        params: { cursor?: string; capabilities?: unknown };
      };
      calls.push(rpc.method);
      expect(request.headers.get("accept")).toBe(
        "application/json, text/event-stream",
      );
      if (rpc.method === "initialize") {
        expect(request.headers.get("Mcp-Session-Id")).toBeNull();
        expect(request.headers.get("MCP-Protocol-Version")).toBeNull();
        expect(rpc.params.capabilities).toEqual({});
        const result = {
          ...init,
          instructions: "ignored private instructions",
        };
        if (transport === "sse")
          return new Response(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`,
            {
              headers: {
                "content-type": "text/event-stream",
                "Mcp-Session-Id": "test-session",
              },
            },
          );
        return json(rpc.id, result, true);
      }
      expect(request.headers.get("Mcp-Session-Id")).toBe("test-session");
      expect(request.headers.get("MCP-Protocol-Version")).toBe("2025-03-26");
      if (rpc.method === "notifications/initialized") {
        expect(rpc.id).toBeUndefined();
        return new Response(null, { status: 202 });
      }
      expect(rpc.method).toBe("tools/list");
      const result = rpc.params.cursor
        ? { tools: [tool("alpha")] }
        : { tools: [tool("zeta")], nextCursor: "page-2" };
      if (rpc.params.cursor) expect(rpc.params.cursor).toBe("page-2");
      if (transport === "json") return json(rpc.id, result);
      const text = `: keepalive\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\r\n\r\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(text);
            // 每个字节独立 chunk，覆盖 UTF-8 与 CRLF 拆分；保持流打开验证及时取消。
            for (const byte of bytes)
              controller.enqueue(new Uint8Array([byte]));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    expect(
      (await client().listTools(endpoint)).map((entry) => entry.name),
    ).toEqual(["alpha", "zeta"]);
    expect(calls).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "DELETE",
    ]);
  });
}

test("无 session 不发送 DELETE，后续请求仍携带协商版本", async () => {
  const endpoint = fixture(async (request) => {
    expect(request.method).toBe("POST");
    const rpc = (await request.json()) as {
      id: number;
      method: string;
      params: { cursor?: string; capabilities?: unknown };
    };
    if (rpc.method === "initialize") return json(rpc.id, init);
    expect(request.headers.get("Mcp-Session-Id")).toBeNull();
    expect(request.headers.get("MCP-Protocol-Version")).toBe(
      init.protocolVersion,
    );
    return rpc.id
      ? json(rpc.id, { tools: [] })
      : new Response(null, { status: 202 });
  });
  expect(await client().listTools(endpoint)).toEqual([]);
});

for (const failure of [
  "rpc",
  "wrong-id",
  "bad-json",
  "cursor-loop",
  "page-limit",
  "duplicate",
  "size",
  "total-size",
  "tool-limit",
  "depth",
  "protocol",
  "notification",
  "redirect",
  "timeout",
  "stream-timeout",
] as const) {
  test(`拒绝 ${failure}，不返回部分工具，仍清理 session`, async () => {
    let deleted = false;
    let redirected = false;
    const endpoint = fixture(async (request) => {
      if (new URL(request.url).pathname === "/redirected") redirected = true;
      if (request.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      const rpc = (await request.json()) as {
        id: number;
        method: string;
        params: { cursor?: string; capabilities?: unknown };
      };
      if (rpc.method === "initialize")
        return json(
          rpc.id,
          {
            ...init,
            protocolVersion:
              failure === "protocol" ? "1900-01-01" : init.protocolVersion,
          },
          true,
        );
      if (!rpc.id)
        return new Response(null, {
          status: failure === "notification" ? 400 : 202,
        });
      switch (failure) {
        case "rpc":
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -1, message: "remote private error" },
          });
        case "wrong-id":
          return json(900, { tools: [] });
        case "bad-json":
          return new Response("private invalid body", {
            headers: { "content-type": "application/json" },
          });
        case "cursor-loop":
          return json(rpc.id, { tools: [], nextCursor: "same" });
        case "page-limit":
          return json(rpc.id, { tools: [], nextCursor: String(rpc.id) });
        case "duplicate":
          return json(rpc.id, { tools: [tool(), tool()] });
        case "size":
          return json(rpc.id, { tools: [], ignored: "x".repeat(4096) });
        case "total-size":
          return json(rpc.id, {
            tools: [],
            ignored: "x".repeat(1000),
            ...(rpc.id === 2 ? { nextCursor: "next" } : {}),
          });
        case "tool-limit":
          return json(rpc.id, {
            tools: Array.from({ length: 257 }, (_, index) =>
              tool(`tool_${index}`),
            ),
          });
        case "depth": {
          let nested: unknown = {};
          for (let i = 0; i < 30; i++) nested = { nested };
          return json(rpc.id, { tools: [], ignored: nested });
        }
        case "redirect":
          return new Response(null, {
            status: 307,
            headers: { location: "/redirected" },
          });
        case "timeout":
          await Bun.sleep(200);
          return json(rpc.id, { tools: [] });
        case "stream-timeout":
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        default:
          return json(rpc.id, { tools: [] });
      }
    });
    const start = performance.now();
    let caught: unknown;
    try {
      await client({
        timeoutMs: 100,
        maxBytes: failure === "tool-limit" ? 1024 * 1024 : 2048,
        maxPages: 2,
      }).listTools(endpoint);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).not.toContain("private");
    expect(performance.now() - start).toBeLessThan(1000);
    expect(deleted).toBe(true);
    expect(redirected).toBe(false);
  });
}

test("清理超时不无限阻塞成功结果", async () => {
  const endpoint = fixture(async (request) => {
    if (request.method === "DELETE") {
      await Bun.sleep(500);
      return new Response(null, { status: 204 });
    }
    const rpc = (await request.json()) as {
      id: number;
      method: string;
      params: { cursor?: string; capabilities?: unknown };
    };
    if (rpc.method === "initialize") return json(rpc.id, init, true);
    return rpc.id
      ? json(rpc.id, { tools: [] })
      : new Response(null, { status: 202 });
  });
  const start = performance.now();
  expect(await client({ timeoutMs: 100 }).listTools(endpoint)).toEqual([]);
  expect(performance.now() - start).toBeLessThan(400);
});

test("DNS 拒绝内网/混合答案，解析也受全流程超时限制", async () => {
  for (const addresses of [["127.0.0.1"], ["8.8.8.8", "10.0.0.1"], []]) {
    const instance = new HttpMcpClient({}, async () => addresses);
    await expect(
      instance.listTools("https://mock.invalid/mcp"),
    ).rejects.toMatchObject({ code: "HTTP_SOURCE_UNAVAILABLE" });
  }
  const start = performance.now();
  const instance = new HttpMcpClient(
    { timeoutMs: 50 },
    () => new Promise(() => {}),
  );
  await expect(
    instance.listTools("https://mock.invalid/mcp"),
  ).rejects.toMatchObject({ code: "HTTP_SOURCE_UNAVAILABLE" });
  expect(performance.now() - start).toBeLessThan(300);
});

test("公网连接固定校验后的 IP，并保留 Host / TLS 身份；禁止代理和重定向", async () => {
  let resolutions = 0;
  const requested: string[] = [];
  // 完全替代 fetch，不打开公网 socket。
  const mocked = spyOn(globalThis, "fetch").mockImplementation((async (
    url,
    rawOptions,
  ) => {
    const options = rawOptions as BunFetchRequestInit | undefined;
    requested.push(String(url));
    expect(String(url)).toBe("https://8.8.8.8/mcp");
    const headers = new Headers(options?.headers);
    expect(headers.get("host")).toBe("mock.invalid");
    expect(options?.proxy).toBe("");
    expect(options?.redirect).toBe("error");
    expect(options?.tls?.serverName).toBe("mock.invalid");
    expect(options?.tls?.rejectUnauthorized).toBe(true);
    expect(typeof options?.tls?.checkServerIdentity).toBe("function");
    if (options?.method === "DELETE")
      return new Response(null, { status: 204 });
    const rpc = JSON.parse(String(options?.body)) as {
      id: number;
      method: string;
    };
    if (rpc.method === "initialize") return json(rpc.id, init, true);
    return rpc.id
      ? json(rpc.id, { tools: [] })
      : new Response(null, { status: 202 });
  }) as typeof fetch);
  try {
    const instance = new HttpMcpClient({}, async () => {
      resolutions++;
      return resolutions === 1 ? ["8.8.8.8"] : ["127.0.0.1"];
    });
    expect(await instance.listTools("https://mock.invalid/mcp")).toEqual([]);
    expect(resolutions).toBe(1);
    expect(requested).toHaveLength(4);
  } finally {
    mocked.mockRestore();
  }
});

test("SSE 多行 data 与延迟 CRLF chunk", async () => {
  const endpoint = fixture(async (request) => {
    const rpc = (await request.json()) as { id: number; method: string };
    if (rpc.method === "initialize") return json(rpc.id, init);
    if (!rpc.id) return new Response(null, { status: 202 });
    const chunks = [
      ": comment\r",
      "\n\r",
      "\nevent: message\r",
      '\ndata: {"jsonrpc":"2.0",\r',
      `\ndata: "id":${rpc.id},"result":{"tools":[]}}\r`,
      "\n\r",
      "\n",
    ];
    return new Response(
      new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
            await Bun.sleep(2);
          }
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  expect(await client().listTools(endpoint)).toEqual([]);
});

describe("SSRF 与元数据白名单", () => {
  test("允许公网 HTTP / HTTPS，包括显式端口", () => {
    for (const endpoint of [
      "http://8.163.76.248:23332/mcp",
      "http://example.com/mcp",
      "https://example.com:23332/mcp",
    ]) {
      expect(validateEndpoint(endpoint)).toBe(endpoint);
    }
  });

  test("拒绝特殊地址、URL 凭据、query/hash、非 HTTP 协议与隐藏路径密钥", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "100.64.0.1",
      "198.18.0.1",
      "192.0.0.1",
      "203.0.113.1",
      "::1",
      "::ffff:127.0.0.1",
      "224.0.0.1",
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    for (const url of [
      "ftp://example.com/mcp",
      "http://10.0.0.1:23332/mcp",
      "http://169.254.169.254/mcp",
      "https://u:p@example.com/mcp",
      "https://example.com/mcp?",
      "https://example.com/mcp#",
      "https://example.com/%74oken/value",
      "https://[::1]/mcp",
      "https://2130706433/mcp",
      "https://127.1/mcp",
      "file:///tmp/mcp",
      "https://10.0.0.1/mcp",
    ])
      expect(() => validateEndpoint(url)).toThrow();
    expect(() => validateEndpoint("http://127.0.0.1/mcp")).toThrow();
    expect(validateEndpoint("http://127.0.0.1/mcp", true)).toBe(
      "http://127.0.0.1/mcp",
    );
    expect(() => validateEndpoint("http://192.168.1.2/mcp", true)).toThrow();
  });

  test("schema 丢弃自由值和扩展，仅保留受限结构", () => {
    const marker = crypto.randomUUID();
    const result = normalizeTool({
      ...tool(),
      _meta: { marker },
      annotations: { title: marker },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            default: marker,
            examples: [marker],
            enum: ["public"],
            $ref: "#/$defs/query",
          },
        },
        additionalProperties: false,
      },
    });
    expect(result.inputSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", enum: ["public"], $ref: "#/$defs/query" },
      },
      additionalProperties: false,
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  test("拒绝 secret-like 文本、危险 key 和无限 schema", () => {
    const marker = crypto.randomUUID();
    for (const text of [
      `Authorization: Bearer ${marker}`,
      `password=${marker}`,
      `https://example.com/?token=${marker}`,
    ])
      expect(() => normalizeTool({ ...tool(), description: text })).toThrow();
    expect(() =>
      normalizeTool({
        ...tool(),
        inputSchema: JSON.parse(
          '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
        ),
      }),
    ).toThrow();
    let nested: unknown = { type: "object" };
    for (let i = 0; i < 14; i++)
      nested = { type: "object", properties: { child: nested } };
    expect(() => normalizeTool({ ...tool(), inputSchema: nested })).toThrow();
  });
});

test("2026-07-28 连接真实 mcpp handler，只发现服务与工具", async () => {
  const { createGatewayRoutes } = await import("../../../mcpp/src/gateway.ts");
  const { createAnydocServer } = await import(
    "../../../../examples/anydoc-mcp/src/server.ts"
  );
  const gateway = createGatewayRoutes([
    {
      path: "/mcp",
      createServer: () => {
        const server = createAnydocServer();
        server.registerResource(
          "review",
          "skill://review/SKILL.md",
          { description: "Reviewing", mimeType: "text/markdown" },
          async () => {
            throw new Error("不允许读取 Skill 正文");
          },
        );
        return server;
      },
    },
  ]);
  const calls: string[] = [];
  const endpoint = fixture(async (request) => {
    const rpc = (await request.clone().json()) as {
      method: string;
      params: { _meta: Record<string, unknown> };
    };
    calls.push(rpc.method);
    expect(request.headers.get("Mcp-Method")).toBe(rpc.method);
    expect(request.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(rpc.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(
      "2026-07-28",
    );
    return gateway.fetch(request);
  });
  try {
    const result = await client().discover(endpoint, "2026-07-28");
    expect(result.serverInfo).toEqual({ name: "anydoc", version: "0.1.1" });
    expect(result.tools.map((t) => t.name)).toEqual(["convert_document"]);
    expect(result.tools[0]!.inputSchema.properties).toEqual({
      path: {
        type: "string",
        minLength: 1,
        description: "Absolute local file path",
      },
    });
    expect(result.skills).toEqual([
      {
        uri: "skill://review/SKILL.md",
        name: "review",
        description: "Reviewing",
      },
    ]);
    expect(calls).toEqual([
      "server/discover",
      "tools/list",
      "resources/list",
      "resources/templates/list",
    ]);
  } finally {
    await gateway.close();
  }
});

for (const mode of ["2025", "2026-07-28"] as const)
  test(`${mode} 无 tools capability 返回空工具清单`, async () => {
    const calls: string[] = [];
    const endpoint = fixture(async (request) => {
      const rpc = (await request.json()) as { id: number; method: string };
      calls.push(rpc.method);
      if (rpc.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (rpc.method === "resources/list")
        return json(rpc.id, { resources: [] });
      if (rpc.method === "resources/templates/list")
        return json(rpc.id, { resourceTemplates: [] });
      return json(
        rpc.id,
        mode === "2025"
          ? { ...init, capabilities: { resources: {} } }
          : {
              capabilities: { resources: {} },
              _meta: { "io.modelcontextprotocol/serverInfo": init.serverInfo },
            },
      );
    });
    expect((await client().discover(endpoint, mode)).tools).toEqual([]);
    expect(calls).not.toContain("tools/list");
  });

test("schema 保留契约、合法属性名、本地引用且防止嵌套敏感值泄漏", () => {
  const inputSchema = {
    type: "object",
    properties: {
      "1 space/name": {
        type: ["null", "string"],
        enum: [null, ""],
        const: "",
        minLength: 0,
        maxLength: 20,
        pattern: "^[a-z]*$",
      },
      extra: false,
      nested: { $ref: "#/$defs/public" },
    },
    required: ["1 space/name"],
    $defs: {
      public: {
        allOf: [
          {
            anyOf: [
              true,
              {
                oneOf: [
                  { type: "number", minimum: 0, exclusiveMaximum: 10 },
                  { type: "boolean" },
                ],
              },
            ],
          },
        ],
      },
    },
    additionalProperties: { type: "integer" },
  };
  expect(normalizeTool({ ...tool(), inputSchema }).inputSchema).toEqual(
    inputSchema,
  );
  for (const key of ["enum", "const"])
    expect(() =>
      normalizeTool({
        ...tool(),
        inputSchema: {
          type: "object",
          [key]:
            key === "enum"
              ? [{ secret: crypto.randomUUID() }]
              : { nested: { password: crypto.randomUUID() } },
        },
      }),
    ).toThrow();
  expect(() =>
    normalizeTool({
      ...tool(),
      inputSchema: { type: "object", $ref: "https://example.com/schema" },
    }),
  ).toThrow();
});

test("服务信息白名单拒绝疑似秘密且不公开 instructions", async () => {
  const endpoint = fixture(async (request) => {
    const rpc = (await request.json()) as { id: number };
    return json(rpc.id, {
      ...init,
      serverInfo: {
        ...init.serverInfo,
        description: `password=${crypto.randomUUID()}`,
      },
    });
  });
  await expect(client().discover(endpoint, "2025")).rejects.toThrow();
  expect(() =>
    normalizeTool({
      ...tool(),
      inputSchema: {
        type: "object",
        properties: { api_key: { const: crypto.randomUUID() } },
      },
    }),
  ).toThrow();
});

for (const mode of ["2025", "2026-07-28"] as const) {
  test(`${mode} 分页采集全部声明清单，只把 SKILL.md 入口投影为 Skills`, async () => {
    const calls: string[] = [];
    const lists = {
      "tools/list": { field: "tools", items: [tool("alpha"), tool("zeta")] },
      "resources/list": {
        field: "resources",
        items: [
          {
            uri: "skill://review/SKILL.md",
            name: "review",
            description: "Reviewing",
          },
          {
            uri: "skill://review/examples/demo.ts",
            name: "example",
            mimeType: "text/plain",
          },
        ],
      },
      "resources/templates/list": {
        field: "resourceTemplates",
        items: [
          { uriTemplate: "doc://{name}", name: "documents" },
          { uriTemplate: "skill://review/{+path}", name: "skill-files" },
        ],
      },
      "prompts/list": {
        field: "prompts",
        items: [
          { name: "analyze", arguments: [{ name: "topic", required: true }] },
          { name: "summarize", description: "Summary" },
        ],
      },
    };
    const endpoint = fixture(async (request) => {
      const rpc = (await request.json()) as {
        id: number;
        method: string;
        params?: { cursor?: string };
      };
      calls.push(rpc.method);
      if (rpc.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (["initialize", "server/discover"].includes(rpc.method)) {
        const capabilities = {
          tools: { listChanged: true },
          resources: { subscribe: false },
          prompts: {},
        };
        return json(
          rpc.id,
          mode === "2025"
            ? { ...init, capabilities }
            : {
                capabilities,
                _meta: {
                  "io.modelcontextprotocol/serverInfo": init.serverInfo,
                },
              },
        );
      }
      const list = lists[rpc.method as keyof typeof lists];
      expect(list).toBeDefined();
      return json(
        rpc.id,
        rpc.params?.cursor
          ? { [list.field]: [list.items[1]] }
          : { [list.field]: [list.items[0]], nextCursor: "next" },
      );
    });
    const result = await client().discover(endpoint, mode);
    expect(result.skills).toEqual([
      {
        uri: "skill://review/SKILL.md",
        name: "review",
        description: "Reviewing",
      },
    ]);
    expect(result.resources).toHaveLength(2);
    expect(result.resourceTemplates).toHaveLength(2);
    expect(result.prompts[0]?.arguments[0]?.required).toBe(true);
    expect(result.capabilities).toEqual({
      tools: { listChanged: true },
      resources: { subscribe: false },
      prompts: {},
    });
    for (const method of Object.keys(lists))
      expect(calls.filter((call) => call === method)).toHaveLength(2);
    expect(calls.some((call) => /call$|read$|get$/.test(call))).toBe(false);
  });
}

for (const failure of [
  "cursor",
  "duplicate",
  "secret",
  "limit",
  "missing-list",
] as const) {
  test(`Resources ${failure} 失败不返回部分发现信息并清理 session`, async () => {
    let deleted = false;
    const endpoint = fixture(async (request) => {
      if (request.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      const rpc = (await request.json()) as {
        id: number;
        method: string;
        params?: { cursor?: string };
      };
      if (rpc.method === "initialize")
        return json(rpc.id, { ...init, capabilities: { resources: {} } }, true);
      if (rpc.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const resource = {
        uri: `doc://item/${rpc.params?.cursor ? "b" : "a"}`,
        name: "public",
      };
      if (failure === "secret")
        resource.name = `Authorization: Bearer ${crypto.randomUUID()}`;
      return json(
        rpc.id,
        failure === "missing-list"
          ? {}
          : {
              resources:
                failure === "limit"
                  ? Array.from({ length: 257 }, (_, i) => ({
                      ...resource,
                      uri: `doc://item/${i}`,
                    }))
                  : [resource, ...(failure === "duplicate" ? [resource] : [])],
              ...(failure === "cursor" ? { nextCursor: "repeat" } : {}),
            },
      );
    });
    await expect(client().discover(endpoint, "2025")).rejects.toHaveProperty(
      "code",
    );
    expect(deleted).toBe(true);
  });
}

for (const mode of ["2025", "2026-07-28"] as const) {
  test(`${mode} 未声明能力不请求清单`, async () => {
    const calls: string[] = [];
    const endpoint = fixture(async (request) => {
      const rpc = (await request.json()) as { id: number; method: string };
      calls.push(rpc.method);
      if (rpc.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      return json(
        rpc.id,
        mode === "2025"
          ? { ...init, capabilities: {} }
          : {
              capabilities: {},
              _meta: { "io.modelcontextprotocol/serverInfo": init.serverInfo },
            },
      );
    });
    const discovered = await client().discover(endpoint, mode);
    expect(discovered.resources).toEqual([]);
    expect(discovered.prompts).toEqual([]);
    expect(discovered.skills).toEqual([]);
    expect(discovered.resourceTemplates).toEqual([]);
    expect(calls).toEqual(
      mode === "2025"
        ? ["initialize", "notifications/initialized"]
        : ["server/discover"],
    );
  });
}
