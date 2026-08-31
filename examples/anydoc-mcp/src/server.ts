import { McpServer } from "@modelcontextprotocol/server";
import { createMcppServerFactory, startServer } from "@peri-code/mcpp/server";
import { z } from "zod";
import { convertLocalFile } from "./converter.ts";

export function createAnydocServer(): McpServer {
  const server = new McpServer(
    { name: "anydoc", version: "0.1.1" },
    {
      instructions:
        "Converts guarded local document files to Markdown. URLs are not supported.",
    },
  );

  // 过渡期仅由底层 MCP SDK 创建 McpServer 并注册 tool；生命周期由 MCPP 统一负责。
  // MCPP Tool API 可用后应移除这项直接依赖并迁移此注册逻辑。
  server.registerTool(
    "convert_document",
    {
      title: "Convert local document",
      description:
        "Convert a local document under ANYDOC_ALLOWED_ROOTS to Markdown. URLs are rejected.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute local file path"),
      }),
    },
    async ({ path }) => {
      try {
        const result = await convertLocalFile(path);
        return {
          content: [{ type: "text", text: result.markdown }],
          structuredContent: { truncated: result.truncated },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Document conversion failed",
            },
          ],
        };
      }
    },
  );
  return server;
}

export const serverFactory = createMcppServerFactory(
  { cacheVersion: "anydoc-0.1.1" },
  () => createAnydocServer(),
);

if (import.meta.main) {
  await startServer(serverFactory, { mode: "stdio" });
}
