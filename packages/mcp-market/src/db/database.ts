import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
export type Db = Database;
export async function openDatabase(path: string) {
  const db = new Database(path, { create: true });
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;",
  );
  await migrate(db);
  return db;
}
export async function migrate(db: Db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)",
  );
  const dir = join(import.meta.dir, "../../migrations");
  for (const name of (await readdir(dir))
    .filter((x) => /^\d+_.+\.sql$/.test(x))
    .sort()) {
    const version = Number(name.slice(0, 4));
    if (
      db.query("SELECT 1 FROM schema_migrations WHERE version=?").get(version)
    )
      continue;
    const sql = await Bun.file(join(dir, name)).text();
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations VALUES(?,?,?)").run(
        version,
        name,
        new Date().toISOString(),
      );
    })();
  }
}
export function immediate<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
