import { isDeepStrictEqual } from "node:util";
import { isJsonValue } from "@modelcontextprotocol/ext-tasks/core";
import {
  CallToolResultV2Schema,
  CreateTaskResultV2Schema,
  DetailedTaskV2Schema,
  ErrorV2Schema,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import {
  internalTaskError,
  invalidTask,
  jsonBytes,
  TaskError,
  taskRpcError,
} from "./errors.ts";
import {
  MemoryTaskStore,
  taskKey,
  validateRecord,
  validateScope,
} from "./store.ts";
import { matchesTaskSchema } from "./schema.ts";
import type {
  CreateTaskResult,
  DetailedTask,
  ForegroundExecution,
  JsonValue,
  TaskExecutionContext,
  TaskKey,
  TaskLimits,
  TaskOutcome,
  TaskRecord,
  TaskScope,
  TaskServiceOptions,
  TaskStartOptions,
  TaskStore,
} from "./types.ts";

export const DEFAULT_TASK_LIMITS = {
  maxActiveTasks: 128,
  maxRecords: 2048,
  maxResultBytes: 256 * 1024,
  maxStoredBytes: 64 * 1024 * 1024,
} as const;

const terminalReserve = 2048;
const isTerminal = (snapshot: DetailedTask) =>
  snapshot.status !== "working" && snapshot.status !== "input_required";

type Accounting = {
  key: TaskKey;
  charge: number;
  active: boolean;
  maxResultBytes: number;
  maxStoredBytes: number;
};
type Coordinator = { tail: Promise<void>; records: Map<string, Accounting> };
const coordinators = new WeakMap<TaskStore, Coordinator>();

/** 一个应用生命周期共享一个实例；替换 Store 不代表自动恢复业务执行。 */
export class TaskService {
  readonly namespace: string;
  readonly store: TaskStore;
  readonly limits: Readonly<TaskLimits>;
  readonly pollIntervalMs: number;
  readonly terminalRetentionMs: number;
  readonly #coordinator: Coordinator;
  readonly #executions = new Map<
    string,
    { controller?: AbortController; promise: Promise<void> }
  >();
  readonly #foregroundExecutions = new WeakMap<
    ForegroundExecution,
    AbortController
  >();
  readonly #foreground = new Map<
    ForegroundExecution,
    { controller: AbortController; wait: Promise<void>; transferring: boolean }
  >();
  readonly #executionErrors: Error[] = [];
  readonly #options: TaskServiceOptions;
  #closed = false;

  constructor(options: TaskServiceOptions) {
    validateScope({ namespace: options.namespace, owner: "validation" });
    this.namespace = options.namespace;
    this.store = options.store ?? new MemoryTaskStore();
    this.limits = Object.freeze({ ...DEFAULT_TASK_LIMITS, ...options.limits });
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.terminalRetentionMs =
      options.terminalRetentionMs ?? 24 * 60 * 60 * 1000;
    for (const value of [
      ...Object.values(this.limits),
      this.pollIntervalMs,
      this.terminalRetentionMs,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TaskError(-32602, "Invalid task limits");
    }
    this.#options = options;
    let coordinator = coordinators.get(this.store);
    if (!coordinator) {
      coordinator = { tail: Promise.resolve(), records: new Map() };
      coordinators.set(this.store, coordinator);
    }
    this.#coordinator = coordinator;
  }

  #key(scope: TaskScope, taskId: string): TaskKey {
    validateScope(scope);
    if (
      scope.namespace !== this.namespace ||
      typeof taskId !== "string" ||
      !taskId
    )
      throw invalidTask();
    return { namespace: scope.namespace, owner: scope.owner, taskId };
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#coordinator.tail;
    let release!: () => void;
    this.#coordinator.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } catch (error) {
      throw error instanceof TaskError ? error : internalTaskError();
    } finally {
      release();
    }
  }

  #charge(record: TaskRecord): Accounting {
    const active = !isTerminal(record.snapshot);
    // 取消意图及终态头部另行预留，不让进度上报耗尽最后的保存空间。
    const admitted = this.#coordinator.records.get(taskKey(record.key));
    const maxResultBytes =
      admitted?.maxResultBytes ?? this.limits.maxResultBytes;
    const maxStoredBytes =
      admitted?.maxStoredBytes ?? this.limits.maxStoredBytes;
    return {
      key: record.key,
      active,
      maxResultBytes,
      maxStoredBytes,
      charge:
        jsonBytes(record) +
        (active
          ? maxResultBytes +
            terminalReserve * 2 -
            (record.cancelRequestedAt ? 128 : 0)
          : 0),
    };
  }

  #account(record: TaskRecord) {
    this.#coordinator.records.set(taskKey(record.key), this.#charge(record));
  }

  #checkBudget(record: TaskRecord, creating = false) {
    const records = this.#coordinator.records;
    const next = this.#charge(record);
    let bytes = next.charge;
    let active = next.active ? 1 : 0;
    let count = 1;
    let maxStoredBytes = next.maxStoredBytes;
    for (const [id, value] of records) {
      maxStoredBytes = Math.min(maxStoredBytes, value.maxStoredBytes);
      if (id === taskKey(record.key)) continue;
      bytes += value.charge;
      active += Number(value.active);
      count++;
    }
    if (
      bytes > maxStoredBytes ||
      (creating &&
        (active > this.limits.maxActiveTasks || count > this.limits.maxRecords))
    ) {
      throw new TaskError(-32603, "Task capacity exceeded");
    }
  }

  #expired(snapshot: DetailedTask): boolean {
    return (
      isTerminal(snapshot) &&
      snapshot.ttlMs !== null &&
      Date.now() >= Date.parse(snapshot.createdAt) + snapshot.ttlMs
    );
  }

  async #read(key: TaskKey): Promise<TaskRecord> {
    const record = await this.store.get(key);
    if (!record) throw invalidTask();
    if (this.#expired(record.snapshot)) {
      if (await this.store.delete(key, record.revision))
        this.#coordinator.records.delete(taskKey(key));
      throw invalidTask();
    }
    try {
      validateRecord(key, record.revision, record);
    } catch {
      throw internalTaskError();
    }
    if (record.snapshot.status === "input_required")
      throw new TaskError(-32603, "Tier 1 task cannot require input");
    this.#account(record);
    return record;
  }

  async #sweep() {
    for (const [id, entry] of this.#coordinator.records) {
      const record = await this.store.get(entry.key);
      if (!record) this.#coordinator.records.delete(id);
      else if (this.#expired(record.snapshot)) {
        if (await this.store.delete(entry.key, record.revision))
          this.#coordinator.records.delete(id);
      } else this.#account(record);
    }
  }

  start(
    scope: TaskScope,
    options: TaskStartOptions,
    execute: (ctx: TaskExecutionContext) => Promise<TaskOutcome>,
  ): Promise<CreateTaskResult> {
    return this.#start(scope, options, execute, true);
  }

  async #start(
    scope: TaskScope,
    options: TaskStartOptions,
    execute: (ctx: TaskExecutionContext) => Promise<TaskOutcome>,
    localCancellation: boolean | AbortController,
    transferred?: () => void,
  ): Promise<CreateTaskResult> {
    const key = this.#key(scope, `t_${crypto.randomUUID()}`);
    return this.#locked(async () => {
      if (this.#closed) throw new TaskError(-32603, "Task service closed");
      await this.#sweep();
      const now = new Date().toISOString();
      const record: TaskRecord = {
        key,
        revision: 1,
        snapshot: {
          taskId: key.taskId,
          status: "working",
          createdAt: now,
          lastUpdatedAt: now,
          ttlMs: null,
          pollIntervalMs: this.pollIntervalMs,
          ...(options.statusMessage !== undefined
            ? { statusMessage: options.statusMessage }
            : {}),
        },
        ...(options.businessRef !== undefined
          ? { businessRef: options.businessRef }
          : {}),
      };
      validateRecord(key, 1, record);
      this.#checkBudget(record, true);
      await this.store.create(record);
      this.#account(record);
      // 准入锁释放前登记运行句柄，避免 close/cancel 观察到没有执行器的 working。
      this.#launch(record.key, execute, localCancellation);
      transferred?.();
      return CreateTaskResultV2Schema.parse({
        ...record.snapshot,
        resultType: "task",
      });
    });
  }

  #launch(
    key: TaskKey,
    execute: (ctx: TaskExecutionContext) => Promise<TaskOutcome>,
    localCancellation: boolean | AbortController,
  ): void {
    const controller =
      typeof localCancellation === "boolean"
        ? new AbortController()
        : localCancellation;
    const trustedScope = { namespace: key.namespace, owner: key.owner };
    const context: TaskExecutionContext = {
      key: structuredClone(key),
      signal: controller.signal,
      report: (message) => this.report(trustedScope, key.taskId, message),
      setBusinessRef: (reference) =>
        this.setBusinessRef(trustedScope, key.taskId, reference),
    };
    const promise = Promise.resolve()
      .then(async () => {
        let outcome: TaskOutcome;
        try {
          outcome = await execute(context);
        } catch (error) {
          outcome = { kind: "error", error: taskRpcError(error) };
        }
        await this.settle(trustedScope, key.taskId, outcome);
      })
      .catch(() => {
        const error = new Error("Task execution settlement failed");
        if (this.#executionErrors.length === 0)
          this.#executionErrors.push(error);
        try {
          this.#options.onExecutionError?.(error);
        } catch {
          /* 观测回调不能制造未处理 Promise。 */
        }
      })
      .finally(() => {
        this.#executions.delete(taskKey(key));
      });
    this.#executions.set(taskKey(key), {
      controller: localCancellation ? controller : undefined,
      promise,
    });
  }

  /** 在调用业务前同步登记；close 可以取消并等待尚未转交的前台执行。 */
  startForeground(
    execute: (signal: AbortSignal) => Promise<TaskOutcome>,
  ): ForegroundExecution {
    if (this.#closed) throw new TaskError(-32603, "Task service closed");
    const controller = new AbortController();
    let settled = false;
    const outcome = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return { kind: "cancelled" as const };
        return execute(controller.signal);
      })
      .catch(
        (error: unknown): TaskOutcome => ({
          kind: "error",
          error: taskRpcError(error),
        }),
      )
      .then((result) => {
        settled = true;
        return result;
      });
    const execution: ForegroundExecution = Object.freeze({
      outcome,
      signal: controller.signal,
      get settled() {
        return settled;
      },
    });
    this.#foregroundExecutions.set(execution, controller);
    const wait = outcome.then(() => {
      this.#foreground.delete(execution);
    });
    this.#foreground.set(execution, { controller, wait, transferring: false });
    return execution;
  }

  /** 失败返回和未转交执行的统一清理；必须等业务自己的 finally 完成。 */
  async discardForeground(execution: ForegroundExecution): Promise<void> {
    if (!this.#foregroundExecutions.has(execution))
      throw new TaskError(-32602, "Unknown foreground execution");
    const owned = this.#foreground.get(execution);
    if (owned?.transferring)
      throw new TaskError(-32602, "Foreground transfer in progress");
    this.#foregroundExecutions.get(execution)!.abort();
    await execution.outcome;
    await owned?.wait;
  }

  /** 同一 service 内原子交接；失败仍由前台所有者清理，不重放执行。 */
  async promoteForeground(
    scope: TaskScope,
    options: TaskStartOptions,
    execution: ForegroundExecution,
    validate: (outcome: TaskOutcome) => Promise<TaskOutcome>,
  ): Promise<CreateTaskResult> {
    if (!this.#foregroundExecutions.has(execution))
      throw new TaskError(-32602, "Unknown foreground execution");
    const owned = this.#foreground.get(execution);
    if (owned?.transferring)
      throw new TaskError(-32602, "Foreground transfer in progress");
    if (owned) owned.transferring = true;
    try {
      return await this.#start(
        scope,
        options,
        async () => validate(await execution.outcome),
        owned?.controller ?? false,
        () => {
          this.#foreground.delete(execution);
          this.#foregroundExecutions.delete(execution);
        },
      );
    } catch (error) {
      if (owned) owned.transferring = false;
      await this.discardForeground(execution);
      throw error;
    }
  }

  /** 接管已启动的同一个 Promise；登记失败时由原执行器决定原工作的存续。 */
  async adopt(
    scope: TaskScope,
    options: TaskStartOptions,
    execution: Promise<TaskOutcome>,
    controller?: AbortController,
  ): Promise<CreateTaskResult> {
    const observed = execution.then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({
        outcome: { kind: "error", error: taskRpcError(error) } as TaskOutcome,
      }),
    );
    // 未提供控制器时，外部执行只能通过业务 onCancel 投递取消。
    return this.#start(
      scope,
      options,
      async () => (await observed).outcome,
      controller ?? false,
    );
  }

  async get(scope: TaskScope, taskId: string): Promise<DetailedTask> {
    const key = this.#key(scope, taskId);
    return this.#locked(async () =>
      DetailedTaskV2Schema.parse((await this.#read(key)).snapshot),
    );
  }

  async #update(
    key: TaskKey,
    update: (record: TaskRecord) => TaskRecord | undefined,
  ): Promise<TaskRecord> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await this.#read(key);
      const next = update(structuredClone(current));
      if (!next) return current;
      next.revision = current.revision + 1;
      next.snapshot.createdAt = current.snapshot.createdAt;
      if (!isTerminal(next.snapshot))
        next.snapshot.lastUpdatedAt = new Date(
          Math.max(Date.now(), Date.parse(current.snapshot.lastUpdatedAt)),
        ).toISOString();
      validateRecord(key, next.revision, next);
      this.#checkBudget(next);
      const result = await this.store.compareAndSet(
        key,
        current.revision,
        next,
      );
      if (result === "updated") {
        this.#account(next);
        return next;
      }
      if (result === "not_found") throw invalidTask();
    }
    throw new TaskError(-32603, "Task update contention");
  }

  async report(
    scope: TaskScope,
    taskId: string,
    message: string,
  ): Promise<void> {
    if (typeof message !== "string")
      throw new TaskError(-32602, "Invalid status message");
    const key = this.#key(scope, taskId);
    await this.#locked(() =>
      this.#update(key, (record) => {
        if (isTerminal(record.snapshot))
          throw new TaskError(-32602, "Task already terminal");
        record.snapshot.statusMessage = message;
        return record;
      }),
    );
  }

  async setBusinessRef(
    scope: TaskScope,
    taskId: string,
    reference: JsonValue,
  ): Promise<void> {
    if (!isJsonValue(reference))
      throw new TaskError(-32602, "Invalid business reference");
    const key = this.#key(scope, taskId);
    await this.#locked(() =>
      this.#update(key, (record) => {
        if (isTerminal(record.snapshot))
          throw new TaskError(-32602, "Task already terminal");
        record.businessRef = structuredClone(reference);
        return record;
      }),
    );
  }

  #outcome(outcome: TaskOutcome, maxResultBytes: number): TaskOutcome {
    try {
      let parsed: TaskOutcome;
      if (outcome.kind === "result") {
        if (outcome.result.resultType !== "complete") throw internalTaskError();
        parsed = {
          kind: "result",
          result: CallToolResultV2Schema.parse(outcome.result),
        };
      } else if (outcome.kind === "error") {
        if (!matchesTaskSchema("Error", outcome.error))
          throw internalTaskError();
        parsed = { kind: "error", error: ErrorV2Schema.parse(outcome.error) };
      } else if (
        outcome.kind === "cancelled" &&
        (outcome.message === undefined || typeof outcome.message === "string")
      )
        parsed = outcome;
      else throw internalTaskError();
      const payload =
        parsed.kind === "result"
          ? parsed.result
          : parsed.kind === "error"
            ? parsed.error
            : parsed;
      if (jsonBytes(payload) > maxResultBytes)
        return {
          kind: "error",
          error: { code: -32603, message: "Task result exceeds storage limit" },
        };
      return structuredClone(parsed);
    } catch {
      return {
        kind: "error",
        error: { code: -32603, message: "Task result could not be stored" },
      };
    }
  }

  async settle(
    scope: TaskScope,
    taskId: string,
    outcome: TaskOutcome,
  ): Promise<void> {
    const key = this.#key(scope, taskId);
    const maxResultBytes =
      this.#coordinator.records.get(taskKey(key))?.maxResultBytes ??
      this.limits.maxResultBytes;
    const normalized = this.#outcome(outcome, maxResultBytes);
    await this.#locked(() =>
      this.#update(key, (record) => {
        const current = record.snapshot;
        if (isTerminal(current)) {
          const same =
            normalized.kind === "result"
              ? current.status === "completed" &&
                isDeepStrictEqual(current.result, normalized.result)
              : normalized.kind === "error"
                ? current.status === "failed" &&
                  isDeepStrictEqual(current.error, normalized.error)
                : current.status === "cancelled" &&
                  current.statusMessage === normalized.message;
          if (same) return;
          throw new TaskError(-32602, "Conflicting terminal outcome");
        }
        const now = Math.max(Date.now(), Date.parse(current.lastUpdatedAt));
        const base = {
          taskId,
          createdAt: current.createdAt,
          lastUpdatedAt: new Date(now).toISOString(),
          ttlMs: now - Date.parse(current.createdAt) + this.terminalRetentionMs,
          pollIntervalMs: this.pollIntervalMs,
        };
        record.snapshot =
          normalized.kind === "result"
            ? { ...base, status: "completed", result: normalized.result }
            : normalized.kind === "error"
              ? { ...base, status: "failed", error: normalized.error }
              : {
                  ...base,
                  status: "cancelled",
                  ...(normalized.message !== undefined
                    ? { statusMessage: normalized.message }
                    : {}),
                };
        return record;
      }),
    );
  }

  async requestCancel(scope: TaskScope, taskId: string): Promise<void> {
    const key = this.#key(scope, taskId);
    const record = await this.#locked(() =>
      this.#update(key, (record) => {
        if (isTerminal(record.snapshot) || record.cancelRequestedAt) return;
        record.cancelRequestedAt = new Date().toISOString();
        return record;
      }),
    );
    if (isTerminal(record.snapshot)) return;
    const execution = this.#executions.get(taskKey(key));
    if (!execution?.controller && !this.#options.onCancel) {
      if (isTerminal(await this.get(scope, taskId))) return;
      throw new TaskError(
        -32603,
        "Task cancellation requires business executor",
      );
    }
    execution?.controller?.abort();
    if (this.#options.onCancel) {
      try {
        await this.#options.onCancel(structuredClone(record));
      } catch {
        throw new TaskError(-32603, "Task cancellation delivery failed");
      }
    }
  }

  /** 应用关闭时显式等待；请求关闭不调用此方法，也不停止后台任务。 */
  async waitForIdle(): Promise<void> {
    while (this.#executions.size || this.#foreground.size)
      await Promise.all([
        ...[...this.#executions.values()].map((entry) => entry.promise),
        ...[...this.#foreground.values()].map((entry) => entry.wait),
      ]);
    if (this.#executionErrors.length)
      throw new AggregateError(this.#executionErrors, "Task settlement failed");
  }

  /** 拒绝新执行；取消尚未转交的前台执行并等待清理，已提交任务保持原业务策略。 */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#locked(async () => {
      for (const owned of this.#foreground.values()) {
        if (!owned.transferring) owned.controller.abort();
      }
    });
    await this.waitForIdle();
  }
}
