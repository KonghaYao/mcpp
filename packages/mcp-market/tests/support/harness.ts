/**
 * Test harness: a real SQLite database in a temporary directory, a real static
 * directory, and a loopback fixture Registry.
 *
 * Nothing is mocked except the Registry host. The catalogue, the filesystem and
 * the HTTP surface under test are the production implementations.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type Application } from "../../src/app.ts";
import type { Config } from "../../src/config.ts";
import { openDatabase, type Db } from "../../src/db/database.ts";
import { NpmRegistryService } from "../../src/npm-registry/service.ts";
// Installs the loopback-only fetch guard for the whole test process.
import "./no-network.ts";
import {
  startFixtureRegistry,
  type FixtureHandler,
  type FixtureRegistry,
} from "./registry-server.ts";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "test-password-value";

let passwordHashPromise: Promise<string> | null = null;

/** bcrypt at the lowest cost keeps login tests fast and still real. */
export const adminPasswordHash = (): Promise<string> => {
  passwordHashPromise ??= Bun.password.hash(ADMIN_PASSWORD, {
    algorithm: "bcrypt",
    cost: 4,
  });
  return passwordHashPromise;
};

export type Harness = {
  application: Application;
  app: Application["app"];
  config: Config;
  db: Db;
  root: string;
  dbPath: string;
  staticDir: string;
  registry: FixtureRegistry;
  setRegistryHandler(handler: FixtureHandler): void;
  /** Signs in and returns the session cookie value. */
  login(): Promise<string>;
  /** Extracts the CSRF token rendered into an Admin form. */
  csrfOf(html: string): string;
  cleanup(): Promise<void>;
};

export type HarnessOptions = {
  registryHandler?: FixtureHandler;
  /** Overrides for the generated config, e.g. a broken static directory. */
  configOverrides?: Partial<Config>;
  /** Skip creating the static directory, to test a missing cache. */
  skipStaticDir?: boolean;
};

export async function createHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "mcpm-test-"));
  const dbPath = join(root, "market.sqlite");
  const staticDir = join(root, "public");

  const registry = startFixtureRegistry(
    options.registryHandler ?? (() => new Response("{}", { status: 404 })),
  );

  const config: Config = {
    adminUsername: ADMIN_USERNAME,
    adminPasswordHash: await adminPasswordHash(),
    sessionSecret: "test-session-secret-value-0123456789abcdef",
    sessionTtlSeconds: 3600,
    dbPath,
    staticDir,
    registryBaseUrl: registry.baseUrl,
    registryHomepageUrl: null,
    sourceId: "npm",
    registryTimeoutMs: 4000,
    registryMaxBytes: 512 * 1024,
    port: 0,
    host: "127.0.0.1",
    secureCookies: false,
    trustProxy: false,
    ...options.configOverrides,
  };

  const db = await openDatabase(dbPath);
  const application = createApplication({
    db,
    config,
    registry: new NpmRegistryService({
      baseUrl: config.registryBaseUrl,
      timeoutMs: config.registryTimeoutMs,
      maxBytes: config.registryMaxBytes,
    }),
  });

  if (!options.skipStaticDir)
    await application.publicSite.store.ensureRoot().catch(() => undefined);

  const csrfOf = (html: string): string => {
    const match = /name="csrf" value="([^"]+)"/.exec(html);
    if (!match?.[1]) throw new Error("CSRF token not found in page");
    return match[1];
  };

  return {
    application,
    app: application.app,
    config,
    db,
    root,
    dbPath,
    staticDir,
    registry,
    setRegistryHandler(handler) {
      registry.setHandler(handler);
    },
    async login() {
      const response = await application.app.request("/admin/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost",
          host: "localhost",
        },
        body: new URLSearchParams({
          username: ADMIN_USERNAME,
          password: ADMIN_PASSWORD,
        }).toString(),
      });
      const setCookie = response.headers.get("set-cookie");
      if (!setCookie) throw new Error(`login failed with ${response.status}`);
      const value = /mcpm_admin=([^;]+)/.exec(setCookie)?.[1];
      if (!value) throw new Error("session cookie not issued");
      return value;
    },
    csrfOf,
    async cleanup() {
      registry.stop();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Request helpers that keep the tests readable. */
export const formRequest = (
  path: string,
  body: Record<string, string>,
  cookie?: string,
): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "http://localhost",
    host: "localhost",
    ...(cookie ? { cookie: `mcpm_admin=${cookie}` } : {}),
  },
  body: new URLSearchParams(body).toString(),
});

export const getRequest = (path: string, cookie?: string): RequestInit => ({
  method: "GET",
  headers: cookie ? { cookie: `mcpm_admin=${cookie}` } : {},
});

/**
 * Blocks the static directory with a regular file, so every page write fails
 * with a real filesystem error instead of a simulated one.
 */
export async function blockStaticDir(staticDir: string): Promise<void> {
  await rm(staticDir, { recursive: true, force: true });
  await writeFile(staticDir, "not a directory", "utf8");
}
