import {
  specTypeSchemas,
  type StandardSchemaV1Sync,
} from "@modelcontextprotocol/server";
import { TaskError } from "./errors.ts";
import { matchesTaskSchema } from "./schema.ts";

const valid = (schema: StandardSchemaV1Sync, value: unknown) =>
  !schema["~standard"].validate(value).issues;

/** 组合公开核心 schemas 的现代 envelope 字段，不调用 SDK 私有 era codec。 */
export function validateTaskRequest(
  params: Record<string, unknown>,
  tool: boolean,
): void {
  const meta = params._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new TaskError(-32602, "Invalid request metadata");
  const envelope = meta as Record<string, unknown>;
  if (
    envelope["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" ||
    !valid(specTypeSchemas.RequestMeta, meta) ||
    !valid(
      specTypeSchemas.ClientCapabilities,
      envelope["io.modelcontextprotocol/clientCapabilities"],
    ) ||
    (envelope["io.modelcontextprotocol/clientInfo"] !== undefined &&
      !valid(
        specTypeSchemas.Implementation,
        envelope["io.modelcontextprotocol/clientInfo"],
      )) ||
    (envelope["io.modelcontextprotocol/logLevel"] !== undefined &&
      !valid(
        specTypeSchemas.LoggingLevel,
        envelope["io.modelcontextprotocol/logLevel"],
      ))
  ) {
    throw new TaskError(-32602, "Invalid request metadata");
  }
  if (tool && !valid(specTypeSchemas.CallToolRequestParams, params))
    throw new TaskError(-32602, "Invalid tool parameters");
  if (
    params.inputResponses !== undefined &&
    !matchesTaskSchema("InputResponses", params.inputResponses)
  )
    throw new TaskError(-32602, "Invalid input responses");
  // Tier 1 不签发 MRTR requestState；普通工具仍交给 SDK 的 verifier，互不影响。
  if (params.requestState !== undefined)
    throw new TaskError(-32602, "Invalid or expired requestState", {
      reason: "invalid_request_state",
    });
}
