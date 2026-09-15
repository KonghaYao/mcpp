/**
 * URL-safe, reversible encoding of an NPM package name.
 *
 * Chosen over slugified names because scope separators and case are load
 * bearing in NPM identity, and `%2F` handling differs between proxies. base64url
 * has no reserved characters, so a route key can never be mistaken for a path
 * separator.
 */
const SLUG_PREFIX = "p-";
const SLUG_BODY_PATTERN = /^[A-Za-z0-9_-]+$/;

export const isHttpSource = (sourceId: string): boolean =>
  sourceId.startsWith("http:");

export const toPackageSlug = (packageName: string, sourceId = "npm"): string =>
  isHttpSource(sourceId)
    ? `h-${Buffer.from(JSON.stringify([sourceId, packageName]), "utf8").toString("base64url")}`
    : `${SLUG_PREFIX}${Buffer.from(packageName, "utf8").toString("base64url")}`;

export const fromHttpSlug = (
  slug: string,
): { sourceId: string; packageName: string } | null => {
  if (!slug.startsWith("h-") || slug.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(slug.slice(2), "base64url").toString("utf8"),
    );
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [sourceId, packageName] = value;
    if (
      typeof sourceId !== "string" ||
      !isHttpSource(sourceId) ||
      typeof packageName !== "string" ||
      !packageName ||
      toPackageSlug(packageName, sourceId) !== slug
    )
      return null;
    return { sourceId, packageName };
  } catch {
    return null;
  }
};

/**
 * Returns the package name only for canonical encodings. Non-canonical input
 * (padding, stray characters, alternate byte sequences) is rejected, which also
 * denies traversal-style route keys before any lookup happens.
 */
export const fromPackageSlug = (slug: string): string | null => {
  if (typeof slug !== "string" || !slug.startsWith(SLUG_PREFIX)) return null;
  const body = slug.slice(SLUG_PREFIX.length);
  if (!SLUG_BODY_PATTERN.test(body)) return null;
  const decoded = Buffer.from(body, "base64url").toString("utf8");
  if (decoded.length === 0) return null;
  return toPackageSlug(decoded) === slug ? decoded : null;
};
