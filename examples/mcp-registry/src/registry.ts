import { Hono, type Context } from "hono";
import { PACKAGE_NAME, validateDeployInput } from "./contract.ts";
import { parseStableRoute, stableRoutePath } from "./stable-route.ts";
import { errorStatus, limitedBody, publicHeaders } from "./http.ts";
import { NpmStore } from "./npm-store.ts";
import { ui } from "./ui.ts";
import { internalToken as token } from "./runtime-config.ts";

const sourceUrl = process.env.NPM_SOURCE_URL ?? "http://localhost:4873";
const runnerUrl = process.env.MCP_RUNNER_URL ?? "http://localhost:3001";
const adminToken = process.env.MCP_REGISTRY_ADMIN_TOKEN ?? "";
const store = new NpmStore(sourceUrl);
const app = new Hono();
const runnerHeaders = () => ({ authorization: `Bearer ${token}` });

type RunnerDeployment = {
  id: string;
  status: string;
  packageName: string;
  serverId: string;
  displayName?: string;
  description?: string;
  serverTitle?: string;
  endpointPath?: string;
  version?: string;
  [key: string]: unknown;
};

function publicDeployment(item: RunnerDeployment, origin: string) {
  const endpointPath = item.endpointPath ?? "/mcp";
  const route = item.version
    ? `${origin}${stableRoutePath({ packageName: item.packageName, version: item.version, serverId: item.serverId, endpointPath })}`
    : undefined;
  const configName = `${item.displayName ?? item.packageName} · ${item.serverTitle ?? item.serverId}`;
  return {
    ...item,
    displayName: item.displayName ?? item.packageName,
    serverTitle: item.serverTitle ?? item.serverId,
    endpointPath,
    route,
    mcpJson: {
      mcpServers: {
        [configName]: { type: "streamable-http", url: route },
      },
    },
  };
}

async function runnerDeployments() {
  const response = await fetch(`${runnerUrl}/internal/deployments`, { headers: runnerHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("RUNNER_UNAVAILABLE");
  return response.json() as Promise<RunnerDeployment[]>;
}

async function proxyDeployment(c: Context, id: string, suffix: string) {
  const body = await limitedBody(c.req.raw.clone());
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host"); headers.delete("authorization"); headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${runnerUrl}/routes/${id}${suffix}${new URL(c.req.url).search}`, { method: c.req.method, headers, body, signal: AbortSignal.timeout(20_000), redirect: "manual" });
  return new Response(response.body, { status: response.status, headers: publicHeaders(response.headers) });
}

app.get("/", c => c.html(ui));
app.get("/health", c => c.json({ status: "ok" }));
app.get("/api/packages", async c => {
  try { return c.json(await store.list(c.req.query("q")?.slice(0, 100) ?? "")); }
  catch (error) { const message = error instanceof Error ? error.message : "NPM_SEARCH_FAILED"; return c.json({ error: message }, errorStatus(message) as 502); }
});
app.get("/api/packages/:name{.+}", async c => {
  try {
    const name = decodeURIComponent(c.req.param("name"));
    if (!PACKAGE_NAME.test(name)) return c.json({ error: "INVALID_PACKAGE_NAME" }, 400);
    return c.json(await store.detail(name));
  } catch (error) { const message = error instanceof Error ? error.message : "PACKAGE_LOOKUP_FAILED"; return c.json({ error: message }, errorStatus(message) as 404); }
});
app.post("/api/deployments", async c => {
  if (!adminToken || c.req.header("x-admin-token") !== adminToken) return c.json({ error: "ADMIN_UNAUTHORIZED" }, 401);
  try {
    const input = validateDeployInput(await c.req.json());
    const response = await fetch(`${runnerUrl}/internal/deployments`, { method: "POST", headers: { ...runnerHeaders(), "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000) });
    return new Response(response.body, { status: response.status, headers: publicHeaders(response.headers) });
  } catch (error) { const message = error instanceof Error ? error.message : "INVALID_BODY"; return c.json({ error: message }, errorStatus(message) as 400); }
});
app.get("/api/deployments", async c => {
  try {
    const deployments = await runnerDeployments();
    return c.json(deployments.map(item => publicDeployment(item, new URL(c.req.url).origin)));
  } catch { return c.json({ error: "RUNNER_UNAVAILABLE" }, 502); }
});
app.all("/mcp/npm/*", async c => {
  try {
    const identity = parseStableRoute(c.req.path);
    if (!identity) return c.json({ error: "INVALID_STABLE_ROUTE" }, 400);
    const deployments = await runnerDeployments();
    const deployment = deployments.find(item =>
      item.status === "active"
      && item.packageName === identity.packageName
      && item.version === identity.version
      && item.serverId === identity.serverId
      && (item.endpointPath ?? "/mcp") === identity.suffix
    );
    if (!deployment) return c.json({ error: "MCP_VERSION_NOT_ACTIVE" }, 503);
    return proxyDeployment(c, deployment.id, identity.suffix);
  } catch (error) { const message = error instanceof Error ? error.message : "PROXY_FAILED"; return c.json({ error: message }, errorStatus(message) as 502); }
});
app.all("/mcp/:id/*", async c => {
  try {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "INVALID_DEPLOYMENT_ID" }, 400);
    const suffix = c.req.path.replace(`/mcp/${id}`, "") || "/";
    return proxyDeployment(c, id, suffix);
  } catch (error) { const message = error instanceof Error ? error.message : "PROXY_FAILED"; return c.json({ error: message }, errorStatus(message) as 502); }
});
if (import.meta.main) Bun.serve({ port: Number(process.env.REGISTRY_PORT ?? 3000), fetch: app.fetch });
export { app };
