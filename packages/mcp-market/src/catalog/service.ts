import { id as newId, immediate, now, type Db } from "../db/database.ts";
import { AppError } from "../errors.ts";
import type { NormalizedPackageVersion } from "../npm-registry/types.ts";
import { MAX_SEARCH_QUERY_LENGTH, toMatchExpression } from "../search-text.ts";
import {
  CatalogRepository,
  type PackageWithPublication,
} from "./repository.ts";
import { fromHttpSlug, fromPackageSlug, toPackageSlug } from "./slug.ts";
import type {
  Publication,
  PublicationChange,
  PublishInput,
  UnpublishInput,
} from "./types.ts";

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;

export type PackageSummary = {
  sourceKind: "npm" | "http";
  slug: string;
  sourceId: string;
  packageName: string;
  metadata: NormalizedPackageVersion;
  /** Presentation switches on the latest snapshot, never on a separate entity. */
  isExpertTeam: boolean;
  latestVersion: string;
  publishedAt: string;
  firstPublishedAt: string;
};

export type PublicVersionRef = {
  version: string;
  publishedAt: string;
  firstPublishedAt: string;
  isLatest: boolean;
};

export type PublicPackageDetail = PackageSummary & {
  versions: PublicVersionRef[];
};

export type PublicPackagePage = {
  items: PackageSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type AdminPackageVersion = {
  version: string;
  publishedAt: string;
  firstPublishedAt: string;
  unpublishedAt: string | null;
  isLatest: boolean;
};

/**
 * Console view of one package.
 *
 * Deliberately not a `PackageSummary`: the console has to render a package
 * whose every version is withdrawn — that page is where a withdrawal gets
 * undone — and it must not reuse the public "latest" vocabulary for a version
 * no visitor can see.
 */
export type AdminPackageDetail = {
  packageId: string;
  slug: string;
  sourceId: string;
  packageName: string;
  /** Taken from the newest stored snapshot; null when none decodes. */
  displayName: string | null;
  /** The publicly visible latest, or null when nothing is listed. */
  latestVersion: string | null;
  versions: AdminPackageVersion[];
  lastRefresh: ReturnType<CatalogRepository["latestRefreshAttempt"]>;
};

export type PublicListQuery = { limit?: number; offset?: number };
export type PublicSearchQuery = { q: string; limit?: number; offset?: number };

const clampLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0)
    return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
};

const clampOffset = (value: number | undefined): number =>
  value === undefined || !Number.isSafeInteger(value) || value < 0 ? 0 : value;

/**
 * Parses a stored snapshot. Failure is treated as "not displayable" rather than
 * an exception so one corrupted row cannot take down the public catalogue.
 */
const parseMetadata = (json: string): NormalizedPackageVersion | null => {
  try {
    const parsed = JSON.parse(json) as NormalizedPackageVersion;
    if (typeof parsed?.name !== "string" || typeof parsed?.version !== "string")
      return null;
    return parsed;
  } catch {
    return null;
  }
};

const instantOf = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Publication order is a logical clock, not wall clock.
 *
 * Two publishes can land in the same millisecond, and every ordering rule here
 * (version history, `latest` fallback, "newest") relies on "later publish sorts
 * later". A candidate instant that does not beat the package's newest recorded
 * instant is therefore advanced past it.
 */
export const monotonicInstant = (
  candidate: string,
  previous: string | null,
): string => {
  const candidateMs = instantOf(candidate);
  const previousMs = instantOf(previous);
  if (candidateMs === null) return candidate;
  if (previousMs === null || candidateMs > previousMs) return candidate;
  return new Date(previousMs + 1).toISOString();
};

const toSummary = (row: PackageWithPublication): PackageSummary | null => {
  const metadata = parseMetadata(row.publication.metadataJson);
  if (!metadata) return null;
  return {
    slug: toPackageSlug(row.package.packageName, row.package.sourceId),
    sourceId: row.package.sourceId,
    sourceKind: row.package.sourceKind,
    packageName: row.package.packageName,
    metadata,
    isExpertTeam: metadata.agents.length > 0,
    latestVersion: row.publication.exactVersion,
    publishedAt: row.publication.publishedAt,
    firstPublishedAt: row.publication.firstPublishedAt,
  };
};

