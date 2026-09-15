import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { HttpMcpClient } from "../../src/http-source/client.ts";
import { HttpSourceService } from "../../src/http-source/service.ts";
import { fromHttpSlug, toPackageSlug } from "../../src/catalog/slug.ts";
import { isExactVersion } from "../../src/npm-registry/normalize.ts";
import { openDatabase } from "../../src/db/database.ts";
import {
  createHarness,
  formRequest,
  getRequest,
  blockStaticDir,
  type Harness,
} from "../support/harness.ts";
import { snapshotRecord } from "../support/snapshot.ts";

let harness: Harness;
let server: ReturnType<typeof Bun.serve>;
let endpoint: string;
let calls: string[];
let tools: unknown[];
let marker: string;
let failRemote: boolean;
let instructions: string;
let cookie: string;
let csrf: string;
let extraDiscovery: boolean;

beforeEach(async () => {
  marker = crypto.randomUUID();
  instructions = `Authorization: Bearer ${marker}`;
  failRemote = false;
  extraDiscovery = false;
  calls = [];
  tools = [
    {
      name: "weather",
      description: "天气查询",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", default: marker, examples: [marker] },
        },
      },
      _meta: { marker },
      annotations: { title: marker },
    },
  ];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "DELETE") {
        calls.push("DELETE");
        return new Response(null, { status: 204 });
      }
      const rpc = (await request.json()) as { id: number; method: string };
      calls.push(rpc.method);
      if (failRemote) return new Response(instructions, { status: 500 });
      if (rpc.method === "server/discover")
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            capabilities: { tools: {} },
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "weather-server",
                version: "1.0.0",
              },
            },
          },
        });
      if (rpc.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {
                tools: {},
                ...(extraDiscovery ? { resources: {}, prompts: {} } : {}),
              },
              serverInfo: { name: "weather-server", version: "1.0.0" },
              instructions,
            },
          },
          { headers: { "Mcp-Session-Id": marker } },
        );
      if (rpc.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (rpc.method === "resources/list")
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            resources: [
              {
                uri: "skill://auditing/SKILL.md",
                name: "auditing",
                description: "Audit workflow",
              },
              { uri: "skill://auditing/example.ts", name: "helperfile" },
              {
                uri: "reports://monthly",
                name: "reporting",
                description: "Monthly reports",
              },
            ],
          },
        });
      if (rpc.method === "resources/templates/list")
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            resourceTemplates: [
              { uriTemplate: "reports://{month}", name: "reporttemplate" },
            ],
          },
        });
      if (rpc.method === "prompts/list")
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            prompts: [
              { name: "forecasting", description: "Forecast workflow" },
            ],
          },
        });
      expect(rpc.method).toBe("tools/list");
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
    },
  });
  endpoint = `http://127.0.0.1:${server.port}/mcp`;
  harness = await createHarness({
    configOverrides: {
      httpAllowLoopback: true,
      registryHomepageUrl: "https://registry.example.com",
    },
  });
  cookie = await harness.login();
  const page = await harness.app.request(
    "/admin/http-sources",
    getRequest("", cookie),
  );
  csrf = harness.csrfOf(await page.text());
});

afterEach(async () => {
  server.stop(true);
  await harness.cleanup();
});
test("后台接受公网 HTTP 定义，读取失败仍保留原表定义", async () => {
  const publicEndpoint = "http://8.163.76.248:23332/mcp";
  const response = await post("/admin/http-sources/save", {
    packageName: "langfuse",
    displayName: "langfuse",
    endpoint: publicEndpoint,
    protocol: "2026-07-28",
  });
  const html = await response.text();
  expect(html).toContain("定义已保存，读取或同步未完成");
  expect(html).not.toContain('name="previewDigest"');
  expect(html).toContain("HTTP 为明文传输");
  expect(html).toContain(publicEndpoint);
  expect(sources().list()).toHaveLength(1);
  expect(sources().list()[0]?.endpoint).toBe(publicEndpoint);
  expect(count("market_packages")).toBe(1);
  expect(count("market_publications")).toBe(0);
  expect(calls).toEqual([]);

  const invalid = await post("/admin/http-sources/save", {
    packageName: "private-source",
    displayName: "私有地址",
    endpoint: "http://169.254.169.254/mcp",
  });
  expect(await invalid.text()).toContain("地址支持公网 HTTP / HTTPS");
  expect(count("market_packages")).toBe(1);
});

