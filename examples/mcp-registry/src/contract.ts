import { resolve, sep } from "node:path";

export const PACKAGE_NAME =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
export const DIST_TAG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const SERVER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const EXACT_VERSION =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type ServerContract = {
  runtime: "serverless";
  entry: string;
  endpointPath: string;
};
export type PackageManifest = {
  name: string;
  version: string;
  description?: string;
  keywords?: readonly string[];
  mcpp?: {
    display?: { name?: string; description?: string };
    servers?: Record<
      string,
      {
        runtime?: string;
        entry?: string;
        transport?: string;
        endpointPath?: string;
        title?: string;
      }
    >;
  };
};

export function validateEndpointPath(value: unknown) {
  const endpointPath = typeof value === "string" ? value : "/mcp";
  if (
    !endpointPath.startsWith("/") ||
    endpointPath.startsWith("//") ||
    endpointPath.includes("?") ||
    endpointPath.includes("#") ||
    endpointPath.includes("\0")
  ) {
    throw new Error("INVALID_ENDPOINT_PATH");
  }
  const segments = endpointPath.split("/");
  if (segments.includes(".") || segments.includes(".."))
    throw new Error("INVALID_ENDPOINT_PATH");
  return endpointPath.length > 1
    ? endpointPath.replace(/\/+$/, "")
    : endpointPath;
}

export function validateDeployInput(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("INVALID_BODY");
  const input = value as Record<string, unknown>;
  const packageName = String(input.packageName ?? "");
  const distTag = String(input.distTag ?? "latest");
  const serverId = String(input.serverId ?? "");
  const sourceId = String(input.sourceId ?? "default");
  if (!PACKAGE_NAME.test(packageName)) throw new Error("INVALID_PACKAGE_NAME");
  if (!DIST_TAG.test(distTag)) throw new Error("INVALID_DIST_TAG");
  if (!SERVER_ID.test(serverId)) throw new Error("INVALID_SERVER_ID");
  if (sourceId !== "default") throw new Error("UNKNOWN_SOURCE");
  return { packageName, distTag, serverId, sourceId };
}

export function validateManifest(
  manifest: PackageManifest,
  serverId: string,
  packageRoot: string,
) {
  if (!manifest.keywords?.includes("mcp-plugin"))
    throw new Error("MISSING_MCP_KEYWORD");
  const server = manifest.mcpp?.servers?.[serverId];
  if (!server) throw new Error("UNKNOWN_SERVER");
  if (server.transport === "stdio") throw new Error("STDIO_NOT_SUPPORTED");
  if (server.runtime !== "serverless" || typeof server.entry !== "string")
    throw new Error("INVALID_SERVER_CONTRACT");
  if (server.entry.startsWith("/") || server.entry.includes("\0"))
    throw new Error("INVALID_ENTRY_PATH");
  const root = resolve(packageRoot);
  const entry = resolve(root, server.entry);
  if (entry !== root && !entry.startsWith(root + sep))
    throw new Error("ENTRY_OUTSIDE_PACKAGE");
  const endpointPath = validateEndpointPath(server.endpointPath);
  return { entry, server: { ...server, endpointPath } as ServerContract };
}
