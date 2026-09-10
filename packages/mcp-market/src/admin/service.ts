/**
 * Application orchestration for the Admin Console.
 *
 * This is the only layer that spans the Registry, the Catalogue and the public
 * page cache. It owns no tables and no rendering: it sequences the three
 * modules, enforces the preview/confirm contract, and reports the two outcomes
 * separately so a page-refresh failure is never mistaken for a failed publish.
 */

import type { CatalogService } from "../catalog/service.ts";
import type { PublicationChange } from "../catalog/types.ts";
import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import { id as newId, now } from "../db/database.ts";
import {
  assertExactVersion,
  assertPackageName,
} from "../npm-registry/normalize.ts";
import type { NpmRegistryService } from "../npm-registry/service.ts";
import type { NormalizedPackageVersion } from "../npm-registry/types.ts";
import type {
  PublicRefreshResult,
  PublicSiteService,
} from "../public-site/service.ts";

export type PublishPreviewView = {
  packageName: string;
  exactVersion: string;
  metadata: NormalizedPackageVersion;
  metadataDigest: string;
};

export type MutationOutcome = {
  change: PublicationChange;
  refresh: PublicRefreshResult;
  /** True when the catalogue changed; false for an idempotent no-op. */
  catalogChanged: boolean;
};

export class AdminService {
  readonly #catalog: CatalogService;
  readonly #registry: NpmRegistryService;
  readonly #publicSite: PublicSiteService;
  readonly #sourceId: string;

  constructor(input: {
    catalog: CatalogService;
    registry: NpmRegistryService;
    publicSite: PublicSiteService;
    config: Pick<Config, "sourceId">;
  }) {
    this.#catalog = input.catalog;
    this.#registry = input.registry;
    this.#publicSite = input.publicSite;
    this.#sourceId = input.config.sourceId;
  }

  /**
   * Reads one exact version and returns what would become public. Nothing is
   * written, so a failed preview leaves no trace.
   */
  async preview(
    packageName: string,
    exactVersion: string,
  ): Promise<PublishPreviewView> {
    const name = assertPackageName(packageName);
    const version = assertExactVersion(exactVersion);
    const preview = await this.#registry.preview({
      sourceId: this.#sourceId,
      packageName: name,
      exactVersion: version,
    });
    return {
      packageName: name,
      exactVersion: version,
      metadata: preview.metadata,
      metadataDigest: preview.metadataDigest,
    };
  }

  /**
   * Commits the publish the Admin confirmed.
   *
   * The snapshot is re-read here rather than accepted from the browser: the
   * only value carried over from the preview is its digest, which is compared
   * against a fresh read. A mismatch stops the publish instead of silently
   * storing something the Admin never saw.
   */
  async publish(input: {
    packageName: string;
    exactVersion: string;
    previewDigest: string | null;
    requestId: string;
  }): Promise<MutationOutcome> {
    const packageName = assertPackageName(input.packageName);
    const exactVersion = assertExactVersion(input.exactVersion);
    const existing = this.#catalog.findPublicationState(
      this.#sourceId,
      packageName,
      exactVersion,
    );

    if (existing.state === "hidden") {
      // Restore reuses the immutable first snapshot: the Registry is not
      // consulted, so a withdrawn version can always be brought back.
      const publication = existing.publication;
      if (!publication) throw new AppError("PUBLICATION_NOT_FOUND");
      const change = this.#catalog.publish({
        sourceId: this.#sourceId,
        packageName,
        exactVersion,
        metadataJson: publication.metadataJson,
        metadataDigest: publication.metadataDigest,
        requestId: input.requestId,
      });
      return this.#commit(change, input.requestId);
    }

    if (existing.state === "visible") {
      // Strictly idempotent: no Registry read, no write, no page refresh.
      const change = this.#catalog.publish({
        sourceId: this.#sourceId,
        packageName,
        exactVersion,
        metadataJson: existing.publication?.metadataJson ?? "{}",
        metadataDigest: existing.publication?.metadataDigest ?? "",
        requestId: input.requestId,
      });
      return {
        change,
        refresh: { outcome: "skipped", paths: [], errorCode: null },
        catalogChanged: false,
      };
    }

    if (!input.previewDigest)
      throw new AppError("INVALID_INPUT", "Preview digest is required");

    const preview = await this.#registry.preview({
      sourceId: this.#sourceId,
      packageName,
      exactVersion,
    });
    if (preview.metadataDigest !== input.previewDigest)
      throw new AppError(
        "PREVIEW_CHANGED",
        "Registry metadata changed since the preview; review it again",
        {
          packageName,
          exactVersion,
          metadata: preview.metadata,
          metadataDigest: preview.metadataDigest,
        },
      );

    const change = this.#catalog.publish({
      sourceId: this.#sourceId,
      packageName,
      exactVersion,
      metadataJson: preview.metadataJson,
      metadataDigest: preview.metadataDigest,
      requestId: input.requestId,
    });
    return this.#commit(change, input.requestId);
  }

  /** Revokes Market visibility for one exact version. */
  async unpublish(input: {
    packageName: string;
    exactVersion: string;
    requestId: string;
  }): Promise<MutationOutcome> {
    const packageName = assertPackageName(input.packageName);
    const exactVersion = assertExactVersion(input.exactVersion);
    const change = this.#catalog.unpublish({
      sourceId: this.#sourceId,
      packageName,
      exactVersion,
      requestId: input.requestId,
    });
    if (change.action === "noop")
      return {
        change,
        refresh: { outcome: "skipped", paths: [], errorCode: null },
        catalogChanged: false,
      };
    return this.#commit(change, input.requestId);
  }

  /**
   * Re-runs page generation for one package without touching the catalogue.
   * Used after a failed refresh; it is idempotent by construction.
   */
  async retryRefresh(
    packageSlug: string,
    requestId: string,
  ): Promise<PublicRefreshResult> {
    const detail = this.#catalog.getAdminPackage(packageSlug);
    if (!detail) throw new AppError("PUBLICATION_NOT_FOUND");
    const result = await this.#publicSite.refreshPackage(packageSlug);
    this.#recordRefresh(detail.packageId, result, requestId);
    return result;
  }

  /** Full regeneration, e.g. after losing the static directory. */
  async rebuildPublicPages(requestId: string): Promise<PublicRefreshResult> {
    const result = await this.#publicSite.rebuildAll();
    for (const entry of this.#catalog.listAdminPackages())
      this.#recordRefresh(entry.packageId, result, requestId);
    return result;
  }

  async #commit(
    change: PublicationChange,
    requestId: string,
  ): Promise<MutationOutcome> {
    const refresh = await this.#publicSite.invalidate(change);
    this.#recordRefresh(change.packageId, refresh, requestId);
    return { change, refresh, catalogChanged: true };
  }

  #recordRefresh(
    packageId: string,
    refresh: PublicRefreshResult,
    requestId: string,
  ): void {
    try {
      this.#catalog.repository.recordRefreshAttempt({
        id: newId(),
        packageId,
        requestedAt: now(),
        completedAt: now(),
        outcome: refresh.outcome === "failed" ? "failed" : "succeeded",
        errorCode: refresh.errorCode,
        requestId,
      });
    } catch {
      // Refresh bookkeeping is diagnostic only; it must never fail the request
      // that already committed a catalogue change.
    }
  }
}
