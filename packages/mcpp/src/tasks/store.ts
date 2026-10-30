import { DetailedTaskV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { matchesTaskSchema } from "./schema.ts";
import { jsonBytes, TaskError } from "./errors.ts";
import type { TaskKey, TaskRecord, TaskScope, TaskStore } from "./types.ts";

/** 数组编码避免分隔符碰撞；不含 token 或会话标识。 */
export function taskKey(key: TaskKey): string {
  return JSON.stringify([key.namespace, key.owner, key.taskId]);
}

export function validateScope(scope: TaskScope): void {
  if (
    typeof scope.namespace !== "string" ||
    !scope.namespace ||
    typeof scope.owner !== "string" ||
    !scope.owner
  ) {
    throw new TaskError(-32602, "Invalid task scope");
  }
}

export function validateRecord(
  key: TaskKey,
  revision: number,
  record: TaskRecord,
): void {
  validateScope(key);
  if (
    !key.taskId ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    record.revision !== revision ||
    taskKey(record.key) !== taskKey(key) ||
    record.snapshot.taskId !== key.taskId ||
    !DetailedTaskV2Schema.safeParse(record.snapshot).success ||
    !matchesTaskSchema("DetailedTask", record.snapshot)
  ) {
    throw new TaskError(-32602, "Invalid task record");
  }
  jsonBytes(record);
}

export class MemoryTaskStore implements TaskStore {
  readonly #records = new Map<string, TaskRecord>();

  async create(record: TaskRecord): Promise<void> {
    validateRecord(record.key, 1, record);
    const id = taskKey(record.key);
    if (this.#records.has(id))
      throw new TaskError(-32602, "Task already exists");
    this.#records.set(id, structuredClone(record));
  }

  async get(key: TaskKey): Promise<TaskRecord | undefined> {
    const record = this.#records.get(taskKey(key));
    return record === undefined ? undefined : structuredClone(record);
  }

  async compareAndSet(
    key: TaskKey,
    expectedRevision: number,
    next: TaskRecord,
  ): Promise<"updated" | "conflict" | "not_found"> {
    validateRecord(key, expectedRevision + 1, next);
    const id = taskKey(key);
    const current = this.#records.get(id);
    if (!current) return "not_found";
    if (current.revision !== expectedRevision) return "conflict";
    this.#records.set(id, structuredClone(next));
    return "updated";
  }

  async delete(key: TaskKey, expectedRevision: number): Promise<boolean> {
    const id = taskKey(key);
    if (this.#records.get(id)?.revision !== expectedRevision) return false;
    return this.#records.delete(id);
  }
}
