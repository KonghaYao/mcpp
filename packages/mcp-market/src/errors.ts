import type { Context } from "hono";

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN_ORIGIN",
  "INVALID_INPUT",
  "PACKAGE_NOT_FOUND",
  "VERSION_NOT_FOUND",
  "METADATA_INVALID",
  "METADATA_TOO_LARGE",
  "UNSUPPORTED_SCHEMA_VERSION",
  "PREVIEW_CHANGED",
  "PUBLICATION_NOT_FOUND",
  "REGISTRY_UNAVAILABLE",
  "HTTP_SOURCE_UNAVAILABLE",
  "REGISTRY_RATE_LIMITED",
  "CATALOG_CONFLICT",
  "PUBLIC_REFRESH_FAILED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 422
  | 429
  | 500
  | 503;

const STATUS_BY_CODE: Record<ErrorCode, ErrorStatus> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN_ORIGIN: 403,
  INVALID_INPUT: 400,
  PACKAGE_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  METADATA_INVALID: 422,
  METADATA_TOO_LARGE: 413,
  UNSUPPORTED_SCHEMA_VERSION: 422,
  PREVIEW_CHANGED: 409,
  PUBLICATION_NOT_FOUND: 404,
  REGISTRY_UNAVAILABLE: 503,
  HTTP_SOURCE_UNAVAILABLE: 503,
  REGISTRY_RATE_LIMITED: 429,
  CATALOG_CONFLICT: 409,
  PUBLIC_REFRESH_FAILED: 500,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly status: ErrorStatus;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    details: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const isAppError = (value: unknown): value is AppError =>
  value instanceof AppError;

export function assert(
  condition: unknown,
  code: ErrorCode,
  message?: string,
): asserts condition {
  if (!condition) throw new AppError(code, message);
}

/**
 * Maps any thrown value to a safe JSON error payload. Internal failures never
 * echo their message or details, so upstream responses, configuration and
 * secrets cannot leak through error output.
 */
export const fail = (c: Context, error: unknown) => {
  const appError = isAppError(error) ? error : null;
  if (!appError) console.error("[internal-error]", error);
  const code = appError?.code ?? "INTERNAL_ERROR";
  const message = appError?.message ?? "Internal error";
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      error: {
        code,
        message,
        details: appError?.details ?? {},
        requestId: c.get("requestId") ?? null,
      },
    },
    appError?.status ?? 500,
  );
};
