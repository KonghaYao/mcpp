/**
 * Single-Admin authentication.
 *
 * The session is the only thing standing between the internet and the publish
 * button, so these tests cover forgery, expiry, rotation and throttling — and
 * the request-shape guards that make a stolen token harder to use.
 */

import { describe, expect, test } from "bun:test";
import {
  deriveCsrfToken,
  issueSession,
  verifySession,
} from "../../src/admin-auth/session.ts";
import { LoginRateLimiter } from "../../src/admin-auth/rate-limit.ts";
import { verifyPassword } from "../../src/admin-auth/password.ts";
import { AppError } from "../../src/errors.ts";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  adminPasswordHash,
  createHarness,
  formRequest,
} from "../support/harness.ts";

const SECRET = "test-session-secret-value-0123456789abcdef";
const NOW = 1_800_000_000;

describe("session token", () => {
  test("round-trips a valid token", async () => {
    const { value } = await issueSession(SECRET, ADMIN_USERNAME, 3600, NOW);
    const payload = await verifySession(SECRET, value, NOW + 10);
    expect(payload?.sub).toBe(ADMIN_USERNAME);
    expect(payload?.exp).toBe(NOW + 3600);
  });

  test("rejects a token signed with a different secret", async () => {
    const { value } = await issueSession(SECRET, ADMIN_USERNAME, 3600, NOW);
    expect(
      await verifySession(`${SECRET}-rotated`, value, NOW + 10),
    ).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const { value } = await issueSession(SECRET, ADMIN_USERNAME, 3600, NOW);
    const [body, signature] = value.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "admin", iat: NOW, exp: NOW + 999_999, v: 1 }),
    ).toString("base64url");
    expect(forged).not.toBe(body);
    expect(
      await verifySession(SECRET, `${forged}.${signature}`, NOW + 10),
    ).toBeNull();
  });

  test("rejects a token with no signature", async () => {
    const { value } = await issueSession(SECRET, ADMIN_USERNAME, 3600, NOW);
    expect(
      await verifySession(SECRET, value.split(".")[0] ?? "", NOW),
    ).toBeNull();
  });

  test("rejects malformed input without throwing", async () => {
    for (const candidate of ["", "not-a-token", "a.b.c", "...", "a."])
      expect(await verifySession(SECRET, candidate, NOW)).toBeNull();
    expect(await verifySession(SECRET, undefined, NOW)).toBeNull();
  });

  test("expires exactly at the deadline", async () => {
    const { value } = await issueSession(SECRET, ADMIN_USERNAME, 60, NOW);
    expect(await verifySession(SECRET, value, NOW + 59)).not.toBeNull();
    expect(await verifySession(SECRET, value, NOW + 60)).toBeNull();
    expect(await verifySession(SECRET, value, NOW + 61)).toBeNull();
  });

  test("rejects an unknown session version", async () => {
    const { value } = await issueSession(SECRET, ADMIN_USERNAME, 3600, NOW);
    const [body, signature] = value.split(".");
    const decoded = JSON.parse(
      Buffer.from(body ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const bumped = Buffer.from(JSON.stringify({ ...decoded, v: 99 })).toString(
      "base64url",
    );
    expect(
      await verifySession(SECRET, `${bumped}.${signature}`, NOW + 10),
    ).toBeNull();
  });

  test("derives a stable CSRF token per session", async () => {
    const { value } = await issueSession(SECRET, ADMIN_USERNAME, 3600, NOW);
    const first = await deriveCsrfToken(SECRET, value);
    expect(await deriveCsrfToken(SECRET, value)).toBe(first);
    const other = await issueSession(SECRET, ADMIN_USERNAME, 3600, NOW + 1);
    expect(await deriveCsrfToken(SECRET, other.value)).not.toBe(first);
  });
});

describe("password verification", () => {
  test("accepts the configured password", async () => {
    expect(
      await verifyPassword(ADMIN_PASSWORD, await adminPasswordHash()),
    ).toBe(true);
  });

  test("rejects a wrong password", async () => {
    expect(await verifyPassword("wrong", await adminPasswordHash())).toBe(
      false,
    );
  });

  test("treats an unusable hash as a rejection rather than an error", async () => {
    expect(await verifyPassword(ADMIN_PASSWORD, "not-a-hash")).toBe(false);
  });

  test("rejects an empty password without consulting the hash", async () => {
    expect(await verifyPassword("", "$2b$04$aaaaaaaaaaaaaaaaaaaaaa")).toBe(
      false,
    );
  });
});

