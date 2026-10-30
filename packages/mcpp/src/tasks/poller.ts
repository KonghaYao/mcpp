import {
  CreateTaskResultV2Schema,
  DetailedTaskV2Schema,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import { matchesTaskSchema } from "./schema.ts";
import { TaskError } from "./errors.ts";
import type { CreateTaskResult, DetailedTask } from "./types.ts";

export interface TaskBinding {
  endpoint: string;
  authorizationContext: string;
  remoteTaskId: string;
  initiatorContext: string;
}

export interface TaskPollerOptions {
  get(binding: Readonly<TaskBinding>, signal: AbortSignal): Promise<unknown>;
  deliver(
    binding: Readonly<TaskBinding>,
    terminal: DetailedTask,
  ): Promise<void>;
  blocked(
    binding: Readonly<TaskBinding>,
    task: Extract<DetailedTask, { status: "input_required" }>,
  ): void | Promise<void>;
  unavailable?(binding: Readonly<TaskBinding>): void;
  requestTimeoutMs?: number;
  maxBackoffMs?: number;
  /** 可注入时钟等待以便宿主调度和测试。 */
  sleep?(milliseconds: number): Promise<void>;
}

type Observation = {
  binding: Readonly<TaskBinding>;
  interval: number;
  failures: number;
  terminal?: DetailedTask;
  snapshot?: DetailedTask;
  queryPending?: boolean;
  delivered: boolean;
  inFlight?: Promise<"working" | "blocked" | "delivered" | "unavailable">;
};

const bindingKey = (binding: TaskBinding) =>
  JSON.stringify([
    binding.endpoint,
    binding.authorizationContext,
    binding.remoteTaskId,
    binding.initiatorContext,
  ]);

/** 进程内轻量观察器；不重放 tools/call，不负责 inbox 或跨重启去重。 */
export class TaskPoller {
  readonly #observations = new Map<string, Observation>();
  readonly #queries = new Set<string>();
  constructor(private readonly options: TaskPollerOptions) {
    for (const value of [options.requestTimeoutMs, options.maxBackoffMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new TaskError(-32602, "Invalid polling limits");
    }
  }

  register(binding: TaskBinding, handle: CreateTaskResult): void {
    if (
      !CreateTaskResultV2Schema.safeParse(handle).success ||
      !matchesTaskSchema("CreateTaskResult", handle)
    )
      throw new TaskError(-32602, "Invalid task handle");
    if (
      !binding.endpoint ||
      !binding.authorizationContext ||
      !binding.initiatorContext ||
      binding.remoteTaskId !== handle.taskId
    )
      throw new TaskError(-32602, "Invalid task binding");
    const key = bindingKey(binding);
    if (!this.#observations.has(key))
      this.#observations.set(key, {
        binding: Object.freeze(structuredClone(binding)),
        interval: this.#interval(handle.pollIntervalMs),
        failures: 0,
        delivered: false,
      });
  }

  #interval(value: number | undefined): number {
    return value !== undefined && Number.isSafeInteger(value) && value > 0
      ? value
      : 2000;
  }

  #observation(binding: TaskBinding): Observation {
    const entry = this.#observations.get(bindingKey(binding));
    if (!entry) throw new TaskError(-32602, "Unknown task binding");
    return entry;
  }

  poll(
    binding: TaskBinding,
    signal?: AbortSignal,
  ): Promise<"working" | "blocked" | "delivered" | "unavailable"> {
    const entry = this.#observation(binding);
    if (!entry.inFlight)
      entry.inFlight = this.#poll(entry, signal).finally(() => {
        entry.inFlight = undefined;
      });
    return entry.inFlight;
  }

  async #poll(
    entry: Observation,
    signal?: AbortSignal,
  ): Promise<"working" | "blocked" | "delivered" | "unavailable"> {
    if (signal?.aborted) return "unavailable";
    if (entry.delivered) return "delivered";
    const remoteKey = JSON.stringify([
      entry.binding.endpoint,
      entry.binding.authorizationContext,
      entry.binding.remoteTaskId,
    ]);
    if (!entry.terminal && (entry.queryPending || this.#queries.has(remoteKey)))
      return "unavailable";
    if (!entry.terminal) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      entry.queryPending = true;
      this.#queries.add(remoteKey);
      const query = Promise.resolve()
        .then(() => this.options.get(entry.binding, controller.signal))
        .finally(() => {
          entry.queryPending = false;
          this.#queries.delete(remoteKey);
        });
      try {
        const raw = await Promise.race([
          query,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error("Task query timed out"));
            }, this.options.requestTimeoutMs ?? 5000);
          }),
        ]);
        if (!matchesTaskSchema("GetTaskResult", raw))
          throw new Error("Invalid task query result");
        const task = DetailedTaskV2Schema.parse(raw);
        if (task.taskId !== entry.binding.remoteTaskId)
          throw new Error("Task identity mismatch");
        entry.snapshot = structuredClone(task);
        entry.interval = this.#interval(task.pollIntervalMs);
        entry.failures = 0;
        if (task.status === "input_required") {
          if (signal?.aborted) return "unavailable";
          await this.options.blocked(entry.binding, structuredClone(task));
          return "blocked";
        }
        if (task.status === "working") return "working";
        entry.terminal = structuredClone(task);
      } catch {
        entry.failures = Math.min(entry.failures + 1, 16);
        this.options.unavailable?.(entry.binding);
        return "unavailable";
      } finally {
        clearTimeout(timeout);
      }
    }
    if (signal?.aborted) return "unavailable";
    try {
      await this.options.deliver(
        entry.binding,
        structuredClone(entry.terminal),
      );
      entry.delivered = true;
      entry.failures = 0;
      return "delivered";
    } catch {
      entry.failures = Math.min(entry.failures + 1, 16);
      return "unavailable";
    }
  }

  /** 登记后立即读取；每个绑定最多一个查询；signal 只停止本地观察。 */
  async observe(
    binding: TaskBinding,
    signal: AbortSignal,
  ): Promise<"blocked" | "delivered" | "stopped"> {
    const entry = this.#observation(binding);
    while (!signal.aborted) {
      const state = await this.poll(binding, signal);
      if (signal.aborted) return "stopped";
      if (state === "blocked" || state === "delivered") return state;
      const delay = entry.failures
        ? Math.min(
            entry.interval * 2 ** entry.failures,
            this.options.maxBackoffMs ?? 30000,
          )
        : entry.interval;
      if (this.options.sleep) await this.options.sleep(delay);
      else
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", stop);
            resolve();
          };
          const timer = setTimeout(stop, delay);
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
        });
    }
    return "stopped";
  }

  snapshot(binding: TaskBinding): DetailedTask | undefined {
    return structuredClone(this.#observation(binding).snapshot);
  }

  /** 宿主保存持久化去重后可释放本地绑定；不调用远端 cancel。 */
  forget(binding: TaskBinding): void {
    const entry = this.#observation(binding);
    if (entry.inFlight || entry.queryPending)
      throw new TaskError(-32602, "Task query in flight");
    this.#observations.delete(bindingKey(binding));
  }
}
