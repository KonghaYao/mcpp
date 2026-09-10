import type { Db } from "../db/database.ts";
import type { NormalizedPackageVersion } from "../npm-registry/types.ts";
import { searchableTextOf, toSearchText } from "../search-text.ts";
import type {
  AdminOperationAction,
  MarketPackage,
  Publication,
} from "./types.ts";

type PackageRow = {
  id: string;
  source_id: string;
  package_name: string;
  latest_publication_id: string | null;
  created_at: string;
  updated_at: string;
};

type PublicationRow = {
  id: string;
  package_id: string;
  exact_version: string;
  metadata_json: string;
  metadata_digest: string;
  first_published_at: string;
  published_at: string;
  unpublished_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Flat shape returned by the package/publication join. */
type JoinedRow = {
  pkg_id: string;
  source_id: string;
  package_name: string;
  latest_publication_id: string | null;
  pkg_created_at: string;
  pkg_updated_at: string;
  pub_id: string;
  pub_package_id: string;
  exact_version: string;
  metadata_json: string;
  metadata_digest: string;
  first_published_at: string;
  published_at: string;
  unpublished_at: string | null;
  pub_created_at: string;
  pub_updated_at: string;
};

export type PackageWithPublication = {
  package: MarketPackage;
  publication: Publication;
};

const toPackage = (row: PackageRow): MarketPackage => ({
  id: row.id,
  sourceId: row.source_id,
  packageName: row.package_name,
  latestPublicationId: row.latest_publication_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toPublication = (row: PublicationRow): Publication => ({
  id: row.id,
  packageId: row.package_id,
  exactVersion: row.exact_version,
  metadataJson: row.metadata_json,
  metadataDigest: row.metadata_digest,
  firstPublishedAt: row.first_published_at,
  publishedAt: row.published_at,
  unpublishedAt: row.unpublished_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const JOINED_COLUMNS = [
  "p.id AS pkg_id",
  "p.source_id AS source_id",
  "p.package_name AS package_name",
  "p.latest_publication_id AS latest_publication_id",
  "p.created_at AS pkg_created_at",
  "p.updated_at AS pkg_updated_at",
  "r.id AS pub_id",
  "r.package_id AS pub_package_id",
  "r.exact_version AS exact_version",
  "r.metadata_json AS metadata_json",
  "r.metadata_digest AS metadata_digest",
  "r.first_published_at AS first_published_at",
  "r.published_at AS published_at",
  "r.unpublished_at AS unpublished_at",
  "r.created_at AS pub_created_at",
  "r.updated_at AS pub_updated_at",
].join(", ");

const VISIBLE_FROM = `FROM market_packages p JOIN market_publications r ON r.id = p.latest_publication_id WHERE p.latest_publication_id IS NOT NULL`;

const mapJoined = (row: JoinedRow): PackageWithPublication => ({
  package: {
    id: row.pkg_id,
    sourceId: row.source_id,
    packageName: row.package_name,
    latestPublicationId: row.latest_publication_id,
    createdAt: row.pkg_created_at,
    updatedAt: row.pkg_updated_at,
  },
  publication: {
    id: row.pub_id,
    packageId: row.pub_package_id,
    exactVersion: row.exact_version,
    metadataJson: row.metadata_json,
    metadataDigest: row.metadata_digest,
    firstPublishedAt: row.first_published_at,
    publishedAt: row.published_at,
    unpublishedAt: row.unpublished_at,
    createdAt: row.pub_created_at,
    updatedAt: row.pub_updated_at,
  },
});

/**
 * Pure SQL access for the Catalog aggregate. Every statement runs inside a
 * caller-owned transaction; the transaction rules themselves live in
 * `service.ts`.
 */
export class CatalogRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  findPackage(sourceId: string, packageName: string): MarketPackage | null {
    const row = this.#db
      .query<
        PackageRow,
        [string, string]
      >("SELECT * FROM market_packages WHERE source_id=? AND package_name=?")
      .get(sourceId, packageName);
    return row ? toPackage(row) : null;
  }

  findPackageById(packageId: string): MarketPackage | null {
    const row = this.#db
      .query<PackageRow, [string]>("SELECT * FROM market_packages WHERE id=?")
      .get(packageId);
    return row ? toPackage(row) : null;
  }

  insertPackage(row: {
    id: string;
    sourceId: string;
    packageName: string;
    createdAt: string;
  }): void {
    this.#db
      .query(
        "INSERT INTO market_packages (id, source_id, package_name, latest_publication_id, created_at, updated_at) VALUES (?,?,?,NULL,?,?)",
      )
      .run(row.id, row.sourceId, row.packageName, row.createdAt, row.createdAt);
  }

  setLatest(
    packageId: string,
    latestPublicationId: string | null,
    updatedAt: string,
  ): void {
    this.#db
      .query(
        "UPDATE market_packages SET latest_publication_id=?, updated_at=? WHERE id=?",
      )
      .run(latestPublicationId, updatedAt, packageId);
  }

  findPublication(packageId: string, exactVersion: string): Publication | null {
    const row = this.#db
      .query<
        PublicationRow,
        [string, string]
      >("SELECT * FROM market_publications WHERE package_id=? AND exact_version=?")
      .get(packageId, exactVersion);
    return row ? toPublication(row) : null;
  }

  findPublicationById(publicationId: string): Publication | null {
    const row = this.#db
      .query<
        PublicationRow,
        [string]
      >("SELECT * FROM market_publications WHERE id=?")
      .get(publicationId);
    return row ? toPublication(row) : null;
  }

  /**
   * Newest publication instant recorded for this package. Feeds the logical
   * clock that keeps publication order total; see `CatalogService.publish`.
   */
  maxPublishedAt(packageId: string): string | null {
    const row = this.#db
      .query<
        { value: string | null },
        [string]
      >("SELECT MAX(published_at) AS value FROM market_publications WHERE package_id=?")
      .get(packageId);
    return row?.value ?? null;
  }

  /** Visible versions, newest first. This is the public version history. */
  listVisiblePublications(packageId: string): Publication[] {
    return this.#db
      .query<
        PublicationRow,
        [string]
      >("SELECT * FROM market_publications WHERE package_id=? AND unpublished_at IS NULL ORDER BY published_at DESC, id DESC")
      .all(packageId)
      .map(toPublication);
  }

  /**
   * Fallback target after hiding `excludedId`. The id tiebreak keeps the choice
   * deterministic when two publications share a timestamp.
   */
  newestVisibleOtherThan(
    packageId: string,
    excludedId: string,
  ): Publication | null {
    const row = this.#db
      .query<
        PublicationRow,
        [string, string]
      >("SELECT * FROM market_publications WHERE package_id=? AND unpublished_at IS NULL AND id<>? ORDER BY published_at DESC, id DESC LIMIT 1")
      .get(packageId, excludedId);
    return row ? toPublication(row) : null;
  }

  /**
   * Newest publication of any state. The console falls back to this for display
   * fields once every version is withdrawn, because a withdrawal has to stay
   * openable in order to be undone.
   */
  newestPublication(packageId: string): Publication | null {
    const row = this.#db
      .query<
        PublicationRow,
        [string]
      >("SELECT * FROM market_publications WHERE package_id=? ORDER BY published_at DESC, id DESC LIMIT 1")
      .get(packageId);
    return row ? toPublication(row) : null;
  }

  insertPublication(row: {
    id: string;
    packageId: string;
    exactVersion: string;
    metadataJson: string;
    metadataDigest: string;
    timestamp: string;
  }): void {
    this.#db
      .query(
        "INSERT INTO market_publications (id, package_id, exact_version, metadata_json, metadata_digest, first_published_at, published_at, unpublished_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,NULL,?,?)",
      )
      .run(
        row.id,
        row.packageId,
        row.exactVersion,
        row.metadataJson,
        row.metadataDigest,
        row.timestamp,
        row.timestamp,
        row.timestamp,
        row.timestamp,
      );
  }

  /** Restore keeps the original snapshot and `first_published_at`. */
  restorePublication(
    publicationId: string,
    publishedAt: string,
    updatedAt: string,
  ): void {
    this.#db
      .query(
        "UPDATE market_publications SET published_at=?, unpublished_at=NULL, updated_at=? WHERE id=?",
      )
      .run(publishedAt, updatedAt, publicationId);
  }

  hidePublication(
    publicationId: string,
    unpublishedAt: string,
    updatedAt: string,
  ): void {
    this.#db
      .query(
        "UPDATE market_publications SET unpublished_at=?, updated_at=? WHERE id=?",
      )
      .run(unpublishedAt, updatedAt, publicationId);
  }

  insertOperation(row: {
    id: string;
    action: AdminOperationAction;
    packageId: string;
    publicationId: string;
    occurredAt: string;
    requestId: string;
  }): void {
    this.#db
      .query(
        "INSERT INTO admin_operations (id, action, package_id, publication_id, occurred_at, request_id) VALUES (?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.action,
        row.packageId,
        row.publicationId,
        row.occurredAt,
        row.requestId,
      );
  }

  recordRefreshAttempt(row: {
    id: string;
    packageId: string;
    requestedAt: string;
    completedAt: string;
    outcome: "succeeded" | "failed";
    errorCode: string | null;
    requestId: string;
  }): void {
    this.#db
      .query(
        "INSERT INTO public_refresh_attempts (id, package_id, requested_at, completed_at, outcome, error_code, request_id) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.packageId,
        row.requestedAt,
        row.completedAt,
        row.outcome,
        row.errorCode,
        row.requestId,
      );
  }

  latestRefreshAttempt(packageId: string): {
    outcome: "succeeded" | "failed";
    errorCode: string | null;
    requestedAt: string;
    completedAt: string | null;
  } | null {
    const row = this.#db
      .query<
        {
          outcome: "succeeded" | "failed";
          error_code: string | null;
          requested_at: string;
          completed_at: string | null;
        },
        [string]
      >(
        "SELECT outcome, error_code, requested_at, completed_at FROM public_refresh_attempts WHERE package_id=? ORDER BY requested_at DESC, id DESC LIMIT 1",
      )
      .get(packageId);
    return row
      ? {
          outcome: row.outcome,
          errorCode: row.error_code,
          requestedAt: row.requested_at,
          completedAt: row.completed_at,
        }
      : null;
  }

  /** Replaces this package's single search-index row. */
  reindexSearch(packageId: string, metadata: NormalizedPackageVersion): void {
    this.#db
      .query("DELETE FROM market_search WHERE package_id=?")
      .run(packageId);
    this.#db
      .query(
        "INSERT INTO market_search (package_id, package_name, display_name, summary, description, keywords, agents, servers) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        packageId,
        toSearchText(metadata.name),
        toSearchText(metadata.displayName ?? ""),
        toSearchText(metadata.summary ?? ""),
        toSearchText(metadata.description ?? ""),
        toSearchText(metadata.keywords.join(" ")),
        toSearchText(
          searchableTextOf(
            metadata.agents.flatMap((agent) => [
              agent.id,
              agent.name,
              agent.description,
            ]),
          ),
        ),
        toSearchText(
          searchableTextOf(
            metadata.servers.flatMap((server) => [
              server.id,
              server.transport,
              server.runtime,
            ]),
          ),
        ),
      );
  }

  removeSearchEntry(packageId: string): void {
    this.#db
      .query("DELETE FROM market_search WHERE package_id=?")
      .run(packageId);
  }

  listVisiblePackages(input: { limit: number; offset: number }): {
    rows: PackageWithPublication[];
    total: number;
  } {
    const total = this.#db
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count ${VISIBLE_FROM}`)
      .get();
    const rows = this.#db
      .query<
        JoinedRow,
        [number, number]
      >(`SELECT ${JOINED_COLUMNS} ${VISIBLE_FROM} ORDER BY r.published_at DESC, r.id DESC LIMIT ? OFFSET ?`)
      .all(input.limit, input.offset);
    return { rows: rows.map(mapJoined), total: total?.count ?? 0 };
  }

  searchVisiblePackages(input: {
    matchExpression: string;
    limit: number;
    offset: number;
  }): PackageWithPublication[] {
    return this.#db
      .query<
        JoinedRow,
        [string, number, number]
      >(`SELECT ${JOINED_COLUMNS} FROM market_search s JOIN market_packages p ON p.id = s.package_id JOIN market_publications r ON r.id = p.latest_publication_id WHERE market_search MATCH ? AND p.latest_publication_id IS NOT NULL ORDER BY bm25(market_search), r.published_at DESC, p.package_name ASC LIMIT ? OFFSET ?`)
      .all(input.matchExpression, input.limit, input.offset)
      .map(mapJoined);
  }

  countVisible(): number {
    const row = this.#db
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) AS count FROM market_packages WHERE latest_publication_id IS NOT NULL")
      .get();
    return row?.count ?? 0;
  }

  listAllPackages(): Array<{
    package: MarketPackage;
    publication: Publication | null;
  }> {
    return this.#db
      .query<PackageRow, []>(
        "SELECT * FROM market_packages ORDER BY package_name ASC",
      )
      .all()
      .map((row) => {
        const record = toPackage(row);
        return {
          package: record,
          publication: record.latestPublicationId
            ? this.findPublicationById(record.latestPublicationId)
            : null,
        };
      });
  }

  /**
   * Invariant audit used by the maintenance command and acceptance tests.
   * Reports violations instead of repairing anything.
   */
  findInvariantViolations(): string[] {
    const violations: string[] = [];
    for (const row of this.#db
      .query<
        { id: string },
        []
      >("SELECT p.id FROM market_packages p WHERE p.latest_publication_id IS NULL AND EXISTS (SELECT 1 FROM market_publications r WHERE r.package_id = p.id AND r.unpublished_at IS NULL)")
      .all())
      violations.push(
        `package ${row.id} has visible publications but no latest`,
      );

    for (const row of this.#db
      .query<
        { id: string },
        []
      >("SELECT p.id FROM market_packages p JOIN market_publications r ON r.id = p.latest_publication_id WHERE r.unpublished_at IS NOT NULL OR r.package_id <> p.id")
      .all())
      violations.push(
        `package ${row.id} latest is not a visible publication of the same package`,
      );

    // Third rule (design 7.3.5): a visible latest must also be the *newest*
    // visible publication, ordered by `published_at DESC, id DESC`. Without this
    // check a pointer stuck on a legal-but-stale version audits clean, so a
    // broken fallback rule is the one defect nobody would notice. The join
    // restricts this rule to packages whose pointer already passes the first two
    // rules, so each defect is reported by exactly one rule.
    for (const row of this.#db
      .query<
        { id: string; latest_publication_id: string },
        []
      >("SELECT p.id AS id, p.latest_publication_id AS latest_publication_id FROM market_packages p JOIN market_publications l ON l.id = p.latest_publication_id WHERE l.unpublished_at IS NULL AND l.package_id = p.id AND p.latest_publication_id <> (SELECT r.id FROM market_publications r WHERE r.package_id = p.id AND r.unpublished_at IS NULL ORDER BY r.published_at DESC, r.id DESC LIMIT 1)")
      .all())
      violations.push(
        `package ${row.id} latest ${row.latest_publication_id} is not the newest visible publication`,
      );

    return violations;
  }
}
