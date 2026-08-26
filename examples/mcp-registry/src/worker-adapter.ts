type SerializedRequest = { url: string; method: string; headers: [string, string][]; body?: ArrayBuffer };
type SerializedResponse = { status: number; headers: [string, string][]; body: ArrayBuffer };

type Pending = { resolve: (response: Response) => void; reject: (error: Error) => void; timer: Timer };

export class WorkerAdapter {
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private worker: Worker;
  private ready: Promise<void>;
  constructor(entry: string, timeoutMs = 15_000, private readonly onFatal?: (error: Error) => void) {
    const workerUrl = new URL("./worker-host.ts", import.meta.url);
    this.worker = new Worker(workerUrl.href, { type: "module", smol: true });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WORKER_LOAD_TIMEOUT")), timeoutMs);
      this.worker.onmessage = ({ data }: MessageEvent<{ type?: string; id?: number; response?: SerializedResponse; error?: string }>) => {
        if (data.type === "ready") { clearTimeout(timer); resolve(); return; }
        if (data.type === "load-error") { clearTimeout(timer); reject(new Error(data.error ?? "WORKER_LOAD_FAILED")); return; }
        if (typeof data.id !== "number") return;
        const pending = this.pending.get(data.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(data.id);
        if (data.error) pending.reject(new Error(data.error));
        else if (data.response) pending.resolve(new Response(data.response.body, { status: data.response.status, headers: data.response.headers }));
      };
    });
    this.worker.postMessage({ type: "load", entry });
    this.timeoutMs = timeoutMs;
  }
  private timeoutMs: number;
  async waitUntilReady() { await this.ready; }
  async fetch(request: Request) {
    await this.ready;
    const id = ++this.sequence;
    const body = request.body ? await request.arrayBuffer() : undefined;
    const payload: SerializedRequest = { url: request.url, method: request.method, headers: [...request.headers.entries()], body };
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("WORKER_TIMEOUT");
        this.pending.delete(id);
        reject(error);
        this.terminate();
        this.onFatal?.(error);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: "request", id, request: payload }, body ? [body] : []);
    });
  }
  terminate() {
    this.worker.terminate();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("WORKER_TERMINATED")); }
    this.pending.clear();
  }
}
