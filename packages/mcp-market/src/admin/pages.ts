/**
 * Admin Console pages.
 *
 * These pages are the only place a Preview is shown, so the "what you confirm
 * is what gets published" contract is visible to the operator: the digest the
 * form carries is the digest of the exact snapshot rendered here.
 */

import type { AdminPackageVersion } from "../catalog/service.ts";
import { escapeHtml, safeHref, THEME_TOKENS } from "../html.ts";
import type { NormalizedPackageVersion } from "../npm-registry/types.ts";

const STYLES = `
${THEME_TOKENS}
.wrap { max-width:960px; margin:0 auto; padding:28px 20px 72px; }
header.bar {
  border-bottom:1px solid var(--line); background:var(--paper);
}
header.bar .inner {
  max-width:960px; margin:0 auto; padding:0 20px; height:56px;
  display:flex; align-items:center; gap:18px;
}
header.bar .brand { font-weight:600; letter-spacing:-.02em; text-decoration:none; }
header.bar nav { display:flex; gap:16px; font-size:12px; color:var(--muted); }
header.bar nav a { text-decoration:none; }
header.bar nav a:hover { color:var(--ink); }
h1 { font-size:23px; letter-spacing:-.03em; margin:0 0 6px; }
h2 { font-size:15px; margin:28px 0 10px; }
p { margin:0 0 10px; font-size:13px; }
.lede { color:var(--muted); font-size:12px; }
label { display:block; font-size:12px; color:var(--muted); margin:12px 0 4px; }
input[type=text], input[type=password] {
  width:100%; border:1px solid var(--line); border-radius:9px; padding:9px 11px;
  font-size:13px; font-family:inherit; background:#fff; color:var(--ink);
}
button {
  border:0; border-radius:9px; background:var(--ink); color:#fff;
  padding:9px 15px; font-size:13px; font-weight:600; font-family:inherit; cursor:pointer;
}
button.secondary { background:#fff; color:var(--ink); border:1px solid var(--line); }
button.danger { background:var(--coral); }
.form-row { display:flex; gap:10px; align-items:flex-end; margin-top:16px; }
.form-row > * { flex:0 0 auto; }
.form-row .grow { flex:1 1 auto; }
.panel { border:1px solid var(--line); border-radius:12px; padding:16px; margin-top:18px; background:#fff; }
.panel.warn { border-left:3px solid var(--coral); }
.panel.ok { border-left:3px solid #16A34A; }
.kv { display:grid; grid-template-columns:150px 1fr; gap:5px 14px; font-size:12px; }
.kv dt { color:var(--muted); }
.kv dd { margin:0; word-break:break-word; }
.mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; }
table { width:100%; border-collapse:collapse; font-size:12px; margin-top:10px; }
th, td { text-align:left; padding:7px 9px; border-bottom:1px solid var(--line); }
th { color:var(--muted); font-weight:500; }
.tag {
  display:inline-block; border:1px solid var(--line); border-radius:999px;
  padding:1px 8px; font-size:11px; color:var(--muted);
}
.tag.strong { border-color:#C7D2FE; color:var(--cobalt); }
.tag.muted { background:var(--fog); }
.error { color:var(--coral); font-size:12px; margin-top:8px; }
ul.agents { margin:6px 0 0; padding-left:18px; font-size:12px; color:var(--muted); }
.empty { color:var(--muted); font-size:12px; padding:14px 0; }
`;

const layout = (title: string, body: string, csrfToken: string): string =>
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · MCPM Admin</title>
<style>${STYLES}</style>
</head>
<body>
<header class="bar"><div class="inner">
<a class="brand" href="/admin">MCPM Admin</a>
<nav><a href="/admin">条目</a><a href="/admin/publish">发布版本</a><a href="/">公开市场</a></nav>
<form method="post" action="/admin/logout" style="margin-left:auto">
<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
<button class="secondary" type="submit">退出</button>
</form>
</div></header>
<div class="wrap">
${body}
</div>
</body>
</html>
`;

/** Login is not a catalogue mutation; same-origin plus SameSite=Strict covers it. */
export const renderLogin = (input: { error?: string | null }): string =>
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>登录 · MCPM Admin</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap" style="max-width:380px;padding-top:64px;">
<h1>管理员登录</h1>
<p class="lede">本系统只有一个管理员账号，凭证来自部署环境变量。</p>
<form method="post" action="/admin/login">
<label for="username">用户名</label>
<input id="username" type="text" name="username" autocomplete="username" required maxlength="128">
<label for="password">密码</label>
<input id="password" type="password" name="password" autocomplete="current-password" required maxlength="256">
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ""}
<div class="form-row"><button type="submit">登录</button></div>
</form>
</div>
</body>
</html>
`;

const refreshSummary = (refresh: {
  outcome: string;
  errorCode: string | null;
}): string => {
  if (refresh.outcome === "refreshed")
    return `<div class="panel ok"><strong>Catalog 已更新</strong><p class="lede">公开页面已重新生成。</p></div>`;
  if (refresh.outcome === "skipped")
    return `<div class="panel ok"><strong>无需变更</strong><p class="lede">该版本已经是当前状态，未写入任何数据。</p></div>`;
  return `<div class="panel warn"><strong>Catalog 已更新，但公开页面刷新失败</strong>
<p class="lede">页面刷新属于可重试的缓存操作，回滚不会发生。错误码：<span class="mono">${escapeHtml(refresh.errorCode ?? "UNKNOWN")}</span></p></div>`;
};

