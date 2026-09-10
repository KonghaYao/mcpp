/**
 * End-to-end acceptance.
 *
 * Everything here goes through the real HTTP surface with a real SQLite
 * database, a real static directory and a loopback Registry. This is the suite
 * that proves the documented operator journey, from sign-in to a page a visitor
 * can read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { toPackageSlug } from "../../src/catalog/slug.ts";
import { mcppMetadata, packumentFor } from "../support/packument.ts";
import {
  ADMIN_PASSWORD,
  createHarness,
  formRequest,
  getRequest,
  type Harness,
} from "../support/harness.ts";

const NAME = "acme-investment-team";
const SLUG = toPackageSlug(NAME);

let harness: Harness;
let session: string;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Serves one exact version with the given metadata. */
const serveVersion = (version: string, options: { agents?: boolean } = {}) =>
  harness.setRegistryHandler(() =>
    jsonResponse(
      packumentFor({
        name: NAME,
        version,
        description: "投资研究专家团队",
        keywords: ["investment"],
        mcpp: mcppMetadata({
          displayName: "投资研究专家团队",
          summary: "连接市场数据，完成财报与行业研究",
          agents:
            options.agents === false
              ? []
              : [
                  {
                    id: "financial-analyst",
                    name: "财报解读顾问",
                    description: "分析财务指标",
                  },
                ],
        }),
      }),
    ),
  );

const post = (path: string, body: Record<string, string>) =>
  harness.app.request(
    new Request(`http://localhost${path}`, formRequest(path, body, session)),
  );

const get = (path: string) =>
  harness.app.request(
    new Request(`http://localhost${path}`, getRequest(path, session)),
  );

const publicGet = (path: string) =>
  harness.app.request(new Request(`http://localhost${path}`));

/** Runs preview then confirm, exactly as the console does. */
const publish = async (version: string) => {
  const csrf = harness.csrfOf(await (await get("/admin/publish")).text());
  const preview = await post("/admin/publish/preview", {
    packageName: NAME,
    exactVersion: version,
    csrf,
  });
  const digest = extractDigest(await preview.text());
  expect(digest).not.toBe("");
  return post("/admin/publish", {
    packageName: NAME,
    exactVersion: version,
    previewDigest: digest,
    csrf,
  });
};

/** Pulls the preview digest out of the rendered confirm form. */
const extractDigest = (html: string): string => {
  const match = /name="previewDigest" value="([^"]*)"/.exec(html);
  return match?.[1] ?? "";
};

/**
 * Row counts for the three business tables the Market owns.
 *
 * Scenario 8's second half says a Registry failure writes none of them. These
 * counts are asserted below instead of being inferred from the Registry
 * adapter's shape, so a future refactor that writes a row first and fetches the
 * metadata afterwards stops passing quietly.
 */
const businessRows = () => ({
  packages:
    harness.db
      .query<
        { total: number },
        []
      >("SELECT COUNT(*) AS total FROM market_packages")
      .get()?.total ?? 0,
  publications:
    harness.db
      .query<
        { total: number },
        []
      >("SELECT COUNT(*) AS total FROM market_publications")
      .get()?.total ?? 0,
  operations:
    harness.db
      .query<
        { total: number },
        []
      >("SELECT COUNT(*) AS total FROM admin_operations")
      .get()?.total ?? 0,
});

/** The catalogue a failed Registry call must leave behind: nothing at all. */
const expectEmptyCatalog = () => {
  expect(businessRows()).toEqual({
    packages: 0,
    publications: 0,
    operations: 0,
  });
  expect(harness.application.catalog.getAdminPackage(SLUG)).toBeNull();
};

/** The same guarantee once a package exists: no row added, none regressed. */
const expectCatalogUnchanged = (before: ReturnType<typeof businessRows>) => {
  expect(businessRows()).toEqual(before);
};

