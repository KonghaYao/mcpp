import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { TasksServer, type TaskForegroundContext } from "./server.ts";
import { TaskService } from "./service.ts";
import { MemoryTaskStore } from "./store.ts";
import type { CallToolResult, TaskOutcome, TaskRecord } from "./types.ts";

const scope = { namespace: "foreground-lifecycle", owner: "trusted-user" };
const result: CallToolResult = {
  resultType: "complete",
  content: [],
  structuredContent: { answer: 42 },
};
const outcome: TaskOutcome = { kind: "result", result };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cooperativeExecution() {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const cleanup = deferred<void>();
  let running = false;
  let calls = 0;
  let signal: AbortSignal | undefined;
  return {
    started,
    aborted,
    cleanup,
    running: () => running,
    calls: () => calls,
    signal: () => signal,
    async execute(abort: AbortSignal): Promise<TaskOutcome> {
      signal = abort;
      running = true;
      calls++;
      started.resolve();
      try {
        await new Promise<void>((resolve) => {
          if (abort.aborted) resolve();
          else abort.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        aborted.resolve();
        await cleanup.promise;
        running = false;
      }
      return { kind: "cancelled" };
    },
  };
}

function endpoint(
  service: TaskService,
  complete: (
    foreground: TaskForegroundContext,
  ) => Promise<CallToolResult | ReturnType<TaskForegroundContext["promote"]>>,
) {
  const handler = createMcpHandler(
    () => {
      const server = new TasksServer(
        { name: "foreground-lifecycle", version: "1" },
        { service, resolveScope: () => scope },
      );
      server.registerTaskTool(
        "foreground",
        {
          inputSchema: z.object({}),
          outputSchema: z.object({ answer: z.number() }),
          mode: () => "foreground",
          complete: async (_, __, foreground) => complete(foreground),
        },
        async () => {
          throw new Error("不得重跑后台执行器");
        },
      );
      return server;
    },
    { legacy: "reject" },
  );
  let id = 0;
  return {
    async call() {
      const response = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": "foreground",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: {
              name: "foreground",
              arguments: {},
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: { "io.modelcontextprotocol/tasks": {} },
                },
              },
            },
          }),
        }),
      );
      return (await response.json()) as {
        error?: { code: number; message: string };
        result?: { resultType: string; taskId: string };
      };
    },
    close: () => handler.close(),
  };
}

