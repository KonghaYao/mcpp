import { expect, test } from "bun:test";
import { getFileInfo } from "prettier";
import { fileURLToPath } from "node:url";
import { matchesTaskSchema } from "./schema.ts";
import {
  InputRequestsV2Schema,
  CancelTaskResultV2Schema,
  CreateTaskResultV2Schema,
  DetailedTaskV2Schema,
  GetTaskResultV2Schema,
  InputResponsesV2Schema,
  TasksExtensionCapabilityV2Schema,
  UpdateTaskResultV2Schema,
} from "@modelcontextprotocol/ext-tasks/core/v2";

test("仓库 Prettier 规则保护原样 vendor 与既有 .peri 规则", async () => {
  const ignorePath = fileURLToPath(
    new URL("../../../../.prettierignore", import.meta.url),
  );
  const snapshot = fileURLToPath(
    new URL("./vendor/schema-2026-07-28.json", import.meta.url),
  );
  const audit = fileURLToPath(
    new URL("../../../../.peri/audit.json", import.meta.url),
  );
  expect((await getFileInfo(snapshot, { ignorePath })).ignored).toBe(true);
  expect((await getFileInfo(audit, { ignorePath })).ignored).toBe(true);
});

test("直接读取规范正文的 JSON 示例并用官方 schema 校验", async () => {
  const document = await Bun.file(
    new URL("../../../../MCPP/20-mcp-tasks.md", import.meta.url),
  ).text();
  const examples = [...document.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (match) => JSON.parse(match[1]!),
  );
  expect(examples).toHaveLength(3);
  expect(
    matchesTaskSchema(
      "TasksExtensionCapability",
      examples[0]["io.modelcontextprotocol/clientCapabilities"].extensions[
        "io.modelcontextprotocol/tasks"
      ],
    ),
  ).toBe(true);
  expect(matchesTaskSchema("CreateTaskResult", examples[1])).toBe(true);
  expect(matchesTaskSchema("GetTaskResult", examples[2])).toBe(true);
  expect(
    TasksExtensionCapabilityV2Schema.safeParse(
      examples[0]["io.modelcontextprotocol/clientCapabilities"].extensions[
        "io.modelcontextprotocol/tasks"
      ],
    ).success,
  ).toBe(true);
  expect(CreateTaskResultV2Schema.safeParse(examples[1]).success).toBe(true);
  expect(GetTaskResultV2Schema.safeParse(examples[2]).success).toBe(true);
});

test("P2-6：快照原始字节固定且用完整 $defs 校验四组 npm 差异", async () => {
  const source = await Bun.file(
    new URL("./vendor/schema-2026-07-28.json", import.meta.url),
  ).text();
  expect(new Bun.CryptoHasher("sha256").update(source).digest("hex")).toBe(
    "bf30afb7ac251e3e22c037b7a685f60ef6603031b5484c0d08b1fa0bbe86d460",
  );
  const requests = [
    {
      prompt: {
        method: "elicitation/create",
        params: { message: "请求", requestedSchema: {} },
      },
    },
    {
      prompt: {
        method: "elicitation/create",
        params: {
          message: "请求",
          requestedSchema: {
            type: "object",
            properties: { nested: { type: "object" } },
          },
        },
      },
    },
    {
      prompt: {
        method: "sampling/createMessage",
        params: { maxTokens: 1, messages: [], tools: [{}] },
      },
    },
    {
      prompt: {
        method: "sampling/createMessage",
        params: { maxTokens: 1, messages: [], toolChoice: { mode: "invalid" } },
      },
    },
  ];
  for (const inputRequests of requests) {
    expect(InputRequestsV2Schema.safeParse(inputRequests).success).toBe(true);
    expect(matchesTaskSchema("InputRequests", inputRequests)).toBe(false);
    expect(
      matchesTaskSchema("DetailedTask", {
        ...base,
        status: "input_required",
        inputRequests,
      }),
    ).toBe(false);
    expect(
      matchesTaskSchema("GetTaskResult", {
        ...base,
        status: "input_required",
        resultType: "complete",
        inputRequests,
      }),
    ).toBe(false);
  }
  const fractional = { prompt: { action: "accept", content: { value: 1.5 } } };
  expect(InputResponsesV2Schema.safeParse(fractional).success).toBe(true);
  expect(matchesTaskSchema("InputResponses", fractional)).toBe(false);
  expect(
    matchesTaskSchema("InputResponses", {
      prompt: { action: "accept", content: { value: 1 } },
    }),
  ).toBe(true);
  expect(
    matchesTaskSchema("InputRequests", {
      prompt: {
        method: "sampling/createMessage",
        params: {
          maxTokens: 1,
          messages: [],
          toolChoice: { mode: "auto" },
          tools: [{ name: "valid", inputSchema: { type: "object" } }],
        },
      },
    }),
  ).toBe(true);
});