test("HTTP 名称边界保证来源 slug 可写入静态目录", async () => {
  const packageName = Array.from({ length: 43 }, () => "ab")
    .join(".")
    .slice(0, 128);
  const source = sources().save({
    packageName,
    displayName: "长名称",
    endpoint,
  });
  expect(toPackageSlug(packageName, source.id).length).toBeLessThan(256);
  const preview = await sources().preview(source.id);
  expect(
    (
      await harness.application.admin.syncHttp(
        source.id,
        preview.confirmationDigest,
        "long-name",
      )
    ).refresh.outcome,
  ).toBe("refreshed");
  expect(() =>
    sources().save({
      packageName: `${packageName}ab`,
      displayName: "太长",
      endpoint,
    }),
  ).toThrow();
});

const sources = () => harness.application.admin.httpSources!;
const save = (displayName = "天气服务") =>
  sources().save({ packageName: "same-name", displayName, endpoint });
const post = (path: string, fields: Record<string, string>) =>
  harness.app.request(path, formRequest(path, { csrf, ...fields }, cookie));
const count = (
  table:
    | "market_packages"
    | "market_publications"
    | "market_search"
    | "admin_operations",
) =>
  harness.db
    .query<{ total: number }, []>(`SELECT count(*) AS total FROM ${table}`)
    .get()!.total;

test("表单保存自动预览但不发布，底层保存与重启不额外请求", async () => {
  const response = await post("/admin/http-sources/save", {
    packageName: "same-name",
    displayName: "天气服务",
    endpoint,
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("重新读取预览");
  const source = sources().list()[0]!;
  expect(calls).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/list",
    "DELETE",
  ]);
  expect(html).toContain("发现结果预览");
  expect(html).toContain('name="previewDigest"');
  calls = [];
  expect(count("market_packages")).toBe(1);
  expect(
    harness.db
      .query(
        "SELECT id, source_kind, latest_publication_id FROM market_packages",
      )
      .get(),
  ).toEqual({
    id: source.id,
    source_kind: "http",
    latest_publication_id: null,
  });
  expect(count("market_publications")).toBe(0);
  expect(count("market_search")).toBe(0);
  const reopened = await openDatabase(harness.dbPath);
  try {
    const fresh = new HttpSourceService(
      reopened,
      new HttpMcpClient({ allowLoopback: true }),
    );
    expect(fresh.get(source.id)).toEqual(source);
    fresh.save({ ...source, displayName: "天气新名称" });
  } finally {
    reopened.close();
  }
  expect(sources().get(source.id).revision).toBe(2);
  expect(() => sources().save({ ...source, packageName: "renamed" })).toThrow();
  expect(calls).toEqual([]);
});

