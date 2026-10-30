import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Disk } from "flydrive";
import { FileError, storageError } from "./errors.ts";
import { isSafeSize, publicInfo, type UploadedFileInfo } from "./protocol.ts";

export interface UploadedFile {
  readonly info: Readonly<UploadedFileInfo>;
  open(): Promise<ReadableStream<Uint8Array>>;
  peek(maxBytes: number): Promise<Uint8Array>;
  bytes(options: { maxBytes: number }): Promise<Uint8Array>;
  withLocalPath<T>(use: (path: string) => Promise<T>): Promise<T>;
}

export type FileValidator = (
  file: UploadedFile,
  context: { signal: AbortSignal },
) => Promise<void>;
export interface ToolFileContext {
  require(fileId: string): Promise<UploadedFile>;
}

/** 只取消调用方的等待；operation 仍由服务追踪到真正 settle。 */
export function waitForFileOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  cancelled: () => unknown = () => new FileError("FILE_CANCELLED"),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    const finish = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error) => {
        finish();
        reject(signal.aborted ? cancelled() : error);
      },
    );
    if (signal.aborted) abort();
  });
}

/** 一次调用的读取预算、流和临时副本；取消等待不代表业务或存储已结束。 */
export class FileLease {
  readonly controller = new AbortController();
  readonly streams = new Set<Readable>();
  readonly temporary = new Set<string>();
  private used = 0;
  private closed = false;
  private readonly abort: () => void;
  private disposal?: Promise<void>;
  private readonly tasks = new Set<Promise<unknown>>();

  constructor(
    private readonly signal: AbortSignal,
    private readonly maxReadBytes: number,
  ) {
    this.abort = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  check(): void {
    if (this.closed || this.signal.aborted)
      throw new FileError("FILE_CANCELLED");
  }

  count(size: number): void {
    this.check();
    this.used += size;
    if (this.used > this.maxReadBytes) throw new FileError("FILE_TOO_LARGE");
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.tasks.add(operation);
    const settled = () => this.tasks.delete(operation);
    void operation.then(settled, settled);
    return operation;
  }

  close(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    this.controller.abort();
    for (const stream of this.streams) stream.destroy();
    const remove = () =>
      Promise.all(
        [...this.temporary].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    this.disposal = (async () => {
      // 先回收已创建副本，再等待取消前已启动的 getStream/mkdtemp/回调，防止迟到资源泄漏。
      const initial = await Promise.allSettled([remove()]);
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      await remove();
      if (initial[0]?.status === "rejected") throw initial[0].reason;
    })();
    return this.disposal;
  }
}

export function createUploadedFile(
  disk: Disk,
  payloadKey: string,
  info: UploadedFileInfo,
  lease: FileLease,
): UploadedFile {
  const frozenInfo = Object.freeze(publicInfo(info));
  async function open(): Promise<ReadableStream<Uint8Array>> {
    lease.check();
    return lease.track(openStream());
  }
  async function openStream(): Promise<ReadableStream<Uint8Array>> {
    lease.check();
    let source: Readable;
    try {
      source = await disk.getStream(payloadKey);
    } catch (error) {
      throw storageError(error);
    }
    // Node Readable 的错误可能早于消费者开始读取。
    source.on("error", () => {});
    lease.track(
      new Promise<void>((resolve) => {
        if (source.closed) resolve();
        else
          source.once("close", () => {
            lease.streams.delete(source);
            resolve();
          });
      }),
    );
    try {
      lease.check();
    } catch (error) {
      source.destroy();
      throw error;
    }
    lease.streams.add(source);
    const iterator = source[Symbol.asyncIterator]();
    let total = 0;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stop = () => {
      source.destroy();
      try {
        controller.error(new FileError("FILE_CANCELLED"));
      } catch {}
      finish();
    };
    const finish = () => {
      // 仍保留 Node stream 到 close 事件；EOF 不保证 autoDestroy，lease.close 必须能销毁它。
      lease.controller.signal.removeEventListener("abort", stop);
    };
    return new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
          lease.controller.signal.addEventListener("abort", stop, {
            once: true,
          });
        },
        async pull(c) {
          try {
            lease.check();
            const chunk = await iterator.next();
            lease.check();
            if (chunk.done) {
              if (total !== info.size) throw new FileError("FILE_UNAVAILABLE");
              finish();
              c.close();
              return;
            }
            const bytes = new Uint8Array(chunk.value);
            total += bytes.byteLength;
            if (total > info.size) throw new FileError("FILE_UNAVAILABLE");
            lease.count(bytes.byteLength);
            c.enqueue(bytes);
          } catch (error) {
            source.destroy();
            finish();
            c.error(storageError(error));
          }
        },
        async cancel() {
          source.destroy();
          finish();
        },
      },
      { highWaterMark: 0 },
    );
  }

  async function read(limit: number, partial: boolean): Promise<Uint8Array> {
    lease.check();
    if (!isSafeSize(limit)) throw new FileError("INVALID_UPLOAD_REQUEST");
    if (!partial && info.size > limit) throw new FileError("FILE_TOO_LARGE");
    if (partial && limit > 65536) throw new FileError("FILE_TOO_LARGE");
    if (limit === 0 && partial) return new Uint8Array();
    const reader = (await open()).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const data = partial
          ? chunk.value.subarray(0, limit - size)
          : chunk.value;
        size += data.byteLength;
        if (size > limit) throw new FileError("FILE_TOO_LARGE");
        chunks.push(data);
        if (partial && size === limit) break;
      }
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  async function withLocalPath<T>(
    use: (path: string) => Promise<T>,
  ): Promise<T> {
    lease.check();
    const directory = await mkdtemp(join(tmpdir(), "mcpp-file-"));
    lease.temporary.add(directory);
    const path = join(directory, "payload");
    try {
      lease.check();
      const stream = await open();
      await pipeline(
        Readable.fromWeb(stream as import("node:stream/web").ReadableStream),
        createWriteStream(path, { mode: 0o600, flags: "wx" }),
        { signal: lease.controller.signal },
      );
      lease.check();
      return await use(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
      lease.temporary.delete(directory);
    }
  }

  return Object.freeze({
    info: frozenInfo,
    open,
    peek: (maxBytes: number) => read(maxBytes, true),
    bytes: ({ maxBytes }: { maxBytes: number }) => read(maxBytes, false),
    withLocalPath<T>(use: (path: string) => Promise<T>): Promise<T> {
      lease.check();
      return lease.track(withLocalPath(use));
    },
  });
}
