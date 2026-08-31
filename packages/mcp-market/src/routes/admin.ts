import { Hono } from "hono";
import type { Db } from "../db/database.ts";
import { issueKey } from "../auth/api-key.ts";
import { id, immediate, now } from "../db/database.ts";
import { assert, AppError } from "../errors.ts";
import * as v from "../validation.ts";
export function adminRoutes(db: Db) {
  const r = new Hono(),
    req = (c: any) => String(c.get("requestId"));
  r.get("/items", (c) =>
    c.json({
      items: db
        .query(
          "SELECT i.slug,i.display_name displayName,i.status,p.slug publisher,b.slug backend FROM mcp_items i JOIN publishers p ON p.id=i.publisher_id JOIN backend_registries b ON b.id=i.backend_registry_id ORDER BY i.created_at DESC",
        )
        .all(),
    }),
  );
  r.get("/backends", (c) =>
    c.json({
      items: db.query("SELECT * FROM backend_registries ORDER BY slug").all(),
    }),
  );
  r.post("/backends", async (c) => {
    const b = v.bodyObject(await c.req.json()),
      x = id(),
      t = now();
    db.query(
      "INSERT INTO backend_registries VALUES(?,?,?,?,?,'active',?,?)",
    ).run(
      x,
      v.globalSlug(b.slug),
      v.text(b.displayName, "displayName", 200, true),
      v.text(b.description, "description", 2000),
      v.displayUrl(b.websiteUrl),
      t,
      t,
    );
    return c.json({ slug: b.slug, status: "active" }, 201);
  });
  r.patch("/backends/:slug", async (c) => {
    const b = v.bodyObject(await c.req.json());
    if ("slug" in b) throw new AppError(422, "IMMUTABLE_FIELD");
    const x = db
      .query("SELECT * FROM backend_registries WHERE slug=?")
      .get(c.req.param("slug")) as any;
    assert(x, 404, "BACKEND_NOT_FOUND");
    db.query(
      "UPDATE backend_registries SET display_name=?,description=?,website_url=?,updated_at=? WHERE id=?",
    ).run(
      b.displayName === undefined
        ? x.display_name
        : v.text(b.displayName, "displayName", 200, true),
      b.description === undefined
        ? x.description
        : v.text(b.description, "description", 2000),
      b.websiteUrl === undefined ? x.website_url : v.displayUrl(b.websiteUrl),
      now(),
      x.id,
    );
    return c.json({ slug: x.slug });
  });
  for (const action of ["disable", "restore"] as const)
    r.post(`/backends/:slug/${action}`, (c) => {
      const from = action === "disable" ? "active" : "disabled",
        to = action === "disable" ? "disabled" : "active",
        result = db
          .query(
            "UPDATE backend_registries SET status=?,updated_at=? WHERE slug=? AND status=?",
          )
          .run(to, now(), c.req.param("slug"), from);
      assert(result.changes === 1, 409, "INVALID_BACKEND_TRANSITION");
      return c.json({ slug: c.req.param("slug"), status: to });
    });
  r.get("/publishers", (c) =>
    c.json({
      items: db
        .query(
          "SELECT id,slug,display_name displayName,description,status FROM publishers ORDER BY slug",
        )
        .all(),
    }),
  );
  r.post("/publishers", async (c) => {
    const b = v.bodyObject(await c.req.json()),
      x = id(),
      t = now();
    db.query("INSERT INTO publishers VALUES(?,?,?,?,?,?,?)").run(
      x,
      v.globalSlug(b.slug),
      v.text(b.displayName, "displayName", 200, true),
      v.text(b.description, "description", 2000),
      "active",
      t,
      t,
    );
    return c.json({ id: x, slug: b.slug, status: "active" }, 201);
  });
  r.patch("/publishers/:slug", async (c) => {
    const b = v.bodyObject(await c.req.json());
    if ("slug" in b) throw new AppError(422, "IMMUTABLE_FIELD");
    const x = db
      .query("SELECT * FROM publishers WHERE slug=?")
      .get(c.req.param("slug")) as any;
    assert(x, 404, "PUBLISHER_NOT_FOUND");
    db.query(
      "UPDATE publishers SET display_name=?,description=?,updated_at=? WHERE id=?",
    ).run(
      b.displayName === undefined
        ? x.display_name
        : v.text(b.displayName, "displayName", 200, true),
      b.description === undefined
        ? x.description
        : v.text(b.description, "description", 2000),
      now(),
      x.id,
    );
    return c.json({ slug: x.slug });
  });
  for (const action of ["suspend", "restore"] as const)
    r.post(`/publishers/:slug/${action}`, (c) => {
      const from = action === "suspend" ? "active" : "suspended",
        to = action === "suspend" ? "suspended" : "active",
        result = db
          .query(
            "UPDATE publishers SET status=?,updated_at=? WHERE slug=? AND status=?",
          )
          .run(to, now(), c.req.param("slug"), from);
      assert(result.changes === 1, 409, "INVALID_PUBLISHER_TRANSITION");
      return c.json({ slug: c.req.param("slug"), status: to });
    });
  r.post("/publishers/:slug/api-keys", async (c) => {
    const p = db
      .query("SELECT id FROM publishers WHERE slug=?")
      .get(c.req.param("slug")) as any;
    assert(p, 404, "PUBLISHER_NOT_FOUND");
    const b = await c.req.json();
    return c.json(
      await issueKey(
        db,
        p.id,
        v.text(b.name, "name", 100, true)!,
        "admin",
        v.expiresAt(b.expiresAt),
      ),
      201,
    );
  });
  r.delete("/api-keys/:id", (c) => {
    db.query(
      "UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
    ).run(now(), c.req.param("id"));
    return c.body(null, 204);
  });
  r.get("/reviews", (c) =>
    c.json({
      items: db
        .query(
          "SELECT i.slug,i.display_name displayName,p.slug publisher,b.slug backend,r.version FROM mcp_items i JOIN publishers p ON p.id=i.publisher_id JOIN backend_registries b ON b.id=i.backend_registry_id JOIN mcp_item_revisions r ON r.item_id=i.id WHERE i.status='pending' AND r.status='pending'",
        )
        .all(),
    }),
  );
  r.get("/reviews/:slug", (c) => {
    const x = db
      .query(
        "SELECT i.slug,p.slug publisher,b.slug backend,r.version,r.backend_locator_json backendLocator,r.server_definition_json serverDefinition,r.env_schema_json envSchema FROM mcp_items i JOIN publishers p ON p.id=i.publisher_id JOIN backend_registries b ON b.id=i.backend_registry_id JOIN mcp_item_revisions r ON r.item_id=i.id WHERE i.slug=? AND i.status='pending' AND r.status='pending'",
      )
      .get(c.req.param("slug")) as any;
    assert(x, 404, "REVIEW_NOT_FOUND");
    return c.json({
      ...x,
      backendLocator: JSON.parse(x.backendLocator),
      serverDefinition: JSON.parse(x.serverDefinition),
      envSchema: x.envSchema ? JSON.parse(x.envSchema) : null,
      notice:
        "MCPM has not scanned or verified the artifact or server definition.",
    });
  });
  for (const decision of ["approve", "reject"] as const)
    r.post(`/reviews/:slug/${decision}`, async (c) => {
      const b = await c.req.json().catch(() => ({}));
      if (decision === "reject")
        assert(
          typeof b.note === "string" && b.note.trim(),
          422,
          "REVIEW_NOTE_REQUIRED",
        );
      return c.json(
        immediate(db, () => {
          const x = db
            .query(
              "SELECT i.id item_id,r.id revision_id FROM mcp_items i JOIN mcp_item_revisions r ON r.item_id=i.id WHERE i.slug=? AND i.status='pending' AND r.status='pending'",
            )
            .get(c.req.param("slug")) as any;
          assert(x, 409, "ITEM_ALREADY_REVIEWED");
          const t = now();
          if (decision === "approve") {
            db.query(
              "UPDATE mcp_item_revisions SET status='published',published_at=?,published_by_type='admin',published_by_id='bootstrap' WHERE id=? AND status='pending'",
            ).run(t, x.revision_id);
            db.query(
              "UPDATE mcp_items SET status='active',updated_at=? WHERE id=? AND status='pending'",
            ).run(t, x.item_id);
            db.query("INSERT INTO mcp_item_latest VALUES(?,?,?)").run(
              x.item_id,
              x.revision_id,
              t,
            );
            db.query(
              "INSERT INTO latest_revision_events VALUES(?,?,?,?,?,?,?,?,?)",
            ).run(
              id(),
              x.item_id,
              null,
              x.revision_id,
              "initial_approval",
              "admin",
              "bootstrap",
              req(c),
              t,
            );
          }
          db.query(
            "INSERT INTO item_review_events VALUES(?,?,?,?,?,?,?,?)",
          ).run(
            id(),
            x.item_id,
            x.revision_id,
            decision === "approve" ? "approved" : "rejected",
            "bootstrap",
            b.note ?? null,
            req(c),
            t,
          );
          return {
            slug: c.req.param("slug"),
            decision,
            notice:
              "Approval trusts the publisher and listing; MCPM does not scan or certify artifacts.",
          };
        }),
      );
    });
  for (const action of ["suspend", "restore"] as const)
    r.post(`/items/:slug/${action}`, (c) =>
      c.json(
        immediate(db, () => {
          const x = db
            .query(
              "SELECT id,status,suspended_from_status FROM mcp_items WHERE slug=?",
            )
            .get(c.req.param("slug")) as any;
          assert(x, 404, "ITEM_NOT_FOUND");
          const from = x.status,
            to = action === "suspend" ? "suspended" : x.suspended_from_status;
          assert(
            action === "suspend"
              ? from !== "suspended"
              : from === "suspended" && to,
            409,
            "INVALID_ITEM_TRANSITION",
          );
          const t = now();
          const result = db
            .query(
              "UPDATE mcp_items SET status=?,suspended_from_status=?,suspended_at=?,updated_at=? WHERE id=? AND status=?",
            )
            .run(
              to,
              action === "suspend" ? from : null,
              action === "suspend" ? t : null,
              t,
              x.id,
              from,
            );
          assert(result.changes === 1, 409, "INVALID_ITEM_TRANSITION");
          db.query(
            "INSERT INTO item_status_events VALUES(?,?,?,?,?,?,?,?,?)",
          ).run(id(), x.id, from, to, "admin", "bootstrap", action, req(c), t);
          return { slug: c.req.param("slug"), status: to };
        }),
      ),
    );
  return r;
}