describe("login throttling", () => {
  test("allows attempts up to the limit, then blocks", () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 1000 });
    expect(limiter.check("k").allowed).toBe(true);
    limiter.recordFailure("k");
    limiter.recordFailure("k");
    expect(limiter.recordFailure("k").allowed).toBe(false);
  });

  test("reports how long to wait", () => {
    let clock = 0;
    const limiter = new LoginRateLimiter({
      maxAttempts: 1,
      windowMs: 1000,
      now: () => clock,
    });
    limiter.recordFailure("k");
    const decision = limiter.check("k");
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);

    clock = 1001;
    expect(limiter.check("k").allowed).toBe(true);
  });

  test("forgets failures after a successful sign-in", () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 2, windowMs: 1000 });
    limiter.recordFailure("k");
    limiter.reset("k");
    expect(limiter.check("k").allowed).toBe(true);
  });

  test("counts each username separately", () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000 });
    limiter.recordFailure("a");
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });
});

describe("login over HTTP", () => {
  test("issues a session cookie and redirects", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.app.request(
        new Request("http://localhost/admin/login", {
          ...formRequest("/admin/login", {
            username: ADMIN_USERNAME,
            password: ADMIN_PASSWORD,
          }),
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/admin");
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("mcpm_admin=");
      expect(cookie.toLowerCase()).toContain("httponly");
      expect(cookie.toLowerCase()).toContain("samesite=strict");
    } finally {
      await harness.cleanup();
    }
  });

  test("rejects a wrong password without revealing which field failed", async () => {
    const harness = await createHarness();
    try {
      const body = async (username: string, password: string) =>
        (
          await (
            await harness.app.request(
              new Request("http://localhost/admin/login", {
                ...formRequest("/admin/login", { username, password }),
              }),
            )
          ).text()
        ).replaceAll(/\s+/g, " ");

      const wrongPassword = await body(ADMIN_USERNAME, "nope");
      const wrongUsername = await body("someone-else", ADMIN_PASSWORD);
      expect(wrongPassword).toBe(wrongUsername);
      expect(wrongPassword).toContain("用户名或密码不正确");
    } finally {
      await harness.cleanup();
    }
  });

  test("rejects a cross-origin sign-in attempt", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.app.request(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://attacker.example",
            host: "localhost",
          },
          body: new URLSearchParams({
            username: ADMIN_USERNAME,
            password: ADMIN_PASSWORD,
          }).toString(),
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("rejects a JSON body", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.app.request(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
            host: "localhost",
          },
          body: JSON.stringify({
            username: ADMIN_USERNAME,
            password: ADMIN_PASSWORD,
          }),
        }),
      );
      expect(response.status).toBe(401);
    } finally {
      await harness.cleanup();
    }
  });

  test("throttles repeated failures", async () => {
    const harness = await createHarness();
    try {
      let last = 0;
      for (let attempt = 0; attempt < 12; attempt += 1)
        last = (
          await harness.app.request(
            new Request("http://localhost/admin/login", {
              ...formRequest("/admin/login", {
                username: ADMIN_USERNAME,
                password: "wrong",
              }),
            }),
          )
        ).status;
      expect(last).toBe(429);
    } finally {
      await harness.cleanup();
    }
  });

  test("requires a session for the console", async () => {
    const harness = await createHarness();
    try {
      const anonymous = await harness.app.request(
        new Request("http://localhost/admin"),
      );
      expect(anonymous.status).toBe(303);

      const cookie = await harness.login();
      const signedIn = await harness.app.request(
        new Request("http://localhost/admin", {
          headers: { cookie: `mcpm_admin=${cookie}` },
        }),
      );
      expect(signedIn.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  test("rejects a forged session cookie", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.app.request(
        new Request("http://localhost/admin", {
          headers: { cookie: "mcpm_admin=forged.signature" },
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/admin/login");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("origin guard", () => {
  test("accepts a matching origin and host", async () => {
    const harness = await createHarness();
    try {
      expect(() =>
        harness.application.auth.assertSameOrigin(
          "https://market.example",
          "market.example",
        ),
      ).not.toThrow();
    } finally {
      await harness.cleanup();
    }
  });

  test("rejects a mismatched or missing origin", async () => {
    const harness = await createHarness();
    try {
      const auth = harness.application.auth;
      expect(() =>
        auth.assertSameOrigin("https://attacker.example", "market.example"),
      ).toThrow(AppError);
      expect(() => auth.assertSameOrigin(undefined, "market.example")).toThrow(
        AppError,
      );
      expect(() =>
        auth.assertSameOrigin("not a url", "market.example"),
      ).toThrow(AppError);
      expect(() =>
        auth.assertSameOrigin("https://market.example", undefined),
      ).toThrow(AppError);
    } finally {
      await harness.cleanup();
    }
  });

  test("accepts only browser form encodings", async () => {
    const harness = await createHarness();
    try {
      expect(() =>
        harness.application.auth.assertFormContentType(
          "application/x-www-form-urlencoded; charset=UTF-8",
        ),
      ).not.toThrow();
      for (const value of [
        "application/json",
        "text/plain",
        "multipart/form-data",
        undefined,
      ])
        expect(() =>
          harness.application.auth.assertFormContentType(value),
        ).toThrow(AppError);
    } finally {
      await harness.cleanup();
    }
  });
});
