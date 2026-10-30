import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  createMcpHandler,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import {
  CallToolResultV2Schema,
  CreateTaskResultV2Schema,
  GetTaskResultV2Schema,
  CancelTaskResultV2Schema,
  UpdateTaskResultV2Schema,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import { TasksServer, TASKS_EXTENSION } from "./server.ts";
import { TaskService } from "./service.ts";
import { TaskPoller } from "./poller.ts";
import type { TaskExecutionContext, TaskOutcome } from "./types.ts";

const meta = (capable = true) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "tasks-integration",
    version: "1",
  },
  "io.modelcontextprotocol/clientCapabilities": capable
    ? { extensions: { [TASKS_EXTENSION]: {} } }
    : {},
});
const scope = { namespace: "test-endpoint", owner: "authorized-user" };
const outcome: TaskOutcome = {
  kind: "result",
  result: {
    resultType: "complete",
    content: [{ type: "text", text: "完成" }],
    structuredContent: { answer: 42 },
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(namespace = scope.namespace) {
  const service = new TaskService({ namespace });
  let calls = 0;
  let executionContext: TaskExecutionContext | undefined;
  const work = deferred<TaskOutcome>();
  const factory = (context: McpRequestContext) => {
    const server = new TasksServer(
      { name: "tasks-test", version: "1" },
      {
        service,
        context,
        // 测试的授权映射由 HTTP harness 放入 WeakMap；客户端元数据没有 owner 权限。
        resolveScope: ({ request }) =>
          request ? principals.get(request) : { namespace, owner: scope.owner },
      },
    );
    server.registerTaskTool(
      "background",
      {
        inputSchema: z.object({ denied: z.boolean().optional() }),
        outputSchema: z.object({ answer: z.number() }),
        startOptions: { businessRef: { job: "internal-only" } },
        authorize(args) {
          if (args.denied) throw new Error("内部授权诊断不应外泄");
        },
      },
      async (_, ctx) => {
        calls++;
        executionContext = ctx;
        return work.promise;
      },
    );
    server.registerTaskTool(
      "mixed",
      {
        inputSchema: z.object({ background: z.boolean() }),
        outputSchema: z.object({ answer: z.number() }),
        mode: (args) => (args.background ? "task" : "complete"),
        complete: async () =>
          outcome.kind === "result" ? outcome.result : never(),
      },
      async () => {
        calls++;
        return outcome;
      },
    );
    server.registerTaskTool(
      "bad-output",
      {
        inputSchema: z.object({}),
        outputSchema: z.object({ required: z.string() }),
      },
      async () => outcome,
    );
    server.registerTool("plain", {}, async () => ({
      content: [{ type: "text", text: "普通" }],
    }));
    server.registerResource("fixture", "test://fixture", {}, async () => ({
      contents: [{ uri: "test://fixture", text: "资源" }],
    }));
    return server;
  };
  return {
    service,
    factory,
    work,
    calls: () => calls,
    context: () => executionContext,
  };
}
function never(): never {
  throw new Error("unreachable");
}
const principals = new WeakMap<Request, typeof scope>();
let id = 0;
function rpc(method: string, params: Record<string, unknown>, capable = true) {
  return {
    jsonrpc: "2.0",
    id: ++id,
    method,
    params: { ...params, _meta: meta(capable) },
  };
}
async function httpHarness(fixture: ReturnType<typeof setup>) {
  const handler = createMcpHandler(fixture.factory, { legacy: "reject" });
  const http = Bun.serve({
    port: 0,
    fetch: (request) => {
      // 这是测试专用可信映射，不是生产认证示例。
      principals.set(request, {
        namespace: fixture.service.namespace,
        owner:
          new URL(request.url).pathname === "/other" ? "other" : scope.owner,
      });
      return handler.fetch(request);
    },
  });
  async function request(
    method: string,
    params: Record<string, unknown>,
    options: {
      capable?: boolean;
      headers?: Record<string, string>;
      path?: string;
      metadata?: Record<string, unknown>;
      signal?: AbortSignal;
      discard?: boolean;
    } = {},
  ) {
    const body = rpc(method, params, options.capable);
    if (options.metadata) Object.assign(body.params._meta, options.metadata);
    const name = params.taskId ?? params.name ?? params.uri;
    const response = await fetch(
      `http://127.0.0.1:${http.port}${options.path ?? "/mcp"}`,
      {
        method: "POST",
        signal: options.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(typeof name === "string" ? { "Mcp-Name": name } : {}),
          ...options.headers,
        },
        body: JSON.stringify(body),
      },
    );
    if (options.discard) {
      await response.body?.cancel();
      return { status: response.status, body: undefined as any };
    }
    return { status: response.status, body: (await response.json()) as any };
  }
  return {
    url: `http://127.0.0.1:${http.port}/mcp`,
    request,
    close: async () => {
      await http.stop(true);
      await handler.close();
    },
  };
}

describe("Tier1 真实 HTTP 集成", () => {
  test("T01/T03/T11：发现、普通与任务结果、outputSchema、跨请求共享，关闭不取消", async () => {
    const fixture = setup();
    const http = await httpHarness(fixture);
    try {
      const discover = await http.request("server/discover", {});
      expect(
        discover.body.result.capabilities.extensions[TASKS_EXTENSION],
      ).toEqual({});
      const list = await http.request("tools/list", {});
      expect(
        list.body.result.tools.find((tool: any) => tool.name === "background")
          .outputSchema.properties.answer,
      ).toBeDefined();
      const plain = await http.request("tools/call", { name: "plain" });
      expect(plain.body.result.content[0].text).toBe("普通");
      expect(
        (await http.request("resources/read", { uri: "test://fixture" })).body
          .result.contents[0].text,
      ).toBe("资源");
      const sync = await http.request(
        "tools/call",
        { name: "mixed", arguments: { background: false } },
        { capable: false },
      );
      expect(CallToolResultV2Schema.safeParse(sync.body.result).success).toBe(
        true,
      );
      const started = await http.request("tools/call", {
        name: "background",
        arguments: {},
      });
      expect(
        CreateTaskResultV2Schema.safeParse(started.body.result).success,
      ).toBe(true);
      const taskId = started.body.result.taskId;
      expect(
        (await http.request("tasks/get", { taskId })).body.result.status,
      ).toBe("working");
      expect(fixture.context()?.signal.aborted).toBe(false);
      fixture.work.resolve(outcome);
      await fixture.service.waitForIdle();
      const completed = await http.request("tasks/get", { taskId });
      expect(
        GetTaskResultV2Schema.safeParse(completed.body.result).success,
      ).toBe(true);
      expect(completed.body.result.status).toBe("completed");
      expect(completed.body.result.result.structuredContent).toEqual({
        answer: 42,
      });
      expect(fixture.calls()).toBe(1);
      for (const field of [
        "key",
        "revision",
        "businessRef",
        "cancelRequestedAt",
      ])
        expect(completed.body.result).not.toHaveProperty(field);
      expect(JSON.stringify(completed.body)).not.toContain("internal-only");
      const invalidOutput = await http.request("tools/call", {
        name: "bad-output",
        arguments: {},
      });
      await fixture.service.waitForIdle();
      const failed = await http.request("tasks/get", {
        taskId: invalidOutput.body.result.taskId,
      });
      expect(failed.body.result.status).toBe("failed");
      expect(failed.body.result.error.code).toBe(-32603);
    } finally {
      fixture.work.resolve(outcome);
      await fixture.service.waitForIdle();
      await http.close();
    }
  });

  test("T04：HTTP 创建响应被丢弃、请求 signal 中止均不取消或重放业务", async () => {
    const fixture = setup();
    const http = await httpHarness(fixture);
    const controller = new AbortController();
    try {
      await http.request(
        "tools/call",
        { name: "background", arguments: {} },
        { signal: controller.signal, discard: true },
      );
      controller.abort();
      expect(fixture.calls()).toBe(1);
      expect(fixture.context()?.signal.aborted).toBe(false);
      const taskId = fixture.context()!.key.taskId;
      expect(
        (await http.request("tasks/get", { taskId })).body.result.status,
      ).toBe("working");
      fixture.work.resolve(outcome);
      await fixture.service.waitForIdle();
      expect(
        (await http.request("tasks/get", { taskId })).body.result.status,
      ).toBe("completed");
      expect(fixture.calls()).toBe(1);
    } finally {
      fixture.work.resolve(outcome);
      await fixture.service.waitForIdle();
      await http.close();
    }
  });

  test("小 Host 通过真实 HTTP 查询终态并只交付给原发起上下文一次", async () => {
    const fixture = setup();
    const http = await httpHarness(fixture);
    try {
      const handle = (
        await http.request("tools/call", { name: "background", arguments: {} })
      ).body.result;
      const binding = {
        endpoint: "test-endpoint",
        authorizationContext: "authorized-user",
        remoteTaskId: handle.taskId,
        initiatorContext: "turn-original",
      };
      let delivered = 0;
      const poller = new TaskPoller({
        get: async (identity, signal) => {
          expect(identity).toEqual(binding);
          const response = await http.request(
            "tasks/get",
            { taskId: identity.remoteTaskId },
            { signal },
          );
          if (response.body.error) throw new Error("查询失败");
          return response.body.result;
        },
        deliver: async (identity, task) => {
          expect(identity.initiatorContext).toBe("turn-original");
          expect(task.status).toBe("completed");
          delivered++;
        },
        blocked: () => {
          throw new Error("不应需要输入");
        },
      });
      poller.register(binding, handle);
      expect(await poller.poll(binding)).toBe("working");
      fixture.work.resolve(outcome);
      await fixture.service.waitForIdle();
      expect(await poller.poll(binding)).toBe("delivered");
      expect(await poller.poll(binding)).toBe("delivered");
      expect(delivered).toBe(1);
      expect(fixture.calls()).toBe(1);
    } finally {
      fixture.work.resolve(outcome);
      await fixture.service.waitForIdle();
      await http.close();
    }
  });

  test("T02：能力按本次检查，-32021 不经工具 isError 转换且执行尚未启动", async () => {
    const fixture = setup();
    const http = await httpHarness(fixture);
    try {
      await http.request("server/discover", {});
      const denied = await http.request(
        "tools/call",
        { name: "background", arguments: {} },
        { capable: false },
      );
      expect(denied.body.error.code).toBe(-32021);
      expect(denied.body.error.data.requiredCapabilities.extensions).toEqual({
        [TASKS_EXTENSION]: {},
      });
      expect(denied.body).not.toHaveProperty("result");
      expect(fixture.calls()).toBe(0);
      for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
        const response = await http.request(
          method,
          { taskId: "missing", inputResponses: {} },
          { capable: false },
        );
        expect(response.body.error.code).toBe(-32021);
      }
      const malformedCapability = await http.request(
        "tools/call",
        { name: "background", arguments: {} },
        {
          metadata: {
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { [TASKS_EXTENSION]: { tier: 1 } },
            },
          },
        },
      );
      expect(malformedCapability.body.error.code).toBe(-32021);
      expect(fixture.calls()).toBe(0);
    } finally {
      await http.close();
    }
  });

  test("T07/T08/T13：更新严格校验并无副作用、隔离不可见、取消 ACK 后再确认终态", async () => {
    const fixture = setup();
    const http = await httpHarness(fixture);
    try {
      const handle = (
        await http.request("tools/call", { name: "background", arguments: {} })
      ).body.result;
      const taskId = handle.taskId;
      const before = await fixture.service.store.get({ ...scope, taskId });
      for (const inputResponses of [
        {},
        {
          unknown: {
            action: "accept",
            content: { name: "同意", selection: ["a"], number: 1 },
          },
        },
        { roots: { roots: [{ uri: "file:///fixture" }] } },
        {
          sample: {
            content: { type: "text", text: "sample" },
            model: "test",
            role: "assistant",
          },
        },
      ]) {
        const ack = await http.request("tasks/update", {
          taskId,
          inputResponses,
        });
        expect(
          UpdateTaskResultV2Schema.safeParse(ack.body.result).success,
        ).toBe(true);
        expect(ack.body.result).toEqual({ resultType: "complete" });
        expect(await fixture.service.store.get({ ...scope, taskId })).toEqual(
          before,
        );
      }
      for (const inputResponses of [
        null,
        [],
        { bad: {} },
        { bad: { action: "accept", content: { number: 1.5 } } },
        { bad: { action: "accept", content: { nested: {} } } },
        { bad: { roots: [1] } },
        { bad: { content: { type: "text", text: "x" }, role: "assistant" } },
      ]) {
        expect(
          (await http.request("tasks/update", { taskId, inputResponses })).body
            .error.code,
        ).toBe(-32602);
      }
      for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
        const params = { taskId, inputResponses: {} };
        const foreign = await http.request(method, params, {
          path: "/other",
          metadata: { "peri/taskOwner": scope.owner },
        });
        const unknown = await http.request(method, {
          ...params,
          taskId: "missing",
        });
        expect(foreign.body.error).toEqual(unknown.body.error);
        expect(foreign.body.error.code).toBe(-32602);
      }
      expect(fixture.context()?.signal.aborted).toBe(false);
      for (let i = 0; i < 2; i++) {
        const cancel = await http.request("tasks/cancel", { taskId });
        expect(
          CancelTaskResultV2Schema.safeParse(cancel.body.result).success,
        ).toBe(true);
        expect(cancel.body.result).toEqual({ resultType: "complete" });
      }
      expect(
        (await http.request("tasks/get", { taskId })).body.result.status,
      ).toBe("working");
      fixture.work.resolve({ kind: "cancelled", message: "清理完成" });
      await fixture.service.waitForIdle();
      expect(
        (await http.request("tasks/get", { taskId })).body.result.status,
      ).toBe("cancelled");
    } finally {
      fixture.work.resolve(outcome);
      await fixture.service.waitForIdle();
      await http.close();
    }
  });

  test("Mcp-Method/Mcp-Name、参数与授权在启动前校验；内部异常不外泄", async () => {
    const fixture = setup();
    const http = await httpHarness(fixture);
    try {
      for (const headers of [
        { "Mcp-Method": "tasks/cancel" },
        { "Mcp-Name": "other" },
        { "Mcp-Name": "" },
      ] as Record<string, string>[]) {
        const response = await http.request(
          "tasks/get",
          { taskId: "missing" },
          { headers },
        );
        expect(response.body.error.code).toBe(-32020);
      }
      for (const arguments_ of [{ denied: "wrong-type" }, { denied: true }]) {
        const response = await http.request("tools/call", {
          name: "background",
          arguments: arguments_,
        });
        expect(response.body.error.code).toBe(
          arguments_.denied === true ? -32603 : -32602,
        );
        expect(JSON.stringify(response.body)).not.toContain("内部授权");
      }
      expect(fixture.calls()).toBe(0);
      expect((await http.request("tasks/get", {})).body.error.code).toBe(
        -32602,
      );
      expect(
        (await http.request("tasks/update", { taskId: "missing" })).body.error
          .code,
      ).toBe(-32602);
    } finally {
      await http.close();
    }
  });

  test("可选订阅未实现时，SDK router 不确认任何 taskIds", async () => {
    const fixture = setup();
    const http = await httpHarness(fixture);
    const controller = new AbortController();
    try {
      const response = await fetch(http.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "subscriptions/listen",
        },
        body: JSON.stringify(
          rpc("subscriptions/listen", {
            notifications: { taskIds: ["foreign-task"] },
          }),
        ),
      });
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      const text = new TextDecoder().decode(chunk.value);
      const data = text.split("\n").find((line) => line.startsWith("data: "));
      expect(data).toBeDefined();
      const payload = JSON.parse(data!.slice(6));
      if (payload.error) expect(payload.error.code).toBeNumber();
      else {
        expect(payload.method).toBe("notifications/subscriptions/acknowledged");
        expect(payload.params.notifications?.taskIds ?? []).toEqual([]);
      }
      await reader.cancel();
    } finally {
      controller.abort();
      await http.close();
    }
  });

  test("不同 endpoint namespace 不复用任务句柄", async () => {
    const first = setup();
    const second = setup("second-endpoint");
    const a = await httpHarness(first);
    const b = await httpHarness(second);
    try {
      const handle = (
        await a.request("tools/call", { name: "background", arguments: {} })
      ).body.result;
      for (const method of ["tasks/get", "tasks/update", "tasks/cancel"])
        expect(
          (
            await b.request(method, {
              taskId: handle.taskId,
              inputResponses: {},
            })
          ).body.error.code,
        ).toBe(-32602);
    } finally {
      first.work.resolve(outcome);
      second.work.resolve(outcome);
      await first.service.waitForIdle();
      await a.close();
      await b.close();
    }
  });
});

