/**
 * Admin Console routes.
 *
 * Every mutation passes the same gate: session, same-origin, form content type,
 * CSRF token. Read routes require a session but no token. Nothing here writes
 * the catalogue directly; all state changes go through `AdminService`.
 */

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  renderAdminNotFound,
  renderDashboard,
  renderLogin,
  renderPackageDetail,
  renderPublish,
} from "../admin/pages.ts";
import type { AdminService } from "../admin/service.ts";
import {
  SESSION_COOKIE_NAME,
  type AdminAuthService,
  type LoginResult,
} from "../admin-auth/service.ts";
import type { CatalogService } from "../catalog/service.ts";
import { toPackageSlug } from "../catalog/slug.ts";
import type { AppEnv } from "../env.ts";
import { AppError, fail, isAppError } from "../errors.ts";
import type { NormalizedPackageVersion } from "../npm-registry/types.ts";

export type AdminRouteDeps = {
  auth: AdminAuthService;
  admin: AdminService;
  catalog: CatalogService;
};

type AdminContext = Context<AppEnv>;

const HTML = { "Content-Type": "text/html; charset=utf-8" } as const;
const NO_STORE = "no-store";

const redirect = (c: AdminContext, location: string) => {
  c.header("Cache-Control", NO_STORE);
  return c.redirect(location, 303);
};

/** Client key for throttling; only used when proxy trust is explicitly enabled. */
const clientKey = (c: AdminContext, trustProxy: boolean): string => {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  const direct = c.req.header("x-real-ip");
  return direct?.trim() || "unknown";
};

const formField = async (
  c: AdminContext,
  name: string,
): Promise<string | undefined> => {
  const body = await c.req.parseBody();
  const value = body[name];
  return typeof value === "string" ? value : undefined;
};

/** Maps a domain error to an operator-facing sentence. */
const describe = (error: unknown): string => {
  if (!isAppError(error)) return "发生内部错误，请重试。";
  switch (error.code) {
    case "PACKAGE_NOT_FOUND":
      return "Registry 中不存在该 package。";
    case "VERSION_NOT_FOUND":
      return "Registry 中不存在该 exact version。";
    case "METADATA_TOO_LARGE":
      return "该版本的元数据超过大小或长度上限。";
    case "METADATA_INVALID":
      return "该版本的元数据结构不合法或不支持。";
    case "UNSUPPORTED_SCHEMA_VERSION":
      return "该版本声明的 mcpp schemaVersion 不受支持。";
    case "REGISTRY_UNAVAILABLE":
      return "无法连接 Registry，请稍后重试。";
    case "REGISTRY_RATE_LIMITED":
      return "Registry 限流，请稍后重试。";
    case "INVALID_INPUT":
      return "输入不合法，请检查 package 名称与 exact version。";
    case "PREVIEW_CHANGED":
      return "Registry 元数据在预览后发生变化，需要重新确认。";
    case "FORBIDDEN_ORIGIN":
      return "请求未通过同源或 CSRF 校验。";
    case "PUBLICATION_NOT_FOUND":
      return "该条目不存在。";
    default:
      return "操作未完成，请重试。";
  }
};

