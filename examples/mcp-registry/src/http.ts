const MAX_BODY = 1024 * 1024;
const BLOCKED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "server", "x-powered-by"]);

export async function limitedBody(request: { headers: { get(name: string): string | null }; body: unknown; arrayBuffer(): Promise<ArrayBuffer> }) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) throw new Error("BODY_TOO_LARGE");
  if (!request.body) return undefined;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY) throw new Error("BODY_TOO_LARGE");
  return bytes;
}

export function workerRequestHeaders(headers: Headers) {
  const result = new Headers(headers);
  result.delete("authorization");
  result.delete("host");
  result.forEach((_, name) => { if (name.toLowerCase().startsWith("x-internal-")) result.delete(name); });
  return result;
}

export function publicHeaders(headers: Headers) {
  const result = new Headers();
  headers.forEach((value, name) => { if (!BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith("x-internal-")) result.set(name, value); });
  return result;
}

export function errorStatus(message: string) {
  if (message === "BODY_TOO_LARGE") return 413;
  if (message.includes("NOT_FOUND") || message === "UNKNOWN_SERVER") return 404;
  if (message.startsWith("INVALID_") || message === "UNKNOWN_SOURCE" || message === "STDIO_NOT_SUPPORTED" || message === "MISSING_MCP_KEYWORD" || message === "ENTRY_OUTSIDE_PACKAGE") return 400;
  return 502;
}
