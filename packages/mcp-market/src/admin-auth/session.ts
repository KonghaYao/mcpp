/**
 * Stateless signed session cookies.
 *
 * The payload is `base64url(json).base64url(hmac)`; there is no server-side
 * session store, so rotating `MCPM_SESSION_SECRET` or bumping the version
 * invalidates every outstanding cookie. Nothing secret is placed in the
 * cookie, and the payload carries no data that could be tampered into a
 * privilege change.
 */

import { AppError } from "../errors.ts";

export const SESSION_COOKIE_NAME = "mcpm_admin";
export const SESSION_VERSION = 1;

export type SessionPayload = {
  /** Fixed subject; there is exactly one Admin. */
  sub: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Session version; bumping it revokes every cookie. */
  v: number;
};

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const hmac = async (secret: string, data: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(signature);
};

/** Length-independent comparison so signature checks cannot be timed. */
const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1)
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
};

export async function issueSession(
  secret: string,
  subject: string,
  ttlSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ value: string; payload: SessionPayload }> {
  const payload: SessionPayload = {
    sub: subject,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    v: SESSION_VERSION,
  };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(secret, body);
  return { value: `${body}.${base64url(signature)}`, payload };
}

/** Returns the payload only for an authentic, unexpired cookie. */
export async function verifySession(
  secret: string,
  cookie: string | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  if (typeof cookie !== "string" || cookie.length === 0) return null;
  const separator = cookie.indexOf(".");
  if (separator <= 0 || separator === cookie.length - 1) return null;
  const body = cookie.slice(0, separator);
  const provided = cookie.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(provided))
    return null;

  let expected: Uint8Array;
  try {
    expected = await hmac(secret, body);
  } catch {
    return null;
  }
  const given = Buffer.from(provided, "base64url");
  if (!timingSafeEqual(expected, new Uint8Array(given))) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload?.sub !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.v !== SESSION_VERSION
  )
    return null;
  if (payload.exp <= nowSeconds) return null;
  return payload;
}

/**
 * Derives the CSRF token from the session value, so a token is valid only for
 * the cookie that produced it and cannot be replayed across sessions.
 */
export async function deriveCsrfToken(
  secret: string,
  sessionValue: string,
): Promise<string> {
  const signature = await hmac(secret, `csrf:${sessionValue}`);
  return base64url(signature);
}

export const assertSession = (
  payload: SessionPayload | null,
): SessionPayload => {
  if (!payload) throw new AppError("UNAUTHENTICATED");
  return payload;
};
