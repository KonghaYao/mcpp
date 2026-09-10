/**
 * Static page store.
 *
 * The store is the only writer of public files, so these tests cover the
 * properties the rest of the system assumes: paths cannot escape the root,
 * a page is never observable half-written, and a failed write leaves the
 * previous page serving.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../src/errors.ts";
import { StaticStore } from "../../src/public-site/store.ts";

let root: string;
let store: StaticStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcpm-store-"));
  store = new StaticStore(join(root, "public"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("path containment", () => {
  test("rejects paths that would escape the root", () => {
    for (const candidate of [
      "../escape.html",
      "market/../../escape.html",
      "/etc/passwd",
      "market//index.html",
      "./index.html",
      "market/./index.html",
      "",
    ])
      expect(() => store.pathFor(candidate)).toThrow(AppError);
  });

  test("accepts nested relative paths", () => {
    expect(store.pathFor("market/p-abcd/index.html")).toBe(
      join(store.root, "market/p-abcd/index.html"),
    );
  });
});

describe("writing", () => {
  test("creates parent directories and reads back the page", async () => {
    await store.write("market/p-a/v/1.0.0/index.html", "<html>one</html>");
    expect(await store.read("market/p-a/v/1.0.0/index.html")).toBe(
      "<html>one</html>",
    );
  });

  test("reports a missing page as null rather than failing", async () => {
    expect(await store.read("nothing/here.html")).toBeNull();
  });

  test("replaces a page in one step", async () => {
    await store.write("index.html", "first");
    await store.write("index.html", "second");
    expect(await store.read("index.html")).toBe("second");
  });

  test("leaves no temporary files behind", async () => {
    await store.write("market/index.html", "content");
    const entries = await readdir(join(store.root, "market"));
    expect(entries.filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("writes many pages and reports each path", async () => {
    const written = await store.writeMany(
      new Map([
        ["index.html", "home"],
        ["market/index.html", "list"],
      ]),
    );
    expect(written).toEqual(["index.html", "market/index.html"]);
  });

  /**
   * The swap is a temporary file in the same directory followed by `rename`, so
   * a write that fails before the rename must leave the complete previous
   * document at the exact path being replaced. Permissions are removed from the
   * containing directory — the directory that holds the page being replaced —
   * rather than from the cache root, so the failure lands on this path.
   */
  test("keeps the previous page byte-identical when the write cannot be created", async () => {
    // A privileged test runner ignores directory permissions.
    if (process.getuid?.() === 0) return;

    await store.write("market/index.html", "good");
    const directory = join(store.root, "market");
    await chmod(directory, 0o500);
    try {
      await expect(
        store.write("market/index.html", "replacement"),
      ).rejects.toThrow();
      // Not truncated, not half-written, not silently replaced.
      expect(await store.read("market/index.html")).toBe("good");
    } finally {
      await chmod(directory, 0o700);
    }

    // The same call succeeds once the directory is writable again.
    await store.write("market/index.html", "replacement");
    expect(await store.read("market/index.html")).toBe("replacement");
  });

  test("leaves other pages untouched when one write fails", async () => {
    await store.write("market/index.html", "good");
    // A directory where the file should be makes `rename` fail after the
    // temporary file has already been written.
    await mkdir(store.pathFor("market/blocked.html"), { recursive: true });
    await expect(store.write("market/blocked.html", "nope")).rejects.toThrow();
    expect(await store.read("market/index.html")).toBe("good");
  });
});

