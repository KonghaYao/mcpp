/**
 * Configuration boundary.
 *
 * Config is the only place a Registry URL can enter the process, so the
 * external-link protocol restriction is enforced here rather than trusted from
 * whatever happens to be in a deployment environment. A `javascript:` or `data:`
 * homepage would otherwise be stored verbatim and rendered into every package
 * page.
 */

import { describe, expect, test } from "bun:test";
import {
  isSupportedPasswordHash,
  loadConfig,
  SESSION_SECRET_MIN_LENGTH,
} from "../../src/config.ts";

const HASH = "$2b$04$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP";
const SECRET = "s".repeat(SESSION_SECRET_MIN_LENGTH);

const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  MCPM_ADMIN_USERNAME: "admin",
  MCPM_ADMIN_PASSWORD_HASH: HASH,
  MCPM_SESSION_SECRET: SECRET,
  MCPM_REGISTRY_URL: "https://registry.npmjs.org",
  ...overrides,
});

describe("homepage link protocol", () => {
  test("accepts an https homepage", () => {
    const config = loadConfig(
      env({ MCPM_REGISTRY_HOMEPAGE_URL: "https://www.npmjs.com" }),
    );
    expect(config.registryHomepageUrl).toBe("https://www.npmjs.com");
  });

  test("accepts an http homepage for a self-hosted registry", () => {
    const config = loadConfig(
      env({ MCPM_REGISTRY_HOMEPAGE_URL: "http://localhost:4873" }),
    );
    expect(config.registryHomepageUrl).toBe("http://localhost:4873");
  });

  test("is null when unset, so the UI shows text instead of a link", () => {
    expect(loadConfig(env()).registryHomepageUrl).toBeNull();
    expect(
      loadConfig(env({ MCPM_REGISTRY_HOMEPAGE_URL: "" })).registryHomepageUrl,
    ).toBeNull();
  });

  test("refuses a javascript: homepage", () => {
    expect(() =>
      loadConfig(env({ MCPM_REGISTRY_HOMEPAGE_URL: "javascript:alert(1)" })),
    ).toThrow(/must be http or https/);
  });

  test("refuses a data: homepage", () => {
    expect(() =>
      loadConfig(
        env({
          MCPM_REGISTRY_HOMEPAGE_URL: "data:text/html,<script>1</script>",
        }),
      ),
    ).toThrow(/must be http or https/);
  });

  test("refuses a file: homepage", () => {
    expect(() =>
      loadConfig(env({ MCPM_REGISTRY_HOMEPAGE_URL: "file:///etc/passwd" })),
    ).toThrow(/must be http or https/);
  });

  test("refuses a vbscript: homepage", () => {
    expect(() =>
      loadConfig(env({ MCPM_REGISTRY_HOMEPAGE_URL: "vbscript:msgbox(1)" })),
    ).toThrow(/must be http or https/);
  });

  test("trims trailing slashes so links are not doubled", () => {
    expect(
      loadConfig(env({ MCPM_REGISTRY_HOMEPAGE_URL: "https://www.npmjs.com//" }))
        .registryHomepageUrl,
    ).toBe("https://www.npmjs.com");
  });

  test("refuses an empty registry base URL rather than defaulting", () => {
    expect(() => loadConfig(env({ MCPM_REGISTRY_URL: "" }))).toThrow(
      /MCPM_REGISTRY_URL is required/,
    );
  });

  test("applies the same protocol rule to the registry base URL", () => {
    expect(() =>
      loadConfig(env({ MCPM_REGISTRY_URL: "ftp://registry.example.com" })),
    ).toThrow(/must be http or https/);
  });
});

describe("admin credentials", () => {
  test("refuses a plaintext password in the hash slot", () => {
    expect(() =>
      loadConfig(env({ MCPM_ADMIN_PASSWORD_HASH: "hunter2" })),
    ).toThrow(/bcrypt or argon2/);
  });

  test("refuses a session secret that is too short", () => {
    expect(() => loadConfig(env({ MCPM_SESSION_SECRET: "short" }))).toThrow(
      /at least/,
    );
  });

  test("refuses a blank admin username", () => {
    expect(() => loadConfig(env({ MCPM_ADMIN_USERNAME: "   " }))).toThrow(
      /MCPM_ADMIN_USERNAME is required/,
    );
  });

  test("recognises the supported hash prefixes", () => {
    for (const prefix of ["$2a$", "$2b$", "$2y$", "$argon2id$", "$argon2i$"]) {
      expect(isSupportedPasswordHash(`${prefix}rest`)).toBe(true);
    }
    expect(isSupportedPasswordHash("$1$md5$rest")).toBe(false);
    expect(isSupportedPasswordHash("")).toBe(false);
  });
});

describe("numeric and boolean guards", () => {
  test("falls back to documented defaults", () => {
    const config = loadConfig(env());
    expect(config.registryTimeoutMs).toBe(8000);
    expect(config.registryMaxBytes).toBe(4 * 1024 * 1024);
    expect(config.port).toBe(3000);
    expect(config.sourceId).toBe("npm");
  });

  test("refuses a non-integer timeout", () => {
    expect(() => loadConfig(env({ MCPM_REGISTRY_TIMEOUT_MS: "soon" }))).toThrow(
      /Invalid MCPM_REGISTRY_TIMEOUT_MS/,
    );
  });

  test("refuses zero or negative sizes", () => {
    expect(() => loadConfig(env({ MCPM_REGISTRY_MAX_BYTES: "0" }))).toThrow(
      /Invalid MCPM_REGISTRY_MAX_BYTES/,
    );
    expect(() => loadConfig(env({ PORT: "-1" }))).toThrow(/Invalid PORT/);
  });

  test("defaults to secure cookies and no proxy trust", () => {
    const config = loadConfig(env());
    expect(config.secureCookies).toBe(true);
    expect(config.trustProxy).toBe(false);
  });

  test("refuses a boolean that is neither true nor false", () => {
    expect(() => loadConfig(env({ MCPM_TRUST_PROXY: "yes" }))).toThrow(
      /Invalid MCPM_TRUST_PROXY/,
    );
  });
});