beforeEach(async () => {
  harness = await createHarness();
  session = await harness.login();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("health", () => {
  test("reports liveness", async () => {
    const response = await publicGet("/health/live");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("reports readiness including the search index", async () => {
    const response = await publicGet("/health/ready");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      dependencies: { sqlite: "ok", fts5: "ok" },
    });
  });
});

describe("security headers", () => {
  test("are applied to every response", async () => {
    for (const path of ["/", "/market", "/admin/login"]) {
      const response = await publicGet(path);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
    }
  });

  test("give every response a request id", async () => {
    const response = await publicGet("/health/live");
    expect(response.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
  });

  test("accepts a valid request id and replaces an invalid one", async () => {
    const accepted = await harness.app.request(
      new Request("http://localhost/health/live", {
        headers: { "x-request-id": "deploy-check:42" },
      }),
    );
    expect(accepted.headers.get("x-request-id")).toBe("deploy-check:42");

    const rejected = await harness.app.request(
      new Request("http://localhost/health/live", {
        headers: { "x-request-id": "invalid/request/id" },
      }),
    );
    expect(rejected.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);
    expect(rejected.headers.get("x-request-id")).not.toContain("invalid");
  });

  test("never let the console be cached", async () => {
    for (const path of ["/admin", "/admin/publish"]) {
      const response = await get(path);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("publish journey", () => {
  test("makes a published version visible to anonymous visitors", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");

    const detail = await publicGet(`/market/${SLUG}`);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain("投资研究专家团队");
    expect(html).toContain("财报解读顾问");
    expect(html).toContain("1.0.0");

    const version = await publicGet(`/market/${SLUG}/v/1.0.0`);
    expect(version.status).toBe(200);

    const list = await publicGet("/market");
    expect(await list.text()).toContain("投资研究专家团队");
  });

  test("moves latest to the newest published version", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    await serveVersion("1.1.0");
    await publish("1.1.0");

    const html = await (await publicGet(`/market/${SLUG}`)).text();
    expect(html).toContain("1.1.0");
    expect(html).toContain("1.0.0");
    expect(
      harness.application.catalog.getPublicPackage(SLUG)?.latestVersion,
    ).toBe("1.1.0");
  });

  test("does not publish a version the operator never previewed", async () => {
    // No `previewDigest` is sent, which is what a hand-rolled request looks like.
    const response = await post("/admin/publish", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("输入不合法");
    expect(harness.application.catalog.getPublicPackage(SLUG)).toBeNull();
  });

  test("stops when the Registry changes between preview and confirm", async () => {
    await serveVersion("1.0.0");
    const page = await (await get("/admin/publish")).text();
    const csrf = harness.csrfOf(page);
    const preview = await post("/admin/publish/preview", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf,
    });
    const digest = extractDigest(await preview.text());
    expect(digest).not.toBe("");

    // The maintainer republishes the same version with different metadata.
    harness.setRegistryHandler(() =>
      jsonResponse(
        packumentFor({
          name: NAME,
          version: "1.0.0",
          description: "换了内容",
        }),
      ),
    );

    const confirm = await post("/admin/publish", {
      packageName: NAME,
      exactVersion: "1.0.0",
      previewDigest: digest,
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    const html = await confirm.text();
    expect(html).toContain("预览内容已更新");
    expect(harness.application.catalog.getPublicPackage(SLUG)).toBeNull();
  });

  test("keeps the snapshot after the Registry stops serving the version", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");

    harness.setRegistryHandler(() => jsonResponse({ error: "gone" }, 404));
    const html = await (await publicGet(`/market/${SLUG}`)).text();
    expect(html).toContain("投资研究专家团队");
  });

  test("reports a missing package to the operator", async () => {
    harness.setRegistryHandler(() => jsonResponse({ error: "no" }, 404));
    const response = await post("/admin/publish/preview", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    expect(await response.text()).toContain("Registry 中不存在该 package");
    // The other half of scenario 8: the failed lookup wrote nothing either.
    expectEmptyCatalog();
  });

  test("reports an invalid package name without contacting the Registry", async () => {
    const response = await post("/admin/publish/preview", {
      packageName: "../etc/passwd",
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    expect(await response.text()).toContain("输入不合法");
    expect(harness.registry.requests).toEqual([]);
  });
});

/**
 * The anonymous surface as a browser receives it: one style block, no script,
 * nothing off-origin, and a page cache whose behaviour the URL cannot change.
 */
describe("public chrome", () => {
  test("serves the pre-rendered pages with the documented page cache header", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");

    for (const path of ["/", "/market"]) {
      const response = await publicGet(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe(
        "public, max-age=60",
      );
    }
  });

  test("answers any query string with the same cached catalogue document", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");

    const plain = await publicGet("/market");
    const queried = await publicGet("/market?limit=1&offset=24");
    const html = await queried.text();

    expect(queried.headers.get("cache-control")).toBe("public, max-age=60");
    expect(html).toBe(await plain.text());
    // The cached route never reads the query string, so the page must not offer
    // a control that would depend on one.
    expect(html).not.toContain("offset=");
    expect(html).not.toContain('class="pager"');
  });

  test("escapes a hostile search query and keeps the page uncached", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");

    const response = await publicGet(
      `/search?q=${encodeURIComponent("<script>alert(1)</script>")}`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("ships no script and no off-origin reference to any visitor page", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");

    for (const path of [
      "/",
      "/market",
      `/market/${SLUG}`,
      `/market/${SLUG}/v/1.0.0`,
      "/search?q=investment",
    ]) {
      const html = await (await publicGet(path)).text();
      expect(html, path).toContain('<a class="skip-link" href="#main">');
      expect(html, path).toContain('<label class="sr-only" for="site-search">');
      expect(html.match(/<style>/g)?.length, path).toBe(1);
      expect(html, path).not.toContain("<script");
      expect(html, path).not.toContain("<link");
      expect(html, path).not.toContain("https://");
      expect(html, path).not.toContain("http://");
    }
  });
});

/**
 * Scenario 8, second half: every Registry failure maps to a stable error code
 * *and* leaves the catalogue untouched. The counts are read straight from the
 * database, so the guarantee no longer rests on the Registry adapter happening
 * to own no database handle.
 */
describe("Registry failure isolation", () => {
  test("writes nothing when the metadata is not usable", async () => {
    // A 200 that is not the JSON packument the normaliser requires.
    harness.setRegistryHandler(
      () => new Response("<html></html>", { status: 200 }),
    );
    const response = await post("/admin/publish/preview", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    expect(await response.text()).toContain(
      "该版本的元数据结构不合法或不支持。",
    );
    expectEmptyCatalog();
  });

  test("writes nothing when the Registry rate limits the preview", async () => {
    harness.setRegistryHandler(
      () => new Response("slow down", { status: 429 }),
    );
    const response = await post("/admin/publish/preview", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    expect(await response.text()).toContain("Registry 限流，请稍后重试。");
    expectEmptyCatalog();
  });

  test("writes nothing when the Registry fails between preview and confirm", async () => {
    await serveVersion("1.0.0");
    const preview = await post("/admin/publish/preview", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    const digest = extractDigest(await preview.text());
    expect(digest).not.toBe("");

    // The Registry breaks after the operator has already confirmed: this is the
    // window a write-first implementation would leak a package row through.
    harness.setRegistryHandler(() => new Response("boom", { status: 503 }));

    const confirm = await post("/admin/publish", {
      packageName: NAME,
      exactVersion: "1.0.0",
      previewDigest: digest,
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    expect(await confirm.text()).toContain("无法连接 Registry，请稍后重试。");
    expectEmptyCatalog();
  });

  test("leaves an existing package and its audit trail untouched", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    const before = businessRows();
    expect(before).toEqual({ packages: 1, publications: 1, operations: 1 });

    // The Registry loses the package the operator now tries to add.
    harness.setRegistryHandler(() => jsonResponse({ error: "no" }, 404));
    const preview = await post("/admin/publish/preview", {
      packageName: NAME,
      exactVersion: "1.1.0",
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    expect(await preview.text()).toContain("Registry 中不存在该 package");
    expectCatalogUnchanged(before);

    // A confirm carrying a digest the Registry can no longer verify fails the
    // same way rather than adding the version it could not read.
    const confirm = await post("/admin/publish", {
      packageName: NAME,
      exactVersion: "1.1.0",
      previewDigest: "digest-from-an-earlier-preview",
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });
    expect(await confirm.text()).toContain("Registry 中不存在该 package");
    expectCatalogUnchanged(before);

    const detail = harness.application.catalog.getAdminPackage(SLUG);
    expect(detail?.latestVersion).toBe("1.0.0");
    expect(detail?.versions.map((entry) => entry.version)).toEqual(["1.0.0"]);
  });
});

describe("withdrawal journey", () => {
  test("moves latest back when the newest version is withdrawn", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    await serveVersion("1.1.0");
    await publish("1.1.0");

    const page = await (await get(`/admin/packages/${SLUG}`)).text();
    const response = await post("/admin/unpublish", {
      packageName: NAME,
      exactVersion: "1.1.0",
      csrf: harness.csrfOf(page),
    });
    expect(response.status).toBe(200);

    expect(
      harness.application.catalog.getPublicPackage(SLUG)?.latestVersion,
    ).toBe("1.0.0");
    expect((await publicGet(`/market/${SLUG}/v/1.1.0`)).status).toBe(404);
    expect((await publicGet(`/market/${SLUG}/v/1.0.0`)).status).toBe(200);
  });

  test("hides the package when nothing is left", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    const page = await (await get(`/admin/packages/${SLUG}`)).text();
    await post("/admin/unpublish", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(page),
    });

    expect((await publicGet(`/market/${SLUG}`)).status).toBe(404);
    expect((await publicGet("/market")).text()).resolves.toBeDefined();
    expect(
      (await (await publicGet("/market")).text()).includes("投资研究专家团队"),
    ).toBe(false);
    // The package is still in the console so it can be brought back.
    expect((await get(`/admin/packages/${SLUG}`)).status).toBe(200);
  });

  test("restores from the stored snapshot without reading the Registry again", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    await post("/admin/unpublish", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get(`/admin/packages/${SLUG}`)).text()),
    });

    // The Registry is now unreachable.
    harness.setRegistryHandler(() => new Response("down", { status: 503 }));
    harness.registry.requests.length = 0;

    const response = await post("/admin/restore", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get(`/admin/packages/${SLUG}`)).text()),
    });
    expect(response.status).toBe(200);
    expect(harness.registry.requests).toEqual([]);
    expect((await publicGet(`/market/${SLUG}`)).status).toBe(200);
  });

  test("leaves no page behind for a withdrawn version", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    await post("/admin/unpublish", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get(`/admin/packages/${SLUG}`)).text()),
    });

    const packageDir = join(harness.staticDir, "market", SLUG);
    const exists = await stat(packageDir).catch(() => null);
    expect(exists).toBeNull();
  });
});

describe("mutation guards", () => {
  test("rejects a mutation without a session", async () => {
    const response = await harness.app.request(
      new Request("http://localhost/admin/unpublish", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost",
          host: "localhost",
        },
        body: new URLSearchParams({
          packageName: NAME,
          exactVersion: "1.0.0",
        }).toString(),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("rejects a mutation with a missing or wrong CSRF token", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");

    for (const csrf of ["", "wrong-token"]) {
      const response = await post("/admin/unpublish", {
        packageName: NAME,
        exactVersion: "1.0.0",
        csrf,
      });
      expect(response.status).toBe(403);
    }
    expect(harness.application.catalog.getPublicPackage(SLUG)).not.toBeNull();
  });

  test("rejects a cross-origin mutation even with a valid session", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    const csrf = harness.csrfOf(
      await (await get(`/admin/packages/${SLUG}`)).text(),
    );

    const response = await harness.app.request(
      new Request("http://localhost/admin/unpublish", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://attacker.example",
          host: "localhost",
          cookie: `mcpm_admin=${session}`,
        },
        body: new URLSearchParams({
          packageName: NAME,
          exactVersion: "1.0.0",
          csrf,
        }).toString(),
      }),
    );
    expect(response.status).toBe(403);
    expect(harness.application.catalog.getPublicPackage(SLUG)).not.toBeNull();
  });

  test("requires the same mutation guard when signing out", async () => {
    const csrf = harness.csrfOf(await (await get("/admin/publish")).text());

    const missingSession = await harness.app.request(
      new Request(
        "http://localhost/admin/logout",
        formRequest("/admin/logout", { csrf }),
      ),
    );
    expect(missingSession.status).toBe(401);

    const missingCsrf = await post("/admin/logout", {});
    expect(missingCsrf.status).toBe(403);

    const crossOrigin = await harness.app.request(
      new Request("http://localhost/admin/logout", {
        ...formRequest("/admin/logout", { csrf }, session),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://attacker.example",
          host: "localhost",
          cookie: `mcpm_admin=${session}`,
        },
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const valid = await post("/admin/logout", { csrf });
    expect(valid.status).toBe(303);
    expect(valid.headers.get("location")).toBe("/admin/login");
    expect(valid.headers.get("set-cookie")).toContain("mcpm_admin=");
  });
});

describe("console", () => {
  test("lists a published package with its latest version", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    const html = await (await get("/admin")).text();
    expect(html).toContain(NAME);
    expect(html).toContain("1.0.0");
  });

  test("shows both visible and hidden versions", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    await serveVersion("1.1.0");
    await publish("1.1.0");
    await post("/admin/unpublish", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf: harness.csrfOf(await (await get(`/admin/packages/${SLUG}`)).text()),
    });

    const html = await (await get(`/admin/packages/${SLUG}`)).text();
    expect(html).toContain("1.0.0");
    expect(html).toContain("1.1.0");
    expect(html).toContain("恢复");
  });

  test("reports an unknown package in the console as not found", async () => {
    expect((await get("/admin/packages/p-unknown")).status).toBe(404);
  });

  test("regenerates pages on request without changing the catalogue", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    const before = harness.application.catalog.getPublicPackage(SLUG);

    const response = await post("/admin/refresh", {
      packageSlug: SLUG,
      csrf: harness.csrfOf(await (await get(`/admin/packages/${SLUG}`)).text()),
    });
    expect(await response.text()).toContain("公开页面已重新生成");
    expect(
      harness.application.catalog.getPublicPackage(SLUG)?.latestVersion,
    ).toBe(before?.latestVersion);
  });

  test("reports a page failure separately from a catalogue change", async () => {
    const { rm, writeFile } = await import("node:fs/promises");
    await rm(harness.staticDir, { recursive: true, force: true });
    await writeFile(harness.staticDir, "blocked", "utf8");

    await serveVersion("1.0.0");
    const csrf = harness.csrfOf(await (await get("/admin/publish")).text());
    const preview = await post("/admin/publish/preview", {
      packageName: NAME,
      exactVersion: "1.0.0",
      csrf,
    });
    const digest = extractDigest(await preview.text());
    const response = await post("/admin/publish", {
      packageName: NAME,
      exactVersion: "1.0.0",
      previewDigest: digest,
      csrf: harness.csrfOf(await (await get("/admin/publish")).text()),
    });

    // The catalogue change is reported as done; the page cache is not.
    expect(await response.text()).toContain("已更新");
    expect(
      harness.application.catalog.getPublicPackage(SLUG)?.latestVersion,
    ).toBe("1.0.0");
    const [entry] = harness.application.catalog.listAdminPackages();
    expect(entry?.lastRefresh?.outcome).toBe("failed");
  });
});