export const adminRoutes = (
  deps: AdminRouteDeps,
  options: { trustProxy: boolean },
): Hono<AppEnv> => {
  const { auth, admin, catalog } = deps;
  const routes = new Hono<AppEnv>();

  const sessionValue = (c: AdminContext): string | undefined =>
    getCookie(c, SESSION_COOKIE_NAME);

  /** Returns the session cookie value, or null after emitting a rejection. */
  const requireSession = async (c: AdminContext): Promise<string | null> => {
    const value = sessionValue(c);
    const payload = await auth.authenticate(value);
    if (payload && value) return value;
    return null;
  };

  const rejectUnauthenticated = (c: AdminContext) =>
    c.req.method === "GET"
      ? redirect(c, "/admin/login")
      : fail(c, new AppError("UNAUTHENTICATED"));

  routes.get("/login", async (c) => {
    const value = sessionValue(c);
    if (await auth.authenticate(value)) return redirect(c, "/admin");
    return c.body(renderLogin({}), 200, { ...HTML, "Cache-Control": NO_STORE });
  });

  routes.post("/login", async (c) => {
    const respond = (status: 400 | 401 | 429, error: string) =>
      c.body(renderLogin({ error }), status, {
        ...HTML,
        "Cache-Control": NO_STORE,
      });
    try {
      auth.assertSameOrigin(c.req.header("origin"), c.req.header("host"));
      auth.assertFormContentType(c.req.header("content-type"));
    } catch {
      return respond(401, "请求未通过同源校验。");
    }

    const username = (await formField(c, "username")) ?? "";
    const password = (await formField(c, "password")) ?? "";
    const result: LoginResult = await auth.login(
      username,
      password,
      clientKey(c, options.trustProxy),
    );

    if (result.status === "rate_limited") {
      c.header("Retry-After", String(result.retryAfterSeconds));
      return respond(429, "登录尝试过于频繁，请稍后再试。");
    }
    if (result.status === "invalid")
      // Deliberately identical for a wrong username and a wrong password.
      return respond(401, "用户名或密码不正确。");

    setCookie(c, SESSION_COOKIE_NAME, result.cookieValue, auth.cookieOptions());
    return redirect(c, "/admin");
  });

  routes.post("/logout", async (c) => {
    const guarded = await guard(c);
    if (!guarded.ok) return guarded.response;
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return redirect(c, "/admin/login");
  });

  routes.get("/", async (c) => {
    const session = await requireSession(c);
    if (!session) return rejectUnauthenticated(c);
    return c.body(
      renderDashboard({
        csrfToken: await auth.csrfTokenFor(session),
        packages: catalog.listAdminPackages(),
      }),
      200,
      { ...HTML, "Cache-Control": NO_STORE },
    );
  });

  routes.get("/publish", async (c) => {
    const session = await requireSession(c);
    if (!session) return rejectUnauthenticated(c);
    return c.body(
      renderPublish({ csrfToken: await auth.csrfTokenFor(session) }),
      200,
      { ...HTML, "Cache-Control": NO_STORE },
    );
  });

  routes.get("/packages/:slug", async (c) => {
    const session = await requireSession(c);
    if (!session) return rejectUnauthenticated(c);
    const detail = catalog.getAdminPackage(c.req.param("slug"));
    if (!detail)
      return c.body(
        renderAdminNotFound(await auth.csrfTokenFor(session)),
        404,
        {
          ...HTML,
          "Cache-Control": NO_STORE,
        },
      );
    return c.body(
      renderPackageDetail({
        csrfToken: await auth.csrfTokenFor(session),
        ...detail,
      }),
      200,
      { ...HTML, "Cache-Control": NO_STORE },
    );
  });

  /** Shared guard for every mutation. */
  const guard = async (
    c: AdminContext,
  ): Promise<
    { ok: true; session: string } | { ok: false; response: Response }
  > => {
    const session = await requireSession(c);
    if (!session) return { ok: false, response: rejectUnauthenticated(c) };
    try {
      auth.assertSameOrigin(c.req.header("origin"), c.req.header("host"));
      auth.assertFormContentType(c.req.header("content-type"));
      await auth.assertCsrf(session, await formField(c, "csrf"));
    } catch (error) {
      return { ok: false, response: fail(c, error) };
    }
    return { ok: true, session };
  };

  const publishPage = async (
    c: AdminContext,
    session: string,
    body: Omit<Parameters<typeof renderPublish>[0], "csrfToken">,
  ) =>
    c.body(
      renderPublish({ ...body, csrfToken: await auth.csrfTokenFor(session) }),
      200,
      { ...HTML, "Cache-Control": NO_STORE },
    );

  routes.post("/publish/preview", async (c) => {
    const guarded = await guard(c);
    if (!guarded.ok) return guarded.response;
    const packageName = (await formField(c, "packageName")) ?? "";
    const exactVersion = (await formField(c, "exactVersion")) ?? "";
    try {
      const preview = await admin.preview(packageName, exactVersion);
      return publishPage(c, guarded.session, { preview });
    } catch (error) {
      return publishPage(c, guarded.session, {
        error: describe(error),
        preview: previewFromError(error),
      });
    }
  });

  routes.post("/publish", async (c) => {
    const guarded = await guard(c);
    if (!guarded.ok) return guarded.response;
    const packageName = (await formField(c, "packageName")) ?? "";
    const exactVersion = (await formField(c, "exactVersion")) ?? "";
    const previewDigest = (await formField(c, "previewDigest")) ?? null;
    try {
      const outcome = await admin.publish({
        packageName,
        exactVersion,
        previewDigest,
        requestId: c.get("requestId") ?? "",
      });
      return publishPage(c, guarded.session, {
        change: outcome.change,
        refresh: outcome.refresh,
      });
    } catch (error) {
      return publishPage(c, guarded.session, {
        error: describe(error),
        // A changed preview is shown again so the operator can confirm the new
        // snapshot instead of guessing what moved.
        preview: previewFromError(error),
        notice:
          isAppError(error) && error.code === "PREVIEW_CHANGED"
            ? "预览内容已更新，请核对后再次确认。"
            : null,
      });
    }
  });

  const visibilityChange = async (
    c: AdminContext,
    direction: "hide" | "show",
  ): Promise<Response> => {
    const guarded = await guard(c);
    if (!guarded.ok) return guarded.response;
    const packageName = (await formField(c, "packageName")) ?? "";
    const exactVersion = (await formField(c, "exactVersion")) ?? "";
    // The slug is a pure encoding of the package name, so a failure path can
    // still find the package page before anything has been written.
    const slug = toPackageSlug(packageName);
    try {
      const outcome =
        direction === "hide"
          ? await admin.unpublish({
              packageName,
              exactVersion,
              requestId: c.get("requestId") ?? "",
            })
          : await admin.publish({
              packageName,
              exactVersion,
              previewDigest: null,
              requestId: c.get("requestId") ?? "",
            });
      const detail = catalog.getAdminPackage(outcome.change.packageSlug);
      if (!detail)
        return c.body(
          renderAdminNotFound(await auth.csrfTokenFor(guarded.session)),
          404,
          {
            ...HTML,
            "Cache-Control": NO_STORE,
          },
        );
      return c.body(
        renderPackageDetail({
          csrfToken: await auth.csrfTokenFor(guarded.session),
          ...detail,
          notice:
            outcome.refresh.outcome === "failed"
              ? `Catalog 已更新，但公开页面刷新失败（${outcome.refresh.errorCode ?? "UNKNOWN"}）。可点击“重新生成公开页面”重试。`
              : null,
        }),
        200,
        { ...HTML, "Cache-Control": NO_STORE },
      );
    } catch (error) {
      const detail = catalog.getAdminPackage(slug);
      if (!detail)
        return c.body(
          renderAdminNotFound(await auth.csrfTokenFor(guarded.session)),
          404,
          {
            ...HTML,
            "Cache-Control": NO_STORE,
          },
        );
      return c.body(
        renderPackageDetail({
          csrfToken: await auth.csrfTokenFor(guarded.session),
          ...detail,
          error: describe(error),
        }),
        200,
        { ...HTML, "Cache-Control": NO_STORE },
      );
    }
  };

  routes.post("/unpublish", (c) => visibilityChange(c, "hide"));
  routes.post("/restore", (c) => visibilityChange(c, "show"));

  routes.post("/refresh", async (c) => {
    const guarded = await guard(c);
    if (!guarded.ok) return guarded.response;
    const slug = (await formField(c, "packageSlug")) ?? "";
    try {
      const result = await admin.retryRefresh(slug, c.get("requestId") ?? "");
      const detail = catalog.getAdminPackage(slug);
      if (!detail)
        return c.body(
          renderAdminNotFound(await auth.csrfTokenFor(guarded.session)),
          404,
          {
            ...HTML,
            "Cache-Control": NO_STORE,
          },
        );
      return c.body(
        renderPackageDetail({
          csrfToken: await auth.csrfTokenFor(guarded.session),
          ...detail,
          notice:
            result.outcome === "failed"
              ? `页面刷新仍然失败（${result.errorCode ?? "UNKNOWN"}）。Catalog 数据未受影响。`
              : "公开页面已重新生成。",
        }),
        200,
        { ...HTML, "Cache-Control": NO_STORE },
      );
    } catch (error) {
      return fail(c, error);
    }
  });

  return routes;
};

/**
 * Rebuilds a preview view from a `PREVIEW_CHANGED` rejection so the operator
 * sees the new snapshot without a second round trip.
 */
const previewFromError = (
  error: unknown,
): {
  packageName: string;
  exactVersion: string;
  metadata: NormalizedPackageVersion;
  metadataDigest: string;
} | null => {
  if (!isAppError(error) || error.code !== "PREVIEW_CHANGED") return null;
  const details = error.details;
  const metadata = details.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  return {
    packageName: String(details.packageName ?? ""),
    exactVersion: String(details.exactVersion ?? ""),
    metadata: metadata as NormalizedPackageVersion,
    metadataDigest: String(details.metadataDigest ?? ""),
  };
};
