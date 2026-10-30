import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Disk } from "flydrive";
import { FSDriver } from "flydrive/drivers/fs";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createGatewayRoutes } from "../gateway.ts";
import { createMcppServerFactory } from "../server/cache.ts";
import { startServer } from "../server/start.ts";
import { createFileClient, FileUploadError } from "./client.ts";
import {
  createFileService,
  FileService,
  type FileServiceOptions,
} from "./service.ts";
import { createFileMount, fileScopeFor } from "./http.ts";
import { FileError, FileValidationError } from "./errors.ts";
import { registerFileTool } from "./tool.ts";
import {
  FILE_ID,
  MCPP_FILES_EXTENSION,
  type UploadedFileInfo,
} from "./protocol.ts";
import type { UploadedFile } from "./handle.ts";

const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});
const scope = { key: "verified:workspace-a" };
const signal = () => new AbortController().signal;
const digest = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const annotation = { "x-mcpp-file": { maxBytes: 1024, accept: [".bin"] } };
const fileSchema = () => z.string().meta(annotation);
async function setup(options: Partial<FileServiceOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mcpp-files-test-"));
  const disk = new Disk(
    new FSDriver({ location: directory, visibility: "private" }),
  );
  const service = createFileService({
    disk,
    namespace: "tests",
    cleanupIntervalMs: 0,
    maxFileBytes: 1024,
    ...options,
  });
  disposers.push(
    () => rm(directory, { recursive: true, force: true }),
    () => service.close(),
  );
  await service.ready;
  return { directory, disk, service };
}
function uploadRequest(
  body: Uint8Array | ReadableStream<Uint8Array> = new Uint8Array([0, 255, 1]),
  extra: Record<string, string> = {},
  abort?: AbortSignal,
) {
  return new Request("http://localhost/mcp-upload", {
    method: "POST",
    signal: abort,
    headers: {
      "Content-Type": "application/octet-stream",
      "MCPP-Files-Version": "1",
      "MCPP-File-Name": encodeURIComponent("数据.bin"),
      "MCPP-File-Size": String(body instanceof Uint8Array ? body.length : 3),
      ...extra,
    },
    body,
  });
}
async function upload(
  service: FileService,
  data = new Uint8Array([0, 255, 1]),
) {
  const response = await service.handleUpload(uploadRequest(data), { scope });
  expect(response.status, await response.clone().text()).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as UploadedFileInfo;
}
function rpc(
  endpoint: string,
  method: string,
  params: Record<string, unknown> = {},
  extensions = true,
) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(params.name ? { "Mcp-Name": String(params.name) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: method,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "files-test",
            version: "1",
          },
          "io.modelcontextprotocol/clientCapabilities": extensions
            ? { extensions: { [MCPP_FILES_EXTENSION]: { version: 1 } } }
            : {},
        },
      },
    }),
  });
}
async function jsonRpc(
  fetcher: (request: Request) => Promise<Response>,
  method: string,
  params = {},
  extension = true,
) {
  return (await (
    await fetcher(rpc("http://localhost/mcp", method, params, extension))
  ).json()) as any;
}
function gatewayFor(service: FileService) {
  const files = createFileMount(service, {
    endpointPath: "/mcp",
    allowedOrigins: ["https://host.example"],
    resolveScope: (_request, _operation) => scope,
  });
  let executions = 0;
  const factory = createMcppServerFactory(
    { cacheVersion: "files-v1" },
    (request, cache) => {
      const server = new McpServer(
        { name: "files", version: "1" },
        { capabilities: cache.capabilities },
      );
      server.registerTool(
        "ordinary",
        { inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text", text: "ordinary" }] }),
      );
      for (const name of ["first", "second"])
        registerFileTool(
          server,
          {
            definition: {
              name,
              description: "读取已上传的二进制文件",
              inputSchema: z.object({ fileId: fileSchema() }),
            },
            async handler({ fileId }, context) {
              executions++;
              const file = await context.files.require(fileId);
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      Array.from(await file.bytes({ maxBytes: 1024 })),
                    ),
                  },
                ],
              };
            },
          },
          { fileService: service, scope: () => fileScopeFor(request) },
        );
      return server;
    },
  );
  const gateway = createGatewayRoutes([
    { path: "/mcp", createServer: factory, files },
  ]);
  disposers.push(() => gateway.close());
  return { gateway, files, factory, executions: () => executions };
}

