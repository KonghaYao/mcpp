import {
  defaultUploadPath,
  isSafeSize,
  MCPP_FILES_EXTENSION,
  publicInfo,
  validInfo,
  validName,
  validateUploadPath,
  type FilesCapability,
  type UploadedFileInfo,
} from "./protocol.ts";

export {
  MCPP_FILES_EXTENSION,
  FILE_ID_PATTERN,
  type FilesCapability,
  type UploadedFileInfo,
} from "./protocol.ts";
export interface FileUploadSource {
  name: string;
  mimeType: string;
  size: number;
  body: ReadableStream<Uint8Array> | Uint8Array | Blob;
  sha256?: string;
}
export interface McppFileClient {
  upload(
    source: FileUploadSource,
    options?: { signal?: AbortSignal },
  ): Promise<UploadedFileInfo>;
}
export class FileUploadError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: "not-uploaded" | "unknown",
    readonly retryable = false,
  ) {
    super(
      outcome === "unknown"
        ? "上传结果未知；不要自动重试 POST"
        : "文件上传未成功",
    );
    this.name = "FileUploadError";
  }
}

type FetchOptions = NonNullable<Parameters<typeof globalThis.fetch>[1]>;

export interface FileClientOptions {
  endpoint: string;
  /** 宿主明确批准向其发送 MCP 凭据的兄弟路径；默认仅 endpoint 对应的 /mcp-upload。 */
  allowedUploadPath?: string;
  discover: (options?: {
    signal?: AbortSignal;
  }) => Promise<{ capabilities?: { extensions?: Record<string, unknown> } }>;
  /** 与对应 MCP endpoint 共用认证提供者，不接受服务端返回的凭据或第三方 URL。 */
  headers?: () =>
    | NonNullable<FetchOptions["headers"]>
    | Promise<NonNullable<FetchOptions["headers"]>>;
  credentials?: "omit" | "same-origin" | "include";
  fetch?: (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch>;
}

export function createFileClient(options: FileClientOptions): McppFileClient {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
    )
  )
    throw new Error(
      "文件 endpoint 必须使用 HTTPS 或 loopback HTTP，且不能嵌入凭据",
    );
  const path = validateUploadPath(
    options.allowedUploadPath ?? defaultUploadPath(endpoint.pathname),
  );
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async upload(source, { signal } = {}) {
      const discovery = await options.discover({ signal });
      const capability = discovery.capabilities?.extensions?.[
        MCPP_FILES_EXTENSION
      ] as FilesCapability | undefined;
      if (
        !capability ||
        capability.version !== 1 ||
        capability.uploadPath !== path ||
        !isSafeSize(capability.maxFileBytes) ||
        !isSafeSize(capability.defaultTtlSeconds) ||
        capability.defaultTtlSeconds === 0
      )
        throw new FileUploadError(
          "UNSUPPORTED_FILES_EXTENSION",
          "not-uploaded",
        );
      if (
        !validName(source.name) ||
        !isSafeSize(source.size) ||
        !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(source.mimeType) ||
        source.mimeType === "multipart/form-data" ||
        (source.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(source.sha256))
      )
        throw new FileUploadError("INVALID_UPLOAD_REQUEST", "not-uploaded");
      if (source.size > capability.maxFileBytes)
        throw new FileUploadError("FILE_TOO_LARGE", "not-uploaded");
      if (
        (source.body instanceof Blob && source.body.size !== source.size) ||
        (source.body instanceof Uint8Array &&
          source.body.byteLength !== source.size)
      )
        throw new FileUploadError("FILE_SIZE_MISMATCH", "not-uploaded");
      const headers = new Headers(await options.headers?.());
      // Content-Length 属于 HTTP 栈；尤其不能手工设置浏览器禁止的 header。
      headers.delete("Content-Length");
      headers.delete("Content-Encoding");
      for (const name of [...headers.keys()]) {
        if (/^(?:mcp-|mcp$)/i.test(name)) headers.delete(name);
      }
      headers.set("Content-Type", source.mimeType);
      headers.set("MCPP-Files-Version", "1");
      headers.set("MCPP-File-Name", encodeURIComponent(source.name));
      headers.set("MCPP-File-Size", String(source.size));
      if (source.sha256) headers.set("MCPP-File-Sha256", source.sha256);
      else headers.delete("MCPP-File-Sha256");
      signal?.throwIfAborted();
      try {
        const response = await fetcher(new URL(path, endpoint.origin), {
          method: "POST",
          body: source.body as FetchOptions["body"],
          headers,
          signal,
          redirect: "error",
          credentials: options.credentials ?? "same-origin",
          ...(source.body instanceof ReadableStream ? { duplex: "half" } : {}),
        });
        if (response.status !== 201) {
          const failure = (await response.json().catch(() => null)) as {
            error?: { code?: unknown; retryable?: unknown };
          } | null;
          const code = failure?.error?.code;
          throw new FileUploadError(
            typeof code === "string" && /^[A-Z_]{1,64}$/.test(code)
              ? code
              : "UPLOAD_HTTP_ERROR",
            response.status >= 500 ? "unknown" : "not-uploaded",
            failure?.error?.retryable === true,
          );
        }
        const info: unknown = await response.json();
        if (
          !validInfo(info) ||
          info.size !== source.size ||
          info.size > capability.maxFileBytes ||
          (source.sha256 && info.sha256 !== source.sha256)
        )
          throw new FileUploadError("INVALID_UPLOAD_RESPONSE", "unknown");
        return publicInfo(info);
      } catch (error) {
        if (error instanceof FileUploadError) throw error;
        throw new FileUploadError("UPLOAD_RESULT_UNKNOWN", "unknown");
      }
    },
  };
}
