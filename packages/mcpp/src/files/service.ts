import { createHash, randomBytes } from "node:crypto";
import type { Disk } from "flydrive";
import { FileError, fileErrorResponse, storageError } from "./errors.ts";
import {
  createUploadedFile,
  FileLease,
  waitForFileOperation,
  type FileValidator,
  type UploadedFile,
  type ToolFileContext,
} from "./handle.ts";
import {
  FILE_ID,
  isSafeSize,
  validInfo,
  validateUploadPath,
  type FileScope,
  type FilesCapability,
  type UploadedFileInfo,
} from "./protocol.ts";
import { parseUploadMetadata, receiveUpload } from "./upload.ts";

export interface FileRecord extends UploadedFileInfo {
  schemaVersion: 2;
  namespace: string;
  ownerScope: string;
  payloadKey: string;
}

export interface FileServiceOptions {
  disk: Disk;
  namespace: string;
  uploadPath?: string;
  maxFileBytes?: number;
  ttlSeconds?: number;
  uploadTimeoutMs?: number;
  maxConcurrentUploads?: number;
  maxConcurrentUploadsPerScope?: number;
  cleanupIntervalMs?: number;
  orphanGraceMs?: number;
  maxReadBytesPerCall?: number;
  maxFilesPerCall?: number;
  validateUpload?: FileValidator;
  /** 仅接收安全错误码，不传递后端异常、key、scope 或凭据。 */
  onError?: (code: "FILE_STORAGE_UNAVAILABLE") => void;
  now?: () => number;
}

export interface FileReference {
  fileId: string;
  maxBytes?: number;
  parameter?: string;
  validator?: FileValidator;
}
interface ActiveUpload {
  scope: string;
  committed?: UploadedFileInfo;
  committing: boolean;
}

/** HTTP 等待可取消；实际任务、额度和 close 必须持续到后端真正 settle。 */
export class FileService {
  readonly disk: Disk;
  readonly namespace: string;
  readonly prefix: string;
  readonly maxFileBytes: number;
  readonly ttlSeconds: number;
  readonly uploadTimeoutMs: number;
  readonly orphanGraceMs: number;
  readonly maxReadBytesPerCall: number;
  readonly maxFilesPerCall: number;
  readonly ready: Promise<void>;
  readonly now: () => number;
  readonly validateUpload?: FileValidator;
  private readonly activeWrites = new Map<string, ActiveUpload>();
  private readonly controllers = new Set<AbortController>();
  private readonly scopeWrites = new Map<string, number>();
  private readonly references = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly leases = new Set<FileLease>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private readonly timer?: ReturnType<typeof setInterval>;
  private sweep?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;

