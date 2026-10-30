import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  McpServer,
  createMcpHandler,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { TasksServer, TASKS_EXTENSION } from "./server.ts";
import { TaskService } from "./service.ts";
import { MemoryTaskStore } from "./store.ts";
import type { TaskOutcome } from "./types.ts";

const scope = { namespace: "regression", owner: "trusted-owner" };
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "regression", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { [TASKS_EXTENSION]: {} },
  },
};
const outcome: TaskOutcome = {
  kind: "result",
  result: {
    resultType: "complete",
    content: [{ type: "text", text: "done" }],
    structuredContent: { answer: 42 },
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let sequence = 0;
function message(
  method: string,
  params: Record<string, unknown> = {},
  metadata: unknown = meta,
) {
  return {
    jsonrpc: "2.0",
    id: ++sequence,
    method,
    params: { ...params, _meta: metadata },
  };
}
async function http(factory: McpServerFactory) {
  const handler = createMcpHandler(factory, { legacy: "reject" });
  return {
    async request(
      method: string,
      params: Record<string, unknown> = {},
      metadata: unknown = meta,
    ) {
      const name = params.name ?? params.taskId;
      const response = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            ...(typeof name === "string" ? { "Mcp-Name": name } : {}),
          },
          body: JSON.stringify(message(method, params, metadata)),
        }),
      );
      return { status: response.status, body: (await response.json()) as any };
    },
    close: () => handler.close(),
  };
}
async function stdio(factory: McpServerFactory) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const iterator = lines[Symbol.asyncIterator]();
  const handle = serveStdio(factory, {
    legacy: "reject",
    transport: new StdioServerTransport(input, output),
  });
  return {
    async request(
      method: string,
      params: Record<string, unknown> = {},
      metadata: unknown = meta,
    ) {
      input.write(`${JSON.stringify(message(method, params, metadata))}\n`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const line = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(`stdio 未响应：${method}/${params.name ?? ""}`),
                ),
              1000,
            );
          }),
        ]);
        return { status: 200, body: JSON.parse(line.value!) as any };
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await handle.close();
      lines.close();
      input.destroy();
      output.destroy();
    },
  };
}

for (const [transportName, connect] of [
  ["HTTP", http],
  ["stdio", stdio],
] as const) {
  test(`P1-1 ${transportName}：核心 envelope/tools 参数执行前校验，与普通工具一致`, async () => {
    const service = new TaskService({ namespace: scope.namespace });
    let taskCalls = 0;
    let plainCalls = 0;
    const connection = await connect(() => {
      const server = new TasksServer(
        { name: "regression", version: "1" },
        { service, resolveScope: () => scope },
      );
      server.registerTaskTool(
        "task",
        { inputSchema: z.object({}) },
        async () => {
          taskCalls++;
          return outcome;
        },
      );
      server.registerTool("plain", {}, async () => {
        plainCalls++;
        return { content: [] };
      });
      return server;
    });
    try {
      await connection.request("server/discover");
      const invalid = [
        {
          params: {},
          metadata: { ...meta, "io.modelcontextprotocol/clientInfo": true },
        },
        {
          params: {},
          metadata: { ...meta, "io.modelcontextprotocol/logLevel": 99 },
        },
        {
          params: {},
          metadata: {
            ...meta,
            "io.modelcontextprotocol/clientCapabilities": true,
          },
        },
        { params: { arguments: null }, metadata: meta },
        { params: { arguments: [] }, metadata: meta },
        { params: { requestState: 123 }, metadata: meta },
      ];
      for (const { params, metadata } of invalid) {
        for (const name of ["plain", "task"]) {
          const response = await connection.request(
            "tools/call",
            { name, ...params },
            metadata,
          );
          expect(
            response.body.error.code,
            `${transportName}/${name}/${JSON.stringify(params)}/${JSON.stringify(metadata)}`,
          ).toBe(-32602);
          expect(response.body.result).toBeUndefined();
        }
      }
      expect(taskCalls).toBe(0);
      expect(plainCalls).toBe(0);
      expect(
        (
          await connection.request("tools/call", {
            name: "task",
            requestState: "not-issued",
          })
        ).body.error.code,
      ).toBe(-32602);
      const optionalInfo = {
        ...meta,
        "io.modelcontextprotocol/logLevel": "info",
      } as Record<string, unknown>;
      delete optionalInfo["io.modelcontextprotocol/clientInfo"];
      expect(
        (
          await connection.request(
            "tools/call",
            { name: "task", arguments: {} },
            optionalInfo,
          )
        ).body.result.resultType,
      ).toBe("task");
      expect(
        (
          await connection.request(
            "tools/call",
            { name: "plain", arguments: {} },
            optionalInfo,
          )
        ).body.result.resultType,
      ).toBe("complete");
      await service.waitForIdle();
      expect(taskCalls).toBe(1);
      expect(plainCalls).toBe(1);
      const unissued = await connection.request(
        "tasks/get",
        { taskId: "missing" },
        { ...meta, "io.modelcontextprotocol/clientInfo": true },
      );
      expect(unissued.body.error.code).toBe(-32602);
    } finally {
      await service.waitForIdle();
      await connection.close();
    }
  });
}

