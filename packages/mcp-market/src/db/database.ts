import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type Db = Database;

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

export async function openDatabase(path: string): Promise<Db> {
  const db = new Database(path, { create: true });
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;",
  );
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<void> {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)",
  );
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const name of files) {
    const version = Number(name.slice(0, 4));
    const applied = db
      .query("SELECT 1 FROM schema_migrations WHERE version=?")
      .get(version);
    if (applied) continue;
    const sql = await Bun.file(join(MIGRATIONS_DIR, name)).text();
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations VALUES(?,?,?)").run(
        version,
        name,
        now(),
      );
    })();
  }
}

/**
 * Runs `fn` inside a single write transaction. `BEGIN IMMEDIATE` takes the
 * write lock up front so concurrent writers fail fast instead of deadlocking
 * mid-transaction.
 */
export function immediate<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw error;
  }
}

export const id = (): string => crypto.randomUUID();

export const now = (): string => new Date().toISOString();

/**
 * FTS5 is a hard requirement: search silently degrading to an unbounded LIKE
 * scan is explicitly forbidden by the architecture, so readiness fails when the
 * runtime lacks it.
 */
export function supportsFts5(db: Db): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x)");
    db.exec("DROP TABLE temp.fts5_probe");
    return true;
  } catch {
    return false;
  }
}

export function checkIntegrity(db: Db): { ok: boolean; reason?: string } {
  try {
    db.query("SELECT 1").get();
  } catch (error) {
    return { ok: false, reason: `sqlite unavailable: ${String(error)}` };
  }
  if (!supportsFts5(db))
    return { ok: false, reason: "sqlite FTS5 unavailable" };
  return { ok: true };
}