const changeSummary = (change: {
  action: string;
  exactVersion: string;
  packageName: string;
  latestPublicationId: string | null;
}): string =>
  `<div class="panel"><dl class="kv">
<dt>操作</dt><dd>${escapeHtml(change.action)}</dd>
<dt>Package</dt><dd class="mono">${escapeHtml(change.packageName)}</dd>
<dt>版本</dt><dd class="mono">${escapeHtml(change.exactVersion)}</dd>
<dt>Market latest</dt><dd class="mono">${change.latestPublicationId ? escapeHtml(change.latestPublicationId) : "（无）"}</dd>
</dl></div>`;

const previewPanel = (input: {
  packageName: string;
  exactVersion: string;
  metadata: NormalizedPackageVersion;
  metadataDigest: string;
  csrfToken: string;
}): string => {
  const metadata = input.metadata;
  const npm = safeHref(metadata.tarballUrl);
  return `<div class="panel">
<h2>预览：即将公开的内容</h2>
<dl class="kv">
<dt>Package</dt><dd class="mono">${escapeHtml(input.packageName)}</dd>
<dt>Exact version</dt><dd class="mono">${escapeHtml(input.exactVersion)}</dd>
<dt>展示名称</dt><dd>${escapeHtml(metadata.displayName ?? "—")}</dd>
<dt>摘要</dt><dd>${escapeHtml(metadata.summary ?? "—")}</dd>
<dt>描述</dt><dd>${escapeHtml(metadata.description ?? "—")}</dd>
<dt>关键词</dt><dd>${escapeHtml(metadata.keywords.join(", ") || "—")}</dd>
<dt>Agent 数量</dt><dd>${metadata.agents.length}</dd>
<dt>Server 数量</dt><dd>${metadata.servers.length}</dd>
<dt>Integrity</dt><dd class="mono">${escapeHtml(metadata.integrity ?? "未提供")}</dd>
<dt>NPM 发布时间</dt><dd>${escapeHtml(metadata.publishedAt ?? "未知")}</dd>
${npm ? `<dt>Tarball（不会下载）</dt><dd class="mono">${escapeHtml(npm)}</dd>` : ""}
<dt>快照 digest</dt><dd class="mono">${escapeHtml(input.metadataDigest)}</dd>
</dl>
${
  metadata.agents.length > 0
    ? `<h2>Agent 成员</h2><ul class="agents">${metadata.agents
        .map(
          (agent) =>
            `<li>${escapeHtml(agent.name)} <span class="mono">${escapeHtml(agent.id)}</span></li>`,
        )
        .join("")}</ul>`
    : ""
}
<h2>确认发布</h2>
<p class="lede">确认时服务端会重新读取该版本；若元数据与本次预览不一致，发布将被阻止并要求重新确认。</p>
<form method="post" action="/admin/publish">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
<input type="hidden" name="packageName" value="${escapeHtml(input.packageName)}">
<input type="hidden" name="exactVersion" value="${escapeHtml(input.exactVersion)}">
<input type="hidden" name="previewDigest" value="${escapeHtml(input.metadataDigest)}">
<button type="submit">确认发布</button>
</form>
</div>`;
};

export const renderPublish = (input: {
  csrfToken: string;
  error?: string | null;
  preview?: {
    packageName: string;
    exactVersion: string;
    metadata: NormalizedPackageVersion;
    metadataDigest: string;
  } | null;
  change?: {
    action: string;
    exactVersion: string;
    packageName: string;
    latestPublicationId: string | null;
  } | null;
  refresh?: { outcome: string; errorCode: string | null } | null;
  notice?: string | null;
}): string =>
  layout(
    "发布版本",
    `<h1>发布 exact version</h1>
<p class="lede">输入 NPM package 与精确版本。Market 只记录该版本的元数据快照；不会下载或扫描 tarball。</p>
<form method="post" action="/admin/publish/preview">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
<div class="form-row">
<div class="grow"><label for="packageName">Package name</label>
<input id="packageName" type="text" name="packageName" required maxlength="214" placeholder="@scope/name" value="${escapeHtml(input.preview?.packageName ?? "")}"></div>
<div class="grow"><label for="exactVersion">Exact version</label>
<input id="exactVersion" type="text" name="exactVersion" required maxlength="128" placeholder="1.4.0" value="${escapeHtml(input.preview?.exactVersion ?? "")}"></div>
<button type="submit">读取并预览</button>
</div>
</form>
${input.error ? `<div class="panel warn"><strong>操作未完成</strong><p class="lede">${escapeHtml(input.error)}</p></div>` : ""}
${input.notice ? `<div class="panel warn"><strong>需要重新确认</strong><p class="lede">${escapeHtml(input.notice)}</p></div>` : ""}
${input.change ? changeSummary(input.change) : ""}
${input.refresh ? refreshSummary(input.refresh) : ""}
${
  input.preview
    ? previewPanel({ ...input.preview, csrfToken: input.csrfToken })
    : ""
}`,
    input.csrfToken,
  );

