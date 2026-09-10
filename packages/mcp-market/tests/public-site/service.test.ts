/**
 * Public page cache behaviour.
 *
 * The catalogue is the source of truth and the pages are a cache, so these
 * tests check the two halves of that contract: the cache always reflects the
 * current catalogue, and a cache that cannot be written never changes the
 * catalogue.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  HOME_PATH,
  MARKET_PATH,
  packagePath,
  versionPath,
} from "../../src/public-site/service.ts";
import { toPackageSlug } from "../../src/catalog/slug.ts";
import { AppError } from "../../src/errors.ts";
import { mcppMetadata, packumentFor } from "../support/packument.ts";
import {
  blockStaticDir,
  createHarness,
  formRequest,
  type Harness,
} from "../support/harness.ts";

const NAME = "acme-investment-team";
const SLUG = toPackageSlug(NAME);

let harness: Harness;

/** Publishes one exact version through the application service. */
const publish = async (version: string, agents = true) => {
  harness.setRegistryHandler(
    () =>
      new Response(
        JSON.stringify(
          packumentFor({
            name: NAME,
            version,
            description: "投资研究专家团队",
            mcpp: mcppMetadata({
              displayName: "投资研究专家团队",
              agents: agents
                ? [{ id: "financial-analyst", name: "财报解读顾问" }]
                : [],
            }),
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const preview = await harness.application.admin.preview(NAME, version);
  return harness.application.admin.publish({
    packageName: NAME,
    exactVersion: version,
    previewDigest: preview.metadataDigest,
    requestId: "req-test",
  });
};

const unpublish = (version: string) =>
  harness.application.admin.unpublish({
    packageName: NAME,
    exactVersion: version,
    requestId: "req-test",
  });

/** Publishes one exact version of an arbitrary package through the service. */
const publishPackage = async (
  packageName: string,
  version: string,
  displayName: string,
) => {
  harness.setRegistryHandler(({ packageName: requested }) =>
    requested === packageName
      ? new Response(
          JSON.stringify(
            packumentFor({
              name: packageName,
              version,
              description: displayName,
              mcpp: mcppMetadata({ displayName }),
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : new Response("{}", { status: 404 }),
  );
  const preview = await harness.application.admin.preview(packageName, version);
  return harness.application.admin.publish({
    packageName,
    exactVersion: version,
    previewDigest: preview.metadataDigest,
    requestId: "req-test",
  });
};

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("page generation", () => {
  test("writes the chrome, package page and version page on publish", async () => {
    const outcome = await publish("1.0.0");
    expect(outcome.refresh.outcome).toBe("refreshed");

    const store = harness.application.publicSite.store;
    expect(await store.read(HOME_PATH)).not.toBeNull();
    expect(await store.read(MARKET_PATH)).not.toBeNull();
    expect(await store.read(packagePath(SLUG))).not.toBeNull();
    expect(await store.read(versionPath(SLUG, "1.0.0"))).not.toBeNull();
  });

  test("the written page contains the published metadata", async () => {
    await publish("1.0.0");
    const page = await harness.application.publicSite.store.read(
      packagePath(SLUG),
    );
    expect(page).toContain("投资研究专家团队");
    expect(page).toContain("财报解读顾问");
  });

  test("keeps a page per visible version", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    const store = harness.application.publicSite.store;
    expect(await store.read(versionPath(SLUG, "1.0.0"))).not.toBeNull();
    expect(await store.read(versionPath(SLUG, "1.1.0"))).not.toBeNull();
  });

  test("escapes metadata so a package cannot inject markup", async () => {
    harness.setRegistryHandler(
      () =>
        new Response(
          JSON.stringify(
            packumentFor({
              name: NAME,
              version: "1.0.0",
              description: "<script>alert(1)</script>",
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const preview = await harness.application.admin.preview(NAME, "1.0.0");
    await harness.application.admin.publish({
      packageName: NAME,
      exactVersion: "1.0.0",
      previewDigest: preview.metadataDigest,
      requestId: "req-test",
    });

    const page = await harness.application.publicSite.store.read(
      packagePath(SLUG),
    );
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
  });
});

describe("withdrawing pages", () => {
  test("removes the page of a version that is no longer visible", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    await unpublish("1.0.0");

    const store = harness.application.publicSite.store;
    expect(await store.read(versionPath(SLUG, "1.0.0"))).toBeNull();
    expect(await store.read(versionPath(SLUG, "1.1.0"))).not.toBeNull();
  });

  test("removes the whole package tree once nothing is visible", async () => {
    await publish("1.0.0");
    await unpublish("1.0.0");

    const store = harness.application.publicSite.store;
    expect(await store.read(packagePath(SLUG))).toBeNull();
    expect(await store.read(versionPath(SLUG, "1.0.0"))).toBeNull();
    // The list page still exists, just without this package.
    expect(await store.read(MARKET_PATH)).not.toBeNull();
  });

  test("restores the pages from the stored snapshot without touching NPM", async () => {
    await publish("1.0.0");
    await unpublish("1.0.0");
    harness.registry.requests.length = 0;

    const outcome = await harness.application.admin.publish({
      packageName: NAME,
      exactVersion: "1.0.0",
      previewDigest: null,
      requestId: "req-test",
    });

    expect(outcome.change.action).toBe("restore");
    expect(harness.registry.requests).toEqual([]);
    const page = await harness.application.publicSite.store.read(
      packagePath(SLUG),
    );
    expect(page).toContain("投资研究专家团队");
  });
});

describe("refresh failure", () => {
  /** Makes page writes fail while leaving the catalogue writable. */
  const breakPages = async () => {
    await blockStaticDir(harness.staticDir);
  };

  test("keeps the catalogue change and reports the failure", async () => {
    await breakPages();
    const outcome = await publish("1.0.0");

    expect(outcome.catalogChanged).toBe(true);
    expect(outcome.refresh.outcome).toBe("failed");
    expect(outcome.refresh.errorCode).not.toBeNull();

    // The publication is real even though no page could be written.
    const detail = harness.application.catalog.getPublicPackage(SLUG);
    expect(detail?.latestVersion).toBe("1.0.0");
  });

  test("records the failed attempt for the operator", async () => {
    await breakPages();
    await publish("1.0.0");
    const [entry] = harness.application.catalog.listAdminPackages();
    expect(entry?.lastRefresh?.outcome).toBe("failed");
  });

  test("recovers on retry once the directory is usable again", async () => {
    await breakPages();
    await publish("1.0.0");

    // Replace the blocking file with a real directory, as an operator who fixed
    // the mount would.
    const { mkdir, rm } = await import("node:fs/promises");
    await rm(harness.staticDir, { force: true });
    await mkdir(harness.staticDir, { recursive: true });

    const result = await harness.application.admin.retryRefresh(
      SLUG,
      "req-retry",
    );
    expect(result.outcome).toBe("refreshed");
    expect(
      await harness.application.publicSite.store.read(packagePath(SLUG)),
    ).not.toBeNull();
  });

  test("does not move latest when a retry runs", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    await harness.application.admin.retryRefresh(SLUG, "req-retry");

    const detail = harness.application.catalog.getPublicPackage(SLUG);
    expect(detail?.latestVersion).toBe("1.1.0");
  });

  test("rebuilds every page from the catalogue", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    await harness.application.publicSite.store.remove("market", true);

    const result = await harness.application.admin.rebuildPublicPages("req");
    expect(result.outcome).toBe("refreshed");

    const store = harness.application.publicSite.store;
    expect(await store.read(HOME_PATH)).not.toBeNull();
    expect(await store.read(MARKET_PATH)).not.toBeNull();
    expect(await store.read(packagePath(SLUG))).not.toBeNull();
    expect(await store.read(versionPath(SLUG, "1.0.0"))).not.toBeNull();
  });

  test("reports an unknown package to the operator", async () => {
    await expect(
      harness.application.admin.retryRefresh("p-unknown", "req"),
    ).rejects.toThrow(AppError);
  });

  /**
   * Recovery is a plain re-render, so an operator who clicks twice must get the
   * same result rather than a second catalogue change or a partially applied
   * page set.
   */
  test("produces the same pages when the operator retries twice", async () => {
    await publish("1.0.0");
    const store = harness.application.publicSite.store;

    const first = await harness.application.admin.retryRefresh(SLUG, "req-1");
    const afterFirst = await store.read(packagePath(SLUG));
    const second = await harness.application.admin.retryRefresh(SLUG, "req-2");

    expect(first.outcome).toBe("refreshed");
    expect(second.outcome).toBe("refreshed");
    expect(await store.read(packagePath(SLUG))).toBe(afterFirst);
    expect(
      harness.application.catalog.getPublicPackage(SLUG)?.latestVersion,
    ).toBe("1.0.0");
  });

  /**
   * Invalidation is per package: another package's pages must survive a
   * publication unchanged, which is what keeps a transient mix of generations
   * bounded to the package that actually moved.
   */
  test("only touches the pages of the package that changed", async () => {
    const other = "@acme/report-editor";
    const otherSlug = toPackageSlug(other);
    await publish("1.0.0");
    await publishPackage(other, "2.0.0", "报告编辑专家");

    const store = harness.application.publicSite.store;
    const untouched = await store.read(packagePath(otherSlug));
    expect(untouched).not.toBeNull();

    await publish("1.1.0");

    expect(await store.read(packagePath(otherSlug))).toBe(untouched);
    expect(await store.read(versionPath(otherSlug, "2.0.0"))).not.toBeNull();
    expect(await store.read(packagePath(SLUG))).toContain("1.1.0");
  });

  /**
   * The swap is temp-file-then-rename, so a write that cannot even create its
   * temporary file must leave the previous document untouched. Writing is
   * blocked on the package directory itself — the exact directory holding the
   * page being replaced — rather than on the cache root.
   */
  test("keeps the previous page byte-identical when the update cannot be written", async () => {
    // A privileged test runner ignores directory permissions.
    if (process.getuid?.() === 0) return;

    await publish("1.0.0");
    const store = harness.application.publicSite.store;
    const target = packagePath(SLUG);
    const before = await store.read(target);
    expect(before).not.toBeNull();

    const packageDir = join(harness.staticDir, "market", SLUG);
    await chmod(packageDir, 0o500);
    try {
      const outcome = await publish("1.1.0");
      expect(outcome.catalogChanged).toBe(true);
      expect(outcome.refresh.outcome).toBe("failed");
      expect(outcome.refresh.errorCode).not.toBeNull();

      // The catalogue moved on...
      expect(
        harness.application.catalog.getPublicPackage(SLUG)?.latestVersion,
      ).toBe("1.1.0");
      // ...but the page on disk is still the complete previous document: not
      // truncated, not half-written, not silently replaced.
      const after = await store.read(target);
      expect(after).toBe(before);
      expect(after).toContain("1.0.0");
      expect(after).not.toContain("1.1.0");
    } finally {
      await chmod(packageDir, 0o700);
    }

    // Pages converge once the directory is writable again.
    const retried = await harness.application.admin.retryRefresh(SLUG, "req");
    expect(retried.outcome).toBe("refreshed");
    const recovered = await store.read(target);
    expect(recovered).not.toBe(before);
    expect(recovered).toContain("1.1.0");
  });
});

describe("public read path", () => {
  test("serves a page without touching the Registry", async () => {
    await publish("1.0.0");
    harness.registry.requests.length = 0;

    const response = await harness.app.request(
      new Request(`http://localhost/market/${SLUG}`),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("投资研究专家团队");
    expect(harness.registry.requests).toEqual([]);
  });

  test("renders on demand when the cache file is missing", async () => {
    await publish("1.0.0");
    await harness.application.publicSite.store.remove(packagePath(SLUG));

    const response = await harness.app.request(
      new Request(`http://localhost/market/${SLUG}`),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("投资研究专家团队");
  });

  test("hides a withdrawn package and version with the same status", async () => {
    await publish("1.0.0");
    await unpublish("1.0.0");

    const detail = await harness.app.request(
      new Request(`http://localhost/market/${SLUG}`),
    );
    const version = await harness.app.request(
      new Request(`http://localhost/market/${SLUG}/v/1.0.0`),
    );
    const missing = await harness.app.request(
      new Request(`http://localhost/market/p-unknown`),
    );

    expect(detail.status).toBe(404);
    expect(version.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await detail.text()).toBe(await missing.text());
  });

  test("rejects a non-canonical slug before any lookup", async () => {
    await publish("1.0.0");
    const response = await harness.app.request(
      new Request(`http://localhost/market/not-a-slug`),
    );
    expect(response.status).toBe(404);
  });

  test("serves search dynamically and never caches it", async () => {
    await publish("1.0.0");
    const response = await harness.app.request(
      new Request("http://localhost/search?q=investment"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("投资研究专家团队");
  });
});

/**
 * The design system as it lands on disk.
 *
 * These assertions are about the artifacts a visitor is actually served — the
 * written pages, not a function called in isolation — which is where a chrome
 * regression would otherwise survive unnoticed.
 */
describe("cached page chrome", () => {
  const pagePaths = () => [
    HOME_PATH,
    MARKET_PATH,
    packagePath(SLUG),
    versionPath(SLUG, "1.0.0"),
  ];

  test("writes the same shell into every cached page", async () => {
    await publish("1.0.0");
    const store = harness.application.publicSite.store;

    for (const path of pagePaths()) {
      const page = await store.read(path);
      expect(page, path).not.toBeNull();
      expect(page, path).toContain('<a class="skip-link" href="#main">');
      expect(page, path).toContain('<main id="main" tabindex="-1">');
      expect(page, path).toContain(
        '<label class="sr-only" for="site-search">搜索能力</label>',
      );
      expect(page?.match(/<style>/g)?.length, path).toBe(1);
      expect(page, path).not.toContain("<script");
      expect(page, path).not.toContain("<link");
      expect(page, path).not.toContain("<img");
      // No origin at all: every page is self-contained by construction.
      expect(page, path).not.toContain("http://");
      expect(page, path).not.toContain("https://");
      // Styling is a fixed class vocabulary, never a data-carrying attribute.
      expect(page, path).not.toContain('style="');
    }
  });

  test("marks the section each cached page belongs to", async () => {
    await publish("1.0.0");
    const store = harness.application.publicSite.store;

    expect(await store.read(HOME_PATH)).not.toContain('aria-current="page">');
    for (const path of [
      MARKET_PATH,
      packagePath(SLUG),
      versionPath(SLUG, "1.0.0"),
    ])
      expect(await store.read(path), path).toContain(
        '<a href="/market" aria-current="page">能力目录</a>',
      );
  });

  test("draws the rig from the published snapshot and invents nothing", async () => {
    // This fixture declares one agent and no MCP server.
    await publish("1.0.0");
    const page = await harness.application.publicSite.store.read(
      packagePath(SLUG),
    );
    expect(page).toContain("<strong>1</strong> 位专家");
    expect(page).not.toContain("个连接器");
  });

  test("offers no offset pager on the cached catalogue page", async () => {
    await publish("1.0.0");
    const page = await harness.application.publicSite.store.read(MARKET_PATH);

    expect(page).not.toContain("offset=");
    expect(page).not.toContain("上一页");
    expect(page).not.toContain("下一页");
    expect(page).toContain("共 1 个公开条目");
  });

  test("regenerates the shared pages when another package is published", async () => {
    await publish("1.0.0");
    const store = harness.application.publicSite.store;
    const before = await store.read(MARKET_PATH);
    expect(before).not.toContain("报告编辑专家");

    await publishPackage("@acme/report-editor", "2.0.0", "报告编辑专家");

    const after = await store.read(MARKET_PATH);
    expect(after).not.toBe(before);
    expect(after).toContain("报告编辑专家");
  });

  test("turns this page's keywords into encoded search links", async () => {
    const tooLong = "k".repeat(30);
    const keywords = [
      "investment",
      "投研 & 数据",
      "<script>x</script>",
      tooLong,
    ];
    harness.setRegistryHandler(
      () =>
        new Response(
          JSON.stringify(
            packumentFor({
              name: NAME,
              version: "1.0.0",
              description: "投资研究专家团队",
              keywords,
              mcpp: mcppMetadata({
                displayName: "投资研究专家团队",
                agents: [{ id: "financial-analyst", name: "财报解读顾问" }],
              }),
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const preview = await harness.application.admin.preview(NAME, "1.0.0");
    await harness.application.admin.publish({
      packageName: NAME,
      exactVersion: "1.0.0",
      previewDigest: preview.metadataDigest,
      requestId: "req-test",
    });

    const page = await harness.application.publicSite.store.read(MARKET_PATH);
    expect(page).toContain("本页关键词");
    expect(page).toContain('href="/search?q=investment"');
    expect(page).toContain(
      `href="/search?q=${encodeURIComponent("投研 & 数据")}"`,
    );
    // A keyword is data: it can never become markup, only an escaped link.
    expect(page).toContain(
      `href="/search?q=${encodeURIComponent("<script>x</script>")}"`,
    );
    expect(page).not.toContain("<script");
    // And the entry point is bounded: an oversized keyword is not a chip.
    expect(page).not.toContain(
      `href="/search?q=${encodeURIComponent(tooLong)}"`,
    );
  });
});
