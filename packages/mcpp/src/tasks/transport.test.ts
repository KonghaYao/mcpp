import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import {
  createMcpHandler,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { TasksTransportServer } from "./transport.ts";

const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "tasks-spike", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};

function factory() {
  const server = new TasksTransportServer(
    { name: "tasks-spike", version: "1" },
    { capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
    (message) => {
      if (!("method" in message)) return;
      if (
        message.method !== "tasks/get" &&
        !(
          message.method === "tools/call" &&
          message.params?.name === "background"
        )
      )
        return;
      return (async () => {
        if (message.method === "tasks/get") {
          return {
            result: {
              resultType: "complete",
              taskId: "t_spike",
              status: "working",
              createdAt: "2026-10-30T00:00:00Z",
              lastUpdatedAt: "2026-10-30T00:00:00Z",
              ttlMs: null,
            },
          };
        }
        if (
          message.method === "tools/call" &&
          message.params?.name === "background"
        ) {
          return {
            result: {
              resultType: "task",
              taskId: "t_spike",
              status: "working",
              createdAt: "2026-10-30T00:00:00Z",
              lastUpdatedAt: "2026-10-30T00:00:00Z",
              ttlMs: null,
            },
          };
        }
        throw new Error("未处理的接管请求");
      })();
    },
  );
  server.registerTool("plain", {}, async () => ({
    content: [{ type: "text", text: "plain" }],
  }));
  server.registerResource("fixture", "test://fixture", {}, async () => ({
    contents: [{ uri: "test://fixture", text: "resource" }],
  }));
  return server;
}

function message(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method,
    params: { ...params, _meta: meta },
  };
}

const calls = [
  ["server/discover", {}],
  ["tools/call", { name: "background" }],
  ["tasks/get", { taskId: "t_spike" }],
  ["tools/call", { name: "plain" }],
  ["resources/read", { uri: "test://fixture" }],
] as const;

function check(results: any[]) {
  for (const response of results) expect(response.error).toBeUndefined();
  expect(
    results[0].result.capabilities.extensions["io.modelcontextprotocol/tasks"],
  ).toEqual({});
  expect(results[1].result.resultType).toBe("task");
  expect(results[2].result.status).toBe("working");
  expect(results[3].result.content[0].text).toBe("plain");
  expect(results[4].result.contents[0].text).toBe("resource");
}

test("公开 connect 包装：真实 HTTP 混用 Tasks、工具、资源和 discover", async () => {
  const handler = createMcpHandler(factory, { legacy: "reject" });
  const http = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req) });
  try {
    const results = [];
    for (const [index, [method, params]] of calls.entries()) {
      const response = await fetch(`http://127.0.0.1:${http.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...("name" in params
            ? { "Mcp-Name": params.name }
            : "taskId" in params
              ? { "Mcp-Name": params.taskId }
              : "uri" in params
                ? { "Mcp-Name": params.uri }
                : {}),
        },
        body: JSON.stringify(message(index, method, params)),
      });
      expect(response.status).toBe(200);
      results.push(await response.json());
    }
    check(results);
  } finally {
    await http.stop(true);
    await handler.close();
  }
});

test("公开 connect 包装：真实 stdio framing 混用同一连接", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const iterator = lines[Symbol.asyncIterator]();
  const handle = serveStdio(factory, {
    legacy: "reject",
    transport: new StdioServerTransport(input, output),
  });
  try {
    const results = [];
    for (const [index, [method, params]] of calls.entries()) {
      input.write(`${JSON.stringify(message(index, method, params))}\n`);
      const line = await iterator.next();
      expect(line.done).toBe(false);
      results.push(JSON.parse(line.value!) as JSONRPCMessage);
    }
    check(results);
  } finally {
    await handle.close();
    lines.close();
    input.destroy();
    output.destroy();
  }
});