  constructor(readonly options: FileServiceOptions) {
    if (!options.namespace.trim()) throw new Error("文件 namespace 必须非空");
    this.disk = options.disk;
    this.namespace = options.namespace;
    this.prefix = `uploads/${createHash("sha256").update(options.namespace).digest("hex")}/`;
    this.maxFileBytes = options.maxFileBytes ?? 128 * 1024 * 1024;
    this.ttlSeconds = options.ttlSeconds ?? 86400;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 600000;
    this.orphanGraceMs = options.orphanGraceMs ?? 3600000;
    this.maxReadBytesPerCall =
      options.maxReadBytesPerCall ?? this.maxFileBytes * 8;
    this.maxFilesPerCall = options.maxFilesPerCall ?? 64;
    this.now = options.now ?? Date.now;
    this.validateUpload = options.validateUpload;
    for (const value of [
      this.maxFileBytes,
      this.orphanGraceMs,
      this.maxReadBytesPerCall,
    ]) {
      if (!isSafeSize(value))
        throw new Error("文件字节数和宽限期必须为非负安全整数");
    }
    for (const value of [
      this.ttlSeconds,
      this.uploadTimeoutMs,
      this.maxFilesPerCall,
      options.maxConcurrentUploads ?? 16,
      options.maxConcurrentUploadsPerScope ?? 4,
    ]) {
      if (!isSafeSize(value) || value === 0)
        throw new Error("文件期限、并发和数量上限必须为正安全整数");
    }
    if (
      !Number.isSafeInteger(this.ttlSeconds * 1000) ||
      !Number.isFinite(new Date(this.now() + this.ttlSeconds * 1000).getTime())
    )
      throw new Error("文件 TTL 超出有效日期范围");
    const interval = options.cleanupIntervalMs ?? 3600000;
    if (!isSafeSize(interval)) throw new Error("清理周期不合法");
    if (options.uploadPath) validateUploadPath(options.uploadPath);
    this.ready = this.cleanup();
    void this.ready.catch(() => this.report());
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.cleanup().catch(() => this.report());
      }, interval);
      this.timer.unref();
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    const settled = () => this.operations.delete(operation);
    void operation.then(settled, settled);
    return operation;
  }

  /** 不 race 底层 Promise；每次返回后再检查取消，禁止启动后续存储操作。 */
  async storage<T>(
    signal: AbortSignal | undefined,
    use: () => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    try {
      const value = await this.track(use());
      signal?.throwIfAborted();
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  }

  report(): void {
    this.options.onError?.("FILE_STORAGE_UNAVAILABLE");
  }
  key(fileId: string, name: "pending.json" | "payload" | "ready.json"): string {
    return `${this.prefix}${fileId}/${name}`;
  }
  capability(uploadPath = this.options.uploadPath): FilesCapability {
    if (!uploadPath) throw new Error("需要上传路径");
    return {
      version: 1,
      uploadPath: validateUploadPath(uploadPath),
      maxFileBytes: this.maxFileBytes,
      defaultTtlSeconds: this.ttlSeconds,
    };
  }
  assertScope(scope: FileScope): void {
    if (!scope || typeof scope.key !== "string" || !scope.key.trim())
      throw new FileError("UNAUTHENTICATED");
  }

  async locked<T>(fileId: string, use: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(fileId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(use);
    this.locks.set(fileId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(fileId) === next) this.locks.delete(fileId);
    }
  }

  async readRecord(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<FileRecord | undefined> {
    const active = this.activeWrites.get(fileId);
    if (active && !active.committed) return;
    const read = <T>(use: () => Promise<T>) => this.storage(signal, use);
    const key = this.key(fileId, "ready.json");
    if (!(await read(() => this.disk.exists(key)))) return;
    if ((await read(() => this.disk.getMetaData(key))).contentLength > 16384)
      return;
    const text = await read(() => this.disk.get(key));
    let record: FileRecord;
    try {
      record = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (
      !validInfo(record) ||
      record.fileId !== fileId ||
      record.schemaVersion !== 2 ||
      record.namespace !== this.namespace ||
      typeof record.ownerScope !== "string" ||
      !record.ownerScope.trim() ||
      record.payloadKey !== this.key(fileId, "payload")
    )
      return;
    // 本进程已收到持久确认；pending 删除可能正并发完成，避免读到半途消失的清理记录。
    if (active?.committed) return record;
    const pendingKey = this.key(fileId, "pending.json");
    if (await read(() => this.disk.exists(pendingKey))) {
      if (
        (await read(() => this.disk.getMetaData(pendingKey))).contentLength >
        16384
      )
        return;
      let pending: {
        schemaVersion?: number;
        state?: string;
        fileId?: string;
        namespace?: string;
        readySha256?: string;
      } | null;
      try {
        pending = JSON.parse(await read(() => this.disk.get(pendingKey)));
      } catch (error) {
        if (error instanceof SyntaxError) return;
        throw error;
      }
      // 原始 pending + 迟到 ready 永不恢复发布；只有绑定该 ready 的持久确认才可见。
      if (
        !pending ||
        pending.schemaVersion !== 2 ||
        pending.state !== "committed" ||
        pending.fileId !== fileId ||
        pending.namespace !== this.namespace ||
        pending.readySha256 !== createHash("sha256").update(text).digest("hex")
      )
        return;
    }
    return record;
  }

  async handleUpload(
    request: Request,
    { scope }: { scope: FileScope },
  ): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort(new FileError("FILE_CANCELLED"));
    const timeout = setTimeout(
      () => controller.abort(new FileError("UPLOAD_TIMEOUT")),
      this.uploadTimeoutMs,
    );
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    let fileId: string | undefined;
    let active: ActiveUpload | undefined;
    let bodyCancellation: Promise<void> | undefined;
    const stopBody = (): Promise<void> => {
      if (bodyCancellation) return bodyCancellation;
      // 已取得 reader 时由 receiveUpload 的 finally 负责；未取得时由 worker 持有取消完成。
      if (!request.body || request.bodyUsed || request.body.locked)
        return Promise.resolve();
      // 先保存 Promise，再调用可能同步重入取消流程的底层 cancel。
      bodyCancellation = Promise.resolve()
        .then(() => request.body!.cancel())
        .catch(() => {});
      return bodyCancellation;
    };
    try {
      this.assertScope(scope);
      if (this.closed) throw new FileError("FILE_STORAGE_UNAVAILABLE");
      controller.signal.throwIfAborted();
      const meta = parseUploadMetadata(request, this.maxFileBytes);
      if (
        this.activeWrites.size >= (this.options.maxConcurrentUploads ?? 16) ||
        (this.scopeWrites.get(scope.key) ?? 0) >=
          (this.options.maxConcurrentUploadsPerScope ?? 4)
      )
        throw new FileError("UPLOAD_LIMIT_REACHED");
      fileId = `f_${randomBytes(16).toString("base64url")}`;
      active = { scope: scope.key, committing: false };
      this.activeWrites.set(fileId, active);
      this.scopeWrites.set(
        scope.key,
        (this.scopeWrites.get(scope.key) ?? 0) + 1,
      );
      this.controllers.add(controller);
      const id = fileId;
      const state = active;
      let publish!: (info: UploadedFileInfo) => void;
      let fail!: (error: unknown) => void;
      const receipt = new Promise<UploadedFileInfo>((resolve, reject) => {
        publish = resolve;
        fail = reject;
      });
      const worker = this.track(
        (async () => {
          try {
            await this.storage(controller.signal, () => this.ready);
            for (const name of [
              "pending.json",
              "ready.json",
              "payload",
            ] as const) {
              if (
                await this.storage(controller.signal, () =>
                  this.disk.exists(this.key(id, name)),
                )
              )
                throw new FileError("FILE_STORAGE_UNAVAILABLE");
            }
            await receiveUpload(
              this,
              request,
              scope,
              id,
              controller.signal,
              meta,
              {
                committing: () => {
                  state.committing = true;
                },
                committed: (info) => {
                  state.committed = info;
                  publish(info);
                },
              },
            );
          } catch (error) {
            if (!(error instanceof FileError)) this.report();
            fail(
              state.committing && !state.committed
                ? new FileError("UPLOAD_RESULT_UNKNOWN")
                : error,
            );
          } finally {
            // HTTP 已返回也不能归还额度，直到未取得 reader 的异步输入取消真正结束。
            await stopBody();
            this.controllers.delete(controller);
            this.activeWrites.delete(id);
            const count = (this.scopeWrites.get(scope.key) ?? 1) - 1;
            if (count) this.scopeWrites.set(scope.key, count);
            else this.scopeWrites.delete(scope.key);
          }
        })(),
      );
      // receipt 负责 HTTP 结果；worker（包含未结束存储/输入/清理）独立持有额度。
      void worker;
      const info = await waitForFileOperation(receipt, controller.signal, () =>
        state.committing
          ? new FileError("UPLOAD_RESULT_UNKNOWN")
          : controller.signal.reason,
      );
      return Response.json(info, {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (active?.committed)
        return Response.json(active.committed, {
          status: 201,
          headers: { "Cache-Control": "no-store" },
        });
      this.track(stopBody());
      return fileErrorResponse(error);
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
    }
  }

  async withFiles<T>(
    scope: FileScope,
    files: FileReference[],
    signal: AbortSignal,
    use: (files: ToolFileContext) => Promise<T>,
  ): Promise<T> {
    this.assertScope(scope);
    if (this.closed) throw new FileError("FILE_UNAVAILABLE");
    if (files.length > this.maxFilesPerCall)
      throw new FileError("FILE_TOO_LARGE");
    const cancelled = AbortSignal.any([signal, this.shutdown.signal]);
    const lease = new FileLease(cancelled, this.maxReadBytesPerCall);
    this.leases.add(lease);
    const worker = this.track(this.useFiles(scope, files, lease, use));
    return waitForFileOperation(worker, cancelled);
  }

  private async useFiles<T>(
    scope: FileScope,
    files: FileReference[],
    lease: FileLease,
    use: (files: ToolFileContext) => Promise<T>,
  ): Promise<T> {
    const acquired = new Map<string, UploadedFile>();
    const signal = lease.controller.signal;
    try {
      await this.storage(signal, () => this.ready);
      for (const ref of files) {
        lease.check();
        if (!FILE_ID.test(ref.fileId))
          throw new FileError("FILE_UNAVAILABLE", ref.parameter);
        try {
          if (!acquired.has(ref.fileId)) {
            // 队列中的 worker 仍被追踪，取消后的 callback 不会发起新的存储请求。
            await this.locked(ref.fileId, async () => {
              lease.check();
              const record = await this.readRecord(ref.fileId, signal);
              if (
                !record ||
                record.ownerScope !== scope.key ||
                Date.parse(record.expiresAt) <= this.now() ||
                !(await this.storage(signal, () =>
                  this.disk.exists(record.payloadKey),
                ))
              )
                throw new FileError("FILE_UNAVAILABLE");
              if (
                (
                  await this.storage(signal, () =>
                    this.disk.getMetaData(record.payloadKey),
                  )
                ).contentLength !== record.size ||
                Date.parse(record.expiresAt) <= this.now()
              )
                throw new FileError("FILE_UNAVAILABLE");
              lease.check();
              // 引用和句柄在同一同步段登记，取消不会在计数后、登记前泄漏引用。
              this.references.set(
                ref.fileId,
                (this.references.get(ref.fileId) ?? 0) + 1,
              );
              acquired.set(
                ref.fileId,
                createUploadedFile(this.disk, record.payloadKey, record, lease),
              );
            });
          }
          if (
            acquired.get(ref.fileId)!.info.size >
            Math.min(ref.maxBytes ?? this.maxFileBytes, this.maxFileBytes)
          )
            throw new FileError("FILE_TOO_LARGE");
        } catch (error) {
          lease.check();
          throw new FileError(storageError(error).code, ref.parameter);
        }
      }
      for (const ref of files) {
        lease.check();
        if (ref.validator) {
          try {
            await ref.validator(acquired.get(ref.fileId)!, { signal });
            lease.check();
          } catch (error) {
            lease.check();
            throw new FileError(
              error instanceof FileError ? error.code : "FILE_REJECTED",
              ref.parameter,
            );
          }
        }
      }
      lease.check();
      return await use({
        async require(fileId) {
          lease.check();
          const file = acquired.get(fileId);
          if (!file) throw new FileError("FILE_UNAVAILABLE");
          return file;
        },
      });
    } finally {
      try {
        await lease.close();
      } finally {
        this.leases.delete(lease);
        for (const fileId of acquired.keys()) {
          const count = (this.references.get(fileId) ?? 1) - 1;
          if (count) this.references.set(fileId, count);
          else this.references.delete(fileId);
        }
      }
    }
  }

  cleanup(): Promise<void> {
    if (this.sweep) return this.sweep;
    if (this.closed)
      return Promise.reject(new FileError("FILE_STORAGE_UNAVAILABLE"));
    this.sweep = this.track(
      this.scan().finally(() => {
        this.sweep = undefined;
      }),
    );
    return this.sweep;
  }

  private async scan(): Promise<void> {
    const groups = new Map<string, { newest: number; keys: string[] }>();
    let paginationToken: string | undefined;
    do {
      const page = await this.disk.listAll(this.prefix, {
        recursive: true,
        paginationToken,
      });
      for (const object of page.objects) {
        if (!object.isFile || !object.key.startsWith(this.prefix)) continue;
        const [id, name, extra] = object.key
          .slice(this.prefix.length)
          .split("/");
        if (
          !id ||
          !FILE_ID.test(id) ||
          extra ||
          !["pending.json", "ready.json", "payload"].includes(name ?? "")
        )
          continue;
        const group = groups.get(id) ?? { newest: 0, keys: [] };
        group.keys.push(object.key);
        group.newest = Math.max(
          group.newest,
          (await object.getMetaData()).lastModified.getTime(),
        );
        groups.set(id, group);
      }
      paginationToken = page.paginationToken;
    } while (paginationToken);
    for (const [id, group] of groups) {
      await this.locked(id, async () => {
        if (this.activeWrites.has(id) || this.references.has(id)) return;
        const record = await this.readRecord(id);
        if (record && Date.parse(record.expiresAt) > this.now()) {
          // 已确认的提交不因 pending 清理失败而撤销，启动也不能因此拒绝全部服务。
          if (group.keys.includes(this.key(id, "pending.json"))) {
            try {
              await this.disk.delete(this.key(id, "pending.json"));
            } catch {
              this.report();
            }
          }
          return;
        }
        if (
          !record &&
          this.now() < group.newest + this.uploadTimeoutMs + this.orphanGraceMs
        )
          return;
        for (const name of ["ready.json", "payload", "pending.json"] as const) {
          const key = this.key(id, name);
          if (await this.disk.exists(key)) await this.disk.delete(key);
        }
      });
    }
  }

  /** 不可取消的 Disk/业务操作可能使关闭持续等待；绝不把 HTTP 已返回当作已关闭。 */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.timer);
    this.shutdown.abort();
    for (const controller of this.controllers)
      controller.abort(new FileError("FILE_CANCELLED"));
    const closingLeases = [...this.leases].map((lease) => lease.close());
    this.closing = (async () => {
      const disposal = await Promise.allSettled(closingLeases);
      while (this.operations.size)
        await Promise.allSettled([...this.operations]);
      for (const result of disposal)
        if (result.status === "rejected") throw result.reason;
    })();
    return this.closing;
  }
}

export function createFileService(options: FileServiceOptions): FileService {
  return new FileService(options);
}
