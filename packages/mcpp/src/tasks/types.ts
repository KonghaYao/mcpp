import type { JsonValue } from "@modelcontextprotocol/ext-tasks/core";
import type {
  CallToolResultV2,
  CreateTaskResultV2,
  DetailedTaskV2,
  ErrorV2,
} from "@modelcontextprotocol/ext-tasks/core/v2";

export type { JsonValue };
export type CallToolResult = CallToolResultV2;
export type CreateTaskResult = CreateTaskResultV2;
export type DetailedTask = DetailedTaskV2;
export type JsonRpcError = ErrorV2;

export interface TaskScope {
  namespace: string;
  /** 可信宿主提供的授权分区，不得保存凭据。 */
  owner: string;
}

export interface TaskKey extends TaskScope {
  taskId: string;
}

export interface TaskRecord {
  key: TaskKey;
  revision: number;
  snapshot: DetailedTask;
  cancelRequestedAt?: string;
  businessRef?: JsonValue;
}

export interface TaskStore {
  create(record: TaskRecord): Promise<void>;
  get(key: TaskKey): Promise<TaskRecord | undefined>;
  compareAndSet(
    key: TaskKey,
    expectedRevision: number,
    next: TaskRecord,
  ): Promise<"updated" | "conflict" | "not_found">;
  delete(key: TaskKey, expectedRevision: number): Promise<boolean>;
}

export type TaskOutcome =
  | { kind: "result"; result: CallToolResult }
  | { kind: "error"; error: JsonRpcError }
  | { kind: "cancelled"; message?: string };

export interface ForegroundExecution {
  readonly outcome: Promise<TaskOutcome>;
  readonly signal: AbortSignal;
  /** 原执行已完成，包括其 finally 清理。 */
  readonly settled: boolean;
}

export interface TaskStartOptions {
  statusMessage?: string;
  businessRef?: JsonValue;
}

export interface TaskExecutionContext {
  key: TaskKey;
  signal: AbortSignal;
  report(message: string): Promise<void>;
  setBusinessRef(reference: JsonValue): Promise<void>;
}

export interface TaskLimits {
  maxActiveTasks: number;
  maxRecords: number;
  maxResultBytes: number;
  maxStoredBytes: number;
}

export interface TaskServiceOptions {
  namespace: string;
  store?: TaskStore;
  pollIntervalMs?: number;
  terminalRetentionMs?: number;
  limits?: Partial<TaskLimits>;
  onCancel?: (record: Readonly<TaskRecord>) => Promise<void>;
  /** 仅报告固定错误信息；不得在此记录业务数据或凭据。 */
  onExecutionError?: (error: Error) => void;
}