// npm schema 的检查仅为额外互操作检查；验收依据是固定快照的完整 $defs。
const base = {
  taskId: "t_example_01",
  status: "working",
  createdAt: "2026-10-30T03:00:00Z",
  lastUpdatedAt: "2026-10-30T03:00:00Z",
  ttlMs: null,
  pollIntervalMs: 2000,
};

test("规范文档的创建、查询与 ACK 示例通过官方 core/v2 schema", () => {
  expect(
    CreateTaskResultV2Schema.safeParse({ ...base, resultType: "task" }).success,
  ).toBe(true);
  expect(
    GetTaskResultV2Schema.safeParse({ ...base, resultType: "complete" })
      .success,
  ).toBe(true);
  expect(
    GetTaskResultV2Schema.safeParse({
      ...base,
      status: "completed",
      lastUpdatedAt: "2026-10-30T03:00:04Z",
      ttlMs: 86404000,
      resultType: "complete",
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "命令执行完成" }],
        isError: false,
      },
    }).success,
  ).toBe(true);
  expect(
    CancelTaskResultV2Schema.safeParse({ resultType: "complete" }).success,
  ).toBe(true);
  expect(
    UpdateTaskResultV2Schema.safeParse({ resultType: "complete" }).success,
  ).toBe(true);
  expect(TasksExtensionCapabilityV2Schema.safeParse({}).success).toBe(true);
  expect(TasksExtensionCapabilityV2Schema.safeParse({ tier: 1 }).success).toBe(
    false,
  );
  expect(
    CreateTaskResultV2Schema.safeParse({ resultType: "task", task: base })
      .success,
  ).toBe(false);
  const { ttlMs: _, ...missingTtl } = base;
  expect(DetailedTaskV2Schema.safeParse(missingTtl).success).toBe(false);
  expect(
    DetailedTaskV2Schema.safeParse({
      ...base,
      status: "failed",
      error: { code: 1.5, message: "错误" },
    }).success,
  ).toBe(false);
});

test("官方 DetailedTask input_required 要求完整请求；update 不接受任意 JSON", () => {
  expect(
    DetailedTaskV2Schema.safeParse({ ...base, status: "input_required" })
      .success,
  ).toBe(false);
  expect(
    DetailedTaskV2Schema.safeParse({
      ...base,
      status: "input_required",
      inputRequests: {
        approval: {
          method: "elicitation/create",
          params: {
            message: "请批准",
            requestedSchema: {
              type: "object",
              properties: { approved: { type: "boolean" } },
            },
          },
        },
      },
    }).success,
  ).toBe(true);
  expect(
    InputResponsesV2Schema.safeParse({
      approval: { action: "accept", content: { approved: true } },
    }).success,
  ).toBe(true);
  expect(
    InputResponsesV2Schema.safeParse({
      approval: { action: "accept", content: { nested: { invalid: true } } },
    }).success,
  ).toBe(false);
});
