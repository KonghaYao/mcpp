/**
 * Process entry point.
 *
 * Startup validates configuration, applies migrations, and verifies that the
 * static directory is actually writable on the filesystem the pages are served
 * from. That check is deliberate: atomic page replacement depends on writing a
 * temporary file beside its target, so a read-only or cross-filesystem static
 * root would break publication refresh in a way that only shows up later.
 */

import { bootstrap } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const application = await bootstrap(config);

try {
  await application.publicSite.store.ensureRoot();
} catch (error) {
  console.error(
    "[startup] static directory is not writable:",
    config.staticDir,
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: application.app.fetch,
});

console.info(`MCPM listening on ${config.host}:${server.port}`);
