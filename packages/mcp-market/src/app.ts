/**
 * Application assembly.
 *
 * This is the only module that knows all four business modules at once. It
 * wires them, applies the cross-cutting headers, and exposes the health
 * endpoints. Routers adapt HTTP to the typed services; no router writes the
 * catalogue directly.
 */

import { Hono } from "hono";
import { AdminService } from "./admin/service.ts";
import { AdminAuthService } from "./admin-auth/service.ts";
import { CatalogService } from "./catalog/service.ts";
import type { Config } from "./config.ts";
import { openDatabase, type Db } from "./db/database.ts";
import type { AppEnv } from "./env.ts";
import { fail } from "./errors.ts";
import { NpmRegistryService } from "./npm-registry/service.ts";
import { PublicSiteService } from "./public-site/service.ts";
import { StaticStore } from "./public-site/store.ts";
import { adminRoutes } from "./routes/admin.ts";
import { publicRoutes } from "./routes/public.ts";

export type AppDependencies = {
  db: Db;
  config: Config;
  /** Injectable so tests can serve a local fixture instead of a real Registry. */
  registry?: NpmRegistryService;
  catalog?: CatalogService;
  publicSite?: PublicSiteService;
};

export type Application = {
  app: Hono<AppEnv>;
  config: Config;
  catalog: CatalogService;
  registry: NpmRegistryService;
  publicSite: PublicSiteService;
  auth: AdminAuthService;
  admin: AdminService;
};

/**
 * Security headers are applied to every response. Scripts are restricted to the
 * single same-origin search-dialog asset; external resources remain blocked.
 */
const MARKET_ASSETS = new Set([
  "img_campus_learning_s01.webp",
  "img_content_creation_s02.webp",
  "img_investment_analysis_s03.webp",
  "img_legal_consulting_s04.webp",
  "img_small_business_s05.webp",
  "img_ecommerce_operations_s06.webp",
  "img_data_analysis_s07.webp",
  "img_professional_documents_s08.webp",
  "img_product_design_s09.webp",
  "img_engineering_development_s10.webp",
  "img_mcpp_market_brand_icon.webp",
  "img_marketplace_background.webp",
]);

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function createApplication(deps: AppDependencies): Application {
  const { db, config } = deps;

  const catalog = deps.catalog ?? new CatalogService(db);
  const registry =
    deps.registry ??
    new NpmRegistryService({
      baseUrl: config.registryBaseUrl,
      timeoutMs: config.registryTimeoutMs,
      maxBytes: config.registryMaxBytes,
    });
  const publicSite =
    deps.publicSite ??
    new PublicSiteService(catalog, new StaticStore(config.staticDir), {
      registryHomepageUrl: config.registryHomepageUrl,
    });
  const auth = new AdminAuthService(config);
  const admin = new AdminService({ catalog, registry, publicSite, config });

  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const provided = c.req.header("x-request-id");
    const requestId =
      provided && /^[A-Za-z0-9._:-]{1,128}$/.test(provided)
        ? provided
        : crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    c.header("X-Content-Type-Options", "nosniff");
    // `same-origin`, not `no-referrer`: Chrome sets `Origin: null` on form
    // navigations from a document whose referrer policy is `no-referrer`, which
    // `AdminAuthService.assertSameOrigin` then rejects. That would break every
    // admin form (login, publish, unpublish, refresh) in a real browser while
    // tests, which set the header by hand, keep passing. `same-origin` still
    // sends no referrer off-origin, and outbound links carry `rel=noreferrer`.
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", CSP);
    await next();
  });

  app.onError((error, c) => fail(c, error));

  app.get(
    "/assets/market/search-dialog.js",
    () =>
      new Response(
        Bun.file(new URL("../assets/market/search-dialog.js", import.meta.url)),
        {
          headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        },
      ),
  );

  app.get("/assets/market/:name", (c) => {
    const name = c.req.param("name");
    if (!MARKET_ASSETS.has(name)) return c.notFound();
    return new Response(
      Bun.file(new URL(`../assets/market/${name}`, import.meta.url)),
      {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      },
    );
  });

  app.get("/health/live", (c) =>
    c.json({ status: "ok" }, 200, { "Cache-Control": "no-store" }),
  );

  app.get("/health/ready", (c) => {
    try {
      db.query("SELECT 1").get();
      // FTS5 is required for search; a build without it must fail readiness
      // rather than silently serving an unindexed catalogue.
      db.query("SELECT count(*) FROM market_search").get();
      return c.json(
        { status: "ready", dependencies: { sqlite: "ok", fts5: "ok" } },
        200,
        { "Cache-Control": "no-store" },
      );
    } catch {
      return c.json(
        { status: "unavailable", dependencies: { sqlite: "error" } },
        503,
        { "Cache-Control": "no-store" },
      );
    }
  });

  app.route(
    "/admin",
    adminRoutes(
      { auth, admin, catalog },
      {
        trustProxy: config.trustProxy,
      },
    ),
  );
  app.route("/", publicRoutes(catalog, publicSite, config.registryHomepageUrl));

  return { app, config, catalog, registry, publicSite, auth, admin };
}

/** Opens the database and assembles the application. */
export async function bootstrap(config: Config): Promise<Application> {
  const db = await openDatabase(config.dbPath);
  return createApplication({ db, config });
}
