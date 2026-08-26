import { app as registry } from "./registry.ts";
import { app as runner } from "./runner.ts";

const runnerPort = Number(process.env.RUNNER_PORT ?? 3001);
const registryPort = Number(process.env.REGISTRY_PORT ?? 3000);

Bun.serve({ hostname: "127.0.0.1", port: runnerPort, fetch: runner.fetch });
Bun.serve({ hostname: process.env.REGISTRY_HOST ?? "0.0.0.0", port: registryPort, fetch: registry.fetch });

console.info(`MCP Runner listening on 127.0.0.1:${runnerPort}`);
console.info(`MCP Registry listening on ${process.env.REGISTRY_HOST ?? "0.0.0.0"}:${registryPort}`);
