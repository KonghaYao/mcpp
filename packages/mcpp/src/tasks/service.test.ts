import { describe, expect, spyOn, test } from "bun:test";
import {
  CreateTaskResultV2Schema,
  DetailedTaskV2Schema,
  GetTaskResultV2Schema,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import { MemoryTaskStore, taskKey } from "./store.ts";
import { DEFAULT_TASK_LIMITS, TaskService } from "./service.ts";
import type {
  TaskExecutionContext,
  TaskOutcome,
  TaskRecord,
  TaskScope,
  TaskStore,
} from "./types.ts";

const scope = { namespace: "endpoint", owner: "tenant:user" };
const result = (text = "完成", isError = false): TaskOutcome => ({
  kind: "result",
  result: {
    resultType: "complete",
    content: [{ type: "text", text }],
    structuredContent: { text },
    isError,
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(): TaskRecord {
  return {
    key: { ...scope, taskId: "one" },
    revision: 1,
    snapshot: {
      taskId: "one",
      status: "working",
      createdAt: "2026-10-30T00:00:00Z",
      lastUpdatedAt: "2026-10-30T00:00:00Z",
      ttlMs: null,
    },
  };
}

/** 与数据库无关的最小代理；注入的业务 Store 只需这四个原子操作。 */
class CustomStore implements TaskStore {
  readonly memory = new MemoryTaskStore();
  conflicts = 0;
  create(record: TaskRecord) {
    return this.memory.create(record);
  }
  get(key: TaskRecord["key"]) {
    return this.memory.get(key);
  }
  async compareAndSet(...args: Parameters<TaskStore["compareAndSet"]>) {
    if (this.conflicts++ === 0) return "conflict" as const;
    return this.memory.compareAndSet(...args);
  }
  delete(...args: Parameters<TaskStore["delete"]>) {
    return this.memory.delete(...args);
  }
}

describe("MemoryTaskStore", () => {
  test("完整 key 无歧义，插入与读取均复制隔离", async () => {
    const store = new MemoryTaskStore();
    const original = fixture();
    await store.create(original);
    original.snapshot.statusMessage = "不能串改";
    const read = await store.get(original.key);
    expect(read?.snapshot.statusMessage).toBeUndefined();
    read!.snapshot.statusMessage = "仍不能串改";
    expect(
      (await store.get(original.key))?.snapshot.statusMessage,
    ).toBeUndefined();
    expect(taskKey({ namespace: "a:b", owner: "c", taskId: "d" })).not.toBe(
      taskKey({ namespace: "a", owner: "b:c", taskId: "d" }),
    );
    expect(
      await store.get({ ...original.key, owner: "other" }),
    ).toBeUndefined();
  });
  test("create 不覆盖、revision 从1开始、CAS/delete 原子匹配", async () => {
    const store = new MemoryTaskStore();
    const record = fixture();
    await store.create(record);
    await expect(store.create(record)).rejects.toThrow("exists");
    await expect(store.create({ ...record, revision: 2 })).rejects.toThrow(
      "record",
    );
    const next = { ...record, revision: 2 };
    expect(await store.compareAndSet(record.key, 1, next)).toBe("updated");
    expect(await store.compareAndSet(record.key, 1, next)).toBe("conflict");
    expect(await store.delete(record.key, 1)).toBe(false);
    expect(await store.delete(record.key, 2)).toBe(true);
    expect(await store.compareAndSet(record.key, 1, next)).toBe("not_found");
  });
  test("CAS 拒绝换 key、taskId 和错误 revision", async () => {
    const store = new MemoryTaskStore();
    const record = fixture();
    await store.create(record);
    await expect(
      store.compareAndSet(record.key, 1, {
        ...record,
        revision: 2,
        key: { ...record.key, owner: "other" },
      }),
    ).rejects.toThrow();
    await expect(
      store.compareAndSet(record.key, 1, {
        ...record,
        revision: 2,
        snapshot: { ...record.snapshot, taskId: "other" },
      }),
    ).rejects.toThrow();
    await expect(store.compareAndSet(record.key, 1, record)).rejects.toThrow();
  });
});

describe("TaskService Tier1", () => {
  test("T01/T03/T06：原子可见、句柄无终态 payload、最终结果通过官方 V2 schema", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    const work = deferred<TaskOutcome>();
    const handle = await service.start(scope, {}, () => work.promise);
    expect(CreateTaskResultV2Schema.safeParse(handle).success).toBe(true);
    expect(handle).not.toHaveProperty("result");
    expect(handle).not.toHaveProperty("key");
    expect(handle.ttlMs).toBeNull();
    expect(handle.pollIntervalMs).toBe(2000);
    expect((await service.get(scope, handle.taskId)).status).toBe("working");
    work.resolve(result());
    await service.waitForIdle();
    const final = await service.get(scope, handle.taskId);
    expect(DetailedTaskV2Schema.safeParse(final).success).toBe(true);
    expect(
      GetTaskResultV2Schema.safeParse({ ...final, resultType: "complete" })
        .success,
    ).toBe(true);
    expect(final.status).toBe("completed");
    expect(
      final.status === "completed" && final.result.structuredContent,
    ).toEqual({ text: "完成" });
  });

  test("T04/T05：已完成或在途前台执行只接管一次，不丢快速终态", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    let executions = 0;
    const original = (async () => {
      executions++;
      return result("前台");
    })();
    const handle = await service.adopt(scope, {}, original);
    await service.waitForIdle();
    expect(executions).toBe(1);
    expect((await service.get(scope, handle.taskId)).status).toBe("completed");
    const slow = deferred<TaskOutcome>();
    const second = await service.adopt(scope, {}, slow.promise);
    await expect(service.requestCancel(scope, second.taskId)).rejects.toThrow(
      "executor",
    );
    slow.resolve(result());
    await service.waitForIdle();
  });

  test("T06：业务 isError 仍 completed；显式协议错误和执行抛错为 failed", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    const business = await service.start(scope, {}, async () =>
      result("业务失败", true),
    );
    const protocol = await service.start(scope, {}, async () => ({
      kind: "error",
      error: { code: -32602, message: "业务提供的安全错误" },
    }));
    const thrown = await service.start(scope, {}, async () => {
      throw new Error("不应回显内部异常");
    });
    await service.waitForIdle();
    expect((await service.get(scope, business.taskId)).status).toBe(
      "completed",
    );
    const failed = await service.get(scope, protocol.taskId);
    expect(failed.status === "failed" && failed.error.code).toBe(-32602);
    const sanitized = await service.get(scope, thrown.taskId);
    expect(sanitized.status).toBe("failed");
    expect(JSON.stringify(sanitized)).not.toContain("不应回显");
  });

  test("T07：先保存取消意图再 abort、ACK 不代表清理完成、重复取消安全", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    const work = deferred<TaskOutcome>();
    let context!: TaskExecutionContext;
    const handle = await service.start(scope, {}, async (ctx) => {
      context = ctx;
      return work.promise;
    });
    await Promise.resolve();
    await service.requestCancel(scope, handle.taskId);
    expect(context.signal.aborted).toBe(true);
    expect(
      (await service.store.get({ ...scope, taskId: handle.taskId }))
        ?.cancelRequestedAt,
    ).toBeString();
    await service.requestCancel(scope, handle.taskId);
    expect((await service.get(scope, handle.taskId)).status).toBe("working");
    work.resolve({ kind: "cancelled", message: "清理已完成" });
    await service.waitForIdle();
    const before = await service.get(scope, handle.taskId);
    await service.requestCancel(scope, handle.taskId);
    expect(await service.get(scope, handle.taskId)).toEqual(before);
  });

  test("T07/T09：取消与完成竞态、相同终态幂等、不同终态拒绝", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    const work = deferred<TaskOutcome>();
    const handle = await service.start(scope, {}, () => work.promise);
    await service.requestCancel(scope, handle.taskId);
    work.resolve(result());
    await service.waitForIdle();
    const before = await service.get(scope, handle.taskId);
    await service.settle(scope, handle.taskId, result());
    expect(await service.get(scope, handle.taskId)).toEqual(before);
    await expect(
      service.settle(scope, handle.taskId, result("不同")),
    ).rejects.toThrow("Conflicting");
    await expect(
      service.settle(scope, handle.taskId, { kind: "cancelled" }),
    ).rejects.toThrow("Conflicting");
    await expect(service.report(scope, handle.taskId, "迟到")).rejects.toThrow(
      "terminal",
    );
  });

  test("T08：namespace、owner 隔离且不可见错误一致", async () => {
    const service = new TaskService({ namespace: scope.namespace });
    const handle = await service.start(scope, {}, async () => result());
    await service.waitForIdle();
    for (const other of [
      { ...scope, owner: "other" },
      { ...scope, namespace: "other" },
    ]) {
      await expect(service.get(other, handle.taskId)).rejects.toThrow(
        "Unknown task",
      );
      await expect(service.requestCancel(other, handle.taskId)).rejects.toThrow(
        "Unknown task",
      );
    }
    await expect(service.get(scope, "missing")).rejects.toThrow("Unknown task");
  });

  test("T10：TTL 从 createdAt 计算，仅删除到期终态，查询不续期", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      const service = new TaskService({
        namespace: scope.namespace,
        terminalRetentionMs: 100,
      });
      const work = deferred<TaskOutcome>();
      const handle = await service.start(scope, {}, () => work.promise);
      // 创建时间采用与 Date.now 相同的应用时钟，而不是测试的系统 new Date。
      const record = (await service.store.get({
        ...scope,
        taskId: handle.taskId,
      }))!;
      const created = Date.parse(record.snapshot.createdAt);
      clock.mockReturnValue(created + 4000);
      work.resolve(result());
      await service.waitForIdle();
      const terminal = await service.get(scope, handle.taskId);
      expect(terminal.ttlMs).toBe(4100);
      clock.mockReturnValue(created + 4099);
      expect(await service.get(scope, handle.taskId)).toEqual(terminal);
      clock.mockReturnValue(created + 4100);
      await expect(service.get(scope, handle.taskId)).rejects.toThrow(
        "Unknown task",
      );
      const active = deferred<TaskOutcome>();
      const activeHandle = await service.start(scope, {}, () => active.promise);
      clock.mockReturnValue(created + 1000000);
      expect((await service.get(scope, activeHandle.taskId)).status).toBe(
        "working",
      );
      active.resolve(result());
      await service.waitForIdle();
    } finally {
      clock.mockRestore();
    }
  });

  test("T10：并发准入按共享 Store 串行检查，容量拒绝发生在执行前", async () => {
    const store = new MemoryTaskStore();
    const first = new TaskService({
      namespace: scope.namespace,
      store,
      limits: { maxActiveTasks: 1 },
    });
    const second = new TaskService({
      namespace: scope.namespace,
      store,
      limits: { maxActiveTasks: 1 },
    });
    const work = deferred<TaskOutcome>();
    let executions = 0;
    const attempts = await Promise.allSettled(
      [first, second].map((service) =>
        service.start(scope, {}, async () => {
          executions++;
          return work.promise;
        }),
      ),
    );
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(executions).toBe(1);
    work.resolve(result());
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    expect(DEFAULT_TASK_LIMITS).toEqual({
      maxActiveTasks: 128,
      maxRecords: 2048,
      maxResultBytes: 262144,
      maxStoredBytes: 67108864,
    });
  });

  test("T10：记录容量不提前驱逐承诺终态", async () => {
    const service = new TaskService({
      namespace: scope.namespace,
      limits: { maxRecords: 1 },
    });
    const handle = await service.start(scope, {}, async () => result());
    await service.waitForIdle();
    await expect(
      service.start(scope, {}, async () => result()),
    ).rejects.toThrow("capacity");
    expect((await service.get(scope, handle.taskId)).status).toBe("completed");
  });

  test("UTF-8 结果预算、总预算、report 与 businessRef 均受限", async () => {
    const service = new TaskService({
      namespace: scope.namespace,
      limits: { maxResultBytes: 300, maxStoredBytes: 9000 },
    });
    const work = deferred<TaskOutcome>();
    const handle = await service.start(scope, {}, () => work.promise);
    await expect(
      service.report(scope, handle.taskId, "界".repeat(5000)),
    ).rejects.toThrow("capacity");
    await expect(
      service.setBusinessRef(scope, handle.taskId, "界".repeat(5000)),
    ).rejects.toThrow("capacity");
    work.resolve(result("界".repeat(200)));
    await service.waitForIdle();
    const final = await service.get(scope, handle.taskId);
    expect(final.status).toBe("failed");
    expect(final.status === "failed" && final.error.message).toContain(
      "storage limit",
    );
    const tooSmall = new TaskService({
      namespace: scope.namespace,
      limits: { maxStoredBytes: 10 },
    });
    let calls = 0;
    await expect(
      tooSmall.start(scope, {}, async () => {
        calls++;
        return result();
      }),
    ).rejects.toThrow("capacity");
    expect(calls).toBe(0);
  });

  test("活动预留覆盖同时完成的最大结果，取消与状态上报不能挤占终态预算", async () => {
    const service = new TaskService({
      namespace: scope.namespace,
      limits: { maxResultBytes: 1000, maxStoredBytes: 12000 },
    });
    const work = deferred<TaskOutcome>();
    const handles = await Promise.all(
      [1, 2].map(() => service.start(scope, {}, () => work.promise)),
    );
    await service.report(scope, handles[0]!.taskId, "状态".repeat(100));
    await service.setBusinessRef(scope, handles[0]!.taskId, { jobId: "job-1" });
    await service.requestCancel(scope, handles[0]!.taskId);
    work.resolve(result("界".repeat(100)));
    await service.waitForIdle();
    for (const handle of handles)
      expect((await service.get(scope, handle.taskId)).status).toBe(
        "completed",
      );
  });

  test("T11/T12：跨 service 共享自定义 Store，受信恢复报告及 settle，无自动重跑", async () => {
    const store = new CustomStore();
    const historical = fixture();
    await store.create(historical);
    const service = new TaskService({ namespace: scope.namespace, store });
    await service.report(scope, historical.key.taskId, "业务核实后恢复");
    expect(store.conflicts).toBeGreaterThan(1);
    await expect(
      service.requestCancel(scope, historical.key.taskId),
    ).rejects.toThrow("executor");
    expect((await store.get(historical.key))?.cancelRequestedAt).toBeDefined();
    await service.settle(scope, historical.key.taskId, result());
    const another = new TaskService({ namespace: scope.namespace, store });
    expect((await another.get(scope, historical.key.taskId)).status).toBe(
      "completed",
    );
    const restarted = new TaskService({ namespace: scope.namespace });
    await expect(restarted.get(scope, historical.key.taskId)).rejects.toThrow(
      "Unknown",
    );
  });

  test("业务 onCancel 失败明确报错，重复投递可重试且意图已存储", async () => {
    const store = new MemoryTaskStore();
    const historical = fixture();
    await store.create(historical);
    let calls = 0;
    const service = new TaskService({
      namespace: scope.namespace,
      store,
      onCancel: async (record) => {
        expect(record.cancelRequestedAt).toBeDefined();
        if (++calls === 1) throw new Error("内部回调错误");
      },
    });
    await expect(
      service.requestCancel(scope, historical.key.taskId),
    ).rejects.toThrow("delivery failed");
    await service.requestCancel(scope, historical.key.taskId);
    expect(calls).toBe(2);
    expect((await service.get(scope, historical.key.taskId)).status).toBe(
      "working",
    );
  });

  test("保存终态的 Store 故障明确报告，业务可核实后重试 settle", async () => {
    const store = new CustomStore();
    store.compareAndSet = async () => {
      throw new Error("内部保存诊断");
    };
    let alerts = 0;
    const service = new TaskService({
      namespace: scope.namespace,
      store,
      onExecutionError: (error) => {
        expect(error.message).toBe("Task execution settlement failed");
        alerts++;
      },
    });
    const handle = await service.start(scope, {}, async () => result());
    await expect(service.waitForIdle()).rejects.toThrow(
      "Task settlement failed",
    );
    expect(alerts).toBe(1);
    expect((await service.get(scope, handle.taskId)).status).toBe("working");
    store.compareAndSet = (...args) => store.memory.compareAndSet(...args);
    await service.settle(scope, handle.taskId, result());
    expect((await service.get(scope, handle.taskId)).status).toBe("completed");
  });

  test("关闭与异步准入竞争时等待已接管执行，而不提前返回或取消", async () => {
    const store = new CustomStore();
    const insertion = deferred<void>();
    const entered = deferred<void>();
    store.create = async (record) => {
      entered.resolve();
      await insertion.promise;
      await store.memory.create(record);
    };
    const work = deferred<TaskOutcome>();
    const service = new TaskService({ namespace: scope.namespace, store });
    const starting = service.start(scope, {}, () => work.promise);
    await entered.promise;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    insertion.resolve();
    const handle = await starting;
    await Promise.resolve();
    expect(closed).toBe(false);
    work.resolve(result());
    await closing;
    expect((await service.get(scope, handle.taskId)).status).toBe("completed");
  });

  test("adopt 登记失败不启动补偿副本，也不丢弃原执行", async () => {
    const service = new TaskService({
      namespace: scope.namespace,
      limits: { maxActiveTasks: 0 },
    });
    let calls = 0;
    const original = (async () => {
      calls++;
      return result();
    })();
    await expect(service.adopt(scope, {}, original)).rejects.toThrow(
      "capacity",
    );
    expect(await original).toEqual(result());
    expect(calls).toBe(1);
  });

  test("创建 Store 失败不启动执行；无效结果明确 failed；关闭不取消在途任务", async () => {
    const store = new CustomStore();
    store.create = async () => {
      throw new Error("内部存储异常");
    };
    const service = new TaskService({ namespace: scope.namespace, store });
    let calls = 0;
    await expect(
      service.start(scope, {}, async () => {
        calls++;
        return result();
      }),
    ).rejects.toThrow("Task operation failed");
    expect(calls).toBe(0);
    const healthy = new TaskService({ namespace: scope.namespace });
    const handle = await healthy.start(scope, {}, async () => ({
      kind: "result",
      result: {
        resultType: "complete",
        content: [],
        structuredContent: { invalid: Infinity },
      },
    }));
    await healthy.close();
    expect((await healthy.get(scope, handle.taskId)).status).toBe("failed");
    await expect(
      healthy.start(scope, {}, async () => result()),
    ).rejects.toThrow("closed");
  });
});
