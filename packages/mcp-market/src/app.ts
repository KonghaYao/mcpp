import { Hono } from "hono";
import type { Db } from "./db/database.ts";
import type { Config } from "./config.ts";
import { adminAuth, publisherAuth, type Actor } from "./auth/api-key.ts";
import { fail } from "./errors.ts";
import { adminRoutes } from "./routes/admin.ts";
import { publisherRoutes } from "./routes/publisher.ts";
import { publicRoutes } from "./routes/public.ts";
import { adminPage, marketPage, publisherPage } from "./ui.ts";
type Vars = { requestId: string; actor: Actor };
export function createApp(db: Db, cfg: Config) {
  const app = new Hono<{ Variables: Vars }>();
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? crypto.randomUUID());
    c.header("x-request-id", c.get("requestId"));
    await next();
  });
  app.onError((e, c) => fail(c, e));
  app.get("/", (c) => c.html(marketPage));
  app.get("/admin", (c) => c.html(adminPage));
  app.get("/publisher", (c) => c.html(publisherPage));
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", (c) => {
    db.query("SELECT 1").get();
    return c.json({ status: "ready", dependencies: { sqlite: "ok" } });
  });
  app.route(
    "/api/v1/admin",
    new Hono<{ Variables: Vars }>()
      .use("*", adminAuth(cfg.adminSecret))
      .route("/", adminRoutes(db)),
  );
  app.route(
    "/api/v1/publisher",
    new Hono<{ Variables: Vars }>()
      .use("*", publisherAuth(db))
      .route("/", publisherRoutes(db)),
  );
  app.route("/api/v1", publicRoutes(db));
  return app;
}
