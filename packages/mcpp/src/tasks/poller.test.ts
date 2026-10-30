import { describe, expect, test } from "bun:test";
import { TaskPoller, type TaskBinding } from "./poller.ts";
import type { CreateTaskResult, DetailedTask } from "./types.ts";

const handle: CreateTaskResult = {
  resultType: "task",
  taskId: "remote",
  status: "working",
  createdAt: "2026-10-30T00:00:00Z",
  lastUpdatedAt: "2026-10-30T00:00:00Z",
  ttlMs: null,
  pollIntervalMs: 37,
};
const binding: TaskBinding = {
  endpoint: "https://tasks.example/mcp",
  authorizationContext: "opaque-owner",
  remoteTaskId: handle.taskId,
  initiatorContext: "turn-1",
};
const { resultType: _resultType, ...taskBase } = handle;
const terminal: DetailedTask = {
  ...taskBase,
  status: "completed",
  result: { resultType: "complete", content: [{ type: "text", text: "完成" }] },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("TaskPoller Host harness", () => {
  test("T04/T09：立即 get、每任务单 query、建议间隔、终态投递去重", async () => {
    const query = deferred<unknown>();
    const sleeps: number[] = [];
    let gets = 0;
    let deliveries = 0;
    const poller = new TaskPoller({
      get: async (identity) => {
        expect(identity).toEqual(binding);
        gets++;
        return gets === 1
          ? query.promise
          : { ...terminal, resultType: "complete" };
      },
      deliver: async (identity, task) => {
        expect(identity).toEqual(binding);
        expect(task).toEqual(terminal);
        deliveries++;
      },
      blocked: () => {
        throw new Error("不应需要输入");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    poller.register(binding, handle);
    const controller = new AbortController();
    const observing = poller.observe(binding, controller.signal);
    await Promise.resolve();
    const concurrent = poller.poll(binding);
    expect(gets).toBe(1);
    query.resolve({ ...taskBase, resultType: "complete", status: "working" });
    expect(await concurrent).toBe("working");
    expect(await observing).toBe("delivered");
    expect(sleeps).toEqual([37]);
    expect(await poller.poll(binding)).toBe("delivered");
    expect(deliveries).toBe(1);
    expect(gets).toBe(2);
  });

  test("T04/T09：网络失败保留绑定；交付失败只重试同一终态、不重新 get 或调用工具", async () => {
    let gets = 0;
    let failures = 0;
    const delivered: DetailedTask[] = [];
    const delays: number[] = [];
    const poller = new TaskPoller({
      get: async () => {
        if (++gets === 1) throw new Error("网络不可用");
        return { ...terminal, resultType: "complete" };
      },
      unavailable: () => {
        failures++;
      },
      deliver: async (_, task) => {
        delivered.push(task);
        if (delivered.length === 1) throw new Error("inbox 写入失败");
      },
      blocked: () => {},
      sleep: async (ms) => {
        delays.push(ms);
      },
      maxBackoffMs: 60,
    });
    poller.register(binding, handle);
    expect(await poller.observe(binding, new AbortController().signal)).toBe(
      "delivered",
    );
    expect(failures).toBe(1);
    expect(gets).toBe(2);
    expect(delivered).toEqual([terminal, terminal]);
    expect(delays).toEqual([60, 60]);
    expect(poller.snapshot(binding)).toEqual(terminal);
  });

  test("T08/T09：endpoint、scope、remoteId 和 initiator 绑定均参与去重", async () => {
    const delivered: TaskBinding[] = [];
    const poller = new TaskPoller({
      get: async (identity) => ({
        ...terminal,
        taskId: identity.remoteTaskId,
        resultType: "complete",
      }),
      deliver: async (identity) => {
        delivered.push(identity);
      },
      blocked: () => {},
    });
    const bindings = [
      binding,
      { ...binding, endpoint: "https://other.example/mcp" },
      { ...binding, authorizationContext: "other-owner" },
      { ...binding, initiatorContext: "turn-2" },
      { ...binding, remoteTaskId: "other-task" },
    ];
    for (const identity of bindings) {
      poller.register(identity, { ...handle, taskId: identity.remoteTaskId });
      expect(await poller.poll(identity)).toBe("delivered");
    }
    expect(delivered).toHaveLength(5);
    poller.register(binding, handle);
    await poller.poll(binding);
    expect(delivered).toHaveLength(5);
    expect(() =>
      poller.poll({ ...binding, initiatorContext: "unregistered" }),
    ).toThrow("binding");
  });

  test("T13：外部 input_required 保留完整请求并 blocked，不自动回答或取消", async () => {
    const input: DetailedTask = {
      ...taskBase,
      status: "input_required",
      inputRequests: {
        approval: {
          method: "elicitation/create",
          params: {
            message: "请批准",
            requestedSchema: {
              type: "object",
              properties: { approved: { type: "boolean" } },
            },
          },
        },
      },
    };
    let blocked: DetailedTask | undefined;
    let deliveries = 0;
    const poller = new TaskPoller({
      get: async () => ({ ...input, resultType: "complete" }),
      deliver: async () => {
        deliveries++;
      },
      blocked: async (_, task) => {
        blocked = task;
      },
    });
    poller.register(binding, handle);
    expect(await poller.observe(binding, new AbortController().signal)).toBe(
      "blocked",
    );
    expect(blocked).toEqual(input);
    expect(poller.snapshot(binding)).toEqual(input);
    expect(deliveries).toBe(0);
    const copy = poller.snapshot(binding)!;
    copy.statusMessage = "不能改变内部快照";
    expect(poller.snapshot(binding)?.statusMessage).toBeUndefined();
  });

  test("单次查询超时不产生第二个仍在途查询，本地停止不修改远端", async () => {
    const query = deferred<unknown>();
    let gets = 0;
    let signal: AbortSignal | undefined;
    const poller = new TaskPoller({
      requestTimeoutMs: 5,
      get: async (_, abort) => {
        gets++;
        signal = abort;
        return query.promise;
      },
      deliver: async () => {},
      blocked: () => {},
    });
    poller.register(binding, handle);
    expect(await poller.poll(binding)).toBe("unavailable");
    expect(signal?.aborted).toBe(true);
    expect(await poller.poll(binding)).toBe("unavailable");
    expect(gets).toBe(1);
    query.resolve(terminal);
    await Bun.sleep(0);
    const controller = new AbortController();
    controller.abort();
    expect(await poller.observe(binding, controller.signal)).toBe("stopped");
    expect(gets).toBe(1);
  });

  test("同一远端任务的不同 initiator 也不能叠加在途 query", async () => {
    const query = deferred<unknown>();
    let gets = 0;
    const poller = new TaskPoller({
      get: async () => {
        gets++;
        return query.promise;
      },
      deliver: async () => {},
      blocked: () => {},
    });
    const other = { ...binding, initiatorContext: "turn-other" };
    poller.register(binding, handle);
    poller.register(other, handle);
    const first = poller.poll(binding);
    await Promise.resolve();
    expect(await poller.poll(other)).toBe("unavailable");
    expect(gets).toBe(1);
    query.resolve({ ...taskBase, resultType: "complete" });
    expect(await first).toBe("working");
  });

  test("停止本地观察后在途终态不交付，保留终态供显式恢复交付", async () => {
    const query = deferred<unknown>();
    let deliveries = 0;
    const poller = new TaskPoller({
      get: async () => query.promise,
      deliver: async () => {
        deliveries++;
      },
      blocked: () => {},
    });
    poller.register(binding, handle);
    const controller = new AbortController();
    const observation = poller.observe(binding, controller.signal);
    await Promise.resolve();
    controller.abort();
    query.resolve({ ...terminal, resultType: "complete" });
    expect(await observation).toBe("stopped");
    expect(deliveries).toBe(0);
    expect(poller.snapshot(binding)).toEqual(terminal);
    expect(await poller.poll(binding)).toBe("delivered");
    expect(deliveries).toBe(1);
  });

  test("P2-6：get 必须携 complete discriminator，固定快照拒绝的输入不能 blocked/交付", async () => {
    let value: unknown = terminal;
    let blocked = 0;
    let delivered = 0;
    const poller = new TaskPoller({
      get: async () => value,
      deliver: async () => {
        delivered++;
      },
      blocked: () => {
        blocked++;
      },
    });
    poller.register(binding, handle);
    expect(await poller.poll(binding)).toBe("unavailable");
    value = {
      ...taskBase,
      resultType: "complete",
      status: "input_required",
      inputRequests: {
        bad: {
          method: "elicitation/create",
          params: { message: "请求", requestedSchema: {} },
        },
      },
    };
    expect(await poller.poll(binding)).toBe("unavailable");
    expect(blocked).toBe(0);
    expect(delivered).toBe(0);
  });

  test("错误 taskId 或无效任务 schema 不可当作远端终态交付", async () => {
    let deliveries = 0;
    const poller = new TaskPoller({
      get: async () => ({ ...terminal, taskId: "other" }),
      deliver: async () => {
        deliveries++;
      },
      blocked: () => {},
    });
    poller.register(binding, handle);
    expect(await poller.poll(binding)).toBe("unavailable");
    expect(deliveries).toBe(0);
  });
});
