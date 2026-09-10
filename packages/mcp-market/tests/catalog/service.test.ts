/**
 * Catalogue publication rules.
 *
 * These tests pin the rules that no other layer may reimplement: strict
 * idempotency, restore from the immutable snapshot, `latest` movement and
 * fallback, and the invariant that a visible package always has a latest.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogService, monotonicInstant } from "../../src/catalog/service.ts";
import { toPackageSlug } from "../../src/catalog/slug.ts";
import { openDatabase, type Db } from "../../src/db/database.ts";
import { AppError } from "../../src/errors.ts";
import { agent, snapshotRecord } from "../support/snapshot.ts";

const PACKAGE = "acme-investment-team";
const SOURCE = "npm";

let root: string;
let db: Db;
let catalog: CatalogService;

const publish = async (
  version: string,
  options: { agents?: boolean; requestId?: string } = {},
) => {
  const record = await snapshotRecord({
    name: PACKAGE,
    version,
    displayName: "投资研究专家团队",
    agents:
      options.agents === false
        ? []
        : [agent("financial-analyst", "财报解读顾问", "分析财务指标")],
  });
  return catalog.publish({
    sourceId: SOURCE,
    packageName: PACKAGE,
    exactVersion: version,
    metadataJson: record.metadataJson,
    metadataDigest: record.metadataDigest,
    requestId: options.requestId ?? "req-test",
  });
};

const unpublish = (version: string) =>
  catalog.unpublish({
    sourceId: SOURCE,
    packageName: PACKAGE,
    exactVersion: version,
    requestId: "req-test",
  });

/**
 * Seeds one publication straight into storage.
 *
 * The service's logical clock never lets two publications share an instant, so
 * a timestamp tie — the case the `id` tiebreak exists for — is only reachable
 * from below the service. Everything after the seeding goes through the service
 * again, so the rule under test is still the production one.
 */
const seedPublication = async (input: {
  id: string;
  packageId: string;
  version: string;
  publishedAt: string;
}): Promise<void> => {
  const record = await snapshotRecord({
    name: PACKAGE,
    version: input.version,
    displayName: "投资研究专家团队",
    agents: [agent("financial-analyst", "财报解读顾问", "分析财务指标")],
  });
  db.query(
    `INSERT INTO market_publications
       (id, package_id, exact_version, metadata_json, metadata_digest,
        first_published_at, published_at, unpublished_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,NULL,?,?)`,
  ).run(
    input.id,
    input.packageId,
    input.version,
    record.metadataJson,
    record.metadataDigest,
    input.publishedAt,
    input.publishedAt,
    input.publishedAt,
    input.publishedAt,
  );
};

const seedPackage = (id: string, timestamp: string): void => {
  db.query(
    "INSERT INTO market_packages (id, source_id, package_name, latest_publication_id, created_at, updated_at) VALUES (?,?,?,NULL,?,?)",
  ).run(id, SOURCE, PACKAGE, timestamp, timestamp);
};

const pointLatestAt = (
  packageId: string,
  publicationId: string | null,
): void => {
  db.query("UPDATE market_packages SET latest_publication_id=? WHERE id=?").run(
    publicationId,
    packageId,
  );
};

type SequenceStep = { kind: "publish" | "unpublish"; version: string };

const SEQUENCE_VERSIONS = ["1.0.0", "1.1.0", "2.0.0"];

/**
 * Operations every generated sequence starts with.
 *
 * The backbone is what makes the generated sequence legal and complete: it
 * publishes all three versions (so a later `unpublish` of any of them is a real
 * transition rather than a not-found), and it contains a restore and a
 * withdrawal of `latest` whatever the generated tail does.
 */
const SEQUENCE_BACKBONE: SequenceStep[] = [
  { kind: "publish", version: "1.0.0" },
  { kind: "publish", version: "1.1.0" },
  { kind: "unpublish", version: "1.0.0" },
  { kind: "publish", version: "1.0.0" },
  { kind: "unpublish", version: "1.0.0" },
  { kind: "publish", version: "2.0.0" },
];

const SEQUENCE_COUNT = 12;
const SEQUENCE_TAIL_LENGTH = 4;

