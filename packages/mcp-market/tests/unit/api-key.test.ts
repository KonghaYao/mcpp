import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminAuth } from "../../src/auth/api-key.ts";

describe("admin auth", () => {
  test("returns 401 for bearer secrets of a different length", async () => {
    const app = new Hono();
    app.onError((error, c) =>
      c.json(
        { error: { code: (error as any).code } },
        (error as any).status ?? 500,
      ),
    );
    app.use("*", adminAuth("correct-secret"));
    app.get("/", (c) => c.text("ok"));
    const response = await app.request("/", {
      headers: { authorization: "Bearer short" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_ADMIN_SECRET" },
    });
  });
});
