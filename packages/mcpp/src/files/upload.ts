import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { FileError } from "./errors.ts";
import { createUploadedFile, FileLease } from "./handle.ts";
import {
  isSafeSize,
  publicInfo,
  validName,
  type FileScope,
  type UploadedFileInfo,
} from "./protocol.ts";
import type { FileRecord, FileService } from "./service.ts";

function integer(value: string | null): number {
  if (
    value === null ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !isSafeSize(Number(value))
  )
    throw new FileError("INVALID_UPLOAD_REQUEST");
  return Number(value);
}

export function parseUploadMetadata(request: Request, maxBytes: number) {
  if (request.method !== "POST" || new URL(request.url).search)
    throw new FileError("INVALID_UPLOAD_REQUEST");
  if (request.headers.get("MCPP-Files-Version") !== "1")
    throw new FileError("UNSUPPORTED_FILES_VERSION");
  const encoding = request.headers.get("Content-Encoding");
  if (encoding && encoding.toLowerCase() !== "identity")
    throw new FileError("UNSUPPORTED_CONTENT_ENCODING");
  const size = integer(request.headers.get("MCPP-File-Size"));
  if (size > maxBytes) throw new FileError("FILE_TOO_LARGE");
  const length = request.headers.get("Content-Length");
  if (length !== null && integer(length) !== size)
    throw new FileError("FILE_SIZE_MISMATCH");
  let name: string;
  try {
    name = decodeURIComponent(request.headers.get("MCPP-File-Name") ?? "");
  } catch {
    throw new FileError("INVALID_UPLOAD_REQUEST");
  }
  if (!validName(name)) throw new FileError("INVALID_UPLOAD_REQUEST");
  const mimeType = (request.headers.get("Content-Type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (
    !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType) ||
    mimeType === "multipart/form-data"
  )
    throw new FileError("INVALID_UPLOAD_REQUEST");
  const sha256 = request.headers.get("MCPP-File-Sha256");
  if (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256))
    throw new FileError("INVALID_UPLOAD_REQUEST");
  return { size, name, mimeType, sha256 };
}

/** 返回的 Promise 代表实际 Disk 操作和输入均已结束，不代表 HTTP 等待期限。 */
export async function receiveUpload(
  service: FileService,
  request: Request,
  scope: FileScope,
  fileId: string,
  signal: AbortSignal,
  meta: ReturnType<typeof parseUploadMetadata>,
  publish: { committing(): void; committed(info: UploadedFileInfo): void },
): Promise<void> {
  const store = <T>(use: () => Promise<T>) => service.storage(signal, use);
  const payloadKey = service.key(fileId, "payload");
  const pendingKey = service.key(fileId, "pending.json");
  const pending = {
    schemaVersion: 2,
    state: "receiving",
    fileId,
    namespace: service.namespace,
    ownerScope: scope.key,
    payloadKey,
    createdAt: new Date(service.now()).toISOString(),
    deadline: service.now() + service.uploadTimeoutMs,
  };
  // FlyDrive 2.2.0 的 S3Driver 不转发 AWS send abortSignal，不能声称此写入可取消。
  await store(() =>
    service.disk.put(pendingKey, JSON.stringify(pending), {
      contentType: "application/json",
    }),
  );
  const reader = (
    request.body ??
    new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    })
  ).getReader();
  let cancellation: Promise<void> | undefined;
  const stopInput = () =>
    (cancellation ??= Promise.resolve()
      .then(() => reader.cancel())
      .catch(() => {}));
  const hash = createHash("sha256");
  let size = 0;
  let inputError: unknown;
  const input = Readable.from(
    (async function* () {
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > service.maxFileBytes)
            throw new FileError("FILE_TOO_LARGE");
          if (size > meta.size) throw new FileError("FILE_SIZE_MISMATCH");
          hash.update(chunk.value);
          yield chunk.value;
        }
        if (size !== meta.size) throw new FileError("FILE_SIZE_MISMATCH");
      } catch (error) {
        inputError = signal.aborted
          ? signal.reason
          : error instanceof FileError
            ? error
            : new FileError("INVALID_UPLOAD_REQUEST");
        // 结束输入而不 emit error：FlyDrive putStream 会因输入 error 提前 reject，
        // 但其内部 FS write/AWS send 可能仍未 settle，不能据此释放真实额度。
      } finally {
        await stopInput();
      }
    })(),
    { objectMode: false, highWaterMark: 65536 },
  );
  const abort = () => {
    void stopInput();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    // 同时提供 ContentLength: 0，绕过 FlyDrive contentLength 的 truthy 判断。
    try {
      await store(() =>
        service.disk.putStream(payloadKey, input, {
          contentLength: meta.size,
          ContentLength: meta.size,
          contentType: meta.mimeType,
          visibility: "private",
        }),
      );
    } catch (error) {
      throw inputError ?? error;
    }
    if (inputError) throw inputError;
    if (
      size !== meta.size ||
      (await store(() => service.disk.getMetaData(payloadKey)))
        .contentLength !== size
    )
      throw new FileError("FILE_SIZE_MISMATCH");
    const sha256 = hash.digest("hex");
    if (meta.sha256 !== null && sha256 !== meta.sha256)
      throw new FileError("FILE_DIGEST_MISMATCH");
    const info: UploadedFileInfo = {
      fileId,
      name: meta.name,
      mimeType: meta.mimeType,
      size,
      sha256,
      createdAt: new Date(service.now()).toISOString(),
      expiresAt: new Date(
        service.now() + service.ttlSeconds * 1000,
      ).toISOString(),
    };
    if (service.validateUpload) {
      const lease = new FileLease(signal, service.maxReadBytesPerCall);
      try {
        await service.validateUpload(
          createUploadedFile(service.disk, payloadKey, info, lease),
          { signal },
        );
        signal.throwIfAborted();
      } catch (error) {
        throw signal.aborted
          ? signal.reason
          : error instanceof FileError
            ? error
            : new FileError("FILE_REJECTED");
      } finally {
        await lease.close();
      }
    }
    signal.throwIfAborted();
    info.createdAt = new Date(service.now()).toISOString();
    info.expiresAt = new Date(
      service.now() + service.ttlSeconds * 1000,
    ).toISOString();
    const record: FileRecord = {
      ...info,
      schemaVersion: 2,
      namespace: service.namespace,
      ownerScope: scope.key,
      payloadKey,
    };
    const text = JSON.stringify(record);
    // ready 仅为候选对象。取消发生在此写入期间时，不会再启动持久确认。
    await store(() =>
      service.disk.put(service.key(fileId, "ready.json"), text, {
        contentType: "application/json",
      }),
    );
    signal.throwIfAborted();
    publish.committing();
    // 最后一个不可撤回操作：一旦发出，取消只能报告结果未知，不能再称为未提交。
    // 普通 pending + 迟到 ready 不依赖“补写 failed 成功”就能在重启后保守拒绝。
    await service.disk.put(
      pendingKey,
      JSON.stringify({
        ...pending,
        state: "committed",
        readySha256: createHash("sha256").update(text).digest("hex"),
      }),
      { contentType: "application/json" },
    );
    publish.committed(publicInfo(record));
    // 只做清理；失败、超时或重启后仍保留 committed 证据，不撤销已提交结果。
    try {
      await service.disk.delete(pendingKey);
    } catch {
      service.report();
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await stopInput();
    const closed = input.closed
      ? Promise.resolve()
      : new Promise<void>((resolve) => input.once("close", resolve));
    input.destroy();
    await closed;
    reader.releaseLock();
  }
}
