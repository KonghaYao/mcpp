export type Config = {
  readonly adminUsername: string;
  readonly adminPasswordHash: string;
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  readonly dbPath: string;
  readonly staticDir: string;
  readonly registryBaseUrl: string;
  readonly registryHomepageUrl: string | null;
  readonly sourceId: string;
  readonly registryTimeoutMs: number;
  readonly registryMaxBytes: number;
  readonly port: number;
  readonly host: string;
  readonly secureCookies: boolean;
  readonly trustProxy: boolean;
};

export const SESSION_SECRET_MIN_LENGTH = 32;

const PASSWORD_HASH_PREFIXES = [
  "$argon2id$",
  "$argon2i$",
  "$argon2d$",
  "$2a$",
  "$2b$",
  "$2y$",
] as const;

export const isSupportedPasswordHash = (value: string): boolean =>
  PASSWORD_HASH_PREFIXES.some((prefix) => value.startsWith(prefix));

const requireNonEmpty = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} is required`);
  return value;
};

const readPositiveInt = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${name}`);
  return value;
};

const readBoolean = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid ${name}`);
};

const readBaseUrl = (env: NodeJS.ProcessEnv, name: string): string => {
  const raw = requireNonEmpty(env, name);
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`${name} must be http or https`);
  return url.toString().replace(/\/+$/, "");
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adminPasswordHash = requireNonEmpty(env, "MCPM_ADMIN_PASSWORD_HASH");
  if (!isSupportedPasswordHash(adminPasswordHash))
    throw new Error(
      "MCPM_ADMIN_PASSWORD_HASH must be a bcrypt or argon2 hash (no plaintext)",
    );
  const sessionSecret = requireNonEmpty(env, "MCPM_SESSION_SECRET");
  if (sessionSecret.length < SESSION_SECRET_MIN_LENGTH)
    throw new Error(
      `MCPM_SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LENGTH} characters`,
    );
  return {
    adminUsername: requireNonEmpty(env, "MCPM_ADMIN_USERNAME"),
    adminPasswordHash,
    sessionSecret,
    sessionTtlSeconds: readPositiveInt(env, "MCPM_SESSION_TTL_SECONDS", 3600),
    dbPath: env.MCPM_DB_PATH ?? "mcpm.sqlite",
    staticDir: env.MCPM_STATIC_DIR ?? "public-static",
    registryBaseUrl: readBaseUrl(env, "MCPM_REGISTRY_URL"),
    registryHomepageUrl:
      env.MCPM_REGISTRY_HOMEPAGE_URL === undefined ||
      env.MCPM_REGISTRY_HOMEPAGE_URL === ""
        ? null
        : readBaseUrl(env, "MCPM_REGISTRY_HOMEPAGE_URL"),
    sourceId: env.MCPM_SOURCE_ID ?? "npm",
    registryTimeoutMs: readPositiveInt(env, "MCPM_REGISTRY_TIMEOUT_MS", 8000),
    registryMaxBytes: readPositiveInt(
      env,
      "MCPM_REGISTRY_MAX_BYTES",
      4 * 1024 * 1024,
    ),
    port: readPositiveInt(env, "PORT", 3000),
    host: env.HOST ?? "0.0.0.0",
    secureCookies: readBoolean(env, "MCPM_SECURE_COOKIES", true),
    trustProxy: readBoolean(env, "MCPM_TRUST_PROXY", false),
  };
}
