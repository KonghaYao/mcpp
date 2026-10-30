/** io.mcpp/files v1 的纯数据契约；此文件不得引入服务端依赖。 */
export const MCPP_FILES_EXTENSION = "io.mcpp/files";
export const FILE_ID_PATTERN = "^f_[A-Za-z0-9_-]{22}$";
export const FILE_ID = new RegExp(FILE_ID_PATTERN);
export const FILES_VERSION = 1;

export interface FileScope {
  /** 宿主验证后的稳定业务身份；不是凭据、session 或客户端自报值。 */
  key: string;
}

export interface UploadedFileInfo {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

export type FilesCapability = {
  version: 1;
  uploadPath: string;
  maxFileBytes: number;
  defaultTtlSeconds: number;
};

export function isSafeSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validateUploadPath(path: string): string {
  if (
    !/^\/(?!\/)[A-Za-z0-9_./~-]+$/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..") ||
    path.includes("//") ||
    path.endsWith("/")
  )
    throw new Error(
      "上传路径必须是无 query、fragment 或路径穿越的同源绝对路径",
    );
  return path;
}

export function defaultUploadPath(endpointPath: string): string {
  validateUploadPath(endpointPath);
  if (!endpointPath.endsWith("/mcp"))
    throw new Error("请为非 /mcp endpoint 显式配置 uploadPath");
  return `${endpointPath}-upload`;
}

export function validName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    new TextEncoder().encode(name).length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !/[\x00-\x1f\x7f-\x9f/\\]/u.test(name)
  );
}

export function validInfo(value: unknown): value is UploadedFileInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as UploadedFileInfo;
  return (
    typeof v.fileId === "string" &&
    FILE_ID.test(v.fileId) &&
    validName(v.name) &&
    typeof v.mimeType === "string" &&
    /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(v.mimeType) &&
    isSafeSize(v.size) &&
    typeof v.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(v.sha256) &&
    typeof v.createdAt === "string" &&
    typeof v.expiresAt === "string" &&
    Number.isFinite(Date.parse(v.createdAt)) &&
    Date.parse(v.expiresAt) > Date.parse(v.createdAt)
  );
}

export function publicInfo(record: UploadedFileInfo): UploadedFileInfo {
  const { fileId, name, mimeType, size, sha256, createdAt, expiresAt } = record;
  return { fileId, name, mimeType, size, sha256, createdAt, expiresAt };
}