test("预览确认完整链路：digest、不可变内容版本、共用页面与搜索", async () => {
  const source = save();
  const previewResponse = await post("/admin/http-sources/preview", {
    id: source.id,
  });
  const previewHtml = await previewResponse.text();
  const digest = /name="previewDigest" value="([a-f0-9]{64})"/.exec(
    previewHtml,
  )?.[1];
  expect(digest).toBeDefined();
  expect(previewHtml).toContain("weather");
  expect(previewHtml).toContain("inputSchema");
  expect(previewHtml).not.toContain(marker);
  expect(count("market_publications")).toBe(0);
  const confirmed = await post("/admin/http-sources/sync", {
    id: source.id,
    previewDigest: digest!,
  });
  expect(await confirmed.text()).toContain("公开页面已重新生成");
  const catalog = harness.application.catalog;
  const slug = toPackageSlug(source.packageName, source.id);
  const detail = catalog.getPublicPackage(slug)!;
  expect(detail.metadata.sourceKind).toBe("http");
  expect(detail.sourceKind).toBe("http");
  expect(detail.metadata.serverInfo).toEqual({
    name: "weather-server",
    version: "1.0.0",
  });
  expect(count("market_packages")).toBe(1);
  expect(
    harness.db.query("SELECT package_id FROM market_publications").get(),
  ).toEqual({ package_id: source.id });
  expect(isExactVersion(detail.latestVersion)).toBe(true);
  expect(detail.latestVersion).toMatch(/^0\.0\.0-http\.[a-f0-9]{64}$/);
  expect(count("market_publications")).toBe(1);
  expect(count("market_search")).toBe(1);
  expect(catalog.searchPublic({ q: "weather" }).items[0]?.slug).toBe(slug);
  expect(catalog.searchPublic({ q: "天气" }).items[0]?.slug).toBe(slug);
  const page = await harness.app.request(`/market/${slug}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain(endpoint);
  expect(html).toContain("weather");
  expect(html).toContain("&quot;url&quot;");
  expect(html).not.toContain("&quot;npx&quot;");
  expect(html).not.toContain("在 NPM 查看");
  expect(html).not.toContain(marker);
  expect(
    (await harness.app.request(`/market/${slug}/v/${detail.latestVersion}`))
      .status,
  ).toBe(200);
  const row = catalog.findPublicationState(
    source.id,
    source.packageName,
    detail.latestVersion,
  ).publication!;
  expect(row.metadataJson).not.toContain(marker);
  expect(
    JSON.stringify(harness.db.query("SELECT * FROM market_search").all()),
  ).not.toContain(marker);
  const unchanged = await harness.application.admin.syncHttp(
    source.id,
    digest!,
    "noop",
  );
  expect(unchanged.catalogChanged).toBe(false);
  expect(unchanged.refresh.outcome).toBe("skipped");
  expect(count("admin_operations")).toBe(1);
  tools.push({ name: "forecast", inputSchema: { type: "object" } });
  const stale = await post("/admin/http-sources/sync", {
    id: source.id,
    previewDigest: digest!,
  });
  expect(await stale.text()).toContain("重新读取预览");
  expect(count("market_publications")).toBe(1);
  const next = await sources().preview(source.id);
  await harness.application.admin.syncHttp(
    source.id,
    next.confirmationDigest,
    "changed",
  );
  expect(count("market_publications")).toBe(2);
  expect(catalog.getPublicPackage(slug)!.latestVersion).not.toBe(
    detail.latestVersion,
  );
  expect(
    catalog.findPublicationState(
      source.id,
      source.packageName,
      detail.latestVersion,
    ).publication!.metadataJson,
  ).toBe(row.metadataJson);
});

test("定义 revision 与来源绑定确认 digest，排序及被忽略字段不影响内容版本", async () => {
  const source = save();
  tools.push({ name: "alpha", inputSchema: { type: "object" } });
  const first = await sources().preview(source.id);
  tools.reverse();
  instructions = "changed instructions";
  expect((await sources().preview(source.id)).metadataDigest).toBe(
    first.metadataDigest,
  );
  const other = save();
  const second = await sources().preview(other.id);
  expect(second.metadataDigest).not.toBe(first.metadataDigest);
  expect(second.confirmationDigest).not.toBe(first.confirmationDigest);
  await expect(
    harness.application.admin.syncHttp(
      other.id,
      first.confirmationDigest,
      "wrong-source",
    ),
  ).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
  sources().save({ ...source, displayName: "新名称" });
  await expect(
    harness.application.admin.syncHttp(
      source.id,
      first.confirmationDigest,
      "old-definition",
    ),
  ).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
  expect(count("market_publications")).toBe(0);
  await expect(
    harness.application.admin.syncHttp(source.id, "", "no-preview"),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("同名 npm 与多个 HTTP 源共表不串数据，旧 URL 与下架恢复兼容", async () => {
  const catalog = harness.application.catalog;
  const first = save("第一源");
  const second = save("第二源");
  for (const source of [first, second]) {
    const preview = await sources().preview(source.id);
    await harness.application.admin.syncHttp(
      source.id,
      preview.confirmationDigest,
      source.id,
    );
  }
  const npm = {
    sourceId: "npm",
    packageName: "same-name",
    exactVersion: "1.0.0",
    requestId: "npm",
  };
  const npmChange = catalog.publish({
    ...npm,
    ...(await snapshotRecord({
      name: npm.packageName,
      version: npm.exactVersion,
      displayName: "NPM 名称",
    })),
  });
  await harness.application.publicSite.invalidate(npmChange);
  const legacySlug = toPackageSlug(npm.packageName);
  expect(npmChange.packageSlug).toBe(legacySlug);
  expect(catalog.getPublicPackage(legacySlug)?.sourceId).toBe("npm");
  expect(catalog.getPublicPackage(legacySlug)?.sourceKind).toBe("npm");
  expect(catalog.getPublicVersion(legacySlug, "1.0.0")?.sourceKind).toBe("npm");
  expect(count("market_packages")).toBe(3);
  expect(count("market_publications")).toBe(3);
  expect(count("market_search")).toBe(3);
  const slug = toPackageSlug(first.packageName, first.id);
  expect(fromHttpSlug(slug)).toEqual({
    sourceId: first.id,
    packageName: first.packageName,
  });
  expect(fromHttpSlug(`${slug}=`)).toBeNull();
  expect(
    catalog.getPublicPackage(toPackageSlug(first.packageName, "http:missing")),
  ).toBeNull();
  expect(catalog.getAdminPackage(slug)?.sourceId).toBe(first.id);
  expect(
    new Set(catalog.listAdminPackages().map((entry) => entry.slug)).size,
  ).toBe(3);
  const version = catalog.getPublicPackage(slug)!.latestVersion;
  const before = calls.length;
  failRemote = true;
  await post("/admin/unpublish", {
    packageName: "same-name",
    packageSlug: slug,
    exactVersion: version,
  });
  expect((await harness.app.request(`/market/${slug}`)).status).toBe(404);
  expect(catalog.getPublicPackage(legacySlug)?.metadata.displayName).toBe(
    "NPM 名称",
  );
  expect(
    catalog.getPublicPackage(toPackageSlug(second.packageName, second.id))
      ?.metadata.displayName,
  ).toBe("第二源");
  await post("/admin/restore", {
    packageName: "same-name",
    packageSlug: slug,
    exactVersion: version,
  });
  expect((await harness.app.request(`/market/${slug}`)).status).toBe(200);
  expect(calls.length).toBe(before);
  expect(count("market_search")).toBe(3);
});

test("远端失败与敏感文本不写入 DB / HTML / error，现有快照保持不变", async () => {
  const source = save();
  const preview = await sources().preview(source.id);
  await harness.application.admin.syncHttp(
    source.id,
    preview.confirmationDigest,
    "first",
  );
  const before = harness.db.query("SELECT * FROM market_publications").all();
  failRemote = true;
  const failed = await post("/admin/http-sources/sync", {
    id: source.id,
    previewDigest: preview.confirmationDigest,
  });
  expect(await failed.text()).not.toContain(marker);
  failRemote = false;
  tools = [
    {
      name: "lookup",
      description: instructions,
      inputSchema: { type: "object" },
    },
  ];
  const rejected = await post("/admin/http-sources/preview", { id: source.id });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(sources().preview(source.id)).rejects.toMatchObject({
      code: "METADATA_INVALID",
      details: {},
    });
    expect(logged).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
    warned.mockRestore();
  }
  const html = await rejected.text();
  expect(html).toContain("HTTP 源操作失败");
  expect(html).not.toContain(marker);
  expect(html).not.toContain('name="previewDigest"');
  expect(harness.db.query("SELECT * FROM market_publications").all()).toEqual(
    before,
  );
  const invalid = await post("/admin/http-sources/save", {
    packageName: "same-name",
    displayName: "bad",
    endpoint: `${endpoint}?token=${marker}`,
  });
  expect(await invalid.text()).not.toContain(marker);
  expect(
    JSON.stringify(harness.db.query("SELECT * FROM market_packages").all()),
  ).not.toContain(marker);
  expect(sources().list()).toHaveLength(1);
});

test("所有后台入口要求 session，所有 mutation 要求同源与 CSRF", async () => {
  expect((await harness.app.request("/admin/http-sources")).status).toBe(303);
  for (const action of ["save", "preview", "sync"]) {
    const path = `/admin/http-sources/${action}`;
    expect(
      (await harness.app.request(path, formRequest(path, {}))).status,
    ).toBe(401);
    expect(
      (await harness.app.request(path, formRequest(path, {}, cookie))).status,
    ).toBe(403);
    const request = formRequest(path, { csrf }, cookie);
    const headers = new Headers(request.headers);
    headers.set("origin", "https://other.example");
    expect(
      (await harness.app.request(path, { ...request, headers })).status,
    ).toBe(403);
  }
  expect(calls).toEqual([]);
});

test("HTTP 发布复用页面刷新失败记录与手动恢复", async () => {
  const source = save();
  const preview = await sources().preview(source.id);
  await blockStaticDir(harness.staticDir);
  const result = await harness.application.admin.syncHttp(
    source.id,
    preview.confirmationDigest,
    "refresh-failed",
  );
  expect(result.catalogChanged).toBe(true);
  expect(result.refresh.outcome).toBe("failed");
  expect(count("market_publications")).toBe(1);
  expect(
    harness.application.catalog.getAdminPackage(result.change.packageSlug)
      ?.lastRefresh?.outcome,
  ).toBe("failed");
  await rm(harness.staticDir);
  await harness.application.publicSite.store.ensureRoot();
  expect(
    (
      await harness.application.admin.retryRefresh(
        result.change.packageSlug,
        "retry",
      )
    ).outcome,
  ).toBe("refreshed");
  expect(count("market_publications")).toBe(1);
});

test("HTTP A→B→A 将既有不可变快照重新设为 latest，当前 latest 重试才 noop", async () => {
  const source = save();
  const a = await sources().preview(source.id);
  await harness.application.admin.syncHttp(
    source.id,
    a.confirmationDigest,
    "a",
  );
  tools.push({ name: "second", inputSchema: { type: "object" } });
  const b = await sources().preview(source.id);
  await harness.application.admin.syncHttp(
    source.id,
    b.confirmationDigest,
    "b",
  );
  tools.pop();
  const restored = await harness.application.admin.syncHttp(
    source.id,
    a.confirmationDigest,
    "a-again",
  );
  expect(restored.change.action).toBe("restore");
  const detail = harness.application.catalog.getPublicPackage(
    toPackageSlug(source.packageName, source.id),
  )!;
  expect(detail.latestVersion).toBe(a.ref.exactVersion);
  expect(count("market_packages")).toBe(1);
  expect(count("market_publications")).toBe(2);
  expect(
    harness.application.catalog.findPublicationState(
      source.id,
      source.packageName,
      a.ref.exactVersion,
    ).publication!.metadataJson,
  ).toBe(a.metadataJson);
  expect(harness.application.catalog.searchPublic({ q: "second" }).total).toBe(
    0,
  );
  expect(
    (
      await harness.application.admin.syncHttp(
        source.id,
        a.confirmationDigest,
        "a-noop",
      )
    ).change.action,
  ).toBe("noop");
});

test("协议保存到原表且使旧预览失效，schema 语义变更改变 digest", async () => {
  const source = save();
  const a = await sources().preview(source.id);
  tools = [
    {
      name: "weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string", enum: ["a"] } },
      },
    },
  ];
  const b = await sources().preview(source.id);
  (
    tools[0] as { inputSchema: { properties: { city: { enum: string[] } } } }
  ).inputSchema.properties.city.enum = ["b"];
  const c = await sources().preview(source.id);
  expect(a.metadataDigest).not.toBe(b.metadataDigest);
  expect(b.metadataDigest).not.toBe(c.metadataDigest);
  const response = await post("/admin/http-sources/save", {
    id: source.id,
    packageName: source.packageName,
    displayName: source.displayName,
    endpoint: source.endpoint,
    revision: String(source.revision),
    protocol: "2026-07-28",
  });
  expect(await response.text()).toContain('value="2026-07-28" selected');
  expect(sources().get(source.id).protocol).toBe("2026-07-28");
  expect(count("market_packages")).toBe(1);
  expect(() => sources().save({ ...source, protocol: "unknown" })).toThrow();
});

test("真实 2026 mcpp 从定义到原表发布完整同步，并返回来源类型", async () => {
  const { createGatewayRoutes } = await import("../../../mcpp/src/gateway.ts");
  const { createAnydocServer } = await import(
    "../../../../examples/anydoc-mcp/src/server.ts"
  );
  const gateway = createGatewayRoutes([
    { path: "/mcp", createServer: createAnydocServer },
  ]);
  const local = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => gateway.fetch(request),
  });
  try {
    const source = sources().save({
      packageName: "anydoc-http",
      displayName: "AnyDoc",
      endpoint: `http://127.0.0.1:${local.port}/mcp`,
      protocol: "2026-07-28",
    });
    const preview = await sources().preview(source.id);
    const outcome = await harness.application.admin.syncHttp(
      source.id,
      preview.confirmationDigest,
      "2026-real",
    );
    expect(outcome.refresh.outcome).toBe("refreshed");
    expect(count("market_packages")).toBe(1);
    expect(count("market_publications")).toBe(1);
    expect(preview.metadata.serverInfo?.name).toBe("anydoc");
    expect(preview.metadata.tools?.[0]?.name).toBe("convert_document");
    expect(
      harness.application.catalog.searchPublic({ q: "convert_document" })
        .items[0]?.sourceKind,
    ).toBe("http");
    expect(preview.metadata.servers[0]!.id).not.toBe("http");
    const second = sources().save({ ...source, id: undefined });
    expect(
      (await sources().preview(second.id)).metadata.servers[0]!.id,
    ).not.toBe(preview.metadata.servers[0]!.id);
  } finally {
    local.stop(true);
    await gateway.close();
  }
});

