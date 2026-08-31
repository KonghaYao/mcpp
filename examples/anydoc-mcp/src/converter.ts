import { lstat, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { toMarkdown } from "@firecrawl/anydoc";

export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_OUTPUT_CHARS = 200_000;

const supportedExtensions = new Set([
  ".csv",
  ".doc",
  ".docm",
  ".docx",
  ".epub",
  ".odp",
  ".ods",
  ".odt",
  ".pdf",
  ".pot",
  ".pps",
  ".ppsm",
  ".ppsx",
  ".ppt",
  ".pptm",
  ".pptx",
  ".rtf",
  ".xls",
  ".xlsb",
  ".xlsm",
  ".xlsx",
]);

function configuredRoots(env = process.env): string[] {
  const value = env.ANYDOC_ALLOWED_ROOTS;
  if (!value)
    throw new Error(
      "ANYDOC_ALLOWED_ROOTS must contain at least one local directory",
    );
  return value
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .map((root) => resolve(root));
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function resolveSafeFile(
  input: string,
  roots = configuredRoots(),
): Promise<string> {
  if (/^[a-z][a-z\d+.-]*:/i.test(input))
    throw new Error("URLs are not supported; provide a local file path");
  if (!isAbsolute(input)) throw new Error("File path must be absolute");
  if (!supportedExtensions.has(extname(input).toLowerCase()))
    throw new Error("Unsupported document format");

  const rootPaths = await Promise.all(roots.map((root) => realpath(root)));
  const path = await realpath(input);
  if (!rootPaths.some((root) => isContained(root, path)))
    throw new Error("File is outside ANYDOC_ALLOWED_ROOTS");

  const linkInfo = await lstat(input);
  if (linkInfo.isSymbolicLink())
    throw new Error("Symbolic links are not allowed");
  const fileInfo = await stat(path);
  if (!fileInfo.isFile()) throw new Error("Path must reference a regular file");
  if (fileInfo.size > MAX_INPUT_BYTES)
    throw new Error(`File exceeds ${MAX_INPUT_BYTES} bytes`);
  return path;
}

export async function convertLocalFile(
  path: string,
  roots?: string[],
): Promise<{ markdown: string; truncated: boolean }> {
  const safePath = await resolveSafeFile(path, roots);
  const markdown = await toMarkdown(safePath);
  const truncated = markdown.length > MAX_OUTPUT_CHARS;
  return {
    markdown: truncated
      ? `${markdown.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated]`
      : markdown,
    truncated,
  };
}
