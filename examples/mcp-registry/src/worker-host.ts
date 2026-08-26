type WorkerGlobal = {
  onmessage: ((event: MessageEvent<any>) => void | Promise<void>) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
};
const MAX_RESPONSE_BYTES = 1024 * 1024;
const workerGlobal = globalThis as unknown as WorkerGlobal;
let handler: ((request: Request) => Response | Promise<Response>) | undefined;

workerGlobal.onmessage = async ({ data }: MessageEvent<any>) => {
  if (data.type === "load") {
    try {
      const module = await import(data.entry);
      const candidate = module.fetch ?? module.default?.fetch ?? module.default;
      if (typeof candidate !== "function") throw new Error("Package must export fetch(Request)");
      handler = candidate;
      workerGlobal.postMessage({ type: "ready" });
    } catch (error) {
      workerGlobal.postMessage({ type: "load-error", error: error instanceof Error ? error.message : "WORKER_LOAD_FAILED" });
    }
    return;
  }
  if (data.type !== "request") return;
  try {
    if (!handler) throw new Error("WORKER_NOT_READY");
    const input = data.request;
    const response = await handler(new Request(input.url, { method: input.method, headers: input.headers, body: input.body }));
    if (!(response instanceof Response)) throw new Error("Worker fetch must return Response");
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RESPONSE_BYTES) throw new Error("WORKER_RESPONSE_TOO_LARGE");
    workerGlobal.postMessage({ id: data.id, response: { status: response.status, headers: [...response.headers.entries()], body } }, [body]);
  } catch (error) {
    workerGlobal.postMessage({ id: data.id, error: error instanceof Error ? error.message : "WORKER_FAILED" });
  }
};
