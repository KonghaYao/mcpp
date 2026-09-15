/**
 * Anonymous read-only surface.
 *
 * Every route is a GET. A request never touches the Registry, so the public
 * read path keeps working while the Registry is down. Pages are served from the
 * pre-rendered cache when present and rendered on demand otherwise, which keeps
 * the site correct even if the cache was never built or was deleted.
 *
 * A catalogue that cannot be read is reported as a temporary failure, never as a
 * withdrawal. Turning a failed lookup into 404 would delist a package that is
 * still published, and reading the disk copy instead is exactly the documented
 * degradation.
 */

import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.ts";
import { MAX_PAGE_SIZE, type CatalogService } from "../catalog/service.ts";
import { fromHttpSlug, fromPackageSlug } from "../catalog/slug.ts";
import {
  renderHome,
  renderList,
  renderNotFound,
  renderPackage,
  renderSearch,
  renderUnavailable,
  renderVersion,
} from "../public-site/render.ts";
import {
  CONNECTORS_PATH,
  EXPERTS_PATH,
  HOME_PATH,
  packagePath,
  versionPath,
  type PublicSiteService,
} from "../public-site/service.ts";
import { MAX_SEARCH_QUERY_LENGTH } from "../search-text.ts";

const HTML = { "Content-Type": "text/html; charset=utf-8" } as const;
const PAGE_CACHE = "public, max-age=60";
const NO_STORE = "no-store";

/**
 * Returned when the catalogue itself could not be read, as opposed to answering
 * "no such package". The two must never be conflated: one is a temporary
 * failure, the other is a withdrawal.
 */
const UNAVAILABLE = Symbol("catalogue-unavailable");

/** Reads the catalogue, converting a failed lookup into {@link UNAVAILABLE}. */
const read = <T>(lookup: () => T): T | typeof UNAVAILABLE => {
  try {
    return lookup();
  } catch (error) {
    console.error("[catalogue-unavailable]", error);
    return UNAVAILABLE;
  }
};

const positiveQuery = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const publicRoutes = (
  catalog: CatalogService,
  publicSite: PublicSiteService,
  homepageUrl: string | null,
): Hono<AppEnv> => {
  const routes = new Hono<AppEnv>();

  /** The document that was already written, or null when there is none. */
  const cached = (relPath: string): Promise<string | null> =>
    publicSite.store.read(relPath).catch(() => null);

  const document = (c: Context<AppEnv>, body: string): Response =>
    c.body(body, 200, { ...HTML, "Cache-Control": PAGE_CACHE });

  const unavailable = (c: Context<AppEnv>): Response =>
    c.body(renderUnavailable(), 503, { ...HTML, "Cache-Control": NO_STORE });

  const notFound = (c: Context<AppEnv>): Response =>
    c.body(renderNotFound(), 404, { ...HTML, "Cache-Control": NO_STORE });

  /**
   * Cache first: serving a page that was already written never touches SQLite,
   * which is what keeps the public surface up while the database is not.
   */
  const serve = async (
    c: Context<AppEnv>,
    relPath: string,
    render: () => Response,
  ): Promise<Response> => {
    const written = await cached(relPath);
    return written !== null ? document(c, written) : render();
  };

  /** The last written page, or a temporary failure when none exists. */
  const stale = async (
    c: Context<AppEnv>,
    relPath: string,
  ): Promise<Response> => {
    const written = await cached(relPath);
    return written === null ? unavailable(c) : document(c, written);
  };

  routes.get("/", (c) =>
    serve(c, HOME_PATH, () => {
      const featured = read(() => catalog.listFeatured(6));
      return featured === UNAVAILABLE
        ? unavailable(c)
        : document(c, renderHome(featured));
    }),
  );

  /**
   * The catalogue page is a pre-rendered document, so it deliberately offers no
   * `limit`/`offset` controls: a page number in the URL would be answered with
   * the same cached file every time. Rendering on demand asks for the same batch
   * the pre-renderer writes, so one URL cannot show two different sets depending
   * on whether the cache happened to hold the document.
   */
  const category = (
    c: Context<AppEnv>,
    relPath: string,
    section: "experts" | "connectors",
  ): Promise<Response> =>
    serve(c, relPath, () => {
      const results = read(() => catalog.listPublic({ limit: MAX_PAGE_SIZE }));
      return results === UNAVAILABLE
        ? unavailable(c)
        : document(c, renderList(results, section));
    });

  routes.get("/market", (c) => category(c, EXPERTS_PATH, "experts"));
  routes.get("/experts", (c) => category(c, EXPERTS_PATH, "experts"));
  routes.get("/connectors", (c) => category(c, CONNECTORS_PATH, "connectors"));

  routes.get("/market/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (fromPackageSlug(slug) === null && fromHttpSlug(slug) === null)
      return notFound(c);

    const detail = read(() => catalog.getPublicPackage(slug));
    // Visibility is settled before the cache is consulted so that a leftover
    // file can never keep serving a withdrawn package.
    if (detail === null) return notFound(c);
    if (detail === UNAVAILABLE) return stale(c, packagePath(slug));

    return serve(c, packagePath(slug), () =>
      document(c, renderPackage({ detail, homepageUrl })),
    );
  });

  routes.get("/market/:slug/v/:version", async (c) => {
    const slug = c.req.param("slug");
    const version = c.req.param("version");
    if (fromPackageSlug(slug) === null && fromHttpSlug(slug) === null)
      return notFound(c);

    const rendered = read(() => catalog.getPublicVersion(slug, version));
    if (rendered === null) return notFound(c);
    if (rendered === UNAVAILABLE) return stale(c, versionPath(slug, version));

    return serve(c, versionPath(slug, version), () =>
      document(
        c,
        renderVersion({
          slug,
          packageName: rendered.packageName,
          sourceId: rendered.sourceId,
          version: rendered.version,
          publishedAt: rendered.publishedAt,
          isLatest: rendered.isLatest,
          metadata: rendered.metadata,
          homepageUrl,
        }),
      ),
    );
  });

  routes.get("/api/search", (c) => {
    const raw = (c.req.query("q") ?? "").slice(0, MAX_SEARCH_QUERY_LENGTH);
    const results = read(() =>
      catalog.searchPublic({ q: raw, limit: 12, offset: 0 }),
    );
    if (results === UNAVAILABLE)
      return c.json({ error: "SEARCH_UNAVAILABLE" }, 503, {
        "Cache-Control": NO_STORE,
      });
    return c.json(
      {
        items: results.items.map((item) => ({
          slug: item.slug,
          sourceKind: item.sourceKind,
          displayName: item.metadata.displayName,
          summary: item.metadata.summary,
          isExpertTeam: item.isExpertTeam,
        })),
      },
      200,
      { "Cache-Control": NO_STORE },
    );
  });

  // Search remains available as a no-JavaScript fallback.
  routes.get("/search", (c) => {
    const raw = (c.req.query("q") ?? "").slice(0, MAX_SEARCH_QUERY_LENGTH);
    const results = read(() =>
      catalog.searchPublic({
        q: raw,
        limit: positiveQuery(c.req.query("limit")),
        offset: positiveQuery(c.req.query("offset")),
      }),
    );
    if (results === UNAVAILABLE) return unavailable(c);
    return c.body(
      renderSearch({
        q: raw,
        items: results.items,
        limit: results.limit,
        offset: results.offset,
      }),
      200,
      { ...HTML, "Cache-Control": NO_STORE },
    );
  });

  return routes;
};
