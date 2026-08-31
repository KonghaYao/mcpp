export type Config = ReturnType<typeof loadConfig>;
const int = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${name}`);
  return value;
};
export function loadConfig() {
  const adminSecret = process.env.MCPM_ADMIN_SECRET;
  if (!adminSecret) throw new Error("MCPM_ADMIN_SECRET is required");
  return {
    adminSecret,
    dbPath: process.env.MCPM_DB_PATH ?? "mcpm.sqlite",
    publicUrl: new URL(process.env.MCPM_PUBLIC_URL ?? "http://localhost:3000/"),
    port: int("PORT", 3000),
    host: process.env.HOST ?? "0.0.0.0",
  };
}
