import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { Disk } from "flydrive";
import { S3Driver } from "flydrive/drivers/s3";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createFileService } from "./service.ts";
import { createFileClient } from "./client.ts";
import { createFileMount, fileScopeFor } from "./http.ts";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createGatewayRoutes } from "../gateway.ts";
import { registerFileTool } from "./tool.ts";
import { MCPP_FILES_EXTENSION } from "./protocol.ts";

/** 真实 FlyDrive S3Driver + AWS Command，模拟远端响应；不连接真实 S3，不使用凭据。 */
function s3Contract() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; modified: Date; contentType?: string }
  >();
  const commands: object[] = [];
  let failReady = false;
  let failHead = false;
  const client = new S3Client({ region: "us-east-1" });
  const send = async (command: any) => {
    commands.push(command);
    const { Key: key, Body: body, Prefix: prefix } = command.input;
    if (command instanceof PutObjectCommand) {
      if (failReady && key.endsWith("ready.json"))
        throw new Error("S3 提交失败");
      expect(command.input.ACL).toBeUndefined();
      let bytes: Uint8Array;
      if (typeof body === "string") bytes = new TextEncoder().encode(body);
      else if (body instanceof Uint8Array) bytes = body;
      else {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) chunks.push(new Uint8Array(chunk));
        bytes = Buffer.concat(chunks);
        if (command.input.ContentLength !== undefined)
          expect(bytes.length).toBe(command.input.ContentLength);
      }
      objects.set(key, {
        bytes,
        modified: new Date(),
        contentType: command.input.ContentType,
      });
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (command instanceof HeadObjectCommand) {
      if (failHead) throw new Error("S3 不可用");
      const object = objects.get(key);
      if (!object) throw { $metadata: { httpStatusCode: 404 } };
      return {
        $metadata: { httpStatusCode: 200 },
        ContentLength: object.bytes.length,
        LastModified: object.modified,
        ContentType: object.contentType,
        ETag: "contract-etag",
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(key);
      if (!object) throw { $metadata: { httpStatusCode: 404 } };
      const stream = Readable.from([object.bytes]);
      return {
        Body: Object.assign(stream, {
          transformToString: async () => new TextDecoder().decode(object.bytes),
          transformToByteArray: async () => object.bytes,
        }),
      };
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(key);
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      return {
        Contents: [...objects]
          .filter(([key]) => key.startsWith(prefix))
          .map(([Key, value]) => ({
            Key,
            Size: value.bytes.length,
            LastModified: value.modified,
            ETag: "contract-etag",
          })),
      };
    }
    throw new Error("契约未覆盖的 S3 command");
  };
  client.send = send as typeof client.send;
  return {
    disk: new Disk(
      new S3Driver({
        client,
        bucket: "mcpp-contract",
        supportsACL: false,
        visibility: "private",
      }),
    ),
    objects,
    commands,
    failReady: () => {
      failReady = true;
    },
    failHead: () => {
      failHead = true;
    },
    close: () => client.destroy(),
  };
}