test("Tier1 真实 stdio：跨请求状态、每次能力检查、连接关闭不取消后台", async () => {
  const fixture = setup();
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const iterator = lines[Symbol.asyncIterator]();
  const handle = serveStdio(fixture.factory, {
    legacy: "reject",
    transport: new StdioServerTransport(input, output),
  });
  const request = async (
    method: string,
    params: Record<string, unknown>,
    capable = true,
  ) => {
    input.write(`${JSON.stringify(rpc(method, params, capable))}\n`);
    return JSON.parse((await iterator.next()).value!) as any;
  };
  try {
    expect(
      (await request("server/discover", {})).result.capabilities.extensions[
        TASKS_EXTENSION
      ],
    ).toEqual({});
    const task = (
      await request("tools/call", { name: "background", arguments: {} })
    ).result;
    expect(CreateTaskResultV2Schema.safeParse(task).success).toBe(true);
    expect(
      (await request("tasks/get", { taskId: task.taskId })).result.status,
    ).toBe("working");
    expect(
      (await request("tasks/get", { taskId: task.taskId }, false)).error.code,
    ).toBe(-32021);
    expect(
      (await request("tools/call", { name: "plain" })).result.content[0].text,
    ).toBe("普通");
    await handle.close();
    expect(fixture.context()?.signal.aborted).toBe(false);
    fixture.work.resolve(outcome);
    await fixture.service.waitForIdle();
    expect((await fixture.service.get(scope, task.taskId)).status).toBe(
      "completed",
    );
    expect(fixture.calls()).toBe(1);
  } finally {
    fixture.work.resolve(outcome);
    await fixture.service.waitForIdle();
    await handle.close();
    lines.close();
    input.destroy();
    output.destroy();
  }
});
