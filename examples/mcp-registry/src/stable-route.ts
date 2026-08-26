import { EXACT_VERSION, PACKAGE_NAME, SERVER_ID } from "./contract.ts";

export type StableRouteIdentity = {
  packageName: string;
  version: string;
  serverId: string;
  suffix: string;
};

export function stableRoutePath(
  identity: Omit<StableRouteIdentity, "suffix"> & { endpointPath: string },
) {
  const packageSpec = encodeURIComponent(`${identity.packageName}@${identity.version}`);
  return `/mcp/npm/${packageSpec}/${encodeURIComponent(identity.serverId)}${identity.endpointPath}`;
}

export function parseStableRoute(path: string): StableRouteIdentity | undefined {
  const prefix = "/mcp/npm/";
  if (!path.startsWith(prefix)) return undefined;

  const segments = path.slice(prefix.length).split("/");
  if (segments.length < 3) return undefined;

  let packageSpec: string;
  let serverIndex: number;
  try {
    packageSpec = decodeURIComponent(segments[0] ?? "");
    serverIndex = 1;
  } catch {
    return undefined;
  }

  const match = packageSpec.match(/^(.+)@([^@]+)$/);
  if (!match || !PACKAGE_NAME.test(match[1] ?? "") || !EXACT_VERSION.test(match[2] ?? "")) {
    return undefined;
  }

  let serverId: string;
  try {
    serverId = decodeURIComponent(segments[serverIndex] ?? "");
  } catch {
    return undefined;
  }
  if (!SERVER_ID.test(serverId)) return undefined;

  const suffixSegments = segments.slice(serverIndex + 1);
  if (suffixSegments.length === 0 || suffixSegments.some(segment => segment === "." || segment === "..")) {
    return undefined;
  }

  return {
    packageName: match[1]!,
    version: match[2]!,
    serverId,
    suffix: `/${suffixSegments.join("/")}`,
  };
}
