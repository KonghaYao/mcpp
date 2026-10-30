import type { z } from "zod";
import type {
  AuthInfo,
  JSONRPCMessage,
  McpRequestContext,
  McpServer,
} from "@modelcontextprotocol/server";
import {
  CallToolResultV2Schema,
  CancelTaskRequestV2Schema,
  GetTaskRequestV2Schema,
  TasksExtensionCapabilityV2Schema,
  UpdateTaskRequestV2Schema,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import { invalidTask, TaskError, taskRpcError } from "./errors.ts";
import { matchesTaskSchema } from "./schema.ts";
import { validateTaskRequest } from "./request.ts";
import { TaskService } from "./service.ts";
import {
  TasksTransportServer,
  type ManagedTaskDispatcher,
} from "./transport.ts";
import type {
  CallToolResult,
  ForegroundExecution,
  TaskExecutionContext,
  TaskOutcome,
  TaskScope,
  TaskStartOptions,
} from "./types.ts";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

export interface TaskRequestContext {
  method: string;
  request?: Request;
  /** 仅调用方已验证并显式传入的上下文；SDK 不会自动完成 OAuth 验证。 */
  authInfo?: AuthInfo;
}

export interface TasksServerOptions {
  service: TaskService;
  resolveScope(
    context: TaskRequestContext,
  ): TaskScope | undefined | Promise<TaskScope | undefined>;
  context?: McpRequestContext;
  serverOptions?: ConstructorParameters<typeof McpServer>[1];
}

export type { ForegroundExecution } from "./types.ts";

const promotion = Symbol("Task promotion");
export interface TaskPromotion {
  readonly [promotion]: ForegroundExecution;
}

export interface TaskForegroundContext {
  /** 仅 foreground 模式可调用，调用前已验证 Tasks 能力。 */
  start(
    execute: (signal: AbortSignal) => Promise<TaskOutcome>,
  ): ForegroundExecution;
  /** 仅接管本次 start 创建的执行，不能提交其他 owner 的句柄。 */
  promote(execution: ForegroundExecution): TaskPromotion;
}

export interface TaskToolConfig<T extends Record<string, unknown>> {
  title?: string;
  description?: string;
  inputSchema: z.ZodType<T>;
  outputSchema?: z.ZodType;
  annotations?: Parameters<McpServer["registerTool"]>[1]["annotations"];
  _meta?: Record<string, unknown>;
  /** 参数和资源授权在启动任务前完成；不得由客户端自行决定权限。 */
  authorize?(args: T, scope: TaskScope): void | Promise<void>;
  startOptions?: TaskStartOptions | ((args: T) => TaskStartOptions);
  /** 可选同步分支；未声明 Tasks 的客户端只有此分支可执行。 */
  mode?(args: T): "task" | "complete" | "foreground";
  complete?(
    args: T,
    scope: TaskScope,
    foreground: TaskForegroundContext,
  ): Promise<CallToolResult | TaskPromotion>;
}

type TaskTool = {
  call(
    args: unknown,
    scope: TaskScope,
    capable: boolean,
  ): Promise<Record<string, unknown>>;
};

function requestSupportsTasks(params: Record<string, unknown>): boolean {
  const meta = params._meta as Record<string, unknown> | undefined;
  const capabilities = meta?.["io.modelcontextprotocol/clientCapabilities"] as
    | Record<string, unknown>
    | undefined;
  const extensions = capabilities?.extensions as
    | Record<string, unknown>
    | undefined;
  return (
    !!extensions &&
    Object.hasOwn(extensions, TASKS_EXTENSION) &&
    TasksExtensionCapabilityV2Schema.safeParse(extensions[TASKS_EXTENSION])
      .success
  );
}

function requireTasks(capable: boolean) {
  if (!capable)
    throw new TaskError(-32021, "Tasks capability required", {
      requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
    });
}

/** 显式选择此 Server，普通注册与 startServer/createMcpHandler/serveStdio 不变。 */
export class TasksServer extends TasksTransportServer {
  readonly #tools = new Map<string, TaskTool>();
  readonly #tasks: TasksServerOptions;

  constructor(
    info: ConstructorParameters<typeof McpServer>[0],
    options: TasksServerOptions,
  ) {
    let dispatch: ManagedTaskDispatcher = () => undefined;
    const original = options.serverOptions;
    super(
      info,
      {
        ...original,
        capabilities: {
          ...original?.capabilities,
          extensions: {
            ...original?.capabilities?.extensions,
            [TASKS_EXTENSION]: {},
          },
        },
      },
      (message, extra) => dispatch(message, extra),
    );
    this.#tasks = options;
    dispatch = (message, extra) => {
      if (!("method" in message) || !("id" in message)) return;
      const { method, params } = message;
      const tool =
        method === "tools/call" && typeof params?.name === "string"
          ? this.#tools.get(params.name)
          : undefined;
      const taskMethod =
        method === "tasks/get" ||
        method === "tasks/update" ||
        method === "tasks/cancel";
      if (!tool && !taskMethod) return;
      return this.#dispatch(message, {
        method,
        request: extra?.request ?? options.context?.requestInfo,
        authInfo: extra?.authInfo ?? options.context?.authInfo,
      });
    };
  }

  registerTaskTool<T extends Record<string, unknown>>(
    name: string,
    config: TaskToolConfig<T>,
    execute: (args: T, context: TaskExecutionContext) => Promise<TaskOutcome>,
  ): void {
    if (this.#tools.has(name))
      throw new TaskError(-32602, "Task tool already registered");
    // 仅把定义交给 SDK 目录；执行在 transport 分流，避免句柄被 outputSchema 错判。
    super.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: config.outputSchema,
        annotations: config.annotations,
        _meta: config._meta,
      },
      async () => {
        throw new TaskError(-32603, "Task transport required");
      },
    );
    const validateResult = async (
      result: CallToolResult,
    ): Promise<CallToolResult> => {
      if (result.resultType !== "complete")
        throw new TaskError(
          -32603,
          "Tier 1 tool must return a complete result",
        );
      const parsed = CallToolResultV2Schema.safeParse(result);
      if (!parsed.success || parsed.data.resultType !== "complete")
        throw new TaskError(-32603, "Invalid final tool result");
      if (
        config.outputSchema &&
        !parsed.data.isError &&
        !(
          await config.outputSchema.safeParseAsync(
            parsed.data.structuredContent,
          )
        ).success
      )
        throw new TaskError(-32603, "Tool output validation failed");
      return parsed.data;
    };
    this.#tools.set(name, {
      call: async (rawArgs, scope, capable) => {
        const parsed = await config.inputSchema.safeParseAsync(rawArgs ?? {});
        if (!parsed.success)
          throw new TaskError(-32602, "Invalid tool arguments");
        await config.authorize?.(parsed.data, scope);
        const mode = config.mode?.(parsed.data) ?? "task";
        const startOptions =
          typeof config.startOptions === "function"
            ? config.startOptions(parsed.data)
            : (config.startOptions ?? {});
        if (mode === "complete" || mode === "foreground") {
          if (!config.complete)
            throw new TaskError(-32603, "Synchronous tool handler unavailable");
          if (mode === "foreground") requireTasks(capable);
          const executions = new Set<ForegroundExecution>();
          let accepting = true;
          const promotions = new Set<TaskPromotion>();
          const foreground: TaskForegroundContext = {
            start: (run) => {
              if (mode !== "foreground" || !accepting || executions.size)
                throw new TaskError(-32602, "Foreground execution unavailable");
              requireTasks(capable);
              const execution = this.#tasks.service.startForeground(run);
              executions.add(execution);
              return execution;
            },
            promote: (execution) => {
              if (!accepting || !executions.has(execution))
                throw new TaskError(-32602, "Unknown foreground execution");
              const value: TaskPromotion = { [promotion]: execution };
              promotions.add(value);
              return value;
            },
          };
          let transferred: ForegroundExecution | undefined;
          try {
            const result = await config.complete(
              parsed.data,
              scope,
              foreground,
            );
            if (promotions.has(result as TaskPromotion)) {
              const execution = (result as TaskPromotion)[promotion];
              const handle = await this.#tasks.service.promoteForeground(
                scope,
                startOptions,
                execution,
                async (outcome) =>
                  outcome.kind === "result"
                    ? {
                        kind: "result",
                        result: await validateResult(outcome.result),
                      }
                    : outcome,
              );
              transferred = execution;
              return handle;
            }
            const validated = await validateResult(result as CallToolResult);
            if ([...executions].some((execution) => !execution.settled))
              throw new TaskError(
                -32603,
                "Foreground execution must finish or be promoted",
              );
            return validated;
          } finally {
            accepting = false;
            await Promise.all(
              [...executions]
                .filter((execution) => execution !== transferred)
                .map((execution) =>
                  this.#tasks.service.discardForeground(execution),
                ),
            );
          }
        }
        requireTasks(capable);
        return await this.#tasks.service.start(
          scope,
          startOptions,
          async (context) => {
            const outcome = await execute(parsed.data, context);
            return outcome.kind === "result"
              ? { kind: "result", result: await validateResult(outcome.result) }
              : outcome;
          },
        );
      },
    });
  }

  async #dispatch(
    message: JSONRPCMessage,
    context: TaskRequestContext,
  ): Promise<Record<string, unknown>> {
    if (!("method" in message) || !("id" in message))
      throw new TaskError(-32602, "Invalid task request");
    const params = message.params ?? {};
    const method = message.method;
    const tool =
      method === "tools/call" && typeof params.name === "string"
        ? this.#tools.get(params.name)
        : undefined;
    const taskMethod =
      method === "tasks/get" ||
      method === "tasks/update" ||
      method === "tasks/cancel";
    try {
      validateTaskRequest(params, !!tool);
      const capable = requestSupportsTasks(params);
      if (taskMethod) requireTasks(capable);
      const scope = await this.#tasks.resolveScope(context);
      if (!scope || scope.namespace !== this.#tasks.service.namespace)
        throw invalidTask();
      if (tool)
        return { result: await tool.call(params.arguments, scope, capable) };
      const schema =
        method === "tasks/get"
          ? GetTaskRequestV2Schema
          : method === "tasks/cancel"
            ? CancelTaskRequestV2Schema
            : UpdateTaskRequestV2Schema;
      const parsed = schema.safeParse(message);
      if (
        !parsed.success ||
        !parsed.data.params.taskId ||
        !matchesTaskSchema(
          method === "tasks/get"
            ? "GetTaskRequest"
            : method === "tasks/cancel"
              ? "CancelTaskRequest"
              : "UpdateTaskRequest",
          message,
        )
      )
        throw new TaskError(-32602, "Invalid task parameters");
      const taskId = parsed.data.params.taskId;
      if (
        context.request &&
        (context.request.headers.get("Mcp-Method") !== method ||
          context.request.headers.get("Mcp-Name") !== taskId)
      )
        throw new TaskError(-32020, "Task routing headers mismatch");
      if (method === "tasks/get")
        return {
          result: {
            ...(await this.#tasks.service.get(scope, taskId)),
            resultType: "complete",
          },
        };
      if (method === "tasks/cancel")
        await this.#tasks.service.requestCancel(scope, taskId);
      else await this.#tasks.service.get(scope, taskId); // Tier 1 无待答 key；只验证并 ACK，不修改任务。
      return { result: { resultType: "complete" } };
    } catch (error) {
      return { error: taskRpcError(error) };
    }
  }
}

export function registerTaskTool<T extends Record<string, unknown>>(
  server: TasksServer,
  name: string,
  config: TaskToolConfig<T>,
  execute: (args: T, context: TaskExecutionContext) => Promise<TaskOutcome>,
): void {
  server.registerTaskTool(name, config, execute);
}
