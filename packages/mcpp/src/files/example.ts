/** 本地演示：bun packages/mcpp/src/files/example.ts；仅绑定 loopback，禁止带 Origin 请求。 */
import { resolve } from "node:path";
import { Disk } from "flydrive";
import { FSDriver } from "flydrive/drivers/fs";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { startServer } from "../server/start.ts";
import {
  createFileService,
  createFileMount,
  fileScopeFor,
  registerFileTool,
  FILE_ID_PATTERN,
} from "./index.ts";

const fileService = createFileService({
  disk: new Disk(
    new FSDriver({
      location: resolve(process.env.MCPP_FILES_DIRECTORY ?? ".mcpp-files"),
      visibility: "private",
    }),
  ),
  namespace: "local-files-demo",
});
const files = createFileMount(fileService, {
  endpointPath: "/mcp",
  allowedOrigins: [],
  // 演示显式匿名 scope，仅限受控的本机；远程部署必须替换为业务认证及权限检查。
  resolveScope: () => ({ key: "local-demo" }),
});
await fileService.ready;
const started = await startServer(
  (context) => {
    const server = new McpServer({ name: "files-demo", version: "1" });
    registerFileTool(
      server,
      {
        definition: {
          name: "inspect_file",
          description:
            "读取当前身份上传的文件，返回字节数、SHA-256 和最多 16 字节的文件头；不导入业务数据。",
          inputSchema: z.object({
            fileId: z
              .string()
              .regex(new RegExp(FILE_ID_PATTERN))
              .meta({ "x-mcpp-file": { maxBytes: 134217728 } }),
          }),
          annotations: { readOnlyHint: true },
        },
        async handler({ fileId }, context) {
          const file = await context.files.require(fileId);
          const header = await file.peek(16);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...file.info,
                  header: Array.from(header),
                }),
              },
            ],
          };
        },
      },
      { fileService, scope: () => fileScopeFor(context) },
    );
    return server;
  },
  { mode: "http", host: "127.0.0.1", files },
);
console.log(`文件演示 MCP endpoint: ${started.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await started.stop();
    await fileService.close();
  });