export const renderDashboard = (input: {
  csrfToken: string;
  packages: Array<{
    slug: string;
    packageName: string;
    latestVersion: string | null;
    visibleVersions: number;
    totalVersions: number;
    lastRefresh: { outcome: string; errorCode: string | null } | null;
  }>;
}): string =>
  layout(
    "条目",
    `<h1>Market 条目</h1>
<p class="lede">每个 package 只展示一个最新版本。下架只撤销本市场的可见性，不改变 NPM 状态。</p>
${
  input.packages.length === 0
    ? `<p class="empty">还没有发布任何版本。</p>`
    : `<table><thead><tr><th>Package</th><th>Latest</th><th>公开版本</th><th>页面</th><th></th></tr></thead><tbody>
${input.packages
  .map(
    (entry) => `<tr>
<td class="mono">${escapeHtml(entry.packageName)}</td>
<td class="mono">${entry.latestVersion ? escapeHtml(entry.latestVersion) : "（无）"}</td>
<td>${entry.visibleVersions} / ${entry.totalVersions}</td>
<td>${
      entry.lastRefresh === null
        ? "—"
        : entry.lastRefresh.outcome === "succeeded"
          ? `<span class="tag">已刷新</span>`
          : `<span class="tag" style="color:var(--coral)">失败 ${escapeHtml(entry.lastRefresh.errorCode ?? "")}</span>`
    }</td>
<td><a href="/admin/packages/${escapeHtml(entry.slug)}">管理</a></td>
</tr>`,
  )
  .join("")}
</tbody></table>`
}`,
    input.csrfToken,
  );

export const renderPackageDetail = (input: {
  csrfToken: string;
  slug: string;
  packageName: string;
  sourceId: string;
  /** Null when the newest snapshot has no display name. */
  displayName: string | null;
  /** Null once every version is withdrawn. */
  latestVersion: string | null;
  versions: AdminPackageVersion[];
  lastRefresh: {
    outcome: string;
    errorCode: string | null;
    requestedAt: string;
  } | null;
  notice?: string | null;
  error?: string | null;
}): string =>
  layout(
    input.packageName,
    `<h1>${escapeHtml(input.displayName ?? input.packageName)}</h1>
<p class="lede mono">${escapeHtml(input.packageName)} · ${escapeHtml(input.sourceId)}</p>
<p class="lede">公开 latest：<span class="mono">${input.latestVersion ? escapeHtml(input.latestVersion) : "（无，全部已下架）"}</span></p>
${input.error ? `<div class="panel warn"><p class="lede">${escapeHtml(input.error)}</p></div>` : ""}
${input.notice ? `<div class="panel warn"><p class="lede">${escapeHtml(input.notice)}</p></div>` : ""}
${
  input.lastRefresh
    ? `<p class="lede">最近一次页面刷新：${escapeHtml(input.lastRefresh.outcome)}${input.lastRefresh.errorCode ? ` (${escapeHtml(input.lastRefresh.errorCode)})` : ""} · ${escapeHtml(input.lastRefresh.requestedAt)}</p>`
    : ""
}
<form method="post" action="/admin/refresh" class="form-row">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
<input type="hidden" name="packageSlug" value="${escapeHtml(input.slug)}">
<button class="secondary" type="submit">重新生成公开页面</button>
</form>
<h2>版本</h2>
<table><thead><tr><th>版本</th><th>状态</th><th>公开时间</th><th></th></tr></thead><tbody>
${input.versions
  .map(
    (version) => `<tr>
<td class="mono">${escapeHtml(version.version)}</td>
<td>${
      version.unpublishedAt === null
        ? `<span class="tag strong">公开</span>`
        : `<span class="tag muted">已下架</span>`
    }${version.isLatest ? ` <span class="tag">latest</span>` : ""}</td>
<td>${escapeHtml(version.publishedAt)}</td>
<td>
${
  version.unpublishedAt === null
    ? `<form method="post" action="/admin/unpublish">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
<input type="hidden" name="packageName" value="${escapeHtml(input.packageName)}">
<input type="hidden" name="exactVersion" value="${escapeHtml(version.version)}">
<button class="danger" type="submit">下架</button>
</form>`
    : `<form method="post" action="/admin/restore">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
<input type="hidden" name="packageName" value="${escapeHtml(input.packageName)}">
<input type="hidden" name="exactVersion" value="${escapeHtml(version.version)}">
<button class="secondary" type="submit">恢复（用原快照）</button>
</form>`
}
</td>
</tr>`,
  )
  .join("")}
</tbody></table>
<p class="lede" style="margin-top:16px"><a href="/market/${escapeHtml(input.slug)}">查看公开页面</a></p>`,
    input.csrfToken,
  );

export const renderAdminNotFound = (csrfToken: string): string =>
  layout(
    "未找到",
    `<h1>未找到</h1><p class="lede">该条目不存在。</p>`,
    csrfToken,
  );