test("P1-1：普通工具的合法 requestState 仍走 SDK verifier，任务工具未签发 state 被拒绝", async () => {
  const service = new TaskService({ namespace: scope.namespace });
  let verified = 0;
  let taskCalls = 0;
  const connection = await http(() => {
    const server = new TasksServer(
      { name: "states", version: "1" },
      {
        service,
        resolveScope: () => scope,
        serverOptions: {
          requestState: {
            verify: async (state) => {
              verified++;
              if (state !== "issued-for-plain")
                throw new Error("不回显的验证详情");
              return { verified: true };
            },
          },
        },
      },
    );
    server.registerTool("plain", {}, async () => ({ content: [] }));
    server.registerTaskTool("task", { inputSchema: z.object({}) }, async () => {
      taskCalls++;
      return outcome;
    });
    return server;
  });
  try {
    expect(
      (
        await connection.request("tools/call", {
          name: "plain",
          requestState: "issued-for-plain",
        })
      ).body.result.resultType,
    ).toBe("complete");
    expect(
      (
        await connection.request("tools/call", {
          name: "plain",
          requestState: "invalid",
        })
      ).body.error.code,
    ).toBe(-32602);
    expect(verified).toBe(2);
    expect(
      (
        await connection.request("tools/call", {
          name: "task",
          requestState: "issued-for-plain",
        })
      ).body.error.code,
    ).toBe(-32602);
    expect(taskCalls).toBe(0);
    expect(verified).toBe(2);
  } finally {
    await connection.close();
  }
});

test("P2-5：未 claim 请求的 HTTP status 与原始 McpServer 一致", async () => {
  const service = new TaskService({ namespace: scope.namespace });
  const plain = await http(() => {
    const server = new McpServer({ name: "plain", version: "1" });
    server.registerTool("known", {}, async () => ({ content: [] }));
    return server;
  });
  const tasks = await http(() => {
    const server = new TasksServer(
      { name: "task", version: "1" },
      { service, resolveScope: () => scope },
    );
    server.registerTool("known", {}, async () => ({ content: [] }));
    return server;
  });
  try {
    for (const [method, params] of [
      ["method/unknown", {}],
      ["tasks/future", {}],
      [
        "initialize",
        {
          protocolVersion: "2025-11-25",
          clientInfo: { name: "test", version: "1" },
          capabilities: {},
        },
      ],
      ["tools/call", { name: "unknown" }],
    ] as const) {
      const ordinary = await plain.request(method, params);
      const wrapped = await tasks.request(method, params);
      expect(wrapped.status, method).toBe(ordinary.status);
      expect(wrapped.body.error.code, method).toBe(ordinary.body.error.code);
      if (method === "method/unknown" || method === "tasks/future") {
        expect(ordinary.status).toBe(404);
        expect(wrapped.body.error.code).toBe(-32601);
      }
    }
  } finally {
    await plain.close();
    await tasks.close();
  }
});

test("P2-5：空工具目录 unknown tools/call 也保留原 SDK 404", async () => {
  const service = new TaskService({ namespace: scope.namespace });
  const plain = await http(
    () => new McpServer({ name: "plain", version: "1" }),
  );
  const tasks = await http(
    () =>
      new TasksServer(
        { name: "tasks", version: "1" },
        { service, resolveScope: () => scope },
      ),
  );
  try {
    const a = await plain.request("tools/call", { name: "unknown" });
    const b = await tasks.request("tools/call", { name: "unknown" });
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(a.body.error.code).toBe(-32601);
    expect(b.body.error.code).toBe(-32601);
  } finally {
    await plain.close();
    await tasks.close();
  }
});

for (const maxStoredBytes of [16000, 24000, 32000]) {
  test(`P1-2：异构 service 的 get/sweep 不下调原始预留，budget=${maxStoredBytes}`, async () => {
    const store = new MemoryTaskStore();
    const work = deferred<TaskOutcome>();
    const a = new TaskService({
      namespace: scope.namespace,
      store,
      limits: { maxStoredBytes, maxResultBytes: 8000 },
    });
    const b = new TaskService({
      namespace: scope.namespace,
      store,
      limits: { maxStoredBytes, maxResultBytes: 100 },
    });
    const handle = await a.start(scope, {}, () => work.promise);
    await b.get(scope, handle.taskId);
    await b.report(scope, handle.taskId, "status");
    const pending: ReturnType<typeof deferred<TaskOutcome>>[] = [];
    for (let index = 0; index < 6; index++) {
      const smaller = deferred<TaskOutcome>();
      try {
        await b.start(scope, {}, () => smaller.promise);
        pending.push(smaller);
      } catch {
        smaller.resolve(outcome);
        break;
      }
    }
    const large: TaskOutcome = {
      kind: "result",
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "x".repeat(7700) }],
      },
    };
    // 由小预算 service 提交也遵守原任务的 8000 字节承诺。
    await b.settle(scope, handle.taskId, large);
    work.resolve(large);
    for (const smaller of pending) smaller.resolve({ kind: "cancelled" });
    await a.waitForIdle();
    await b.waitForIdle();
    const final = await a.get(scope, handle.taskId);
    expect(final.status).toBe("completed");
    expect(final.status === "completed" && final.result).toEqual(large.result);
    expect(pending.length).toBeLessThan(6);
  });
}