describe("stale page fallback", () => {
  /**
   * The documented degradation: a failed refresh never rolls back the
   * catalogue, and visitors keep being served the last page that was fully
   * written rather than an error.
   */
  test("keeps serving the previous page when the cache cannot be updated", async () => {
    // Directory permissions do not constrain a privileged test runner.
    if (process.getuid?.() === 0) return;

    await serveVersion("1.0.0");
    await publish("1.0.0");
    expect(await (await publicGet(`/market/${SLUG}`)).text()).toContain(
      "1.0.0",
    );

    const { chmod } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const packageDir = join(harness.staticDir, "market", SLUG);
    await chmod(packageDir, 0o500);
    try {
      await serveVersion("1.1.0");
      const response = await publish("1.1.0");

      // The operator is told the catalogue moved but the cache did not.
      expect(await response.text()).toContain("刷新失败");
      expect(
        harness.application.catalog.getPublicPackage(SLUG)?.latestVersion,
      ).toBe("1.1.0");

      // Visitors still get the complete previous document.
      const stale = await (await publicGet(`/market/${SLUG}`)).text();
      expect(stale).toContain("1.0.0");
      expect(stale).not.toContain("1.1.0");
    } finally {
      await chmod(packageDir, 0o700);
    }
  });

  /**
   * The other half of the degradation rule: pages that were already written keep
   * serving while the database itself is unreachable, so a database outage does
   * not take the public site down with it.
   */
  test("keeps serving written pages while the database is unreachable", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");

    // A real SQLite failure rather than a simulated one.
    harness.db.close();

    // The cache-first routes never consult the catalogue at all.
    expect((await publicGet("/")).status).toBe(200);
    expect((await publicGet("/market")).status).toBe(200);

    // Detail routes settle visibility before trusting the cache; an
    // unanswerable catalogue falls back to the page that was written.
    const detail = await publicGet(`/market/${SLUG}`);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("投资研究专家团队");
    expect((await publicGet(`/market/${SLUG}/v/1.0.0`)).status).toBe(200);
  });

  /**
   * A failed lookup must not be published as a withdrawal. 404 says "this
   * package is not in the market"; 503 says "try again", and only the second is
   * true when the catalogue cannot be read.
   */
  test("reports a temporary failure instead of a missing package", async () => {
    harness.db.close();

    for (const path of [
      "/market",
      `/market/${SLUG}`,
      `/market/${SLUG}/v/1.0.0`,
      "/search?q=investment",
    ]) {
      const response = await publicGet(path);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("暂时不可用");
    }

    // An unknown slug is still an ordinary 404: the catalogue answered.
    expect((await publicGet("/market/p-unknown")).status).toBe(404);
  });
});

describe("secret handling", () => {
  test("never renders the configured password or session secret", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");

    const pages = await Promise.all(
      ["/", "/market", `/market/${SLUG}`, "/admin", "/admin/publish"].map(
        async (path) => (await get(path)).text(),
      ),
    );
    for (const html of pages) {
      expect(html).not.toContain(ADMIN_PASSWORD);
      expect(html).not.toContain(harness.config.sessionSecret);
      expect(html).not.toContain(harness.config.adminPasswordHash);
    }
  });

  test("does not leak the session token into any rendered page", async () => {
    const html = await (await get("/admin")).text();
    expect(html).not.toContain(session);
  });

  test("leaves no stray files in the static directory", async () => {
    await serveVersion("1.0.0");
    await publish("1.0.0");
    const entries = await readdir(harness.staticDir);
    expect(entries.filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
