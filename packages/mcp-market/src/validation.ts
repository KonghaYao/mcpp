import { AppError, assert } from "./errors.ts";
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
function depth(v: unknown, n = 0): number {
  if (n > 20) throw new AppError(422, "JSON_TOO_DEEP");
  if (!v || typeof v !== "object") return n;
  for (const x of Object.values(v)) depth(x, n + 1);
  return n;
}
export function globalSlug(v: unknown) {
  assert(
    typeof v === "string" && v.length <= 100 && slug.test(v),
    422,
    "INVALID_SLUG",
  );
  return v;
}
export function exactSemver(v: unknown) {
  assert(
    typeof v === "string" && v.length <= 100 && semver.test(v),
    422,
    "INVALID_VERSION",
  );
  return v;
}
export function text(v: unknown, name: string, max = 2000, required = false) {
  assert(v == null || typeof v === "string", 422, "INVALID_INPUT");
  if (required)
    assert(typeof v === "string" && v.trim().length > 0, 422, "INVALID_INPUT");
  if (typeof v === "string") assert(v.length <= max, 422, "INVALID_INPUT");
  return (v ?? null) as string | null;
}
export function displayUrl(v: unknown) {
  if (v == null) return null;
  assert(typeof v === "string" && v.length <= 2048, 422, "INVALID_URL");
  try {
    const u = new URL(v);
    assert(["http:", "https:"].includes(u.protocol), 422, "INVALID_URL");
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(422, "INVALID_URL");
  }
  return v;
}
export function tags(v: unknown) {
  assert(
    Array.isArray(v) &&
      v.length <= 20 &&
      v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 50),
    422,
    "INVALID_TAGS",
  );
  return v as string[];
}
export function backendLocator(v: unknown) {
  assert(typeof v === "string" || object(v), 422, "INVALID_BACKEND_LOCATOR");
  assert(size(v) <= 65536, 413, "JSON_TOO_LARGE");
  depth(v);
  return v;
}
export function serverDefinition(v: unknown) {
  assert(object(v) && !object(v.mcpServers), 422, "INVALID_SERVER_DEFINITION");
  assert(
    typeof v.command === "string" &&
      v.command.trim().length > 0 &&
      v.command.length <= 1024,
    422,
    "INVALID_SERVER_DEFINITION",
  );
  for (const k of ["url", "transport", "type"])
    assert(!(k in v), 422, "INVALID_SERVER_DEFINITION");
  if (v.args !== undefined)
    assert(
      Array.isArray(v.args) && v.args.every((x) => typeof x === "string"),
      422,
      "INVALID_SERVER_DEFINITION",
    );
  if (v.env !== undefined)
    assert(
      object(v.env) && Object.values(v.env).every((x) => typeof x === "string"),
      422,
      "INVALID_SERVER_DEFINITION",
    );
  assert(size(v) <= 65536, 413, "JSON_TOO_LARGE");
  depth(v);
  return v;
}
export function envSchema(v: unknown) {
  if (v == null) return null;
  assert(object(v), 422, "INVALID_ENV_SCHEMA");
  if (v.type !== undefined)
    assert(v.type === "object", 422, "INVALID_ENV_SCHEMA");
  if (v.properties !== undefined)
    assert(object(v.properties), 422, "INVALID_ENV_SCHEMA");
  assert(size(v) <= 65536, 413, "JSON_TOO_LARGE");
  depth(v);
  return v;
}
export function expiresAt(v: unknown) {
  if (v == null) return null;
  assert(typeof v === "string", 422, "INVALID_EXPIRES_AT");
  const timestamp = Date.parse(v);
  assert(
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === v,
    422,
    "INVALID_EXPIRES_AT",
  );
  return v;
}
export function bodyObject(v: unknown) {
  assert(object(v), 400, "INVALID_INPUT");
  return v;
}
