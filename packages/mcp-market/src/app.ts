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
 * Security headers are applied to every response. `default-src 'none'` is
 * accurate rather than aspirational: the rendered documents contain no scripts
 * and no external resources.
 */
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

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
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", CSP);
    await next();
  });

  app.onError((error, c) => fail(c, error));

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