/**
 * Table-driven sequences for the invariant sweep, generated from a fixed seed so
 * a failure is always reproducible and no run depends on the clock or on luck.
 */
const publicationSequences = (): Array<[number, SequenceStep[]]> =>
  Array.from({ length: SEQUENCE_COUNT }, (_, index) => {
    let state = index + 1;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const tail: SequenceStep[] = Array.from(
      { length: SEQUENCE_TAIL_LENGTH },
      () => ({
        kind: next() < 0.5 ? "publish" : "unpublish",
        version:
          SEQUENCE_VERSIONS[Math.floor(next() * SEQUENCE_VERSIONS.length)]!,
      }),
    );
    return [index + 1, [...SEQUENCE_BACKBONE, ...tail]];
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcpm-catalog-"));
  db = await openDatabase(join(root, "market.sqlite"));
  catalog = new CatalogService(db);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("publish", () => {
  test("creates the package and makes the first version latest", async () => {
    const change = await publish("1.0.0");
    expect(change.action).toBe("publish");
    expect(change.previousLatestPublicationId).toBeNull();
    expect(change.latestPublicationId).toBe(change.publicationId);

    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail).not.toBeNull();
    expect(detail?.latestVersion).toBe("1.0.0");
    expect(detail?.versions.map((entry) => entry.version)).toEqual(["1.0.0"]);
  });

  test("moves latest to a newly published version", async () => {
    const first = await publish("1.0.0");
    const second = await publish("1.1.0");
    expect(second.action).toBe("publish");
    expect(second.previousLatestPublicationId).toBe(first.publicationId);
    expect(second.latestPublicationId).toBe(second.publicationId);

    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("1.1.0");
    expect(detail?.versions.map((entry) => entry.version)).toEqual([
      "1.1.0",
      "1.0.0",
    ]);
  });

  test("is strictly idempotent for an already visible version", async () => {
    const first = await publish("1.0.0");
    await publish("1.1.0");
    const again = await publish("1.0.0");

    expect(again.action).toBe("noop");
    expect(again.publicationId).toBe(first.publicationId);
    expect(again.previousLatestPublicationId).toBe(again.latestPublicationId);
    expect(again.affectedVersions).toEqual([]);

    // A no-op must not move latest back to the republished version.
    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("1.1.0");
    expect(detail?.versions).toHaveLength(2);
  });

  test("does not rewrite the stored snapshot on a repeated publish", async () => {
    await publish("1.0.0");
    const before = db
      .query<
        { metadata_json: string; published_at: string },
        []
      >("SELECT metadata_json, published_at FROM market_publications")
      .get();

    const replacement = await snapshotRecord({
      name: PACKAGE,
      version: "1.0.0",
      displayName: "改写后的名字",
    });
    catalog.publish({
      sourceId: SOURCE,
      packageName: PACKAGE,
      exactVersion: "1.0.0",
      metadataJson: replacement.metadataJson,
      metadataDigest: replacement.metadataDigest,
      requestId: "req-again",
    });

    const after = db
      .query<
        { metadata_json: string; published_at: string },
        []
      >("SELECT metadata_json, published_at FROM market_publications")
      .get();
    expect(after?.metadata_json).toBe(before?.metadata_json);
    expect(after?.published_at).toBe(before?.published_at);
  });

  test("records one operation per real change and none for a no-op", async () => {
    await publish("1.0.0");
    await publish("1.0.0");
    const operations = db
      .query<{ action: string }, []>("SELECT action FROM admin_operations")
      .all();
    expect(operations.map((row) => row.action)).toEqual(["publish"]);
  });

  test("leans on the unique constraint rather than on caller discipline", async () => {
    const change = await publish("1.0.0");

    // A second writer that skipped the service's re-read cannot produce a
    // duplicate: the invariant has to hold at the storage layer, because two
    // concurrent requests are not prevented by anything in the UI.
    expect(() =>
      db
        .query(
          "INSERT INTO market_publications (id, package_id, exact_version, metadata_json, metadata_digest, first_published_at, published_at, unpublished_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,NULL,?,?)",
        )
        .run(
          "duplicate",
          change.packageId,
          "1.0.0",
          "{}",
          "sha256:0",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ),
    ).toThrow();

    const count = db
      .query<
        { total: number },
        []
      >("SELECT COUNT(*) AS total FROM market_publications")
      .get();
    expect(count?.total).toBe(1);
  });

  /**
   * The realistic version of the same guarantee: several confirmations of the
   * same version arriving at once. Only one publication may exist afterwards,
   * exactly one operation may be recorded, and every caller must receive the
   * same publication id rather than an error.
   */
  test("collapses concurrent publishes of one version into a single record", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => publish("1.0.0")),
    );

    expect(new Set(results.map((change) => change.publicationId)).size).toBe(1);
    // Exactly one caller wins and performs the write; the others find the
    // version already visible and report a no-op rather than failing.
    expect(
      results.filter((change) => change.action === "publish"),
    ).toHaveLength(1);
    expect(results.filter((change) => change.action === "noop")).toHaveLength(
      7,
    );

    const versions = db
      .query<
        { total: number },
        []
      >("SELECT COUNT(*) AS total FROM market_publications")
      .get();
    expect(versions?.total).toBe(1);

    const operations = db
      .query<
        { total: number },
        []
      >("SELECT COUNT(*) AS total FROM admin_operations")
      .get();
    expect(operations?.total).toBe(1);

    // The package still has exactly one latest, and it is that publication.
    const detail = catalog.getAdminPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("1.0.0");
  });
});

