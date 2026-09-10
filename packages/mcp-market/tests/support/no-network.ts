/**
 * Test network boundary.
 *
 * Contract tests must never reach a real Registry: it would be slow, flaky, and
 * would prove nothing about the code under test. Enforcing the rule at the fetch
 * boundary covers every call the code makes, rather than only the calls a
 * reviewer remembered to check.
 *
 * Importing this module installs the guard for the whole test process.
 */

/** Hosts a test may reach. Everything else is refused before a socket opens. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

const allowed = new Set(LOOPBACK_HOSTS);

let installed = false;

/** Refuses any request that would leave the loopback interface. */
export const installNetworkGuard = (): void => {
  if (installed) return;
  installed = true;
  const real = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const target = input instanceof Request ? input.url : String(input);
    const host = new URL(target, "http://localhost").hostname;
    if (!allowed.has(host))
      throw new Error(`Test network access refused: ${host}`);
    return real(input, init);
  }) as typeof fetch;
};

installNetworkGuard();