/**
 * Owns every Catalog write transaction and the Market `latest` pointer rules.
 * No other module may write these tables.
 */
export class CatalogService {
  readonly #db: Db;
  readonly #repo: CatalogRepository;

  constructor(db: Db) {
    this.#db = db;
    this.#repo = new CatalogRepository(db);
  }

  get repository(): CatalogRepository {
    return this.#repo;
  }

  /**
   * Brings an exact version into the Market. Callers must have already read and
   * validated the snapshot; this method re-reads current state inside the write
   * transaction so concurrent calls cannot create duplicates.
   */
  syncHttp(
    input: PublishInput & { definitionRevision: number },
  ): PublicationChange {
    return this.#publish(input, input.definitionRevision);
  }

  publish(input: PublishInput): PublicationChange {
    return this.#publish(input, false);
  }

  #publish(input: PublishInput, syncHttp: number | false): PublicationChange {
    const metadata = parseMetadata(input.metadataJson);
    if (!metadata)
      throw new AppError("METADATA_INVALID", "Snapshot is not valid JSON");

    return immediate(this.#db, () => {
      if (syncHttp !== false) {
        const definition = this.#db
          .query<
            { definition_revision: number },
            [string, string]
          >("SELECT definition_revision FROM market_packages WHERE source_id=? AND package_name=? AND source_kind='http'")
          .get(input.sourceId, input.packageName);
        if (!definition || definition.definition_revision !== syncHttp)
          throw new AppError("PREVIEW_CHANGED");
      }
      let marketPackage = this.#repo.findPackage(
        input.sourceId,
        input.packageName,
      );
      if (!marketPackage) {
        const packageId = newId();
        this.#repo.insertPackage({
          id: packageId,
          sourceId: input.sourceId,
          packageName: input.packageName,
          createdAt: now(),
        });
        marketPackage = this.#repo.findPackage(
          input.sourceId,
          input.packageName,
        );
        if (!marketPackage) throw new AppError("CATALOG_CONFLICT");
      }

      // Allocated after the package exists so the logical clock can be compared
      // against every instant already recorded for it.
      const timestamp = monotonicInstant(
        now(),
        this.#repo.maxPublishedAt(marketPackage.id),
      );
      const previousLatest = marketPackage.latestPublicationId;
      const existing = this.#repo.findPublication(
        marketPackage.id,
        input.exactVersion,
      );
      if (syncHttp && marketPackage.sourceKind !== "http")
        throw new AppError("INVALID_INPUT");
      if (
        existing &&
        existing.unpublishedAt === null &&
        (!syncHttp || existing.id === previousLatest)
      ) {
        // Strictly idempotent: no snapshot refresh, no timestamp change, no
        // latest movement, no operation record.
        return {
          action: "noop",
          packageId: marketPackage.id,
          packageName: marketPackage.packageName,
          packageSlug: toPackageSlug(
            marketPackage.packageName,
            marketPackage.sourceId,
          ),
          publicationId: existing.id,
          exactVersion: existing.exactVersion,
          previousLatestPublicationId: previousLatest,
          latestPublicationId: previousLatest,
          affectedVersions: [],
        } satisfies PublicationChange;
      }

      if (existing) {
        // Restore: the first snapshot stays authoritative and immutable.
        this.#repo.restorePublication(existing.id, timestamp, timestamp);
        this.#repo.setLatest(marketPackage.id, existing.id, timestamp);
        const storedMetadata = parseMetadata(existing.metadataJson);
        if (!storedMetadata) throw new AppError("METADATA_INVALID");
        this.#repo.reindexSearch(marketPackage.id, storedMetadata);
        this.#repo.insertOperation({
          id: newId(),
          action: "restore",
          packageId: marketPackage.id,
          publicationId: existing.id,
          occurredAt: timestamp,
          requestId: input.requestId,
        });
        return {
          action: "restore",
          packageId: marketPackage.id,
          packageName: marketPackage.packageName,
          packageSlug: toPackageSlug(
            marketPackage.packageName,
            marketPackage.sourceId,
          ),
          publicationId: existing.id,
          exactVersion: existing.exactVersion,
          previousLatestPublicationId: previousLatest,
          latestPublicationId: existing.id,
          affectedVersions: [existing.exactVersion],
        } satisfies PublicationChange;
      }

      const publicationId = newId();
      this.#repo.insertPublication({
        id: publicationId,
        packageId: marketPackage.id,
        exactVersion: input.exactVersion,
        metadataJson: input.metadataJson,
        metadataDigest: input.metadataDigest,
        timestamp,
      });
      this.#repo.setLatest(marketPackage.id, publicationId, timestamp);
      this.#repo.reindexSearch(marketPackage.id, metadata);
      this.#repo.insertOperation({
        id: newId(),
        action: "publish",
        packageId: marketPackage.id,
        publicationId,
        occurredAt: timestamp,
        requestId: input.requestId,
      });
      return {
        action: "publish",
        packageId: marketPackage.id,
        packageName: marketPackage.packageName,
        packageSlug: toPackageSlug(
          marketPackage.packageName,
          marketPackage.sourceId,
        ),
        publicationId,
        exactVersion: input.exactVersion,
        previousLatestPublicationId: previousLatest,
        latestPublicationId: publicationId,
        affectedVersions: [input.exactVersion],
      } satisfies PublicationChange;
    });
  }

  /** Revokes Market visibility. NPM version state is untouched. */
  unpublish(input: UnpublishInput): PublicationChange {
    return immediate(this.#db, () => {
      const marketPackage = this.#repo.findPackage(
        input.sourceId,
        input.packageName,
      );
      if (!marketPackage) throw new AppError("PUBLICATION_NOT_FOUND");
      const publication = this.#repo.findPublication(
        marketPackage.id,
        input.exactVersion,
      );
      if (!publication) throw new AppError("PUBLICATION_NOT_FOUND");

      const previousLatest = marketPackage.latestPublicationId;
      if (publication.unpublishedAt !== null) {
        return {
          action: "noop",
          packageId: marketPackage.id,
          packageName: marketPackage.packageName,
          packageSlug: toPackageSlug(
            marketPackage.packageName,
            marketPackage.sourceId,
          ),
          publicationId: publication.id,
          exactVersion: publication.exactVersion,
          previousLatestPublicationId: previousLatest,
          latestPublicationId: previousLatest,
          affectedVersions: [],
        } satisfies PublicationChange;
      }

      const timestamp = now();
      const isLatest = previousLatest === publication.id;
      let nextLatest = previousLatest;
      if (isLatest) {
        // The pointer must move before the publication is hidden: the schema
        // refuses to leave latest naming a hidden publication.
        const fallback = this.#repo.newestVisibleOtherThan(
          marketPackage.id,
          publication.id,
        );
        nextLatest = fallback?.id ?? null;
        this.#repo.setLatest(marketPackage.id, nextLatest, timestamp);
      }

      this.#repo.hidePublication(publication.id, timestamp, timestamp);
      if (nextLatest === null) this.#repo.removeSearchEntry(marketPackage.id);
      else {
        const next = this.#repo.findPublicationById(nextLatest);
        const metadata = next ? parseMetadata(next.metadataJson) : null;
        if (next && metadata)
          this.#repo.reindexSearch(marketPackage.id, metadata);
        else this.#repo.removeSearchEntry(marketPackage.id);
      }

      this.#repo.insertOperation({
        id: newId(),
        action: "unpublish",
        packageId: marketPackage.id,
        publicationId: publication.id,
        occurredAt: timestamp,
        requestId: input.requestId,
      });

      return {
        action: "unpublish",
        packageId: marketPackage.id,
        packageName: marketPackage.packageName,
        packageSlug: toPackageSlug(
          marketPackage.packageName,
          marketPackage.sourceId,
        ),
        publicationId: publication.id,
        exactVersion: publication.exactVersion,
        previousLatestPublicationId: previousLatest,
        latestPublicationId: nextLatest,
        affectedVersions: [publication.exactVersion],
      } satisfies PublicationChange;
    });
  }

  listPublic(input: PublicListQuery = {}): PublicPackagePage {
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);
    const { rows, total } = this.#repo.listVisiblePackages({ limit, offset });
    return {
      items: rows
        .map(toSummary)
        .filter((item): item is PackageSummary => item !== null),
      total,
      limit,
      offset,
    };
  }

  searchPublic(input: PublicSearchQuery): PublicPackagePage {
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);
    const query = input.q.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
    if (query.length === 0) return this.listPublic({ limit, offset });
    const matchExpression = toMatchExpression(query);
    if (!matchExpression) return { items: [], total: 0, limit, offset };
    const rows = this.#repo.searchVisiblePackages({
      matchExpression,
      limit,
      offset,
    });
    const items = rows
      .map(toSummary)
      .filter((item): item is PackageSummary => item !== null);
    return { items, total: items.length, limit, offset };
  }

  listFeatured(limit: number): PackageSummary[] {
    return this.listPublic({ limit }).items;
  }

  getPublicPackage(slug: string): PublicPackageDetail | null {
    const resolved = this.#resolve(slug);
    if (!resolved) return null;
    const summary = toSummary(resolved);
    if (!summary) return null;
    const versions = this.#repo
      .listVisiblePublications(resolved.package.id)
      .map((publication) => ({
        version: publication.exactVersion,
        publishedAt: publication.publishedAt,
        firstPublishedAt: publication.firstPublishedAt,
        isLatest: publication.id === resolved.package.latestPublicationId,
      }));
    return { ...summary, versions };
  }

  /**
   * Resolves one publicly visible version. A hidden version is reported exactly
   * like a missing one so a withdrawal cannot be detected from the outside.
   */
  getPublicVersion(
    slug: string,
    version: string,
  ): (PackageSummary & { version: string; isLatest: boolean }) | null {
    const resolved = this.#resolve(slug);
    if (!resolved) return null;
    const publication = this.#repo.findPublication(
      resolved.package.id,
      version,
    );
    // Hidden versions are indistinguishable from non-existent ones publicly.
    if (!publication || publication.unpublishedAt !== null) return null;
    const metadata = parseMetadata(publication.metadataJson);
    if (!metadata) return null;
    return {
      slug: toPackageSlug(
        resolved.package.packageName,
        resolved.package.sourceId,
      ),
      sourceId: resolved.package.sourceId,
      sourceKind: resolved.package.sourceKind,
      packageName: resolved.package.packageName,
      metadata,
      isExpertTeam: metadata.agents.length > 0,
      latestVersion: resolved.publication.exactVersion,
      publishedAt: publication.publishedAt,
      firstPublishedAt: publication.firstPublishedAt,
      version: publication.exactVersion,
      isLatest: publication.id === resolved.package.latestPublicationId,
    };
  }

  /**
   * Resolves a package for the console without requiring public visibility.
   *
   * Every other lookup here hides packages that are not publicly listed, which
   * is right for visitors and wrong for the operator: withdrawing the last
   * version must not make the record unreachable, or it could never be
   * restored. Display fields therefore fall back to the newest stored snapshot.
   */
  getAdminPackage(slug: string): AdminPackageDetail | null {
    const http = fromHttpSlug(slug);
    const packageName = http?.packageName ?? fromPackageSlug(slug);
    if (packageName === null) return null;
    const row = this.#db
      .query<
        {
          id: string;
          source_id: string;
          package_name: string;
          latest_publication_id: string | null;
        },
        [string, string | null, string | null]
      >(
        "SELECT id, source_id, package_name, latest_publication_id FROM market_packages WHERE package_name=? AND ((? IS NULL AND source_kind='npm') OR source_id=?) LIMIT 1",
      )
      .get(packageName, http?.sourceId ?? null, http?.sourceId ?? null);
    if (!row) return null;

    const versions = this.#db
      .query<
        {
          exact_version: string;
          published_at: string;
          first_published_at: string;
          unpublished_at: string | null;
          id: string;
        },
        [string]
      >(
        "SELECT id, exact_version, published_at, first_published_at, unpublished_at FROM market_publications WHERE package_id=? ORDER BY published_at DESC, id DESC",
      )
      .all(row.id)
      .map((publication) => ({
        version: publication.exact_version,
        publishedAt: publication.published_at,
        firstPublishedAt: publication.first_published_at,
        unpublishedAt: publication.unpublished_at,
        isLatest: publication.id === row.latest_publication_id,
      }));

    const latest = row.latest_publication_id
      ? this.#repo.findPublicationById(row.latest_publication_id)
      : null;
    const display = latest ?? this.#repo.newestPublication(row.id);
    const metadata = display ? parseMetadata(display.metadataJson) : null;

    return {
      packageId: row.id,
      slug: toPackageSlug(row.package_name, row.source_id),
      sourceId: row.source_id,
      packageName: row.package_name,
      displayName: metadata?.displayName ?? null,
      latestVersion: latest?.exactVersion ?? null,
      versions,
      lastRefresh: this.#repo.latestRefreshAttempt(row.id),
    };
  }

  listAdminPackages(): Array<{
    packageId: string;
    slug: string;
    packageName: string;
    sourceId: string;
    latestVersion: string | null;
    visibleVersions: number;
    totalVersions: number;
    lastRefresh: ReturnType<CatalogRepository["latestRefreshAttempt"]>;
  }> {
    return this.#repo.listAllPackages().map(({ package: record }) => {
      const latest = record.latestPublicationId
        ? this.#repo.findPublicationById(record.latestPublicationId)
        : null;
      const counts = this.#db
        .query<
          { total: number; visible: number },
          [string]
        >("SELECT COUNT(*) AS total, SUM(CASE WHEN unpublished_at IS NULL THEN 1 ELSE 0 END) AS visible FROM market_publications WHERE package_id=?")
        .get(record.id);
      return {
        packageId: record.id,
        slug: toPackageSlug(record.packageName, record.sourceId),
        packageName: record.packageName,
        sourceId: record.sourceId,
        latestVersion: latest?.exactVersion ?? null,
        visibleVersions: counts?.visible ?? 0,
        totalVersions: counts?.total ?? 0,
        lastRefresh: this.#repo.latestRefreshAttempt(record.id),
      };
    });
  }

  /**
   * Reports how an exact version currently relates to the Market, together
   * with the stored records, so callers can decide between publish, restore and
   * idempotent no-op without a second lookup.
   */
  findPublicationState(
    sourceId: string,
    packageName: string,
    exactVersion: string,
  ): {
    state: "missing" | "visible" | "hidden";
    packageSlug: string;
    publication: Publication | null;
  } {
    const marketPackage = this.#repo.findPackage(sourceId, packageName);
    const packageSlug = toPackageSlug(packageName, sourceId);
    if (!marketPackage)
      return { state: "missing", packageSlug, publication: null };
    const publication = this.#repo.findPublication(
      marketPackage.id,
      exactVersion,
    );
    if (!publication)
      return { state: "missing", packageSlug, publication: null };
    return {
      state: publication.unpublishedAt === null ? "visible" : "hidden",
      packageSlug,
      publication,
    };
  }

  /** Resolves a slug to a package that currently has a visible latest. */
  #resolve(slug: string): PackageWithPublication | null {
    const http = fromHttpSlug(slug);
    const packageName = http?.packageName ?? fromPackageSlug(slug);
    if (packageName === null) return null;
    const row = this.#db
      .query<
        {
          pkg_id: string;
          source_id: string;
          package_name: string;
          source_kind: "npm" | "http";
          latest_publication_id: string | null;
          pkg_created_at: string;
          pkg_updated_at: string;
        },
        [string, string | null, string | null]
      >(
        "SELECT id AS pkg_id, source_id, package_name, source_kind, latest_publication_id, created_at AS pkg_created_at, updated_at AS pkg_updated_at FROM market_packages WHERE package_name=? AND ((? IS NULL AND source_kind='npm') OR source_id=?) LIMIT 1",
      )
      .get(packageName, http?.sourceId ?? null, http?.sourceId ?? null);
    if (!row || row.latest_publication_id === null) return null;
    const publication = this.#repo.findPublicationById(
      row.latest_publication_id,
    );
    if (!publication || publication.unpublishedAt !== null) return null;
    return {
      package: {
        id: row.pkg_id,
        sourceId: row.source_id,
        packageName: row.package_name,
        sourceKind: row.source_kind,
        latestPublicationId: row.latest_publication_id,
        createdAt: row.pkg_created_at,
        updatedAt: row.pkg_updated_at,
      },
      publication,
    };
  }
}
