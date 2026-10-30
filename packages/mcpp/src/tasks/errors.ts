import { isJsonValue } from "@modelcontextprotocol/ext-tasks/core";
import type { JsonRpcError } from "./types.ts";

export class TaskError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

export function invalidTask(): TaskError {
  return new TaskError(-32602, "Unknown task");
}

export function internalTaskError(): TaskError {
  return new TaskError(-32603, "Task operation failed");
}

export function taskRpcError(error: unknown): JsonRpcError {
  if (!(error instanceof TaskError))
    return { code: -32603, message: "Task operation failed" };
  return {
    code: error.code,
    message: error.message,
    ...(error.data !== undefined && isJsonValue(error.data)
      ? { data: error.data }
      : {}),
  };
}

export function jsonBytes(value: unknown): number {
  if (!isJsonValue(value))
    throw new TaskError(-32602, "Expected serializable JSON");
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
