/**
 * Password verification for the single configured Admin.
 *
 * Only a hash is ever configured; a plaintext password cannot be supplied and
 * the deployment refuses to start with one (`config.ts` validates the prefix).
 */

/** Verifies a candidate password against the configured bcrypt/argon2 hash. */
export async function verifyPassword(
  candidate: string,
  hash: string,
): Promise<boolean> {
  if (candidate.length === 0) return false;
  try {
    return await Bun.password.verify(candidate, hash);
  } catch {
    // A malformed hash must read as "wrong password", never as an exception
    // that could leak the configured value through an error path.
    return false;
  }
}
