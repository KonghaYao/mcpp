import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Disk } from "flydrive";
import { FSDriver } from "flydrive/drivers/fs";
import { createFileService, type FileServiceOptions } from "./service.ts";
import type { UploadedFileInfo } from "./protocol.ts";

const scope = { key: "verified" };
const id = "f_AAAAAAAAAAAAAAAAAAAAAA";
const signal = () => new AbortController().signal;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function request(bytes = new Uint8Array()) {
  return new Request("http://localhost/mcp-upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "MCPP-Files-Version": "1",
      "MCPP-File-Name": "a.bin",
      "MCPP-File-Size": String(bytes.length),
    },
    body: bytes,
  });
}
async function promptly<T>(operation: Promise<T>): Promise<T> {
  const timeout = gate();
  const timer = setTimeout(timeout.release, 150);
  try {
    return await Promise.race([
      operation,
      timeout.promise.then(() => {
        throw new Error("取消/截止未在 150ms 内完成");
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function stillPending(operation: Promise<unknown>) {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Bun.sleep(15);
  expect(settled).toBe(false);
}
const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
async function fsService(options: Partial<FileServiceOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mcpp-lifecycle-"));
  const disk = new Disk(
    new FSDriver({ location: directory, visibility: "private" }),
  );
  const settings = {
    disk,
    namespace: "lifecycle",
    cleanupIntervalMs: 0,
    uploadTimeoutMs: 30,
    orphanGraceMs: 100000,
    ...options,
  };
  const service = createFileService(settings);
  disposers.push(
    () => rm(directory, { recursive: true, force: true }),
    () => service.close(),
  );
  await service.ready;
  return { disk, service, settings };
}

describe("独立验证 F1：未决后端而非 HTTP 请求持有额度", () => {
  test("Check 7：limit=1 连续四请求只启动一个真实写入，close 等待 settle", async () => {
    const writing = gate();
    let outstanding = 0;
    let peak = 0;
    const disk = {
      listAll: async () => ({ objects: [] }),
      exists: async () => false,
      put: async () => {
        outstanding++;
        peak = Math.max(peak, outstanding);
        await writing.promise;
        outstanding--;
      },
    } as unknown as Disk;
    const service = createFileService({
      disk,
      namespace: "unsettled",
      cleanupIntervalMs: 0,
      uploadTimeoutMs: 15,
      maxConcurrentUploads: 1,
      maxConcurrentUploadsPerScope: 1,
    });
    try {
      await service.ready;
      const statuses = [];
      for (let index = 0; index < 4; index++)
        statuses.push(
          (await promptly(service.handleUpload(request(), { scope }))).status,
        );
      expect(statuses).toEqual([408, 429, 429, 429]);
      expect(outstanding).toBe(1);
      expect(peak).toBe(1);
      const closing = service.close();
      await stillPending(closing);
      expect(outstanding).toBe(1);
      writing.release();
      await closing;
      expect(outstanding).toBe(0);
    } finally {
      writing.release();
      await service.close();
    }
  });

  for (const stage of [
    "pending-timeout",
    "pending-error",
    "preflight-error",
    "reader-timeout",
  ] as const) {
    test(`R6 / ${stage}：异步输入取消结束前保留额度，且取消只启动一次`, async () => {
      const { service, disk } = await fsService({
        maxConcurrentUploads: 1,
        maxConcurrentUploadsPerScope: 1,
      });
      const storage = gate();
      const cancelling = gate();
      const cancelStarted = gate();
      let cancellationFinished = false;
      let cancelCalls = 0;
      let payloadWrites = 0;
      let blockedOperationFinished = false;
      const put = disk.put.bind(disk);
      const exists = disk.exists.bind(disk);
      const putStream = disk.putStream.bind(disk);
      disk.put = async (key, contents, options) => {
        if (
          !blockedOperationFinished &&
          stage.startsWith("pending") &&
          key.endsWith("pending.json")
        ) {
          await storage.promise;
          blockedOperationFinished = true;
          if (stage === "pending-error") throw new Error("pending 写入失败");
        }
        return put(key, contents, options);
      };
      disk.exists = async (key) => {
        if (!blockedOperationFinished && stage === "preflight-error") {
          await storage.promise;
          blockedOperationFinished = true;
          throw new Error("reader 前预检失败");
        }
        return exists(key);
      };
      disk.putStream = async (...args) => {
        payloadWrites++;
        return putStream(...args);
      };
      const abort = new AbortController();
      const body = new ReadableStream<Uint8Array>({
        async cancel() {
          cancelCalls++;
          cancelStarted.release();
          // 同步重入外部取消；缓存 Promise 必须先建立，不能重复调用底层 cancel。
          abort.abort();
          await cancelling.promise;
          cancellationFinished = true;
        },
      });
      try {
        const uploading = service.handleUpload(
          new Request(request(), { body, signal: abort.signal }),
          { scope },
        );
        if (stage.endsWith("error")) storage.release();
        const response = await promptly(uploading);
        expect(response.status).toBe(stage.endsWith("error") ? 503 : 408);
        await cancelStarted.promise;
        expect(cancelCalls).toBe(1);
        expect(cancellationFinished).toBe(false);
        storage.release();
        await Bun.sleep(15);
        if (stage !== "reader-timeout")
          expect(blockedOperationFinished).toBe(true);
        const writesBeforeRetry = payloadWrites;
        expect((await service.handleUpload(request(), { scope })).status).toBe(
          429,
        );
        expect(
          (await service.handleUpload(request(), { scope: { key: "other" } }))
            .status,
        ).toBe(429);
        expect(payloadWrites).toBe(writesBeforeRetry);
        expect(cancellationFinished).toBe(false);
        cancelling.release();
        // worker 清理 Node stream/reader 后应释放额度，而不依赖 close 来清空状态。
        let retry: Response | undefined;
        for (let attempt = 0; attempt < 20; attempt++) {
          retry = await service.handleUpload(request(), { scope });
          if (retry.status !== 429) break;
          await Bun.sleep(5);
        }
        expect(retry!.status).toBe(201);
        expect(cancellationFinished).toBe(true);
        expect(cancelCalls).toBe(1);
      } finally {
        storage.release();
        cancelling.release();
        await service.close();
      }
    });
  }

  test("R6：pending 先结束时 close 仍等待异步正文取消", async () => {
    const { service, disk } = await fsService({
      maxConcurrentUploads: 1,
      maxConcurrentUploadsPerScope: 1,
    });
    const storage = gate();
    const cancelling = gate();
    const cancelStarted = gate();
    const put = disk.put.bind(disk);
    disk.put = async (...args) => {
      await storage.promise;
      return put(...args);
    };
    const body = new ReadableStream<Uint8Array>({
      async cancel() {
        cancelStarted.release();
        await cancelling.promise;
      },
    });
    try {
      expect(
        (
          await promptly(
            service.handleUpload(new Request(request(), { body }), { scope }),
          )
        ).status,
      ).toBe(408);
      await cancelStarted.promise;
      storage.release();
      const closing = service.close();
      await stillPending(closing);
      cancelling.release();
      await closing;
    } finally {
      storage.release();
      cancelling.release();
      await service.close();
    }
  });

  test("per-scope 额度在超时后仍保留，其他 scope 只受全局额度约束", async () => {
    const writing = gate();
    let calls = 0;
    const disk = {
      listAll: async () => ({ objects: [] }),
      exists: async () => false,
      put: async () => {
        calls++;
        await writing.promise;
      },
    } as unknown as Disk;
    const service = createFileService({
      disk,
      namespace: "scope-limit",
      cleanupIntervalMs: 0,
      uploadTimeoutMs: 15,
      maxConcurrentUploads: 2,
      maxConcurrentUploadsPerScope: 1,
    });
    try {
      expect((await service.handleUpload(request(), { scope })).status).toBe(
        408,
      );
      expect((await service.handleUpload(request(), { scope })).status).toBe(
        429,
      );
      expect(
        (await service.handleUpload(request(), { scope: { key: "other" } }))
          .status,
      ).toBe(408);
      expect(
        (await service.handleUpload(request(), { scope: { key: "third" } }))
          .status,
      ).toBe(429);
      expect(calls).toBe(2);
    } finally {
      writing.release();
      await service.close();
    }
  });
});

describe("独立验证 F2：三个固定键的保守恢复", () => {
  test("Check 9：408 时 ready 尚不存在；failed 标记不可写；迟到 ready 在同进程与重启后都不可读", async () => {
    const { service, disk, settings } = await fsService();
    const writing = gate();
    const entered = gate();
    const put = disk.put.bind(disk);
    let fileId = "";
    let failedMarkerWrites = 0;
    disk.put = async (key, contents, options) => {
      if (key.endsWith("ready.json")) {
        fileId = key.split("/")[2]!;
        entered.release();
        await writing.promise;
        return put(key, contents);
      }
      if (key.endsWith("pending.json") && JSON.parse(String(contents)).failed) {
        failedMarkerWrites++;
        throw new Error("故障标记不可写");
      }
      return put(key, contents, options);
    };
    try {
      const uploading = service.handleUpload(request(new Uint8Array([7])), {
        scope,
      });
      await entered.promise;
      const response = await promptly(uploading);
      expect(response.status).toBe(408);
      expect(await disk.exists(service.key(fileId, "ready.json"))).toBe(false);
      const closing = service.close();
      await stillPending(closing);
      writing.release();
      await closing;
      expect(await disk.exists(service.key(fileId, "ready.json"))).toBe(true);
      expect(failedMarkerWrites).toBe(0); // 安全性不再依赖失败时补写任何标记。
      await expect(service.readRecord(fileId)).resolves.toBeUndefined();
      disk.put = put;
      const restarted = createFileService(settings);
      try {
        await restarted.ready;
        await expect(
          restarted.withFiles(scope, [{ fileId }], signal(), async () => {}),
        ).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
      } finally {
        await restarted.close();
      }
    } finally {
      writing.release();
      await service.close();
    }
  });

  test("真正确认成功后 pending 清理失败，201 与重启后的可读性不撤销", async () => {
    const { service, disk, settings } = await fsService({
      uploadTimeoutMs: 1000,
    });
    const remove = disk.delete.bind(disk);
    disk.delete = async (key) => {
      if (key.endsWith("pending.json")) throw new Error("清理失败");
      return remove(key);
    };
    const response = await service.handleUpload(request(new Uint8Array([7])), {
      scope,
    });
    expect(response.status).toBe(201);
    const info = (await response.json()) as UploadedFileInfo;
    await service.close();
    expect(
      JSON.parse(await disk.get(service.key(info.fileId, "pending.json")))
        .state,
    ).toBe("committed");
    const restarted = createFileService(settings);
    try {
      await restarted.ready;
      await restarted.withFiles(
        scope,
        [{ fileId: info.fileId }],
        signal(),
        async (files) => {
          expect(
            await (await files.require(info.fileId)).bytes({ maxBytes: 1 }),
          ).toEqual(new Uint8Array([7]));
        },
      );
    } finally {
      await restarted.close();
      disk.delete = remove;
    }
  });

  test("最终确认写入未决时只报告结果未知，close 等到确认和清理结束", async () => {
    const { service, disk, settings } = await fsService();
    const writing = gate();
    const entered = gate();
    const put = disk.put.bind(disk);
    let fileId = "";
    disk.put = async (key, contents, options) => {
      if (
        key.endsWith("pending.json") &&
        JSON.parse(String(contents)).state === "committed"
      ) {
        fileId = key.split("/")[2]!;
        entered.release();
        await writing.promise;
      }
      return put(key, contents, options);
    };
    try {
      const uploading = service.handleUpload(request(new Uint8Array([7])), {
        scope,
      });
      await entered.promise;
      const response = await promptly(uploading);
      expect(response.status).toBe(503);
      expect(((await response.json()) as any).error.code).toBe(
        "UPLOAD_RESULT_UNKNOWN",
      );
      const closing = service.close();
      await stillPending(closing);
      writing.release();
      await closing;
      const restarted = createFileService(settings);
      try {
        await restarted.ready;
        expect((await restarted.readRecord(fileId))?.size).toBe(1);
      } finally {
        await restarted.close();
      }
    } finally {
      writing.release();
      await service.close();
    }
  });
});

describe("独立验证 F3：启动、HEAD、锁队列、元数据取消", () => {
  for (const stage of ["startup", "exists"] as const)
    test(`Check 6 / ${stage}：25ms 截止不等待后端释放，close 仍等待`, async () => {
      const waiting = gate();
      let calls = 0;
      const disk = {
        listAll: async () => {
          if (stage === "startup") await waiting.promise;
          return { objects: [] };
        },
        exists: async () => {
          calls++;
          await waiting.promise;
          return false;
        },
      } as unknown as Disk;
      const service = createFileService({
        disk,
        namespace: stage,
        cleanupIntervalMs: 0,
        uploadTimeoutMs: 25,
        maxConcurrentUploads: 1,
      });
      try {
        const response = await promptly(
          service.handleUpload(request(), { scope }),
        );
        expect(response.status).toBe(408);
        expect((await service.handleUpload(request(), { scope })).status).toBe(
          429,
        );
        expect(calls).toBe(stage === "startup" ? 0 : 1);
        const closing = service.close();
        await stillPending(closing);
        waiting.release();
        await closing;
        expect(calls).toBe(stage === "startup" ? 0 : 1);
      } finally {
        waiting.release();
        await service.close();
      }
    });

  test("上传 payload metadata 阻塞同样按截止返回且保留额度，不发布 ready", async () => {
    const { service, disk } = await fsService({ maxConcurrentUploads: 1 });
    const waiting = gate();
    const entered = gate();
    const metadata = disk.getMetaData.bind(disk);
    disk.getMetaData = async (key) => {
      if (key.endsWith("payload")) {
        entered.release();
        await waiting.promise;
      }
      return metadata(key);
    };
    try {
      const uploading = service.handleUpload(request(new Uint8Array([7])), {
        scope,
      });
      await entered.promise;
      expect((await promptly(uploading)).status).toBe(408);
      expect((await service.handleUpload(request(), { scope })).status).toBe(
        429,
      );
      const closing = service.close();
      await stillPending(closing);
      waiting.release();
      await closing;
      const objects = [
        ...(await disk.listAll(service.prefix, { recursive: true })).objects,
      ];
      expect(
        objects.some(
          (object) => object.isFile && object.key.endsWith("ready.json"),
        ),
      ).toBe(false);
    } finally {
      waiting.release();
      await service.close();
    }
  });

  test("不协作业务回调已取消等待但 close 不假完成", async () => {
    const { service } = await fsService({ uploadTimeoutMs: 1000 });
    const info = (await (
      await service.handleUpload(request(new Uint8Array([7])), { scope })
    ).json()) as UploadedFileInfo;
    const waiting = gate();
    const entered = gate();
    const controller = new AbortController();
    const work = service.withFiles(
      scope,
      [{ fileId: info.fileId }],
      controller.signal,
      async () => {
        entered.release();
        await waiting.promise;
      },
    );
    try {
      await entered.promise;
      controller.abort();
      await expect(promptly(work)).rejects.toMatchObject({
        code: "FILE_CANCELLED",
      });
      const closing = service.close();
      await stillPending(closing);
      waiting.release();
      await closing;
    } finally {
      waiting.release();
      await service.close();
    }
  });

  test("getStream 未决和不协作业务回调在取消后仍被 close 追踪", async () => {
    const { service, disk } = await fsService({ uploadTimeoutMs: 1000 });
    const info = (await (
      await service.handleUpload(request(new Uint8Array([7])), { scope })
    ).json()) as UploadedFileInfo;
    const waiting = gate();
    const entered = gate();
    const getStream = disk.getStream.bind(disk);
    disk.getStream = async (...args) => {
      entered.release();
      await waiting.promise;
      return getStream(...args);
    };
    const controller = new AbortController();
    const work = service.withFiles(
      scope,
      [{ fileId: info.fileId }],
      controller.signal,
      async (files) => {
        await (await files.require(info.fileId)).open();
      },
    );
    try {
      await entered.promise;
      controller.abort();
      await expect(promptly(work)).rejects.toMatchObject({
        code: "FILE_CANCELLED",
      });
      const closing = service.close();
      await stillPending(closing);
      waiting.release();
      await closing;
    } finally {
      waiting.release();
      await service.close();
    }
  });

  test("已成功提交后 pending 删除阻塞：HTTP 201 不等待，但 close 等待真实删除", async () => {
    const { service, disk } = await fsService({ uploadTimeoutMs: 25 });
    const waiting = gate();
    const remove = disk.delete.bind(disk);
    disk.delete = async (key) => {
      if (key.endsWith("pending.json")) await waiting.promise;
      return remove(key);
    };
    try {
      const response = await promptly(
        service.handleUpload(request(new Uint8Array([7])), { scope }),
      );
      expect(response.status).toBe(201);
      const info = (await response.json()) as UploadedFileInfo;
      expect((await service.readRecord(info.fileId))?.size).toBe(1);
      const closing = service.close();
      await stillPending(closing);
      waiting.release();
      await closing;
    } finally {
      waiting.release();
      await service.close();
    }
  });

  for (const stage of ["startup", "exists", "metadata", "queue"] as const)
    test(`Check 10 / ${stage}：取消立即返回，真实任务仍阻止 close`, async () => {
      const waiting = gate();
      const entered = gate();
      let calls = 0;
      let block = false;
      const { disk, service } = await fsService({ uploadTimeoutMs: 1000 });
      const uploaded = await service.handleUpload(
        request(new Uint8Array([7])),
        { scope },
      );
      const info = (await uploaded.json()) as UploadedFileInfo;
      await service.close();
      const list = disk.listAll.bind(disk);
      const exists = disk.exists.bind(disk);
      const metadata = disk.getMetaData.bind(disk);
      if (stage === "startup")
        disk.listAll = async (...args) => {
          entered.release();
          await waiting.promise;
          return list(...args);
        };
      const restarted = createFileService({
        disk,
        namespace: "lifecycle",
        cleanupIntervalMs: 0,
      });
      if (stage !== "startup") await restarted.ready;
      disk.exists = async (key) => {
        calls++;
        if (block && stage === "exists") {
          entered.release();
          await waiting.promise;
          return false;
        }
        return exists(key);
      };
      disk.getMetaData = async (key) => {
        if (block && stage === "metadata") {
          entered.release();
          await waiting.promise;
        }
        return metadata(key);
      };
      let queued: Promise<void> | undefined;
      if (stage === "queue")
        queued = restarted.locked(info.fileId, async () => {
          entered.release();
          await waiting.promise;
        });
      block = true;
      const controller = new AbortController();
      const work = restarted.withFiles(
        scope,
        [{ fileId: info.fileId }],
        controller.signal,
        async () => {
          throw new Error("取消后不得执行业务");
        },
      );
      try {
        await entered.promise;
        controller.abort();
        await expect(promptly(work)).rejects.toMatchObject({
          code: "FILE_CANCELLED",
        });
        const callsAtCancel = calls;
        const closing = restarted.close();
        await stillPending(closing);
        waiting.release();
        await queued;
        await closing;
        if (stage !== "startup") expect(calls).toBe(callsAtCancel);
      } finally {
        waiting.release();
        await queued;
        await restarted.close();
      }
    });
});
