import { expect, test } from "bun:test";

process.env.MCP_REGISTRY_ADMIN_TOKEN = "test-admin-token";
const { app } = await import("../src/registry.ts");

test("deployment creation requires the admin token", async () => {
  const body = JSON.stringify({
    packageName: "@example/echo-mcp",
    distTag: "latest",
    serverId: "default",
    sourceId: "default",
  });

  const unauthorized = await app.request("/api/deployments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toEqual({ error: "ADMIN_UNAUTHORIZED" });
});