describe("FlyDrive FS 与真实 JSON-RPC", () => {
  test("发现、注解、上传、两工具复用；普通工具无需扩展；缺失能力为核心错误", async () => {
    const { service } = await setup();
    const { gateway, executions } = gatewayFor(service);
    const discovered = await jsonRpc(gateway.fetch, "server/discover");
    expect(
      discovered.result.capabilities.extensions[MCPP_FILES_EXTENSION],
    ).toEqual(service.capability("/mcp-upload"));
    expect(
      discovered.result.capabilities.extensions["io.mcpp/server-cache-version"]
        .cacheVersion,
    ).toBe("files-v1");
    const listed = await jsonRpc(gateway.fetch, "tools/list");
    expect(
      listed.result.tools.find((tool: any) => tool.name === "first").inputSchema
        .properties.fileId["x-mcpp-file"],
    ).toEqual(annotation["x-mcpp-file"]);
    const info = await upload(service);
    expect(FILE_ID.test(info.fileId)).toBe(true);
    expect(info.sha256).toBe(digest(new Uint8Array([0, 255, 1])));
    expect(Object.keys(info).sort()).toEqual(
      [
        "fileId",
        "name",
        "mimeType",
        "size",
        "sha256",
        "createdAt",
        "expiresAt",
      ].sort(),
    );
    for (const name of ["first", "second"]) {
      const call = await jsonRpc(gateway.fetch, "tools/call", {
        name,
        arguments: { fileId: info.fileId },
      });
      expect(call.result.isError).toBeUndefined();
      expect(call.result.resultType).toBe("complete");
      expect(JSON.parse(call.result.content[0].text)).toEqual([0, 255, 1]);
    }
    expect(executions()).toBe(2);
    const missing = await jsonRpc(
      gateway.fetch,
      "tools/call",
      { name: "first", arguments: { fileId: info.fileId } },
      false,
    );
    expect(missing.error.code).toBe(-32021);
    expect(executions()).toBe(2);
    expect(
      (
        await jsonRpc(
          gateway.fetch,
          "tools/call",
          { name: "ordinary", arguments: {} },
          false,
        )
      ).result.content[0].text,
    ).toBe("ordinary");
  });

  test("真实监听端口经 client Blob 上传与 tools/call", async () => {
    const { service } = await setup();
    const { factory, files } = gatewayFor(service);
    const server = await startServer(factory, {
      mode: "http",
      host: "127.0.0.1",
      port: 0,
      files,
    });
    disposers.push(() => server.stop());
    const endpoint = server.url!;
    const client = createFileClient({
      endpoint,
      discover: async () =>
        ((await (await fetch(rpc(endpoint, "server/discover"))).json()) as any)
          .result,
    });
    const bytes = new Uint8Array([0, 255, 123, 128]);
    const info = await client.upload({
      name: "附件.bin",
      mimeType: "application/octet-stream",
      size: bytes.length,
      body: new Blob([bytes]),
      sha256: digest(bytes),
    });
    const called = (await (
      await fetch(
        rpc(endpoint, "tools/call", {
          name: "first",
          arguments: { fileId: info.fileId },
        }),
      )
    ).json()) as any;
    expect(called.result.isError).toBeUndefined();
    expect(JSON.parse(called.result.content[0].text)).toEqual(
      Array.from(bytes),
    );
  });

  test("stdio 不挂载文件能力且不启动额外 HTTP listener", async () => {
    const { service } = await setup();
    const files = createFileMount(service, {
      endpointPath: "/mcp",
      allowedOrigins: [],
      resolveScope: () => scope,
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new StdioServerTransport(input, output);
    const started = await startServer(
      () => new McpServer({ name: "stdio", version: "1" }),
      { mode: "stdio", transport, files },
    );
    disposers.push(() => started.stop());
    expect(started.url).toBeUndefined();
    const response = new Promise<string>((resolve) =>
      output.once("data", (data) => resolve(data.toString())),
    );
    input.write(
      (await rpc("http://localhost/mcp", "server/discover").text()) + "\n",
    );
    const payload = JSON.parse(await response);
    expect(
      payload.result.capabilities.extensions?.[MCPP_FILES_EXTENSION],
    ).toBeUndefined();
  });

  test("空文件、重启恢复、真实 Disk 直接读取，错误身份和 namespace 隔离", async () => {
    const { service, disk } = await setup();
    const info = await upload(service, new Uint8Array());
    expect(info.size).toBe(0);
    expect(info.sha256).toBe(digest(new Uint8Array()));
    await service.close();
    const restarted = createFileService({
      disk,
      namespace: "tests",
      cleanupIntervalMs: 0,
    });
    disposers.push(() => restarted.close());
    await restarted.withFiles(
      scope,
      [{ fileId: info.fileId }],
      signal(),
      async (files) => {
        expect(
          (await (await files.require(info.fileId)).bytes({ maxBytes: 0 }))
            .length,
        ).toBe(0);
      },
    );
    await expect(
      restarted.withFiles(
        { key: "other" },
        [{ fileId: info.fileId }],
        signal(),
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
    const other = createFileService({
      disk,
      namespace: "other-endpoint",
      cleanupIntervalMs: 0,
    });
    disposers.push(() => other.close());
    await expect(
      other.withFiles(
        scope,
        [{ fileId: info.fileId }],
        signal(),
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
    expect(await disk.getBytes(restarted.key(info.fileId, "payload"))).toEqual(
      new Uint8Array(),
    );
  });
});

describe("上传契约与失败清理", () => {
  for (const [headers, code, status] of [
    [{ "MCPP-Files-Version": "2" }, "UNSUPPORTED_FILES_VERSION", 400],
    [{ "MCPP-File-Size": "-1" }, "INVALID_UPLOAD_REQUEST", 400],
    [{ "MCPP-File-Size": "1025" }, "FILE_TOO_LARGE", 413],
    [{ "Content-Length": "1" }, "FILE_SIZE_MISMATCH", 422],
    [{ "MCPP-File-Name": "%2e%2e" }, "INVALID_UPLOAD_REQUEST", 400],
    [{ "MCPP-File-Name": "%252f.bin" }, "ok", 201],
    [{ "MCPP-File-Name": "%00.bin" }, "INVALID_UPLOAD_REQUEST", 400],
    [{ "Content-Encoding": "gzip" }, "UNSUPPORTED_CONTENT_ENCODING", 415],
    [{ "MCPP-File-Sha256": "a".repeat(64) }, "FILE_DIGEST_MISMATCH", 422],
    [{ "MCPP-File-Size": "2" }, "FILE_SIZE_MISMATCH", 422],
    [{ "MCPP-File-Size": "4" }, "FILE_SIZE_MISMATCH", 422],
  ] as const)
    test(`元数据 ${JSON.stringify(headers)} → ${code}`, async () => {
      const { service } = await setup();
      const response = await service.handleUpload(
        uploadRequest(undefined, headers),
        { scope },
      );
      expect(response.status).toBe(status);
      const body = (await response.json()) as any;
      if (code !== "ok") expect(body.error.code).toBe(code);
    });

  test("实际超限、断流和过期 pending 不发布 ready", async () => {
    const { service, disk } = await setup({
      maxFileBytes: 2,
      orphanGraceMs: 0,
      uploadTimeoutMs: 1,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    const response = await service.handleUpload(
      uploadRequest(stream, { "MCPP-File-Size": "2" }),
      { scope },
    );
    expect(["FILE_TOO_LARGE", "UPLOAD_TIMEOUT"]).toContain(
      ((await response.json()) as any).error.code,
    );
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("输入断开"));
      },
    });
    expect(
      (
        await service.handleUpload(
          uploadRequest(broken, { "MCPP-File-Size": "2" }),
          { scope },
        )
      ).status,
    ).not.toBe(201);
    await Bun.sleep(20);
    await service.cleanup();
    expect([
      ...(await disk.listAll(service.prefix, { recursive: true })).objects,
    ]).toHaveLength(0);
  });

  test("后端写失败与 ready 部分写失败不伪成功，可清理和重试删除", async () => {
    let now = Date.now();
    const { service, disk } = await setup({
      now: () => now,
      orphanGraceMs: 0,
      uploadTimeoutMs: 100,
    });
    const put = disk.put.bind(disk);
    disk.put = async (key, data, options) => {
      if (key.endsWith("ready.json")) {
        await put(key, "{", options);
        throw new Error("模拟存储故障");
      }
      return put(key, data, options);
    };
    expect(
      (await service.handleUpload(uploadRequest(), { scope })).status,
    ).toBe(503);
    const objects = [
      ...(await disk.listAll(service.prefix, { recursive: true })).objects,
    ];
    const id = objects.find((object) => object.isFile) as any;
    const fileId = id.key.split("/")[2];
    await expect(
      service.withFiles(scope, [{ fileId }], signal(), async () => {}),
    ).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
    now += 1000;
    const remove = disk.delete.bind(disk);
    disk.delete = async () => {
      throw new Error("删除失败");
    };
    await expect(service.cleanup()).rejects.toThrow();
    disk.delete = remove;
    await service.cleanup();
    expect([
      ...(await disk.listAll(service.prefix, { recursive: true })).objects,
    ]).toHaveLength(0);
    disk.put = put;
    disk.putStream = async () => {
      throw new Error("磁盘写失败");
    };
    expect(
      (await service.handleUpload(uploadRequest(), { scope })).status,
    ).toBe(503);
  });

  test("并发限制与上传超时、取消传播到输入流", async () => {
    const { service } = await setup({
      maxConcurrentUploads: 1,
      uploadTimeoutMs: 60,
    });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const first = service.handleUpload(uploadRequest(stream), { scope });
    await Bun.sleep(10);
    expect(
      (await service.handleUpload(uploadRequest(), { scope })).status,
    ).toBe(429);
    const response = await first;
    expect(response.status).toBe(408);
    expect(cancelled).toBe(true);
    const controller = new AbortController();
    const pending = service.handleUpload(
      uploadRequest(new ReadableStream(), {}, controller.signal),
      { scope },
    );
    await Bun.sleep(5);
    controller.abort();
    expect((await pending).status).not.toBe(201);
  });

  test("全服务与同 scope 并发分别生效，取消客户端仍不重发", async () => {
    const { service } = await setup({
      maxConcurrentUploads: 4,
      maxConcurrentUploadsPerScope: 1,
      uploadTimeoutMs: 1000,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.handleUpload(
      uploadRequest(new ReadableStream(), {}, firstController.signal),
      { scope },
    );
    await Bun.sleep(5);
    expect(
      (await service.handleUpload(uploadRequest(), { scope })).status,
    ).toBe(429);
    const second = service.handleUpload(
      uploadRequest(new ReadableStream(), {}, secondController.signal),
      { scope: { key: "verified:workspace-b" } },
    );
    await Bun.sleep(5);
    firstController.abort();
    secondController.abort();
    expect((await first).status).not.toBe(201);
    expect((await second).status).not.toBe(429);
    const controller = new AbortController();
    let count = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const client = createFileClient({
      endpoint: "http://localhost/mcp",
      discover: async () => ({
        capabilities: {
          extensions: {
            [MCPP_FILES_EXTENSION]: service.capability("/mcp-upload"),
          },
        },
      }),
      fetch: async (_url, init) => {
        count++;
        const pending = service.handleUpload(
          new Request("http://localhost/mcp-upload", init),
          { scope },
        );
        entered();
        return pending;
      },
    });
    const uploading = client.upload(
      {
        name: "a.bin",
        mimeType: "application/octet-stream",
        size: 3,
        body: new ReadableStream(),
      },
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    await expect(uploading).rejects.toBeInstanceOf(FileUploadError);
    expect(count).toBe(1);
  });
});

describe("生命周期与工具预检", () => {
  test("TTL 立即拒绝新调用，活动引用读取完成后才能清理", async () => {
    let now = Date.now();
    const { service, disk } = await setup({ ttlSeconds: 1, now: () => now });
    const info = await upload(service);
    let retained: UploadedFile | undefined;
    await service.withFiles(
      scope,
      [{ fileId: info.fileId }],
      signal(),
      async (files) => {
        retained = await files.require(info.fileId);
        now += 1001;
        await service.cleanup();
        expect(await disk.exists(service.key(info.fileId, "payload"))).toBe(
          true,
        );
        expect(await retained.bytes({ maxBytes: 3 })).toEqual(
          new Uint8Array([0, 255, 1]),
        );
        await expect(
          service.withFiles(
            scope,
            [{ fileId: info.fileId }],
            signal(),
            async () => {},
          ),
        ).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
      },
    );
    await expect(retained!.open()).rejects.toMatchObject({
      code: "FILE_CANCELLED",
    });
    await service.cleanup();
    expect(await disk.exists(service.key(info.fileId, "payload"))).toBe(false);
  });

  test("临时副本隔离、受限读取、require 白名单和取消清理", async () => {
    const { service } = await setup();
    const info = await upload(service);
    const other = await upload(service);
    let temporary = "";
    await service.withFiles(
      scope,
      [{ fileId: info.fileId }],
      signal(),
      async (files) => {
        const file = await files.require(info.fileId);
        await expect(files.require(other.fileId)).rejects.toMatchObject({
          code: "FILE_UNAVAILABLE",
        });
        await expect(file.bytes({ maxBytes: 2 })).rejects.toMatchObject({
          code: "FILE_TOO_LARGE",
        });
        await expect(file.peek(65537)).rejects.toMatchObject({
          code: "FILE_TOO_LARGE",
        });
        expect(await file.peek(1)).toEqual(new Uint8Array([0]));
        await file.withLocalPath(async (path) => {
          temporary = path;
          await writeFile(path, "modified");
        });
        await expect(access(temporary)).rejects.toThrow();
        expect(await file.bytes({ maxBytes: 3 })).toEqual(
          new Uint8Array([0, 255, 1]),
        );
      },
    );
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = service.withFiles(
      scope,
      [{ fileId: info.fileId }],
      controller.signal,
      async (files) => {
        const file = await files.require(info.fileId);
        return file.withLocalPath(async (path) => {
          temporary = path;
          entered();
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        });
      },
    );
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "FILE_CANCELLED" });
    // 请求取消立即返回；关闭等待协作回调和真实副本清理完成。
    await service.close();
    await expect(access(temporary)).rejects.toThrow();
  });

  test("多文件中途失败释放引用，累计读取预算生效", async () => {
    let now = Date.now();
    const { service, disk } = await setup({
      ttlSeconds: 1,
      now: () => now,
      maxReadBytesPerCall: 4,
    });
    const info = await upload(service);
    await expect(
      service.withFiles(
        scope,
        [{ fileId: info.fileId }, { fileId: "f_AAAAAAAAAAAAAAAAAAAAAA" }],
        signal(),
        async () => {
          throw new Error("不应执行");
        },
      ),
    ).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
    await expect(
      service.withFiles(
        scope,
        [{ fileId: info.fileId }],
        signal(),
        async (files) => {
          const file = await files.require(info.fileId);
          await file.bytes({ maxBytes: 3 });
          await file.bytes({ maxBytes: 3 });
        },
      ),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    now += 1001;
    await service.cleanup();
    expect(await disk.exists(service.key(info.fileId, "payload"))).toBe(false);
  });

  test("validator 拒绝伪 MIME，数组任一失败均不执行业务", async () => {
    const { service } = await setup();
    const info = await upload(service);
    const files = createFileMount(service, {
      endpointPath: "/mcp",
      allowedOrigins: [],
      resolveScope: () => scope,
    });
    let called = 0;
    const gateway = createGatewayRoutes([
      {
        path: "/mcp",
        files,
        createServer(request) {
          const server = new McpServer({ name: "validators", version: "1" });
          registerFileTool(
            server,
            {
              definition: {
                name: "parse",
                description: "校验内容后解析",
                inputSchema: z.object({
                  attachments: z.array(fileSchema()).max(2),
                }),
              },
              validators: {
                attachments: async (file) => {
                  const bytes = await file.peek(2);
                  if (bytes[0] !== 65) throw new FileValidationError();
                },
              },
              async handler() {
                called++;
                return { content: [] };
              },
            },
            { fileService: service, scope: () => fileScopeFor(request) },
          );
          return server;
        },
      },
    ]);
    disposers.push(() => gateway.close());
    const result = await jsonRpc(gateway.fetch, "tools/call", {
      name: "parse",
      arguments: { attachments: [info.fileId] },
    });
    expect(result.result.structuredContent.error).toMatchObject({
      code: "FILE_REJECTED",
      parameter: "attachments[0]",
    });
    expect(result.result.resultType).toBe("complete");
    expect(called).toBe(0);
    const unknown = await jsonRpc(gateway.fetch, "tools/call", {
      name: "parse",
      arguments: { attachments: [info.fileId, "f_AAAAAAAAAAAAAAAAAAAAAA"] },
    });
    expect(unknown.result.structuredContent.error.code).toBe(
      "FILE_UNAVAILABLE",
    );
    expect(called).toBe(0);
  });

  test("注册拒绝嵌套、无界数组与条件标记", async () => {
    const { service } = await setup();
    const server = new McpServer({ name: "invalid", version: "1" });
    for (const inputSchema of [
      z.object({ nested: z.object({ file: fileSchema() }) }),
      z.object({ files: z.array(fileSchema()) }),
      z.object({ file: z.union([fileSchema(), z.number()]) }),
    ]) {
      expect(() =>
        registerFileTool(
          server,
          {
            definition: {
              name: "invalid",
              description: "invalid",
              inputSchema,
            },
            async handler() {
              return { content: [] };
            },
          },
          { fileService: service, scope },
        ),
      ).toThrow();
    }
  });

  test("大文件按块流式写入，ready 提交前不可见，内存缓冲有界", async () => {
    const total = 16 * 1024 * 1024;
    const { service, disk } = await setup({ maxFileBytes: total });
    const originalPut = disk.put.bind(disk);
    const originalStream = disk.putStream.bind(disk);
    let generated = 0;
    let consumed = 0;
    let maxAhead = 0;
    let released!: () => void;
    let publishing!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      publishing = resolve;
    });
    let uploadingId = "";
    disk.put = async (key, data, options) => {
      if (key.endsWith("ready.json")) {
        uploadingId = key.split("/")[2]!;
        // 即使 ready 已有完整字节，写入确认完成前也不能获得句柄。
        await originalPut(key, data, options);
        publishing();
        await readyGate;
        return;
      }
      return originalPut(key, data, options);
    };
    disk.putStream = async (key, stream, options) => {
      const measured = Readable.from(
        (async function* () {
          for await (const chunk of stream) {
            consumed += chunk.length;
            maxAhead = Math.max(maxAhead, generated - consumed);
            yield chunk;
          }
        })(),
        { objectMode: false, highWaterMark: 65536 },
      );
      return originalStream(key, measured, options);
    };
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (generated === total) {
            controller.close();
            return;
          }
          const chunk = new Uint8Array(65536).fill(123);
          generated += chunk.length;
          maxAhead = Math.max(maxAhead, generated - consumed);
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const pending = service.handleUpload(
      uploadRequest(body, { "MCPP-File-Size": String(total) }),
      { scope },
    );
    await reached;
    await expect(
      service.withFiles(
        scope,
        [{ fileId: uploadingId }],
        signal(),
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
    released();
    const response = await pending;
    expect(response.status).toBe(201);
    const info = (await response.json()) as UploadedFileInfo;
    expect(info.size).toBe(total);
    expect(generated).toBe(total);
    expect(consumed).toBe(total);
    expect(maxAhead).toBeLessThanOrEqual(4 * 65536);
    expect(
      (await disk.getMetaData(service.key(info.fileId, "payload")))
        .contentLength,
    ).toBe(total);
  });

  test("未决后端写入不会与清理竞争，失败 ready 完整记录仍不可用", async () => {
    let now = Date.now();
    const { service, disk } = await setup({
      now: () => now,
      uploadTimeoutMs: 30,
      orphanGraceMs: 0,
    });
    const put = disk.put.bind(disk);
    let resolveWrite!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    let id = "";
    disk.put = async (key, data, options) => {
      if (key.endsWith("ready.json")) {
        id = key.split("/")[2]!;
        await gate;
        return put(key, data); // 模拟忽略取消的迟到后端。
      }
      return put(key, data, options);
    };
    const response = await service.handleUpload(uploadRequest(), { scope });
    expect(response.status).toBe(408);
    now += 1000;
    await service.cleanup();
    expect(await disk.exists(service.key(id, "payload"))).toBe(true);
    resolveWrite();
    await Bun.sleep(5);
    await expect(
      service.withFiles(scope, [{ fileId: id }], signal(), async () => {}),
    ).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
    await service.cleanup();
    expect(await disk.exists(service.key(id, "payload"))).toBe(false);
  });

  test("全局 validator 拒绝后不发布可用 ready，存储故障不伪装为不存在", async () => {
    const { service, disk } = await setup({
      validateUpload: async () => {
        throw new FileValidationError();
      },
    });
    expect(
      (await service.handleUpload(uploadRequest(), { scope })).status,
    ).toBe(422);
    const ids = [
      ...(await disk.listAll(service.prefix, { recursive: true })).objects,
    ]
      .filter((item) => item.isFile)
      .map((item: any) => item.key.split("/")[2]);
    await expect(
      service.withFiles(scope, [{ fileId: ids[0] }], signal(), async () => {}),
    ).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
    disk.exists = async () => {
      throw new Error("存储暂不可用");
    };
    await expect(
      service.withFiles(
        scope,
        [{ fileId: "f_AAAAAAAAAAAAAAAAAAAAAA" }],
        signal(),
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "FILE_STORAGE_UNAVAILABLE" });
  });
});

describe("路由授权与 CORS", () => {
  test("Origin 预检、Unicode 文件名、认证失败与共享稳定身份", async () => {
    const { service } = await setup();
    const operations: string[] = [];
    const files = createFileMount(service, {
      endpointPath: "/mcp",
      allowedOrigins: ["https://host.example"],
      allowCredentials: true,
      resolveScope(request, operation) {
        operations.push(operation);
        if (!request.headers.has("X-Test-Identity"))
          throw new FileError("UNAUTHENTICATED");
        return scope;
      },
    });
    const preflight = await files.fetchUpload(
      new Request("http://localhost/mcp-upload", {
        method: "OPTIONS",
        headers: {
          Origin: "https://host.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "content-type, mcpp-file-name, mcpp-file-size, mcpp-files-version, authorization",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://host.example",
    );
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
    expect(operations).toEqual([]);
    expect((await files.fetchUpload(uploadRequest())).status).toBe(401);
    expect(
      (
        await files.fetchUpload(
          uploadRequest(undefined, {
            Origin: "https://evil.example",
            "X-Test-Identity": "verified",
          }),
        )
      ).status,
    ).toBe(403);
    const response = await files.fetchUpload(
      uploadRequest(undefined, {
        Origin: "https://host.example",
        "X-Test-Identity": "verified",
      }),
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as any).name).toBe("数据.bin");
    const mcp = await files.fetchMcp(
      new Request("http://localhost/mcp", {
        headers: { "X-Test-Identity": "renewed" },
      }),
      async () => new Response("ok"),
    );
    expect(mcp.status).toBe(200);
    expect(operations).toEqual(["upload", "upload", "mcp"]);
  });

  test("上传与 MCP/Catalog/上传路由冲突，endpoint 和 namespace 约束", async () => {
    const { service } = await setup();
    const mount = (endpointPath: string, uploadPath?: string) =>
      createFileMount(service, {
        endpointPath,
        uploadPath,
        allowedOrigins: [],
        resolveScope: () => scope,
      });
    const createServer = () => new McpServer({ name: "route", version: "1" });
    expect(() =>
      createGatewayRoutes([
        { path: "/mcp", createServer, files: mount("/mcp", "/other/mcp") },
        { path: "/other/mcp", createServer },
      ]),
    ).toThrow();
    expect(() =>
      createGatewayRoutes(
        [{ path: "/mcp", createServer, files: mount("/mcp") }],
        { catalog: { path: "/mcp-upload" } },
      ),
    ).toThrow();
    expect(() =>
      createGatewayRoutes([
        { path: "/mcp", createServer, files: mount("/other/mcp") },
      ]),
    ).toThrow();
    expect(() =>
      createGatewayRoutes([
        { path: "/mcp", createServer, files: mount("/mcp") },
        { path: "/other/mcp", createServer, files: mount("/other/mcp") },
      ]),
    ).toThrow();
    const { gateway } = gatewayFor(service);
    expect(
      (
        await gateway.fetch(
          new Request("http://localhost/mcp-upload/", {
            method: "POST",
            body: "not-json",
          }),
        )
      ).status,
    ).toBe(404);
    expect((await gateway.fetch(uploadRequest())).status).toBe(201);
  });
});

describe("客户端结果与依赖边界", () => {
  test("响应丢失只发送一次 POST，重传独立 ID、不执行业务", async () => {
    const { service } = await setup();
    const { gateway, executions } = gatewayFor(service);
    let count = 0;
    const client = createFileClient({
      endpoint: "http://localhost/mcp",
      discover: async () => ({
        capabilities: {
          extensions: {
            [MCPP_FILES_EXTENSION]: service.capability("/mcp-upload"),
          },
        },
      }),
      fetch: (async (url: any, init: any) => {
        count++;
        await gateway.fetch(new Request(url, init));
        throw new TypeError("响应丢失");
      }) as NonNullable<import("./client.ts").FileClientOptions["fetch"]>,
    });
    await expect(
      client.upload({
        name: "a.bin",
        mimeType: "application/octet-stream",
        size: 3,
        body: new Uint8Array([0, 255, 1]),
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_RESULT_UNKNOWN",
      outcome: "unknown",
    });
    expect(count).toBe(1);
    const a = await upload(service);
    const b = await upload(service);
    expect(a.fileId).not.toBe(b.fileId);
    expect(executions()).toBe(0);
  });

  test("拒绝未知版本、跨 child 上传路径、远程 HTTP，禁重定向且不手工发送 Content-Length", async () => {
    let count = 0;
    const { service } = await setup();
    const discover = async () => ({
      capabilities: {
        extensions: {
          [MCPP_FILES_EXTENSION]: service.capability("/mcp-upload"),
        },
      },
    });
    const client = createFileClient({
      endpoint: "http://localhost/child/mcp",
      discover,
      fetch: (async () => {
        count++;
        return new Response();
      }) as NonNullable<import("./client.ts").FileClientOptions["fetch"]>,
    });
    await expect(
      client.upload({
        name: "a",
        mimeType: "text/plain",
        size: 0,
        body: new Blob(),
      }),
    ).rejects.toBeInstanceOf(FileUploadError);
    expect(count).toBe(0);
    expect(() =>
      createFileClient({ endpoint: "http://remote.example/mcp", discover }),
    ).toThrow();
    const helper = createFileClient({
      endpoint: "http://localhost/mcp",
      discover,
      headers: () => ({ "Content-Length": "99" }),
      fetch: (async (_url: any, init: any) => {
        expect(init.redirect).toBe("error");
        expect(init.headers.has("Content-Length")).toBe(false);
        return service.handleUpload(
          new Request("http://localhost/mcp-upload", init),
          { scope },
        );
      }) as NonNullable<import("./client.ts").FileClientOptions["fetch"]>,
    });
    expect(
      (
        await helper.upload({
          name: "空白.txt",
          mimeType: "text/plain",
          size: 0,
          body: new Blob(),
        })
      ).size,
    ).toBe(0);
  });

  test("client 浏览器 bundle 与未启用 files 的 gateway 不加载 Node/FlyDrive/AWS", async () => {
    for (const entry of [
      import.meta.dir + "/client.ts",
      import.meta.dir + "/../gateway.ts",
    ]) {
      const result = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        minify: false,
      });
      expect(result.success, JSON.stringify(result.logs)).toBe(true);
      const output = await result.outputs[0]!.text();
      expect(output).not.toMatch(
        /(?:from|require\()\s*["'](?:node:|flydrive|@aws-sdk)/,
      );
      expect(output).not.toContain("FSDriver");
      expect(output).not.toContain("S3Client");
    }
  });
});
