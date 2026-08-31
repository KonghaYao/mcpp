import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/database.ts";
import { AppError } from "../errors.ts";
import { id, now } from "../db/database.ts";
export type Actor = {
  keyId: string;
  publisherId: string;
  publisherStatus: string;
};
const prefixOf = (token: string) => token.split("_")[1] ?? "";
export async function issueKey(
  db: Db,
  publisherId: string,
  name: string,
  createdBy: string,
  expiresAt?: string | null,
) {
  const prefix = crypto.randomUUID().replaceAll("-", "").slice(0, 12),
    token = `mcpm_${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`,
    hash = await Bun.password.hash(token),
    keyId = id();
  db.query(
    "INSERT INTO api_keys(id,publisher_id,name,key_prefix,key_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    keyId,
    publisherId,
    name,
    prefix,
    hash,
    expiresAt ?? null,
    createdBy,
    now(),
  );
  return { id: keyId, token, keyPrefix: prefix };
}
export const publisherAuth =
  (db: Db): MiddlewareHandler =>
  async (c, next) => {
    const h = c.req.header("authorization"),
      token = h?.startsWith("Bearer ") ? h.slice(7) : "";
    if (!/^mcpm_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/.test(token))
      throw new AppError(401, "INVALID_API_KEY");
    const rows = db
      .query(
        "SELECT k.id keyId,k.publisher_id publisherId,k.key_hash keyHash,p.status publisherStatus,k.expires_at expiresAt FROM api_keys k JOIN publishers p ON p.id=k.publisher_id WHERE k.key_prefix=? AND k.revoked_at IS NULL",
      )
      .all(prefixOf(token)) as any[];
    let row: any;
    for (const x of rows)
      if (
        (!x.expiresAt || x.expiresAt > now()) &&
        (await Bun.password.verify(token, x.keyHash))
      ) {
        if (row) throw new AppError(401, "INVALID_API_KEY");
        row = x;
      }
    if (!row) throw new AppError(401, "INVALID_API_KEY");
    if (row.publisherStatus !== "active")
      throw new AppError(403, "PUBLISHER_SUSPENDED");
    c.set("actor", {
      keyId: row.keyId,
      publisherId: row.publisherId,
      publisherStatus: row.publisherStatus,
    });
    db.query("UPDATE api_keys SET last_used_at=? WHERE id=?").run(
      now(),
      row.keyId,
    );
    await next();
  };
export const adminAuth =
  (secret: string): MiddlewareHandler =>
  async (c, next) => {
    const h = c.req.header("authorization"),
      a = Buffer.from(h?.startsWith("Bearer ") ? h.slice(7) : ""),
      b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      throw new AppError(401, "INVALID_ADMIN_SECRET");
    await next();
  };