test("最终入库事务再次校验定义 revision，拒绝预览后的编辑", async () => {
  const source = save();
  const preview = await sources().preview(source.id);
  sources().save({ ...source, displayName: "新名称" });
  expect(() =>
    harness.application.catalog.syncHttp({
      ...preview.ref,
      metadataJson: preview.metadataJson,
      metadataDigest: preview.metadataDigest,
      definitionRevision: preview.definitionRevision,
      requestId: "stale",
    }),
  ).toThrow();
  expect(count("market_publications")).toBe(0);
});

test("保存自动发现完整信息，确认后在连接器、详情和搜索统一展示", async () => {
  extraDiscovery = true;
  const response = await post("/admin/http-sources/save", {
    packageName: "full-connector",
    displayName: "完整连接器",
    endpoint,
  });
  const html = await response.text();
  for (const label of [
    "Tools：1",
    "Skills：1",
    "Resources：3",
    "资源模板：1",
    "Prompts：1",
  ])
    expect(html).toContain(label);
  expect(html).toContain('class="capability-list"');
  expect(html).toContain('id="http-tools"');
  expect(html).toContain('id="http-skills"');
  const rawSnapshot = html.match(
    /<details\b[^>]*data-snapshot-details[^>]*>/,
  )?.[0];
  expect(rawSnapshot).toBeDefined();
  expect(rawSnapshot).not.toMatch(/\sopen(?:\s|>|=)/);
  expect(html.indexOf('action="/admin/http-sources/sync"')).toBeLessThan(
    html.indexOf("data-snapshot-details"),
  );
  expect(html).toContain(`name="csrf" value="${csrf}"`);
  expect(html).toContain('<details class="panel definition" >');
  expect(html).toContain("未发布");
  const source = sources().list()[0]!;
  const slug = toPackageSlug(source.packageName, source.id);
  expect(await (await harness.app.request("/connectors")).text()).not.toContain(
    "完整连接器",
  );
  const digest = /name="previewDigest" value="([a-f0-9]{64})"/.exec(html)![1]!;
  const synced = await post("/admin/http-sources/sync", {
    id: source.id,
    previewDigest: digest,
  });
  const syncedHtml = await synced.text();
  expect(syncedHtml).toContain("已发布");
  expect(syncedHtml).toContain("查看连接器详情");
  expect(count("market_packages")).toBe(1);
  expect(count("market_publications")).toBe(1);
  expect(await (await harness.app.request("/connectors")).text()).toContain(
    "完整连接器",
  );
  const details = await (await harness.app.request(`/market/${slug}`)).text();
  for (const word of [
    "auditing",
    "reporting",
    "reporttemplate",
    "forecasting",
    "weather",
    "服务信息",
    "weather-server",
  ])
    expect(details).toContain(word);
  for (const q of [
    "auditing",
    "reporting",
    "reporttemplate",
    "forecasting",
    "weather",
  ])
    expect(harness.application.catalog.searchPublic({ q }).items[0]?.slug).toBe(
      slug,
    );
  expect(harness.application.catalog.getPublicPackage(slug)?.isExpertTeam).toBe(
    false,
  );
  expect(
    calls.some((method) =>
      ["resources/read", "prompts/get", "tools/call"].includes(method),
    ),
  ).toBe(false);

  const old = sources().preview(source.id);
  const preview = await old;
  const edited = await post("/admin/http-sources/save", {
    id: source.id,
    packageName: source.packageName,
    displayName: "修改待确认",
    endpoint,
  });
  expect(await edited.text()).toContain("当前公开页面使用已确认快照");
  expect(
    harness.application.catalog.getPublicPackage(slug)?.metadata.displayName,
  ).toBe("完整连接器");
  expect((await sources().preview(source.id)).confirmationDigest).not.toBe(
    preview.confirmationDigest,
  );
});

