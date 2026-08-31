import type { Context } from "hono";
export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503,
    public code: string,
    message = code,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export const fail = (c: Context, error: unknown) => {
  const e =
    error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR");
  return c.json(
    { error: { code: e.code, message: e.message, details: e.details } },
    e.status,
  );
};
export function assert(
  condition: unknown,
  status: AppError["status"],
  code: string,
  message = code,
): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
