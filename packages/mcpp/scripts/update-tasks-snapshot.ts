/** 固定上游快照导入；保留原始 JSON/许可证字节，不重写 schema。 */
const commit = "b3d28aceaa6d49f5f92258e3d06b61ad6f111e84";
const root = new URL("../src/tasks/vendor/", import.meta.url);
for (const [source, target] of [
  ["schema/2026-07-28/schema.json", "schema-2026-07-28.json"],
  ["LICENSE", "LICENSE"],
] as const) {
  const url = `https://github.com/modelcontextprotocol/ext-tasks/blob/${commit}/${source}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("无法读取固定上游快照");
  const html = await response.text();
  const embedded = html.match(
    /<script type="application\/json" data-target="react-app.embeddedData">([\s\S]*?)<\/script>/,
  );
  if (!embedded) throw new Error("上游页面未提供原始内容");
  const payload = JSON.parse(embedded[1]!).payload;
  const lines = payload["codeViewBlobLayoutRoute.StyledBlob"]?.rawLines;
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string"))
    throw new Error("快照原始内容无效");
  const content = `${lines.join("\n")}\n`;
  if (target.endsWith(".json")) JSON.parse(content);
  else if (
    !content.includes("Apache License") ||
    !content.includes("Copyright 2025 The Model Context Protocol Authors")
  )
    throw new Error("许可证内容不匹配");
  await Bun.write(new URL(target, root), content);
  console.log(
    `${target}: ${lines.length} 行，SHA256 ${new Bun.CryptoHasher("sha256").update(content).digest("hex")}`,
  );
}
