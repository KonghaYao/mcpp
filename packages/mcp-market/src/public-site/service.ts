/**
 * Owns the public page cache: which files must exist for the current catalogue
 * to be served, and how they are refreshed.
 *
 * Static pages are a cache, never a source of truth. Invalidation failures are
 * reported to the caller and never roll back a catalogue change.
 */

import type { CatalogService } from "../catalog/service.ts";
import type { PublicationChange } from "../catalog/types.ts";
import { isAppError } from "../errors.ts";
import {
  renderHome,
  renderList,
  renderNotFound,
  renderPackage,
  renderVersion,
} from "./render.ts";
import { StaticStore } from "./store.ts";

export const HOME_PATH = "index.html";
export const MARKET_PATH = "market/index.html";
export const NOT_FOUND_PATH = "404.html";

export const packagePath = (slug: string): string =>
  `market/${slug}/index.html`;
export const versionPath = (slug: string, version: string): string =>
  `market/${slug}/v/${encodeURIComponent(version)}/index.html`;
export const versionRoot = (slug: string): string => `market/${slug}/v`;

export type PublicRefreshOutcome = "refreshed" | "skipped" | "failed";

export type PublicRefreshResult = {
  outcome: PublicRefreshOutcome;
  paths: string[];
  errorCode: string | null;
};

export type PublicSiteOptions = {
  /** Registry homepage template for the human-facing "view on NPM" link. */
  registryHomepageUrl: string | null;
  /** How many packages the home page features. */
  homeLimit?: number;
};

const DEFAULT_HOME_LIMIT = 6;

/**
 * Renders and stores the anonymous pages. It only reads from `CatalogService`
 * and never touches the Registry, so a Registry outage cannot break the public
 * read path.
 */
export class PublicSiteService {
  readonly #catalog: CatalogService;
  readonly #store: StaticStore;
  readonly #homepageUrl: string | null;
  readonly #homeLimit: number;

  constructor(
    catalog: CatalogService,
    store: StaticStore,
    options: PublicSiteOptions,
  ) {
    this.#catalog = catalog;
    this.#store = store;
    this.#homepageUrl = options.registryHomepageUrl;
    this.#homeLimit = options.homeLimit ?? DEFAULT_HOME_LIMIT;
  }

  get store(): StaticStore {
    return this.#store;
  }

  /**
   * Brings the package's pages in line with the catalogue. Every visible
   * version of the affected package is re-rendered, and any page for a version
   * that is no longer visible is deleted: a stale file would keep serving a
   * withdrawn version, which the public contract forbids.
   */
  async invalidate(change: PublicationChange): Promise<PublicRefreshResult> {
    return this.#run(() => this.#refreshPackage(change.packageSlug));
  }

  /**
   * Re-renders one package without a catalogue change. This is the recovery path
   * after a failed refresh, so it must not require a publication to have just
   * happened.
   */
  async refreshPackage(slug: string): Promise<PublicRefreshResult> {
    return this.#run(() => this.#refreshPackage(slug));
  }

  /** Rebuilds every public page from the catalogue. Safe to call repeatedly. */
  async rebuildAll(): Promise<PublicRefreshResult> {
    return this.#run(async (paths) => {
      const page = this.#catalog.listPublic({ limit: 1000, offset: 0 });
      for (const item of page.items)
        await this.#refreshPackage(item.slug, paths);
      await this.#writeChrome(paths);
    });
  }

  async #run(
    work: (paths: string[]) => Promise<void>,
  ): Promise<PublicRefreshResult> {
    const paths: string[] = [];
    try {
      await work(paths);
      return { outcome: "refreshed", paths, errorCode: null };
    } catch (error) {
      return {
        outcome: "failed",
        paths,
        errorCode: isAppError(error)
          ? error.code
          : ((error as { code?: string })?.code ?? "IO_ERROR"),
      };
    }
  }

  async #writeChrome(paths: string[]): Promise<void> {
    const featured = this.#catalog.listFeatured(this.#homeLimit);
    await this.#store.write(HOME_PATH, renderHome(featured));
    paths.push(HOME_PATH);
    const list = this.#catalog.listPublic({ limit: 1000, offset: 0 });
    await this.#store.write(
      MARKET_PATH,
      renderList({ items: list.items, total: list.total }),
    );
    paths.push(MARKET_PATH);
    await this.#store.write(NOT_FOUND_PATH, renderNotFound());
    paths.push(NOT_FOUND_PATH);
  }

  async #refreshPackage(slug: string, paths: string[] = []): Promise<void> {
    const detail = this.#catalog.getPublicPackage(slug);
    if (!detail) {
      // Nothing is publicly visible: remove the package tree entirely so a
      // withdrawn package cannot be served from a leftover file.
      await this.#store.remove(`market/${slug}`, true);
      await this.#writeChrome(paths);
      return;
    }

    await this.#store.write(
      packagePath(slug),
      renderPackage({ detail, homepageUrl: this.#homepageUrl }),
    );
    paths.push(packagePath(slug));

    const visible = new Set(detail.versions.map((version) => version.version));
    for (const version of detail.versions) {
      const rendered = this.#catalog.getPublicVersion(slug, version.version);
      if (!rendered) continue;
      await this.#store.write(
        versionPath(slug, version.version),
        renderVersion({
          slug,
          packageName: rendered.packageName,
          sourceId: rendered.sourceId,
          version: rendered.version,
          publishedAt: rendered.publishedAt,
          isLatest: rendered.isLatest,
          metadata: rendered.metadata,
          homepageUrl: this.#homepageUrl,
        }),
      );
      paths.push(versionPath(slug, version.version));
    }

    // Cases are encoded into the path, so a previously written page uses the
    // same name; only versions that vanished need removing.
    for (const directory of await this.#store.listDirectories(
      versionRoot(slug),
    )) {
      const decoded = decodeURIComponent(directory);
      if (!visible.has(decoded))
        await this.#store.remove(`market/${slug}/v/${directory}`, true);
    }

    await this.#writeChrome(paths);
  }
}
