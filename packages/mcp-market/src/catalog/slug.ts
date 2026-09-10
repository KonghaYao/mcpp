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

export const toPackageSlug = (packageName: string): string =>
  `${SLUG_PREFIX}${Buffer.from(packageName, "utf8").toString("base64url")}`;

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
