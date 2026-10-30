import {
  CLIENT_CAPABILITIES_META_KEY,
  MissingRequiredClientCapabilityError,
  type CallToolResult,
  type McpServer,
  type ServerContext,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { FileError } from "./errors.ts";
import { markFileTool } from "./http.ts";
import {
  FILE_ID,
  isSafeSize,
  MCPP_FILES_EXTENSION,
  type FileScope,
} from "./protocol.ts";
import type { FileService, FileReference } from "./service.ts";
import type { FileValidator, ToolFileContext } from "./handle.ts";

type SchemaNode = Record<string, unknown>;
interface FileField {
  name: string;
  array: boolean;
  maxItems?: number;
  maxBytes?: number;
}

function fieldsFor(schema: SchemaNode): FileField[] {
  if (schema.type !== "object")
    throw new Error("文件工具必须使用顶层 object schema");
  const properties = (schema.properties ?? {}) as Record<string, SchemaNode>;
  const supported = new Set<unknown>();
  const fields: FileField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const array = property.type === "array";
    const marked = array
      ? (property.items as SchemaNode | undefined)
      : property;
    if (!marked || !("x-mcpp-file" in marked)) continue;
    const annotation = marked["x-mcpp-file"] as {
      maxBytes?: unknown;
      accept?: unknown;
    };
    if (
      marked.type !== "string" ||
      !annotation ||
      typeof annotation !== "object" ||
      Array.isArray(annotation)
    )
      throw new Error("x-mcpp-file 只能标记字符串");
    if (annotation.maxBytes !== undefined && !isSafeSize(annotation.maxBytes))
      throw new Error("文件 maxBytes 不合法");
    if (
      annotation.accept !== undefined &&
      (!Array.isArray(annotation.accept) ||
        annotation.accept.some((v) => typeof v !== "string"))
    )
      throw new Error("文件 accept 必须是字符串数组");
    if (array && !isSafeSize(property.maxItems))
      throw new Error("文件数组必须声明有限 maxItems");
    supported.add(marked);
    fields.push({
      name,
      array,
      maxItems: array ? (property.maxItems as number) : undefined,
      maxBytes: annotation.maxBytes as number | undefined,
    });
  }
  function walk(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if ("x-mcpp-file" in value && !supported.has(value))
      throw new Error("x-mcpp-file 位于 v1 不支持的位置");
    // 含标记的引用/分支无法唯一提取，注册时失败而非静默忽略。
    const node = value as SchemaNode;
    if (
      supported.has(value) &&
      ["$ref", "if", "then", "else", "oneOf", "anyOf", "allOf"].some(
        (key) => key in node,
      )
    )
      throw new Error("文件参数不支持引用或条件分支");
    for (const item of Object.values(node)) walk(item);
  }
  walk(schema);
  if (!fields.length) throw new Error("文件工具至少需要一个 x-mcpp-file 参数");
  return fields;
}

export interface FileToolOptions<S extends z.ZodObject> {
  definition: {
    name: string;
    title?: string;
    description: string;
    inputSchema: S;
    annotations?: ToolAnnotations;
  };
  validators?: Record<string, FileValidator>;
  /** 业务资源授权应在此或 handler 内完成；FileScope 不能替代业务授权。 */
  authorize?: (args: z.output<S>, context: ServerContext) => Promise<void>;
  handler: (
    args: z.output<S>,
    context: ServerContext & { files: ToolFileContext },
  ) => CallToolResult | Promise<CallToolResult>;
}

export function registerFileTool<S extends z.ZodObject>(
  server: McpServer,
  options: FileToolOptions<S>,
  binding: {
    fileService: FileService;
    scope:
      | FileScope
      | ((context: ServerContext) => FileScope | Promise<FileScope>);
  },
) {
  const { name, ...definition } = options.definition;
  const fields = fieldsFor(
    z.toJSONSchema(definition.inputSchema) as SchemaNode,
  );
  for (const key of Object.keys(options.validators ?? {})) {
    if (!fields.some((field) => field.name === key))
      throw new Error("validator 必须对应文件参数");
  }
  markFileTool(server, name);
  return server.registerTool<z.ZodObject, z.ZodObject>(
    name,
    { ...definition, inputSchema: definition.inputSchema as z.ZodObject },
    async (args, context) => {
      const envelope = context.mcpReq.envelope as
        | Record<string, unknown>
        | undefined;
      const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
        | { extensions?: Record<string, { version?: unknown }> }
        | undefined;
      if (capabilities?.extensions?.[MCPP_FILES_EXTENSION]?.version !== 1)
        throw new MissingRequiredClientCapabilityError({
          requiredCapabilities: {
            extensions: { [MCPP_FILES_EXTENSION]: { version: 1 } },
          },
        });
      try {
        const scope =
          typeof binding.scope === "function"
            ? await binding.scope(context)
            : binding.scope;
        await options.authorize?.(args as z.output<S>, context);
        const references: FileReference[] = [];
        for (const field of fields) {
          const value = (args as Record<string, unknown>)[field.name];
          if (value === undefined) continue;
          const ids = field.array ? value : [value];
          if (
            !Array.isArray(ids) ||
            (field.array && ids.length > field.maxItems!)
          )
            throw new FileError("FILE_REJECTED", field.name);
          for (const [index, id] of ids.entries()) {
            const parameter = field.array
              ? `${field.name}[${index}]`
              : field.name;
            if (typeof id !== "string" || !FILE_ID.test(id))
              throw new FileError("FILE_UNAVAILABLE", parameter);
            references.push({
              fileId: id,
              maxBytes: field.maxBytes,
              parameter,
              validator: options.validators?.[field.name],
            });
          }
        }
        return await binding.fileService.withFiles(
          scope,
          references,
          context.mcpReq.signal,
          async (files) =>
            options.handler(args as z.output<S>, { ...context, files }),
        );
      } catch (error) {
        const e =
          error instanceof FileError ? error : new FileError("FILE_REJECTED");
        return {
          isError: true,
          content: [{ type: "text", text: e.message }],
          structuredContent: {
            error: {
              code: e.code,
              parameter: e.parameter ?? null,
              retryable: e.retryable,
            },
          },
        };
      }
    },
  );
}
