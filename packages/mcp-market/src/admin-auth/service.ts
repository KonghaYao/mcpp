/**
 * Authentication policy for the single Admin account.
 *
 * No user table, no roles, no permissions: one subject, verified against a
 * configured hash and carried in a signed cookie. Mutation requests must also
 * prove same-origin intent, which is what makes a CSRF token meaningful here.
 */

import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import { verifyPassword } from "./password.ts";
import { LoginRateLimiter, type RateLimitDecision } from "./rate-limit.ts";
import {
  SESSION_COOKIE_NAME,
  deriveCsrfToken,
  issueSession,
  verifySession,
  type SessionPayload,
} from "./session.ts";

export { SESSION_COOKIE_NAME };

export type LoginResult =
  | { status: "issued"; cookieValue: string; csrfToken: string; maxAge: number }
  | { status: "invalid" }
  | { status: "rate_limited"; retryAfterSeconds: number };

export type AdminAuthOptions = {
  maxLoginAttempts?: number;
  windowMs?: number;
  now?: () => number;
  nowSeconds?: () => number;
};

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

export class AdminAuthService {
  readonly #config: Config;
  readonly #limiter: LoginRateLimiter;
  readonly #nowSeconds: () => number;

  constructor(config: Config, options: AdminAuthOptions = {}) {
    this.#config = config;
    this.#limiter = new LoginRateLimiter({
      maxAttempts: options.maxLoginAttempts ?? DEFAULT_MAX_ATTEMPTS,
      windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
      now: options.now,
    });
    this.#nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  get sessionCookieName(): string {
    return SESSION_COOKIE_NAME;
  }

  get maxAgeSeconds(): number {
    return this.#config.sessionTtlSeconds;
  }

  /**
   * Verifies credentials. The username comparison is constant-ish for the same
   * reason the password check is: a caller must not learn whether the username
   * exists by timing the response.
   */
  async login(
    username: string,
    password: string,
    clientKey: string,
  ): Promise<LoginResult> {
    const bucketKey = `${clientKey}\u0000${username}`;
    const precheck = this.#limiter.check(bucketKey);
    if (!precheck.allowed)
      return {
        status: "rate_limited",
        retryAfterSeconds: precheck.retryAfterSeconds,
      };

    const usernameMatches = username === this.#config.adminUsername;
    const passwordMatches = await verifyPassword(
      password,
      this.#config.adminPasswordHash,
    );
    if (!usernameMatches || !passwordMatches) {
      const decision = this.#limiter.recordFailure(bucketKey);
      return decision.allowed
        ? { status: "invalid" }
        : {
            status: "rate_limited",
            retryAfterSeconds: decision.retryAfterSeconds,
          };
    }

    this.#limiter.reset(bucketKey);
    const { value } = await issueSession(
      this.#config.sessionSecret,
      this.#config.adminUsername,
      this.#config.sessionTtlSeconds,
      this.#nowSeconds(),
    );
    return {
      status: "issued",
      cookieValue: value,
      csrfToken: await deriveCsrfToken(this.#config.sessionSecret, value),
      maxAge: this.#config.sessionTtlSeconds,
    };
  }

  /** Returns the payload for an authentic cookie, or null. */
  async authenticate(
    cookieValue: string | undefined,
  ): Promise<SessionPayload | null> {
    return verifySession(
      this.#config.sessionSecret,
      cookieValue,
      this.#nowSeconds(),
    );
  }

  async csrfTokenFor(cookieValue: string): Promise<string> {
    return deriveCsrfToken(this.#config.sessionSecret, cookieValue);
  }

  async assertCsrf(
    cookieValue: string,
    provided: string | undefined,
  ): Promise<void> {
    const expected = await this.csrfTokenFor(cookieValue);
    if (
      typeof provided !== "string" ||
      !timingSafeStringEqual(expected, provided)
    )
      throw new AppError("FORBIDDEN_ORIGIN", "Invalid CSRF token");
  }

  /**
   * Requires an `Origin` header that matches the request host. Browsers always
   * send it for cross-origin form posts, so a mismatch means the request did
   * not originate from this site.
   */
  assertSameOrigin(origin: string | undefined, host: string | undefined): void {
    if (!origin) throw new AppError("FORBIDDEN_ORIGIN", "Missing Origin");
    if (!host) throw new AppError("FORBIDDEN_ORIGIN", "Missing Host");
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new AppError("FORBIDDEN_ORIGIN", "Malformed Origin");
    }
    if (parsed.host !== host)
      throw new AppError("FORBIDDEN_ORIGIN", "Origin does not match Host");
  }

  /**
   * Only browser form encodings are accepted. Rejecting everything else
   * prevents a cross-site `fetch` from turning this endpoint into a JSON API.
   */
  assertFormContentType(contentType: string | undefined): void {
    const value = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (value !== "application/x-www-form-urlencoded")
      throw new AppError("FORBIDDEN_ORIGIN", "Unsupported content type");
  }

  /** Cookie attributes; `Secure` is configurable for local HTTP development. */
  cookieOptions(): {
    httpOnly: true;
    secure: boolean;
    sameSite: "Strict";
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      secure: this.#config.secureCookies,
      sameSite: "Strict",
      path: "/",
      maxAge: this.#config.sessionTtlSeconds,
    };
  }

  /** Applies the limiter's own decision headers to a blocked response. */
  static retryAfterHeaders(
    decision: RateLimitDecision,
  ): Record<string, string> {
    return decision.retryAfterSeconds > 0
      ? { "Retry-After": String(decision.retryAfterSeconds) }
      : {};
  }
}

const timingSafeStringEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1)
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
};

export { timingSafeStringEqual };
