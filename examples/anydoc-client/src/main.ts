import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const TIMEOUT_MS = 30_000;
const adminSecret = `e2e-admin-${crypto.randomUUID()}`;
const port = 30_000 + Math.floor(Math.random() * 20_000);
const root = await mkdtemp(join(tmpdir(), "mcpm-directory-e2e-"));
const dbPath = join(root, "directory.sqlite");
const base = `http://127.0.0.1:${port}`;
const workspaceRoot = resolve(import.meta.dir, "../../..");
const server = Bun.spawn(["bun", join(workspaceRoot, "packages/mcp-market/src/main.ts")], {
  cwd: workspaceRoot,
  env: { ...process.env, MCPM_ADMIN_SECRET: adminSecret, MCPM_DB_PATH: dbPath, PORT: String(port), HOST: "127.0.0.1" },
  stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const stderr = new Response(server.stderr).text();
const timer = setTimeout(() => server.kill(), TIMEOUT_MS);

async function request(path: string, init: RequestInit = {}, expected?: number) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (expected !== undefined && response.status !== expected) throw new Error(`${init.method ?? "GET"} ${path}: expected ${expected}, got ${response.status}`);
  return response;
}
async function json(path: string, init: RequestInit = {}, expected?: number): Promise<any> {
  const response = await request(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }, expected);
  return response.status === 204 ? null : response.json();
}
const admin = (path: string, body?: unknown, expected?: number) => json(`/api/v1/admin${path}`, { method: "POST", headers: { authorization: `Bearer ${adminSecret}` }, body: body === undefined ? undefined : JSON.stringify(body) }, expected);
let publisherToken = "";
const publisher = (path: string, method = "GET", body?: unknown, expected?: number) => json(`/api/v1/publisher${path}`, { method, headers: { authorization: `Bearer ${publisherToken}` }, body: body === undefined ? undefined : JSON.stringify(body) }, expected);
const item = { slug: "anydoc", backend: "unreachable", displayName: "AnyDoc", summary: "Document conversion", revision: { version: "0.1.0", backendLocator: "opaque-placeholder", serverDefinition: { command: "anydoc-mcp", args: [], env: { API_KEY: "${ANYDOC_API_KEY}" } }, envSchema: { type: "object", properties: { API_KEY: { type: "string" } } } } };

try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(`MCPM exited during startup with code ${server.exitCode}: ${(await stderr).trim()}`);
    try { await request("/health/live", {}, 200); ready = true; break; } catch { await Bun.sleep(50); }
  }
  if (!ready) throw new Error("MCPM did not become ready before the startup deadline");
  await admin("/backends", { slug: "unreachable", displayName: "Opaque backend", websiteUrl: "http://127.0.0.1:9" }, 201);
  await admin("/publishers", { slug: "anydoc-publisher", displayName: "AnyDoc Publisher" }, 201);
  const key = await admin("/publishers/anydoc-publisher/api-keys", { name: "e2e" }, 201); publisherToken = key.token;
  await publisher("/items", "POST", item, 201);
  await request("/api/v1/items/anydoc", {}, 404);
  await admin("/reviews/anydoc/approve", {}, 200);
  let config = await json("/api/v1/items/anydoc/config", {}, 200);
  if (config.version !== "0.1.0" || config.backend !== "unreachable" || config.config?.mcpServers?.anydoc?.command !== "anydoc-mcp") throw new Error("initial config is incomplete");
  await publisher("/items/anydoc/revisions", "POST", { ...item.revision, version: "0.2.0" }, 201);
  if ((await json("/api/v1/items/anydoc", {}, 200)).latestVersion !== "0.2.0") throw new Error("automatic latest failed");
  await publisher("/items/anydoc/latest", "PUT", { version: "0.1.0" }, 200);
  await publisher("/items/anydoc", "PATCH", { displayName: "AnyDoc Updated", summary: "Updated summary" }, 200);
  await publisher("/items/anydoc/archive", "POST", undefined, 200);
  await request("/api/v1/items/anydoc", {}, 404);
  await publisher("/items/anydoc/restore", "POST", undefined, 200);
  await admin("/items/anydoc/suspend", undefined, 200);
  await publisher("/items/anydoc/revisions", "POST", { ...item.revision, version: "0.3.0" }, 409);
  await request("/api/v1/items/anydoc", {}, 404);
  await admin("/items/anydoc/restore", undefined, 200);
  if ((await json("/api/v1/items/anydoc", {}, 200)).displayName !== "AnyDoc Updated") throw new Error("restore lost metadata");
  console.log(JSON.stringify({ ok: true, lifecycle: ["pending", "approved", "auto-latest", "rollback", "metadata", "archive", "restore", "suspend", "admin-restore"], backendRequests: 0 }, null, 2));
} finally {
  clearTimeout(timer);
  server.kill();
  await server.exited.catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
