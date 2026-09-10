/**
 * Local HTTP fixture Registry.
 *
 * Contract tests must never reach a real Registry, so every NPM interaction in
 * this suite goes through a loopback server on an ephemeral port. The recorder
 * also proves a negative: that no tarball URL was ever requested.
 */

export type FixtureContext = {
  request: Request;
  url: URL;
  /** Percent-decoded package name from the path, e.g. `@acme/team`. */
  packageName: string;
};

export type FixtureHandler = (
  context: FixtureContext,
) => Response | Promise<Response>;

export type FixtureRegistry = {
  baseUrl: string;
  /** Request paths in order of arrival. */
  requests: string[];
  /** Anything that looks like an artifact download. Must stay empty. */
  artifactRequests: string[];
  setHandler(handler: FixtureHandler): void;
  stop(): void;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const jsonResponse = json;

export const statusResponse = (
  status: number,
  headers: Record<string, string> = {},
): Response => new Response(status === 304 ? null : "{}", { status, headers });

/** Looks like a tarball or artifact fetch rather than a metadata read. */
const ARTIFACT_PATTERN = /\.tgz$|\.tar\.gz$|\/-\//i;

export function startFixtureRegistry(initial: FixtureHandler): FixtureRegistry {
  let handler = initial;
  const requests: string[] = [];
  const artifactRequests: string[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (ARTIFACT_PATTERN.test(url.pathname))
        artifactRequests.push(url.pathname);
      const packageName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      return handler({ request, url, packageName });
    },
  });

  return {
    baseUrl: server.url.toString().replace(/\/+$/, ""),
    requests,
    artifactRequests,
    setHandler(next) {
      handler = next;
    },
    stop() {
      server.stop(true);
    },
  };
}
