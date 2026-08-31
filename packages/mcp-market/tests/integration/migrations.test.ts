import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/db/database.ts";
describe("migrations", () => {
  test("are idempotent and enable constraints", async () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    await migrate(db);
    await migrate(db);
    expect(
      (db.query("SELECT count(*) n FROM schema_migrations").get() as any).n,
    ).toBe(1);
    expect((db.query("PRAGMA foreign_keys").get() as any).foreign_keys).toBe(1);
    db.close();
  });
  test("latest accepts only a published revision of the same item", async () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    await migrate(db);
    const t = new Date().toISOString();
    db.query(
      "INSERT INTO backend_registries(id,slug,display_name,status,created_at,updated_at) VALUES('b','backend','Backend','active',?,?)",
    ).run(t, t);
    db.query(
      "INSERT INTO publishers(id,slug,display_name,status,created_at,updated_at) VALUES('p','publisher','Publisher','active',?,?)",
    ).run(t, t);
    for (const item of ["one", "two"])
      db.query(
        "INSERT INTO mcp_items(id,slug,publisher_id,backend_registry_id,display_name,status,created_at,updated_at) VALUES(?,?, 'p','b',?,'active',?,?)",
      ).run(item, item, item, t, t);
    db.query(
      "INSERT INTO mcp_item_revisions(id,item_id,version,backend_locator_json,server_definition_json,status,submitted_by,submitted_at,created_at) VALUES('pending','one','1.0.0','{}','{}','pending','p',?,?)",
    ).run(t, t);
    db.query(
      "INSERT INTO mcp_item_revisions(id,item_id,version,backend_locator_json,server_definition_json,status,submitted_by,submitted_at,created_at) VALUES('published','two','1.0.0','{}','{}','published','p',?,?)",
    ).run(t, t);
    expect(() =>
      db.query("INSERT INTO mcp_item_latest VALUES('one','pending',?)").run(t),
    ).toThrow();
    expect(() =>
      db
        .query("INSERT INTO mcp_item_latest VALUES('one','published',?)")
        .run(t),
    ).toThrow();
    db.close();
  });
});