for (const [transportName, connect] of [
  ["HTTP", http],
  ["stdio", stdio],
] as const) {
  test(`P2-3 ${transportName}：同步结果与超时 promote 接管同一执行，最终 outputSchema 生效`, async () => {
    const service = new TaskService({ namespace: scope.namespace });
    let work = deferred<TaskOutcome>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const connection = await connect(() => {
      const server = new TasksServer(
        { name: "foreground", version: "1" },
        { service, resolveScope: () => scope },
      );
      server.registerTaskTool(
        "foreground",
        {
          inputSchema: z.object({ fast: z.boolean() }),
          outputSchema: z.object({ answer: z.number() }),
          mode: () => "foreground",
          complete: async (args, _, foreground) => {
            const execution = foreground.start(async (abort) => {
              calls++;
              signal = abort;
              return args.fast ? outcome : work.promise;
            });
            const result = await Promise.race([
              execution.outcome,
              Bun.sleep(2).then(() => undefined),
            ]);
            if (result?.kind === "result") return result.result;
            return foreground.promote(execution);
          },
        },
        async () => {
          throw new Error("不能启动第二份执行");
        },
      );
      return server;
    });
    try {
      const unsupported = {
        ...meta,
        "io.modelcontextprotocol/clientCapabilities": {},
      };
      expect(
        (
          await connection.request(
            "tools/call",
            { name: "foreground", arguments: { fast: false } },
            unsupported,
          )
        ).body.error.code,
      ).toBe(-32021);
      expect(calls).toBe(0);
      expect(
        (
          await connection.request("tools/call", {
            name: "foreground",
            arguments: { fast: true },
          })
        ).body.result.structuredContent,
      ).toEqual({ answer: 42 });
      const promoted = (
        await connection.request("tools/call", {
          name: "foreground",
          arguments: { fast: false },
        })
      ).body.result;
      expect(promoted.resultType).toBe("task");
      expect(calls).toBe(2);
      expect(
        (await connection.request("tasks/get", { taskId: promoted.taskId }))
          .body.result.status,
      ).toBe("working");
      await connection.request("tasks/cancel", { taskId: promoted.taskId });
      expect(signal?.aborted).toBe(true);
      work.resolve({
        kind: "result",
        result: {
          resultType: "complete",
          content: [],
          structuredContent: { invalid: true },
        },
      });
      await service.waitForIdle();
      const final = (
        await connection.request("tasks/get", { taskId: promoted.taskId })
      ).body.result;
      expect(final.status).toBe("failed");
      expect(final.error.code).toBe(-32603);
      expect(calls).toBe(2);
      work = deferred<TaskOutcome>();
      const success = (
        await connection.request("tools/call", {
          name: "foreground",
          arguments: { fast: false },
        })
      ).body.result;
      expect(success.resultType).toBe("task");
      work.resolve(outcome);
      await service.waitForIdle();
      const completed = (
        await connection.request("tasks/get", { taskId: success.taskId })
      ).body.result;
      expect(completed.status).toBe("completed");
      expect(completed.result.structuredContent).toEqual({ answer: 42 });
      expect(calls).toBe(3);
    } finally {
      work.resolve(outcome);
      await service.waitForIdle();
      await connection.close();
    }
  });
}

test("P2-3：promote 登记失败 abort 原控制器，不重放，不接受伪造句柄", async () => {
  const service = new TaskService({
    namespace: scope.namespace,
    limits: { maxRecords: 0 },
  });
  let calls = 0;
  let signal: AbortSignal | undefined;
  const connection = await http(() => {
    const server = new TasksServer(
      { name: "foreground", version: "1" },
      { service, resolveScope: () => scope },
    );
    server.registerTaskTool(
      "foreground",
      {
        inputSchema: z.object({}),
        mode: () => "foreground",
        complete: async (_, __, foreground) => {
          const execution = foreground.start(async (abort) => {
            calls++;
            signal = abort;
            return outcome;
          });
          return foreground.promote(execution);
        },
      },
      async () => outcome,
    );
    server.registerTaskTool(
      "forged",
      {
        inputSchema: z.object({}),
        mode: () => "complete",
        complete: async () =>
          ({ resultType: "task", taskId: "foreign" }) as any,
      },
      async () => outcome,
    );
    return server;
  });
  try {
    expect(
      (await connection.request("tools/call", { name: "foreground" })).body
        .error.code,
    ).toBe(-32603);
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(
      (await connection.request("tools/call", { name: "forged" })).body.error
        .code,
    ).toBe(-32603);
  } finally {
    await connection.close();
  }
});