describe("unpublish", () => {
  test("hides a non-latest version without moving latest", async () => {
    await publish("1.0.0");
    const second = await publish("1.1.0");
    const change = unpublish("1.0.0");

    expect(change.action).toBe("unpublish");
    expect(change.latestPublicationId).toBe(second.publicationId);

    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail?.versions.map((entry) => entry.version)).toEqual(["1.1.0"]);
  });

  test("falls back to the newest remaining visible version", async () => {
    await publish("1.0.0");
    const second = await publish("1.1.0");
    const change = unpublish("1.1.0");

    expect(change.previousLatestPublicationId).toBe(second.publicationId);
    expect(change.latestPublicationId).not.toBe(second.publicationId);

    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("1.0.0");
  });

  test("hides the whole package when the last visible version is withdrawn", async () => {
    await publish("1.0.0");
    const change = unpublish("1.0.0");
    expect(change.latestPublicationId).toBeNull();

    const slug = toPackageSlug(PACKAGE);
    expect(catalog.getPublicPackage(slug)).toBeNull();
    expect(catalog.getPublicVersion(slug, "1.0.0")).toBeNull();
    expect(catalog.listPublic().items).toHaveLength(0);
  });

  test("is idempotent for an already hidden version", async () => {
    await publish("1.0.0");
    await unpublish("1.0.0");
    const again = unpublish("1.0.0");
    expect(again.action).toBe("noop");

    const operations = db
      .query<{ action: string }, []>(
        // Insertion order: `occurred_at` can legitimately tie within a
        // millisecond, and the audit trail must still read in true order.
        "SELECT action FROM admin_operations ORDER BY rowid",
      )
      .all();
    expect(operations.map((row) => row.action)).toEqual([
      "publish",
      "unpublish",
    ]);
  });

  test("reports an unknown version as not found", async () => {
    await publish("1.0.0");
    expect(() => unpublish("9.9.9")).toThrow(AppError);
  });

  test("reports an unknown package as not found", () => {
    expect(() =>
      catalog.unpublish({
        sourceId: SOURCE,
        packageName: "never-seen",
        exactVersion: "1.0.0",
        requestId: "req-test",
      }),
    ).toThrow(AppError);
  });
});

