export async function fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/huge")
    return new Response("x".repeat(1024 * 1024 + 1));
  if (url.pathname === "/slow")
    await new Promise((resolve) => setTimeout(resolve, 100));
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.text();
  return Response.json({ method: request.method, path: url.pathname, body });
}
export default { fetch };
