import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRunnerRuntime, type RunnerRuntime } from "../src/runner.ts";

const runtimes: RunnerRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("deployment survives Runner runtime recreation through its HTTP API", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mcp-runner-recovery-"));
  directories.push(dataDir);
  const first = createRunnerRuntime({ dataDir, token: "test-token", autoStart: false });
  runtimes.push(first);

  const created = await first.app.request("/internal/deployments", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ packageName: "@example/openspec-mcp", distTag: "latest", serverId: "default", sourceId: "default" }),
  });
  expect(created.status).toBe(202);
  const deployment = await created.json() as { id: string };
  first.close();
  runtimes.pop();

  const recovered = createRunnerRuntime({ dataDir, token: "test-token", autoStart: false });
  runtimes.push(recovered);
  const response = await recovered.app.request("/internal/deployments", { headers: { authorization: "Bearer test-token" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    expect.objectContaining({ id: deployment.id, packageName: "@example/openspec-mcp", status: "queued" }),
  ]);
});