describe("restore", () => {
  test("reuses the original snapshot and first publication time", async () => {
    const first = await publish("1.0.0");
    const storedBefore = db
      .query<
        {
          metadata_json: string;
          first_published_at: string;
          published_at: string;
        },
        []
      >(
        "SELECT metadata_json, first_published_at, published_at FROM market_publications",
      )
      .get();

    unpublish("1.0.0");
    const restored = await publish("1.0.0");

    expect(restored.action).toBe("restore");
    expect(restored.publicationId).toBe(first.publicationId);
    expect(restored.latestPublicationId).toBe(first.publicationId);

    const storedAfter = db
      .query<
        {
          metadata_json: string;
          first_published_at: string;
          published_at: string;
          unpublished_at: string | null;
        },
        []
      >(
        "SELECT metadata_json, first_published_at, published_at, unpublished_at FROM market_publications",
      )
      .get();

    expect(storedAfter?.metadata_json).toBe(storedBefore?.metadata_json);
    expect(storedAfter?.first_published_at).toBe(
      storedBefore?.first_published_at,
    );
    expect(storedAfter?.unpublished_at).toBeNull();
    // Restoring counts as a fresh publication for ordering purposes: the
    // instant has to move *forward*, not merely stay "not older". The first
    // publish writes `published_at` and `first_published_at` from one instant,
    // so a `>=` comparison against `first_published_at` stayed true even when a
    // restore left the column completely untouched.
    expect(
      (storedAfter?.published_at ?? "") > (storedBefore?.published_at ?? ""),
    ).toBe(true);
  });

  test("moves the restored version ahead of the newest recorded instant", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    unpublish("1.0.0");
    await publish("1.0.0");

    const rows = db
      .query<
        { exact_version: string; published_at: string },
        []
      >("SELECT exact_version, published_at FROM market_publications")
      .all();
    expect(
      rows
        .map((row) => row.exact_version)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["1.0.0", "1.1.0"]);
    const restored = rows.find((row) => row.exact_version === "1.0.0");
    const displaced = rows.find((row) => row.exact_version === "1.1.0");

    // The restored version overtakes the version that was newest before it,
    // which is the stored reason it is once again `latest`.
    expect(
      (restored?.published_at ?? "") > (displaced?.published_at ?? ""),
    ).toBe(true);
    expect(
      catalog.getPublicPackage(toPackageSlug(PACKAGE))?.latestVersion,
    ).toBe("1.0.0");
  });

  test("makes the restored version latest again", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    unpublish("1.0.0");
    await publish("1.0.0");

    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("1.0.0");
    expect(detail?.versions.map((entry) => entry.version).sort()).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
  });
});

describe("invariants", () => {
  test("stays consistent across an arbitrary operation sequence", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    await publish("2.0.0");
    unpublish("2.0.0");
    unpublish("1.1.0");
    await publish("1.1.0");
    unpublish("2.0.0");
    unpublish("1.0.0");
    unpublish("1.1.0");
    await publish("1.0.0");

    expect(catalog.repository.findInvariantViolations()).toEqual([]);
  });

  test("keeps the package hidden after every version is withdrawn", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    unpublish("1.0.0");
    unpublish("1.1.0");

    const row = db
      .query<
        { latest_publication_id: string | null },
        []
      >("SELECT latest_publication_id FROM market_packages")
      .get();
    expect(row?.latest_publication_id).toBeNull();
    expect(catalog.repository.findInvariantViolations()).toEqual([]);
  });

  /**
   * The audit has to see a `latest` that is legal but stale, not only a dangling
   * one: the pointer below still names a visible publication of this package, so
   * the first two rules pass it. Only a defect can reach this state.
   */
  test("reports a latest that is no longer the newest visible publication", async () => {
    const first = await publish("1.0.0");
    await seedPublication({
      id: "pub-newer",
      packageId: first.packageId,
      version: "1.1.0",
      publishedAt: "2030-01-01T00:00:00.000Z",
    });

    expect(catalog.repository.findInvariantViolations()).toEqual([
      `package ${first.packageId} latest ${first.publicationId} is not the newest visible publication`,
    ]);
  });

  /**
   * The table-driven sweep: every generated sequence runs through the service,
   * and the audit runs after *every* step rather than once at the end — a
   * violation that a later step happens to repair would otherwise stay
   * invisible. Sequences come from a fixed seed, so a failure is reproducible.
   */
  test.each(publicationSequences())(
    "holds the three latest invariants after every step of sequence %i",
    async (seed, steps) => {
      const actions: string[] = [];
      for (const [index, step] of steps.entries()) {
        const label = `sequence ${seed}, step ${index + 1}: ${step.kind} ${step.version}`;
        const change =
          step.kind === "publish"
            ? await publish(step.version)
            : unpublish(step.version);
        actions.push(change.action);

        expect({
          label,
          violations: catalog.repository.findInvariantViolations(),
        }).toEqual({ label, violations: [] });

        // `latest` must also agree with the storage order itself: the public
        // latest is the head of the visible set, and the version history is that
        // same set in that same order.
        const visible = catalog.repository.listVisiblePublications(
          change.packageId,
        );
        const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
        expect({
          label,
          listed: detail !== null,
          latest: detail?.latestVersion ?? null,
          versions: detail?.versions.map((entry) => entry.version) ?? [],
        }).toEqual({
          label,
          listed: visible.length > 0,
          latest: visible[0]?.exactVersion ?? null,
          versions: visible.map((entry) => entry.exactVersion),
        });
      }

      // Every sequence really did cover all three transitions, so the sweep
      // cannot silently degrade into repeated no-ops.
      expect(
        ["publish", "restore", "unpublish"].filter(
          (action) => !actions.includes(action),
        ),
      ).toEqual([]);
    },
  );

  test("refuses a snapshot that is not valid JSON", () => {
    expect(() =>
      catalog.publish({
        sourceId: SOURCE,
        packageName: PACKAGE,
        exactVersion: "1.0.0",
        metadataJson: "{",
        metadataDigest: "sha256:0",
        requestId: "req-test",
      }),
    ).toThrow(AppError);
  });
});