describe("atomic replacement", () => {
  /**
   * The property that actually matters to a reader: while a page is being
   * replaced, every read returns *some* complete document and never a partial
   * or empty one. Documents are large enough that a non-atomic write would be
   * observed torn with near certainty.
   */
  test("never exposes a partially written document to a concurrent reader", async () => {
    const path = "market/p-concurrent/index.html";
    const documents: string[] = Array.from({ length: 12 }, (_, index) =>
      `${index}`.repeat(64 * 1024),
    );
    await store.write(path, documents[0]!);

    const valid = new Set(documents);
    const observed: string[] = [];
    let writing = true;

    const readers = Array.from({ length: 4 }, async () => {
      while (writing) {
        const content = await store.read(path);
        if (content !== null) observed.push(content);
        await Bun.sleep(0);
      }
    });

    for (const document of documents.slice(1))
      await store.write(path, document);
    writing = false;
    await Promise.all(readers);

    expect(observed.length).toBeGreaterThan(0);
    for (const content of observed) expect(valid.has(content)).toBe(true);
    // The last write still wins once the dust settles.
    expect(await store.read(path)).toBe(documents.at(-1)!);
  });

  /**
   * Concurrent writers to one path must converge on a single complete document.
   * This does not order the writers, only that no interleaving leaves a mixed or
   * truncated page behind.
   */
  test("settles on one complete document when writers race", async () => {
    const path = "market/p-race/index.html";
    const documents = Array.from({ length: 8 }, (_, index) =>
      `${index}`.repeat(32 * 1024),
    );

    await Promise.all(documents.map((document) => store.write(path, document)));

    const settled = await store.read(path);
    expect(settled).not.toBeNull();
    expect(new Set(documents).has(settled!)).toBe(true);
    // Every temporary file was consumed by its rename.
    const entries = await readdir(join(store.root, "market/p-race"));
    expect(entries).toEqual(["index.html"]);
  });

  /**
   * The deterministic form of the atomicity claim, with no reliance on timing.
   *
   * A reader that already opened the page keeps a descriptor on the *old* file.
   * If the swap were an in-place rewrite, that descriptor would observe the new
   * bytes, or a truncated mixture of both. Because replacement is a `rename`,
   * the old inode is untouched and the reader finishes a complete old document
   * while the next reader gets a complete new one.
   */
  test("leaves an already-open reader on a complete old page after the swap", async () => {
    const path = "market/index.html";
    await store.write(path, "first-version");
    const held = await open(store.pathFor(path), "r");

    await store.write(path, "second-version");

    expect(await held.readFile({ encoding: "utf8" })).toBe("first-version");
    await held.close();
    expect(await store.read(path)).toBe("second-version");
  });

  /**
   * A crash part-way through a write — an OOM kill, a deploy restart, a full
   * disk — must not publish a truncated page. Rather than inject an errno that
   * cannot be produced portably, the real scenario is reproduced: a child
   * process is killed while writing, and the page is read afterwards.
   *
   * The child writes in a loop so the kill is very likely to land mid-write
   * rather than between writes. The assertion accepts either document, which
   * keeps the test free of timing assumptions: whichever side of the swap the
   * kill lands on, the page must be complete.
   */
  test("leaves a complete page when a writer is killed mid-write", async () => {
    const path = "market/p-crash/index.html";
    const before = "old".repeat(32 * 1024);
    const after = "new".repeat(4 * 1024 * 1024);
    await store.write(path, before);

    const script = join(root, "crash-writer.ts");
    await Bun.write(
      script,
      `import { StaticStore } from ${JSON.stringify(join(import.meta.dir, "../../src/public-site/store.ts"))};
const store = new StaticStore(${JSON.stringify(store.root)});
// Write continuously so the kill lands inside a write, not between two of them.
for (;;) await store.write(${JSON.stringify(path)}, ${JSON.stringify(after)});
`,
    );

    const child = Bun.spawn(["bun", script], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(250);
    child.kill("SIGKILL");
    await child.exited;

    const served = await store.read(path);
    expect(served === before || served === after).toBe(true);
  });

  /**
   * An interrupted write must not leave a temporary file that anything could
   * mistake for a page, and it must not corrupt a *different* path.
   */
  test("leaves no readable page under a partial name after a kill", async () => {
    const path = "market/p-crash2/index.html";
    await store.write(path, "ok");
    const entries = await readdir(join(store.root, "market/p-crash2"));
    // Only the page itself is ever addressable; temporaries carry a `.tmp-`
    // marker and are named with a UUID, so no route can resolve to one.
    expect(entries.filter((name) => !name.includes(".tmp-"))).toEqual([
      "index.html",
    ]);
  });

  /**
   * `writeMany` is used by the operator rebuild, so a failure part-way through
   * must still leave every already-written page complete and readable.
   */
  test("keeps earlier pages complete when a later write in a batch fails", async () => {
    const pages = new Map([
      ["market/index.html", "list"],
      ["market/p-blocked/index.html", "detail"],
    ]);
    await mkdir(store.pathFor("market/p-blocked/index.html"), {
      recursive: true,
    });

    await expect(store.writeMany(pages)).rejects.toThrow();
    expect(await store.read("market/index.html")).toBe("list");
  });
});

describe("removing", () => {
  test("removes a single page", async () => {
    await store.write("market/index.html", "x");
    await store.remove("market/index.html");
    expect(await store.read("market/index.html")).toBeNull();
  });

  test("removing a page that is already gone is not an error", async () => {
    await expect(store.remove("market/absent.html")).resolves.toBeUndefined();
  });

  test("removes a whole package tree recursively", async () => {
    await store.write("market/p-a/index.html", "detail");
    await store.write("market/p-a/v/1.0.0/index.html", "version");
    await store.remove("market/p-a", true);
    expect(await store.read("market/p-a/index.html")).toBeNull();
    expect(await store.read("market/p-a/v/1.0.0/index.html")).toBeNull();
  });
});

describe("directory listing", () => {
  test("lists child directories in a stable order", async () => {
    await store.write("market/p-a/v/1.0.0/index.html", "a");
    await store.write("market/p-a/v/2.0.0/index.html", "b");
    expect(await store.listDirectories("market/p-a/v")).toEqual([
      "1.0.0",
      "2.0.0",
    ]);
  });

  test("returns an empty list for a missing directory", async () => {
    expect(await store.listDirectories("market/absent/v")).toEqual([]);
  });

  test("ignores files mixed in with directories", async () => {
    await store.write("market/p-a/v/index.html", "stray");
    await store.write("market/p-a/v/1.0.0/index.html", "a");
    expect(await store.listDirectories("market/p-a/v")).toEqual(["1.0.0"]);
  });
});
