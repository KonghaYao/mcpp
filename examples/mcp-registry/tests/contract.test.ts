import { describe, expect, test } from "bun:test";
import { validateDeployInput, validateManifest } from "../src/contract.ts";
import { workerRequestHeaders } from "../src/http.ts";

describe("input validation", () => {
  test("accepts controlled source", () => expect(validateDeployInput({ packageName: "@example/echo-mcp", distTag: "latest", serverId: "default", sourceId: "default" }).sourceId).toBe("default"));
  test.each(["../bad", "a b", "https://evil.test/x"])("rejects package %s", packageName => expect(() => validateDeployInput({ packageName, serverId: "default" })).toThrow("INVALID_PACKAGE_NAME"));
  test("rejects arbitrary source", () => expect(() => validateDeployInput({ packageName: "safe", serverId: "default", sourceId: "https://evil.test" })).toThrow("UNKNOWN_SOURCE"));
});
describe("manifest contract", () => {
  const valid = { name: "safe", version: "1.0.0", keywords: ["mcp-plugin"], mcpp: { servers: { default: { runtime: "serverless", entry: "./dist/server.js" } } } } as const;
  test("resolves contained entry", () => expect(validateManifest(valid, "default", "/tmp/pkg").entry).toBe("/tmp/pkg/dist/server.js"));
  test("rejects traversal", () => expect(() => validateManifest({ ...valid, mcpp: { servers: { default: { runtime: "serverless", entry: "../escape.js" } } } }, "default", "/tmp/pkg")).toThrow("ENTRY_OUTSIDE_PACKAGE"));
  test("defaults to the standard MCP endpoint", () => expect(validateManifest(valid, "default", "/tmp/pkg").server.endpointPath).toBe("/mcp"));
  test("rejects stdio", () => expect(() => validateManifest({ ...valid, mcpp: { servers: { default: { runtime: "serverless", entry: "./x.js", transport: "stdio" } } } }, "default", "/tmp/pkg")).toThrow("STDIO_NOT_SUPPORTED"));
  test("rejects endpoint traversal", () => expect(() => validateManifest({ ...valid, mcpp: { servers: { default: { runtime: "serverless", entry: "./x.js", endpointPath: "/../private" } } } }, "default", "/tmp/pkg")).toThrow("INVALID_ENDPOINT_PATH"));
});

test("worker headers exclude internal credentials", () => {
  const headers = workerRequestHeaders(new Headers({ authorization: "Bearer secret", host: "runner", "x-internal-trace": "private", "content-type": "application/json" }));
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("host")).toBeNull();
  expect(headers.get("x-internal-trace")).toBeNull();
  expect(headers.get("content-type")).toBe("application/json");
});
