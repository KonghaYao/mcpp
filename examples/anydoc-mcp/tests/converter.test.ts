import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertLocalFile, resolveSafeFile } from "../src/converter.ts";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "anydoc-mcp-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  return { base, root, outside };
}

describe("local file guard", () => {
  test("performs a real CSV conversion", async () => {
    const { root } = await fixture();
    const csv = join(root, "people.csv");
    await writeFile(csv, "name,age\nAda,36\nLinus,55\n");
    const result = await convertLocalFile(csv, [root]);
    expect(result.markdown).toContain("Ada");
    expect(result.markdown).toContain("Linus");
    expect(result.truncated).toBe(false);
  });

  test("rejects URLs and unsupported formats", async () => {
    const { root } = await fixture();
    await expect(
      resolveSafeFile("https://example.invalid/file.pdf", [root]),
    ).rejects.toThrow("URLs are not supported");
    const text = join(root, "notes.txt");
    await writeFile(text, "nope");
    await expect(resolveSafeFile(text, [root])).rejects.toThrow(
      "Unsupported document format",
    );
  });

  test("rejects containment escapes and symlinks", async () => {
    const { root, outside } = await fixture();
    const csv = join(outside, "secret.csv");
    await writeFile(csv, "secret,value\nkey,hidden\n");
    await expect(resolveSafeFile(csv, [root])).rejects.toThrow("outside");
    const inside = join(root, "inside.csv");
    await writeFile(inside, "name,value\nallowed,yes\n");
    const link = join(root, "linked.csv");
    await symlink(inside, link);
    await expect(resolveSafeFile(link, [root])).rejects.toThrow(
      "Symbolic links",
    );
  });

  test("rejects non-regular files", async () => {
    const { root } = await fixture();
    const directoryWithExtension = join(root, "folder.csv");
    await mkdir(directoryWithExtension);
    await expect(
      resolveSafeFile(directoryWithExtension, [root]),
    ).rejects.toThrow("regular file");
  });
});