test("所有新增发现字段均参与快照 digest，变化需重新确认", async () => {
  extraDiscovery = true;
  const source = save();
  const client = sources().client;
  const discovery = await client.discover(endpoint, "2025");
  const spy = spyOn(client, "discover");
  try {
    spy.mockResolvedValue(discovery);
    const baseline = await sources().preview(source.id);
    const changes = [
      (value: typeof discovery) => {
        value.skills[0]!.description = "Changed skill";
      },
      (value: typeof discovery) => {
        value.resources[0]!.description = "Changed resource";
      },
      (value: typeof discovery) => {
        value.resourceTemplates[0]!.description = "Changed template";
      },
      (value: typeof discovery) => {
        value.prompts[0]!.description = "Changed prompt";
      },
      (value: typeof discovery) => {
        value.capabilities.resources = { listChanged: true };
      },
      (value: typeof discovery) => {
        value.serverInfo.description = "Changed server";
      },
    ];
    for (const change of changes) {
      const changed = structuredClone(discovery);
      change(changed);
      spy.mockResolvedValue(changed);
      expect((await sources().preview(source.id)).metadataDigest).not.toBe(
        baseline.metadataDigest,
      );
      await expect(
        harness.application.admin.syncHttp(
          source.id,
          baseline.confirmationDigest,
          "changed",
        ),
      ).rejects.toHaveProperty("code", "PREVIEW_CHANGED");
    }
    expect(count("market_publications")).toBe(0);
  } finally {
    spy.mockRestore();
  }
});