describe("真实 S3Driver 的模拟服务契约（非真实 S3 实测）", () => {
  for (const phase of ["pending", "payload"] as const)
    test(`Check 8 / ${phase}：S3Driver 不支持 send 取消，真实 PUT settle 前额度和 close 均保留`, async () => {
      const client = new S3Client({ region: "us-east-1" });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let outstanding = 0;
      let peak = 0;
      const observations: Array<{
        abortSignal: boolean;
        inputSignal: boolean;
      }> = [];
      client.send = (async (command: any, options: any) => {
        if (command instanceof ListObjectsV2Command) return { Contents: [] };
        if (command instanceof HeadObjectCommand)
          throw { $metadata: { httpStatusCode: 404 } };
        if (!(command instanceof PutObjectCommand))
          throw new Error("意外 S3 command");
        const shouldBlock =
          phase === "pending"
            ? command.input.Key!.endsWith("pending.json")
            : command.input.Key!.endsWith("payload");
        observations.push({
          abortSignal: !!options?.abortSignal,
          inputSignal: "signal" in command.input,
        });
        if (!shouldBlock) return {};
        outstanding++;
        peak = Math.max(peak, outstanding);
        // payload 的输入会因取消而停止，但 send 不因此完成，不能提前释放并发。
        if (phase === "payload")
          for await (const _chunk of command.input.Body as Readable) {
            /* 正常消费有限请求体 */
          }
        await blocked;
        outstanding--;
        return {};
      }) as typeof client.send;
      const service = createFileService({
        disk: new Disk(
          new S3Driver({
            client,
            bucket: "abort-contract",
            supportsACL: false,
            visibility: "private",
          }),
        ),
        namespace: `s3-${phase}`,
        cleanupIntervalMs: 0,
        uploadTimeoutMs: 25,
        maxConcurrentUploads: 1,
        maxConcurrentUploadsPerScope: 1,
      });
      const upload = () =>
        service.handleUpload(
          new Request("http://localhost/mcp-upload", {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "MCPP-Files-Version": "1",
              "MCPP-File-Name": "a.bin",
              "MCPP-File-Size": "1",
            },
            body: new Uint8Array([7]),
          }),
          { scope: { key: "verified" } },
        );
      try {
        await service.ready;
        const statuses = [];
        for (let index = 0; index < 3; index++)
          statuses.push((await upload()).status);
        expect(statuses).toEqual([408, 429, 429]);
        expect(outstanding).toBe(1);
        expect(peak).toBe(1);
        expect(observations.length).toBe(phase === "pending" ? 1 : 2);
        // 记录当前驱动的真实限制：没有 AWS abortSignal，也不再把无效 signal 塞进 Command。
        expect(
          observations.every((item) => !item.abortSignal && !item.inputSignal),
        ).toBe(true);
        let closed = false;
        const closing = service.close().then(() => {
          closed = true;
        });
        await Bun.sleep(30);
        expect(closed).toBe(false);
        expect(outstanding).toBe(1);
        release();
        await closing;
        expect(outstanding).toBe(0);
      } finally {
        release();
        await service.close();
        client.destroy();
      }
    });

  test("FlyDrive 2.2.0 原生 signal 契约：只进入 Command input，取消不使 send settle", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const controller = new AbortController();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const sent = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finished = false;
    client.send = (async (command: any, options: any) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input.signal).toBe(controller.signal);
      expect(options?.abortSignal).toBeUndefined();
      entered();
      await blocked;
      return {};
    }) as typeof client.send;
    const disk = new Disk(
      new S3Driver({
        client,
        bucket: "native-cancel-contract",
        supportsACL: false,
        visibility: "private",
      }),
    );
    const pending = disk
      .put("probe", new Uint8Array(), { signal: controller.signal })
      .then(() => {
        finished = true;
      });
    try {
      await sent;
      controller.abort();
      await Bun.sleep(15);
      expect(finished).toBe(false);
      release();
      await pending;
      expect(finished).toBe(true);
    } finally {
      release();
      await pending;
      client.destroy();
    }
  });

  test("只替换 Disk，client 上传、空文件、重启、读取、TTL 清理", async () => {
    const backend = s3Contract();
    let now = Date.now();
    const service = createFileService({
      disk: backend.disk,
      namespace: "s3-contract",
      cleanupIntervalMs: 0,
      ttlSeconds: 1,
      now: () => now,
    });
    const scope = { key: "verified-workspace" };
    const mount = createFileMount(service, {
      endpointPath: "/mcp",
      allowedOrigins: [],
      resolveScope: () => scope,
    });
    const gateway = createGatewayRoutes([
      {
        path: "/mcp",
        files: mount,
        createServer(request) {
          const server = new McpServer({ name: "s3-contract", version: "1" });
          registerFileTool(
            server,
            {
              definition: {
                name: "read",
                description: "读取 S3 上传文件",
                inputSchema: z.object({
                  fileId: z.string().meta({ "x-mcpp-file": {} }),
                }),
              },
              async handler({ fileId }, context) {
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
      },
    ]);
    const invoke = async (method: string, params = {}) => {
      const response = await gateway.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            ...(method === "tools/call" ? { "Mcp-Name": "read" } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "s3-contract",
                  version: "1",
                },
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: { [MCPP_FILES_EXTENSION]: { version: 1 } },
                },
              },
            },
          }),
        }),
      );
      const payload = (await response.json()) as any;
      expect(payload.error).toBeUndefined();
      return payload.result;
    };
    const helper = createFileClient({
      endpoint: "http://localhost/mcp",
      discover: async () => invoke("server/discover"),
      fetch: async (url, init) =>
        gateway.fetch(new Request(url as string, init)),
    });
    try {
      await service.ready;
      for (const bytes of [
        new Uint8Array(),
        new Uint8Array([0, 255, 128, 42]),
      ]) {
        const info = await helper.upload({
          name: "附件.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
          body: bytes,
        });
        const called = await invoke("tools/call", {
          name: "read",
          arguments: { fileId: info.fileId },
        });
        expect(JSON.parse(called.content[0].text)).toEqual(Array.from(bytes));
        await service.withFiles(
          scope,
          [{ fileId: info.fileId }],
          new AbortController().signal,
          async (files) => {
            expect(
              await (
                await files.require(info.fileId)
              ).bytes({ maxBytes: bytes.length }),
            ).toEqual(bytes);
          },
        );
      }
      await service.close();
      const restarted = createFileService({
        disk: backend.disk,
        namespace: "s3-contract",
        cleanupIntervalMs: 0,
        ttlSeconds: 1,
        now: () => now,
      });
      try {
        await restarted.ready;
        expect(backend.objects.size).toBe(4);
        now += 1001;
        await restarted.cleanup();
        expect(backend.objects.size).toBe(0);
      } finally {
        await restarted.close();
      }
      expect(
        backend.commands.some((command) => command instanceof PutObjectCommand),
      ).toBe(true);
      expect(
        backend.commands.some((command) => command instanceof GetObjectCommand),
      ).toBe(true);
    } finally {
      await gateway.close();
      await service.close();
      backend.close();
    }
  });

  test("S3 ready 提交失败与后端不可用不伪成功", async () => {
    const backend = s3Contract();
    let now = Date.now();
    const service = createFileService({
      disk: backend.disk,
      namespace: "s3-failure",
      cleanupIntervalMs: 0,
      uploadTimeoutMs: 100,
      orphanGraceMs: 0,
      now: () => now,
    });
    try {
      await service.ready;
      backend.failReady();
      const request = new Request("http://localhost/mcp-upload", {
        method: "POST",
        headers: {
          "MCPP-Files-Version": "1",
          "MCPP-File-Name": "a.bin",
          "MCPP-File-Size": "1",
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array([1]),
      });
      const response = await service.handleUpload(request, {
        scope: { key: "verified-workspace" },
      });
      expect(response.status).toBe(503);
      expect(
        [...backend.objects.keys()].some((key) => key.endsWith("ready.json")),
      ).toBe(false);
      now += 1000;
      await service.cleanup();
      expect(backend.objects.size).toBe(0);
      backend.failHead();
      await expect(
        service.withFiles(
          { key: "verified-workspace" },
          [{ fileId: "f_AAAAAAAAAAAAAAAAAAAAAA" }],
          new AbortController().signal,
          async () => {},
        ),
      ).rejects.toMatchObject({ code: "FILE_STORAGE_UNAVAILABLE" });
    } finally {
      await service.close();
      backend.close();
    }
  });
});
