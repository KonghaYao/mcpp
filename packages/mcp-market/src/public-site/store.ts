/**
 * Atomic on-disk store for pre-rendered public pages.
 *
 * Pages are written to a temporary file in the *same directory* as their final
 * path and then `rename`d into place. `rename` is atomic within a filesystem,
 * so a reader never observes a partially written document, and a crash or a
 * full disk leaves the previous page intact. There is no cleanup sweep that
 * could delete a page the catalogue still references.
 */

import {
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
  open as openFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AppError } from "../errors.ts";

const TMP_SUFFIX = ".tmp";

/** Rejects absolute paths and any segment that would escape the root. */
const assertContained = (root: string, relPath: string): string => {
  if (
    relPath.length === 0 ||
    relPath.startsWith("/") ||
    relPath.includes("\0") ||
    relPath.includes("\\")
  )
    throw new AppError("INTERNAL_ERROR", "Invalid page path");
  const segments = relPath.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    throw new AppError("INTERNAL_ERROR", "Invalid page path");
  const full = resolve(root, relPath);
  if (full !== root && !full.startsWith(`${root}/`))
    throw new AppError("INTERNAL_ERROR", "Page path escapes static root");
  return full;
};

export class StaticStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  get root(): string {
    return this.#root;
  }

  pathFor(relPath: string): string {
    return assertContained(this.#root, relPath);
  }

  /**
   * Writes one page. The temporary file lives beside its target so the final
   * `rename` never crosses a filesystem boundary.
   */
  async write(relPath: string, html: string): Promise<string> {
    const target = this.pathFor(relPath);
    const directory = dirname(target);
    await mkdir(directory, { recursive: true });
    const temporary = join(
      directory,
      `.${relPath.split("/").at(-1) ?? "page"}${TMP_SUFFIX}-${crypto.randomUUID()}`,
    );
    const handle = await openFile(temporary, "w");
    try {
      await handle.writeFile(html, "utf8");
      // Durability before the swap: without this a crash could publish an
      // empty file under the final name.
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return relPath;
  }

  /** Removes one page, or a whole subtree when `recursive` is set. */
  async remove(relPath: string, recursive = false): Promise<void> {
    await rm(this.pathFor(relPath), { recursive, force: true });
  }

  /**
   * Lists child directory names under `relPath`. Missing directories are an
   * empty list, which is the normal case for a package with one version.
   */
  async listDirectories(relPath: string): Promise<string[]> {
    try {
      const entries = await readdir(this.pathFor(relPath), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Reads one page, or null when it does not exist.
   *
   * The read goes through a single opened descriptor rather than a path-based
   * helper. A path-based read resolves the path twice — once to size the file
   * and once to read it — so a `rename` landing between the two returns the new
   * document truncated to the previous document's length. Reading from one
   * descriptor pins the inode, so a concurrent swap yields either the complete
   * old page or the complete new one.
   */
  async read(relPath: string): Promise<string | null> {
    const target = this.pathFor(relPath);
    let handle: Awaited<ReturnType<typeof openFile>>;
    try {
      handle = await openFile(target, "r");
    } catch {
      return null;
    }
    try {
      return await handle.readFile({ encoding: "utf8" });
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Used by tests and the operator rebuild command. */
  async writeMany(pages: Map<string, string>): Promise<string[]> {
    const written: string[] = [];
    for (const [relPath, html] of pages)
      written.push(await this.write(relPath, html));
    return written;
  }

  /** Exposed so callers can pre-create the root during startup validation. */
  async ensureRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const probe = join(this.#root, `.probe-${crypto.randomUUID()}`);
    await writeFile(probe, "", "utf8");
    await rm(probe, { force: true });
  }
}
