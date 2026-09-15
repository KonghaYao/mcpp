/**
 * Schema bootstrap.
 *
 * The migration carries the storage-level half of the catalogue's invariants: a
 * version can only be published once, a hidden version cannot stay `latest`, and
 * the pointer can only ever name a publication of its own package. These tests
 * boot an empty database and check the schema refuses the states the service is
 * forbidden to produce, so those guards cannot quietly rot.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrate,
  openDatabase,
  supportsFts5,
  type Db,
} from "../../src/db/database.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-02-01T00:00:00.000Z";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcpm-migration-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const objects = (db: Db, type: string): string[] =>
  db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type=? ORDER BY name",
    )
    .all(type)
    .map((row) => row.name);

const insertPackage = (
  db: Db,
  input: { id: string; name?: string; latestPublicationId?: string | null },
): void => {
  db.query(
    `INSERT INTO market_packages
       (id, source_id, package_name, latest_publication_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    "npm",
    input.name ?? "acme-investment-team",
    input.latestPublicationId ?? null,
    NOW,
    NOW,
  );
};

const insertPublication = (
  db: Db,
  input: {
    id: string;
    packageId: string;
    version?: string;
    publishedAt?: string;
    unpublishedAt?: string | null;
  },
): void => {
  db.query(
    `INSERT INTO market_publications
       (id, package_id, exact_version, metadata_json, metadata_digest,
        first_published_at, published_at, unpublished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.packageId,
    input.version ?? "1.0.0",
    "{}",
    "sha256:0",
    NOW,
    input.publishedAt ?? NOW,
    input.unpublishedAt ?? null,
    NOW,
    NOW,
  );
};

const pointLatestAt = (db: Db, packageId: string, publicationId: string) =>
  db
    .query("UPDATE market_packages SET latest_publication_id=? WHERE id=?")
    .run(publicationId, packageId);

describe("fresh database", () => {
  test("reaches the complete schema in one pass", async () => {
    const db = await openDatabase(join(root, "fresh.sqlite"));
    try {
      const tables = objects(db, "table");
      for (const required of [
        "market_packages",
        "market_publications",
        "admin_operations",
        "public_refresh_attempts",
        "market_search",
      ])
        expect(tables).toContain(required);

      expect(objects(db, "trigger")).toEqual([
        "market_latest_visible_insert",
        "market_latest_visible_update",
        "market_publication_visible_update",
      ]);
      expect(objects(db, "index")).toContain("market_publications_visible");

      // Applied exactly once, and the search index is a real FTS5 table.
      expect(
        db
          .query<
            { version: number; name: string },
            []
          >("SELECT version, name FROM schema_migrations")
          .all(),
      ).toEqual([
        { version: 1, name: "0001_market.sql" },
        { version: 2, name: "0002_http_sources.sql" },
      ]);
      expect(objects(db, "table")).not.toContain("http_sources");
      expect(db.query("SELECT source_kind FROM market_packages").all()).toEqual(
        [],
      );
      expect(
        db.query("SELECT count(*) AS total FROM market_search").get(),
      ).toEqual({ total: 0 });
    } finally {
      db.close();
    }
  });

  test("is idempotent across a service restart", async () => {
    const path = join(root, "restart.sqlite");
    const first = await openDatabase(path);
    insertPackage(first, { id: "pkg-1" });
    await migrate(first);
    first.close();

    // A restart re-runs every migration against an already-migrated file.
    const second = await openDatabase(path);
    try {
      expect(
        second.query("SELECT count(*) AS total FROM schema_migrations").get(),
      ).toEqual({ total: 2 });
      expect(
        second.query("SELECT count(*) AS total FROM market_packages").get(),
      ).toEqual({ total: 1 });
    } finally {
      second.close();
    }
  });
});

describe("storage invariants", () => {
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase(join(root, "invariants.sqlite"));
  });

  afterEach(() => {
    db.close();
  });

  test("refuses a second publication of the same exact version", () => {
    insertPackage(db, { id: "pkg-1" });
    insertPublication(db, { id: "pub-1", packageId: "pkg-1" });

    // Two concurrent publishes are not prevented by anything in the UI, so the
    // uniqueness has to hold here.
    expect(() =>
      insertPublication(db, { id: "pub-2", packageId: "pkg-1" }),
    ).toThrow();
  });

  test("refuses a latest pointer to a hidden publication", () => {
    insertPackage(db, { id: "pkg-1" });
    insertPublication(db, {
      id: "pub-1",
      packageId: "pkg-1",
      unpublishedAt: LATER,
    });

    expect(() => pointLatestAt(db, "pkg-1", "pub-1")).toThrow(/visible/);
  });

  test("refuses to hide the publication that is still latest", () => {
    insertPackage(db, { id: "pkg-1" });
    insertPublication(db, { id: "pub-1", packageId: "pkg-1" });
    pointLatestAt(db, "pkg-1", "pub-1");

    // Callers must move the pointer first; hiding in place is not allowed.
    expect(() =>
      db
        .query("UPDATE market_publications SET unpublished_at=? WHERE id=?")
        .run(LATER, "pub-1"),
    ).toThrow(/latest/);
  });

  test("refuses a latest pointer to another package's publication", () => {
    insertPackage(db, { id: "pkg-1" });
    insertPackage(db, { id: "pkg-2", name: "other-package" });
    insertPublication(db, { id: "pub-1", packageId: "pkg-2" });

    expect(() => pointLatestAt(db, "pkg-1", "pub-1")).toThrow();
  });

  test("refuses a publication timestamped before its first publication", () => {
    insertPackage(db, { id: "pkg-1" });
    expect(() =>
      insertPublication(db, {
        id: "pub-1",
        packageId: "pkg-1",
        publishedAt: "2025-12-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  test("accepts withdrawing an older version once the pointer has moved", () => {
    insertPackage(db, { id: "pkg-1" });
    insertPublication(db, { id: "pub-1", packageId: "pkg-1" });
    insertPublication(db, {
      id: "pub-2",
      packageId: "pkg-1",
      version: "1.1.0",
    });
    pointLatestAt(db, "pkg-1", "pub-2");
    db.query("UPDATE market_publications SET unpublished_at=? WHERE id=?").run(
      LATER,
      "pub-1",
    );

    const latest = db
      .query<
        { latest_publication_id: string },
        []
      >("SELECT latest_publication_id FROM market_packages")
      .get();
    expect(latest?.latest_publication_id).toBe("pub-2");
  });

  test("restricts operations and refresh outcomes to known values", () => {
    insertPackage(db, { id: "pkg-1" });
    insertPublication(db, { id: "pub-1", packageId: "pkg-1" });

    expect(() =>
      db
        .query(
          `INSERT INTO admin_operations
             (id, action, package_id, publication_id, occurred_at, request_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("op-1", "deleted", "pkg-1", "pub-1", NOW, "req"),
    ).toThrow();

    expect(() =>
      db
        .query(
          `INSERT INTO public_refresh_attempts
             (id, package_id, requested_at, completed_at, outcome, error_code, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("ra-1", "pkg-1", NOW, null, "maybe", null, "req"),
    ).toThrow();
  });
});

test("升级原始 npm 数据库只加字段，不增加任何表", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      await Bun.file(
        new URL("../../migrations/0001_market.sql", import.meta.url),
      ).text(),
    );
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)",
    );
    db.query("INSERT INTO schema_migrations VALUES(1,'0001_market.sql',?)").run(
      NOW,
    );
    insertPackage(db, { id: "legacy" });
    insertPublication(db, { id: "publication", packageId: "legacy" });
    const tables = objects(db, "table");
    await migrate(db);
    expect(objects(db, "table")).toEqual(tables);
    expect(
      db
        .query(
          "SELECT source_kind, endpoint, definition_revision FROM market_packages WHERE id='legacy'",
        )
        .get(),
    ).toEqual({ source_kind: "npm", endpoint: null, definition_revision: 1 });
    expect(
      db
        .query(
          "SELECT metadata_json FROM market_publications WHERE id='publication'",
        )
        .get(),
    ).toEqual({ metadata_json: "{}" });
    insertPackage(db, { id: "new-npm", name: "other" });
    expect(
      db
        .query("SELECT source_kind FROM market_packages WHERE id='new-npm'")
        .get(),
    ).toEqual({ source_kind: "npm" });
  } finally {
    db.close();
  }
});
