import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DeploymentStatus =
  | "queued"
  | "resolving"
  | "installing"
  | "starting"
  | "active"
  | "failed";
export type Deployment = {
  id: string;
  packageName: string;
  distTag: string;
  serverId: string;
  sourceId: string;
  status: DeploymentStatus;
  createdAt: string;
  version?: string;
  integrity?: string;
  displayName?: string;
  description?: string;
  serverTitle?: string;
  endpointPath?: string;
  error?: string;
};

const RECOVERABLE = new Set<DeploymentStatus>([
  "queued",
  "resolving",
  "installing",
  "starting",
  "active",
]);

export class DeploymentStore {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  put(item: Deployment) {
    const now = new Date().toISOString();
    this.db
      .query(
        `
      INSERT INTO deployments (id, payload, status, created_at, updated_at)
      VALUES ($id, $payload, $status, $createdAt, $updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        status = excluded.status,
        updated_at = excluded.updated_at
    `,
      )
      .run({
        id: item.id,
        payload: JSON.stringify(item),
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: now,
      });
  }

  load(): Deployment[] {
    const rows = this.db
      .query("SELECT payload FROM deployments ORDER BY created_at")
      .all() as Array<{ payload: string }>;
    return rows.map((row) => {
      const item = JSON.parse(row.payload) as Deployment;
      if (!RECOVERABLE.has(item.status)) return item;
      const recovered = {
        ...item,
        status: "queued" as const,
        error: undefined,
      };
      this.put(recovered);
      return recovered;
    });
  }

  close() {
    this.db.close();
  }
}