describe("publication order", () => {
  test("advances the logical clock past the newest recorded instant", () => {
    const base = "2026-08-01T00:00:00.000Z";
    expect(monotonicInstant(base, null)).toBe(base);
    expect(monotonicInstant(base, "2026-07-01T00:00:00.000Z")).toBe(base);
    expect(monotonicInstant(base, base)).toBe("2026-08-01T00:00:00.001Z");
    expect(monotonicInstant(base, "2026-09-01T00:00:00.000Z")).toBe(
      "2026-09-01T00:00:00.001Z",
    );
  });

  test("orders back-to-back publishes newest first", async () => {
    // Published in a tight loop so the wall clock cannot separate them.
    for (const version of ["1.0.0", "1.1.0", "2.0.0"]) await publish(version);

    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("2.0.0");
    expect(detail?.versions.map((entry) => entry.version)).toEqual([
      "2.0.0",
      "1.1.0",
      "1.0.0",
    ]);
  });

  test("falls back to the publication before the newest one", async () => {
    for (const version of ["1.0.0", "1.1.0", "2.0.0"]) await publish(version);
    const change = unpublish("2.0.0");

    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("1.1.0");
    expect(change.latestPublicationId).not.toBeNull();
  });

  /**
   * The `id DESC` tiebreak is the one ordering rule the service can never reach
   * on its own: the logical clock keeps every recorded instant strictly apart.
   * The tie is therefore seeded below the service and the withdrawal that
   * triggers the fallback still goes through it.
   */
  test("decides a published_at tie by id when latest falls back", async () => {
    const tie = "2026-08-01T00:00:00.000Z";
    const packageId = "pkg-tied";
    seedPackage(packageId, tie);
    const seeded: Array<[string, string]> = [
      ["pub-tie-a", "1.0.0"],
      ["pub-tie-m", "1.1.0"],
      ["pub-tie-z", "2.0.0"],
    ];
    for (const [id, version] of seeded)
      await seedPublication({ id, packageId, version, publishedAt: tie });
    // Three versions sharing one instant, so only the id orders them, and the
    // largest id is the newest — the publication `latest` has to name.
    pointLatestAt(packageId, "pub-tie-z");
    expect(
      catalog.repository
        .listVisiblePublications(packageId)
        .map((entry) => [entry.id, entry.publishedAt]),
    ).toEqual([
      ["pub-tie-z", tie],
      ["pub-tie-m", tie],
      ["pub-tie-a", tie],
    ]);
    expect(catalog.repository.findInvariantViolations()).toEqual([]);

    const change = unpublish("2.0.0");

    // Not `pub-tie-a`: with equal instants the larger id wins the fallback.
    expect(change.previousLatestPublicationId).toBe("pub-tie-z");
    expect(change.latestPublicationId).toBe("pub-tie-m");
    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("1.1.0");
    expect(detail?.versions.map((entry) => entry.version)).toEqual([
      "1.1.0",
      "1.0.0",
    ]);
    expect(catalog.repository.findInvariantViolations()).toEqual([]);
  });

  test("keeps a restored version ordering ahead of what came before it", async () => {
    for (const version of ["1.0.0", "1.1.0"]) await publish(version);
    unpublish("1.0.0");
    await publish("1.0.0");

    const detail = catalog.getPublicPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("1.0.0");
  });
});

