import { Hono, type Context, type Next } from "hono";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { validateDeployInput, validateManifest, type PackageManifest } from "./contract.ts";
import { DeploymentStore, type Deployment } from "./deployment-store.ts";
import { errorStatus, limitedBody, publicHeaders, workerRequestHeaders } from "./http.ts";
import { internalToken } from "./runtime-config.ts";
import { WorkerAdapter } from "./worker-adapter.ts";

export type RunnerRuntime = {
  app: Hono;
  close(): void;
};

type RunnerOptions = {
  dataDir?: string;
  sourceUrl?: string;
  token?: string;
  autoStart?: boolean;
};

export function createRunnerRuntime(options: RunnerOptions = {}): RunnerRuntime {
  const dataDir = options.dataDir ?? process.env.MCP_DATA_DIR ?? join(import.meta.dir, "../data");
  const sourceUrl = options.sourceUrl ?? process.env.NPM_SOURCE_URL ?? "http://localhost:4873";
  const token = options.token ?? internalToken;
  const store = new DeploymentStore(join(dataDir, "runner.sqlite3"));
  const deployments = new Map<string, Deployment>();
  const workers = new Map<string, WorkerAdapter>();
  const app = new Hono();
  let closed = false;

  const save = (item: Deployment) => {
    deployments.set(item.id, item);
    store.put(item);
  };
  const setStatus = (item: Deployment, status: Deployment["status"], error?: string) => {
    item.status = status;
    item.error = error;
    save(item);
  };

  app.get("/health", c => c.json({ status: "ok" }));
  const requireInternalToken = async (c: Context, next: Next) => {
    if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "UNAUTHORIZED" }, 401);
    await next();
  };
  app.use("/internal/*", requireInternalToken);
  app.use("/routes/*", requireInternalToken);

  app.post("/internal/deployments", async c => {
    try {
      const input = validateDeployInput(await c.req.json());
      const item: Deployment = { ...input, id: crypto.randomUUID(), status: "queued", createdAt: new Date().toISOString() };
      save(item);
      if (options.autoStart !== false) void deploy(item);
      return c.json(item, 202);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : "INVALID_BODY" }, 400); }
  });
  app.get("/internal/deployments", c => c.json([...deployments.values()]));
  app.get("/internal/deployments/:id", c => {
    const item = deployments.get(c.req.param("id"));
    return item ? c.json(item) : c.json({ error: "DEPLOYMENT_NOT_FOUND" }, 404);
  });
  app.all("/routes/:id/*", async c => {
    try {
      const worker = workers.get(c.req.param("id"));
      if (!worker) return c.json({ error: "DEPLOYMENT_NOT_ACTIVE" }, 404);
      const body = await limitedBody(c.req.raw.clone());
      const route = c.req.path.replace(`/routes/${c.req.param("id")}`, "") || "/";
      const headers = workerRequestHeaders(c.req.raw.headers);
      const request = new Request(new URL(route + new URL(c.req.url).search, "http://worker.local").toString(), { method: c.req.method, headers, body });
      const response = await worker.fetch(request);
      return new Response(response.body, { status: response.status, headers: publicHeaders(response.headers) });
    } catch (error) { const message = error instanceof Error ? error.message : "ROUTE_FAILED"; return c.json({ error: message }, errorStatus(message) as 400); }
  });

  async function command(args: string[], cwd?: string, timeoutMs = 60_000) {
    const env = { PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: Bun.env.HOME ?? "/tmp", TMPDIR: Bun.env.TMPDIR ?? "/tmp", npm_config_registry: sourceUrl };
    const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", env });
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    const [stdout, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timeout);
    if (exitCode !== 0) {
      console.error(`NPM command failed with exit code ${exitCode}`);
      throw new Error("NPM_COMMAND_FAILED");
    }
    return stdout;
  }

  async function deploy(item: Deployment) {
    const root = join(dataDir, "deployments", item.id);
    try {
      if (!item.version) {
        setStatus(item, "resolving");
        const spec = `${item.packageName}@${item.distTag}`;
        const metadata = JSON.parse(await command(["npm", "view", spec, "version", "dist.integrity", "--json", "--registry", sourceUrl])) as { version: string; integrity?: string };
        item.version = metadata.version;
        item.integrity = metadata.integrity;
        save(item);
      }
      setStatus(item, "installing");
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
      await command(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", sourceUrl, `${item.packageName}@${item.version}`], root, 180_000);
      setStatus(item, "starting");
      const packageRoot = join(root, "node_modules", ...item.packageName.split("/"));
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
      const { entry, server } = validateManifest(manifest, item.serverId, packageRoot);
      item.displayName = manifest.mcpp?.display?.name ?? manifest.name;
      item.description = manifest.mcpp?.display?.description ?? manifest.description ?? "";
      item.serverTitle = manifest.mcpp?.servers?.[item.serverId]?.title ?? item.serverId;
      item.endpointPath = server.endpointPath;
      save(item);
      const [realRoot, realEntry] = await Promise.all([realpath(packageRoot), realpath(entry)]);
      if (realEntry !== realRoot && !realEntry.startsWith(realRoot + sep)) throw new Error("ENTRY_OUTSIDE_PACKAGE");
      let worker: WorkerAdapter;
      worker = new WorkerAdapter(realEntry, 15_000, error => {
        if (workers.get(item.id) !== worker) return;
        workers.delete(item.id);
        setStatus(item, "failed", error.message);
      });
      try {
        await worker.waitUntilReady();
        const probe = await worker.fetch(new Request("http://worker.local/", { method: "GET" }));
        if (probe.status >= 500) throw new Error("WORKER_HEALTH_FAILED");
      } catch (error) { worker.terminate(); throw error; }
      workers.set(item.id, worker);
      setStatus(item, "active");
      console.info(`Deployment ${item.id} is active`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "DEPLOYMENT_FAILED";
      setStatus(item, "failed", message);
      await rm(root, { recursive: true, force: true });
      console.error(`Deployment ${item.id} failed: ${message}`);
    }
  }

  const recovered = store.load();
  for (const item of recovered) {
    deployments.set(item.id, item);
    if (item.status === "queued" && options.autoStart !== false) void deploy(item);
  }

  return {
    app,
    close() {
      if (closed) return;
      closed = true;
      for (const worker of workers.values()) worker.terminate();
      workers.clear();
      store.close();
    },
  };
}

const runtime = createRunnerRuntime();
const app = runtime.app;
function shutdown() { runtime.close(); }
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("SIGINT", () => { shutdown(); process.exit(0); });
if (import.meta.main) Bun.serve({ port: Number(process.env.RUNNER_PORT ?? 3001), fetch: app.fetch });
export { app, runtime };
