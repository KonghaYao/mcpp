export type FileErrorCode =
  | "INVALID_UPLOAD_REQUEST"
  | "UNSUPPORTED_FILES_VERSION"
  | "UNAUTHENTICATED"
  | "UPLOAD_FORBIDDEN"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_ENCODING"
  | "FILE_SIZE_MISMATCH"
  | "FILE_DIGEST_MISMATCH"
  | "FILE_REJECTED"
  | "UPLOAD_TIMEOUT"
  | "UPLOAD_RESULT_UNKNOWN"
  | "UPLOAD_LIMIT_REACHED"
  | "FILE_STORAGE_UNAVAILABLE"
  | "FILE_UNAVAILABLE"
  | "FILE_CANCELLED";

const errors: Record<FileErrorCode, [number, string, boolean]> = {
  INVALID_UPLOAD_REQUEST: [400, "上传元数据不合法", false],
  UNSUPPORTED_FILES_VERSION: [400, "不支持的文件扩展版本", false],
  UNAUTHENTICATED: [401, "请先完成身份验证", false],
  UPLOAD_FORBIDDEN: [403, "当前请求无权访问文件入口", false],
  FILE_TOO_LARGE: [413, "文件超过允许的大小", false],
  UNSUPPORTED_CONTENT_ENCODING: [415, "请使用未压缩的原始字节", false],
  FILE_SIZE_MISMATCH: [422, "文件实际大小与声明不一致", false],
  FILE_DIGEST_MISMATCH: [422, "文件摘要与声明不一致", false],
  FILE_REJECTED: [422, "文件未通过内容校验", false],
  UPLOAD_TIMEOUT: [408, "上传已超时", true],
  UPLOAD_RESULT_UNKNOWN: [503, "提交确认结果未知；不要自动重试上传", true],
  UPLOAD_LIMIT_REACHED: [429, "上传并发或额度已达上限", true],
  FILE_STORAGE_UNAVAILABLE: [503, "文件存储暂不可用", true],
  FILE_UNAVAILABLE: [404, "文件不可用，请重新上传", false],
  FILE_CANCELLED: [400, "文件操作已取消", false],
};

export class FileError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: FileErrorCode,
    readonly parameter?: string,
  ) {
    const [status, message, retryable] = errors[code];
    super(message);
    this.name = "FileError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** 内容解析器可显式拒绝文件，但不将解析器异常或文件内容直接传回客户端。 */
export class FileValidationError extends FileError {
  constructor() {
    super("FILE_REJECTED");
  }
}

export function storageError(error: unknown): FileError {
  return error instanceof FileError
    ? error
    : new FileError("FILE_STORAGE_UNAVAILABLE");
}

export function fileErrorResponse(error: unknown): Response {
  const e = storageError(error);
  return Response.json(
    { error: { code: e.code, message: e.message, retryable: e.retryable } },
    {
      status: e.status,
      headers: {
        "Cache-Control": "no-store",
        ...(e.status === 429 ? { "Retry-After": "1" } : {}),
      },
    },
  );
}