describe("console view", () => {
  test("stays resolvable after every version is withdrawn", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    unpublish("1.0.0");
    unpublish("1.1.0");

    // The public surface hides the package entirely...
    expect(catalog.getPublicPackage(toPackageSlug(PACKAGE))).toBeNull();
    // ...but the console is where a withdrawal gets undone, so the record and
    // its versions must remain reachable.
    const detail = catalog.getAdminPackage(toPackageSlug(PACKAGE));
    expect(detail).not.toBeNull();
    expect(detail?.latestVersion).toBeNull();
    expect(detail?.packageName).toBe(PACKAGE);
    expect(detail?.displayName).toBe("投资研究专家团队");
    expect(detail?.versions.map((entry) => entry.version)).toEqual([
      "1.1.0",
      "1.0.0",
    ]);
    expect(
      detail?.versions.every((entry) => entry.unpublishedAt !== null),
    ).toBe(true);
  });

  test("reports the visible latest and marks it", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    const detail = catalog.getAdminPackage(toPackageSlug(PACKAGE));
    expect(detail?.latestVersion).toBe("1.1.0");
    expect(detail?.versions.find((entry) => entry.isLatest)?.version).toBe(
      "1.1.0",
    );
    expect(
      detail?.versions.find((entry) => entry.version === "1.0.0")
        ?.unpublishedAt,
    ).toBeNull();
  });

  test("treats an unknown slug as not found", () => {
    expect(
      catalog.getAdminPackage(toPackageSlug("never-published")),
    ).toBeNull();
  });
});

describe("search", () => {
  test("indexes the latest snapshot and follows latest when it moves", async () => {
    await publish("1.0.0", { agents: false });
    expect(catalog.searchPublic({ q: "financial-analyst" }).items).toHaveLength(
      0,
    );

    await publish("1.1.0", { agents: true });
    expect(catalog.searchPublic({ q: "financial-analyst" }).items).toHaveLength(
      1,
    );
    expect(catalog.searchPublic({ q: "investment" }).items).toHaveLength(1);
  });

  test("drops the package from the index once everything is withdrawn", async () => {
    await publish("1.0.0");
    expect(catalog.searchPublic({ q: "investment" }).items).toHaveLength(1);
    unpublish("1.0.0");
    expect(catalog.searchPublic({ q: "investment" }).items).toHaveLength(0);
  });

  test("matches Chinese text inside a longer token", async () => {
    await publish("1.0.0");
    expect(catalog.searchPublic({ q: "投资研究" }).items).toHaveLength(1);
    expect(catalog.searchPublic({ q: "研究" }).items).toHaveLength(1);
  });

  test("treats FTS syntax typed by a user as literal text", async () => {
    await publish("1.0.0");
    expect(() => catalog.searchPublic({ q: '" OR 1=1 --' })).not.toThrow();
    expect(() => catalog.searchPublic({ q: "*" })).not.toThrow();
    expect(catalog.searchPublic({ q: "   " }).items).toHaveLength(1);
  });

  test("clamps pagination bounds", async () => {
    await publish("1.0.0");
    expect(catalog.listPublic({ limit: 10_000 }).limit).toBe(60);
    expect(catalog.listPublic({ limit: 0 }).limit).toBe(24);
    expect(catalog.listPublic({ offset: -5 }).offset).toBe(0);
  });
});