describe("前台运行所有权与拒绝清理", () => {
  for (const failure of [
    "output-invalid",
    "fake-handle",
    "handler-throws",
    "pending-complete",
    "admission-fails",
  ] as const) {
    test(`${failure}：RPC 与 close 均等待原执行的可控 finally 清理`, async () => {
      const service = new TaskService({
        namespace: scope.namespace,
        ...(failure === "admission-fails" ? { limits: { maxRecords: 0 } } : {}),
      });
      const work = cooperativeExecution();
      const http = endpoint(service, async (foreground) => {
        const execution = foreground.start(work.execute);
        await work.started.promise;
        if (failure === "handler-throws") throw new Error("受控 handler 失败");
        if (failure === "fake-handle")
          return {
            resultType: "task",
            taskId: "forged",
          } as unknown as CallToolResult;
        if (failure === "output-invalid")
          return {
            resultType: "complete",
            content: [],
            structuredContent: { invalid: true },
          };
        if (failure === "admission-fails") return foreground.promote(execution);
        return result;
      });
      let replied = false;
      const response = http.call().then((value) => {
        replied = true;
        return value;
      });
      let closed = false;
      try {
        await work.aborted.promise;
        const closing = service.close().then(() => {
          closed = true;
        });
        await Bun.sleep(0);
        expect(work.signal()?.aborted).toBe(true);
        expect(work.running()).toBe(true);
        expect(replied).toBe(false);
        expect(closed).toBe(false);
        work.cleanup.resolve();
        const reply = await response;
        await closing;
        expect(reply.error?.code).toBe(-32603);
        expect(work.calls()).toBe(1);
        expect(work.running()).toBe(false);
        expect(closed).toBe(true);
      } finally {
        work.cleanup.resolve();
        await service.close();
        await response;
        await http.close();
      }
    });
  }

  test("close-before-start：已关闭 service 在业务执行前拒绝", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    await service.close();
    let calls = 0;
    const http = endpoint(service, async (foreground) => {
      const execution = foreground.start(async () => {
        calls++;
        return outcome;
      });
      return foreground.promote(execution);
    });
    try {
      expect((await http.call()).error?.code).toBe(-32603);
      expect(calls).toBe(0);
    } finally {
      await http.close();
    }
  });

  test("close 与延迟 start 竞争：已进入 complete 也不能在关闭后启动业务", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    const entered = deferred<void>();
    const proceed = deferred<void>();
    let calls = 0;
    const http = endpoint(service, async (foreground) => {
      entered.resolve();
      await proceed.promise;
      const execution = foreground.start(async () => {
        calls++;
        return outcome;
      });
      return foreground.promote(execution);
    });
    const response = http.call();
    try {
      await entered.promise;
      await service.close();
      proceed.resolve();
      expect((await response).error?.code).toBe(-32603);
      expect(calls).toBe(0);
    } finally {
      proceed.resolve();
      await response;
      await http.close();
    }
  });

  test("close-before-promote：关闭取消未转交执行并等待清理，之后拒绝 promote", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    const work = cooperativeExecution();
    const promote = deferred<void>();
    const http = endpoint(service, async (foreground) => {
      const execution = foreground.start(work.execute);
      await work.started.promise;
      await promote.promise;
      return foreground.promote(execution);
    });
    const response = http.call();
    let closed = false;
    try {
      await work.started.promise;
      const closing = service.close().then(() => {
        closed = true;
      });
      await work.aborted.promise;
      await Bun.sleep(0);
      expect(closed).toBe(false);
      expect(work.running()).toBe(true);
      work.cleanup.resolve();
      await closing;
      expect(work.running()).toBe(false);
      promote.resolve();
      expect((await response).error?.code).toBe(-32603);
      expect(work.calls()).toBe(1);
    } finally {
      work.cleanup.resolve();
      promote.resolve();
      await response;
      await service.close();
      await http.close();
    }
  });

  test("close-during-promotion：Store 写入窗口内交接不丢 Promise，close 等待最终清理及终态", async () => {
    const inserting = deferred<void>();
    const inserted = deferred<void>();
    class DelayedStore extends MemoryTaskStore {
      override async create(record: TaskRecord) {
        inserting.resolve();
        await inserted.promise;
        await super.create(record);
      }
    }
    const service = new TaskService({
      namespace: scope.namespace,
      store: new DelayedStore(),
    });
    const started = deferred<void>();
    const finish = deferred<void>();
    const cleanup = deferred<void>();
    const cleaning = deferred<void>();
    let running = false;
    let calls = 0;
    let signal: AbortSignal | undefined;
    const http = endpoint(service, async (foreground) => {
      const execution = foreground.start(async (abort) => {
        running = true;
        calls++;
        signal = abort;
        started.resolve();
        try {
          await finish.promise;
        } finally {
          cleaning.resolve();
          await cleanup.promise;
          running = false;
        }
        return outcome;
      });
      await started.promise;
      return foreground.promote(execution);
    });
    const response = http.call();
    let closed = false;
    try {
      await inserting.promise;
      const closing = service.close().then(() => {
        closed = true;
      });
      await Bun.sleep(0);
      expect(closed).toBe(false);
      inserted.resolve();
      const reply = await response;
      expect(reply.result?.resultType).toBe("task");
      expect(signal?.aborted).toBe(false);
      expect(closed).toBe(false);
      finish.resolve();
      await cleaning.promise;
      await Bun.sleep(0);
      expect(running).toBe(true);
      expect(closed).toBe(false);
      cleanup.resolve();
      await closing;
      expect(running).toBe(false);
      expect(calls).toBe(1);
      expect((await service.get(scope, reply.result!.taskId)).status).toBe(
        "completed",
      );
    } finally {
      inserted.resolve();
      finish.resolve();
      cleanup.resolve();
      await response;
      await service.close();
      await http.close();
    }
  });

  test("前台 Promise 拒绝也经过清理等待，不遗留未观察 rejection", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    const cleanup = deferred<void>();
    const aborted = deferred<void>();
    let running = false;
    const http = endpoint(service, async (foreground) => {
      foreground.start(async (signal) => {
        running = true;
        try {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        } finally {
          aborted.resolve();
          await cleanup.promise;
          running = false;
        }
        throw new Error("受控执行器退出");
      });
      await Bun.sleep(0);
      throw new Error("受控调用退出");
    });
    const response = http.call();
    try {
      await aborted.promise;
      let closed = false;
      const closing = service.close().then(() => {
        closed = true;
      });
      await Bun.sleep(0);
      expect(closed).toBe(false);
      cleanup.resolve();
      expect((await response).error?.code).toBe(-32603);
      await closing;
      expect(running).toBe(false);
    } finally {
      cleanup.resolve();
      await response;
      await service.close();
      await http.close();
    }
  });

  test("complete 返回后的前台上下文失效，不能异步补启动未托管工作", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    let context!: TaskForegroundContext;
    let calls = 0;
    const http = endpoint(service, async (foreground) => {
      context = foreground;
      return result;
    });
    try {
      expect((await http.call()).result?.resultType).toBe("complete");
      expect(() =>
        context.start(async () => {
          calls++;
          return outcome;
        }),
      ).toThrow("unavailable");
      expect(calls).toBe(0);
    } finally {
      await service.close();
      await http.close();
    }
  });
});
