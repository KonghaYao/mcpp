import {
  McpServer,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type Transport,
} from "@modelcontextprotocol/server";

export type ManagedTaskDispatcher = (
  message: JSONRPCMessage,
  extra?: MessageExtraInfo,
) => Promise<Record<string, unknown>> | undefined;

/** 仅接管显式注册的 Tasks 请求，其余报文原样交给 SDK。 */
class TasksTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];

  constructor(
    private readonly transport: Transport,
    private readonly dispatch: ManagedTaskDispatcher,
  ) {}

  get sessionId() {
    return this.transport.sessionId;
  }

  get hasPerRequestStream() {
    return this.transport.hasPerRequestStream;
  }

  setProtocolVersion(version: string) {
    this.transport.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]) {
    this.transport.setSupportedProtocolVersions?.(versions);
  }

  async start() {
    this.transport.onclose = () => this.onclose?.();
    this.transport.onerror = (error) => this.onerror?.(error);
    this.transport.onmessage = (message, extra) => {
      // SDK 依赖同一个调用栈判断 method-not-found；未接管请求不能跨 await。
      let response: ReturnType<ManagedTaskDispatcher>;
      try {
        response = this.dispatch(message, extra);
      } catch (error) {
        response = Promise.reject(error);
      }
      if (response === undefined) {
        this.onmessage?.(message, extra);
        return;
      }
      void this.receive(message, response).catch(() => {
        this.onerror?.(new Error("Tasks transport delivery failed"));
      });
    };
    await this.transport.start();
  }

  private async receive(
    message: JSONRPCMessage,
    response: Promise<Record<string, unknown>>,
  ) {
    let result: Record<string, unknown>;
    try {
      result = await response;
    } catch {
      result = { error: { code: -32603, message: "Task operation failed" } };
    }
    if (!("id" in message) || !("method" in message)) return;
    await this.transport.send(
      { jsonrpc: "2.0", id: message.id, ...result } as JSONRPCMessage,
      { relatedRequestId: message.id },
    );
  }

  send(...args: Parameters<Transport["send"]>) {
    return this.transport.send(...args);
  }

  close() {
    return this.transport.close();
  }
}

/** SDK 2.0 的窄兼容入口；只覆盖公开 connect，不触碰 SDK 私有实现。 */
export class TasksTransportServer extends McpServer {
  constructor(
    info: ConstructorParameters<typeof McpServer>[0],
    options: ConstructorParameters<typeof McpServer>[1],
    private readonly dispatchTasks: ManagedTaskDispatcher,
  ) {
    super(info, options);
  }

  override connect(transport: Transport): Promise<void> {
    return super.connect(new TasksTransport(transport, this.dispatchTasks));
  }
}
