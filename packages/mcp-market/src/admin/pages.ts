/**
 * Admin Console pages.
 *
 * These pages are the only place a Preview is shown, so the "what you confirm
 * is what gets published" contract is visible to the operator: the digest the
 * form carries is the digest of the exact snapshot rendered here.
 */

import { toPackageSlug } from "../catalog/slug.ts";
import type { HttpSource } from "../http-source/service.ts";
import type { PublicationPreview } from "../npm-registry/types.ts";
import type { MutationOutcome } from "./service.ts";
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
.http-sources .section-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:14px; }
.http-sources .section-heading h2,.http-sources .panel h2 { margin:0; }
.http-sources .section-heading p { margin:4px 0 0; }
.http-sources .actions { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.http-sources .actions form { margin:0; }
.http-sources .actions a { font-size:12px; color:var(--cobalt); }
.http-sources .form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 18px; margin:8px 0 18px; }
.http-sources .form-grid .wide { grid-column:1/-1; }
.http-sources select { width:100%; border:1px solid var(--line); border-radius:9px; padding:9px 11px; font:inherit; font-size:13px; background:#fff; color:var(--ink); }
.http-sources input,.http-sources select { margin-top:5px; }
.http-sources .form-note { display:block; margin-top:4px; font-size:11px; color:var(--muted); }
.http-sources details>summary { cursor:pointer; font-size:12px; font-weight:600; overflow-wrap:anywhere; }
.http-sources .definition>summary { font-size:15px; }
.http-sources .definition[open]>summary { margin-bottom:12px; }
.http-sources .capability-nav { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0; }
.http-sources .capability-nav a { text-decoration:none; padding:5px 10px; }
.http-sources .capability-group { margin-top:24px; scroll-margin-top:20px; }
.http-sources .capability-group h3 { margin:0; font-size:14px; }
.http-sources p.empty { padding:4px 0; margin:0; }
.http-sources .capability-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin:0; padding:0; list-style:none; }
.http-sources .capability-item { min-width:0; border:1px solid var(--line); border-radius:12px; padding:14px; }
.http-sources .capability-item strong { display:block; font-size:13px; overflow-wrap:anywhere; }
.http-sources .capability-item p { margin:6px 0; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.http-sources .capability-item code { display:block; margin-top:10px; color:var(--muted); overflow-wrap:anywhere; font-size:11px; }
.http-sources .capability-item details { margin-top:12px; padding-top:10px; border-top:1px solid var(--line); }
.http-sources .parameter-list { margin:10px 0 0; padding:0; list-style:none; font-size:11px; }
.http-sources .parameter-list li { padding:5px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
.http-sources .parameter-list code { display:inline; margin:0; color:var(--ink); }
.http-sources .technical { margin-top:18px; border-top:1px solid var(--line); padding-top:14px; }
.http-sources pre { max-height:360px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; padding:12px; border-radius:9px; background:var(--fog); font-size:11px; }
.http-sources .table-scroll { overflow-x:auto; margin-top:14px; }
.http-sources .table-scroll table { margin:0; min-width:640px; }
.http-sources .table-scroll td { vertical-align:top; }
.http-sources .endpoint-cell { max-width:260px; overflow-wrap:anywhere; }
.http-sources .source-state { margin:14px 0; padding:10px 12px; background:var(--fog); border-radius:9px; }
.http-sources .kv { grid-template-columns:110px minmax(0,1fr); margin:14px 0 0; }
.http-sources :is(a,button,input,select,summary):focus-visible { outline:2px solid var(--cobalt); outline-offset:3px; }
@media (max-width:640px) {
  .http-sources .form-grid,.http-sources .capability-list { grid-template-columns:minmax(0,1fr); }
  .http-sources .section-heading { align-items:flex-start; flex-direction:column; gap:10px; }
  .http-sources .kv { grid-template-columns:minmax(0,1fr); gap:3px; }
  .http-sources .kv dd { margin-bottom:8px; }
}
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
<nav><a href="/admin">条目</a><a href="/admin/publish">发布版本</a><a href="/admin/http-sources">HTTP 源</a><a href="/">公开市场</a></nav>
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
    sourceId: string;
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
<td class="mono">${escapeHtml(entry.packageName)}<br><small>${escapeHtml(entry.sourceId)}</small></td>
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
<input type="hidden" name="packageSlug" value="${escapeHtml(input.slug)}">
<input type="hidden" name="exactVersion" value="${escapeHtml(version.version)}">
<button class="danger" type="submit">下架</button>
</form>`
    : `<form method="post" action="/admin/restore">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
<input type="hidden" name="packageName" value="${escapeHtml(input.packageName)}">
<input type="hidden" name="packageSlug" value="${escapeHtml(input.slug)}">
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

const httpSchema = (label: string, schema: unknown): string =>
  `<details><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(JSON.stringify(schema, null, 2))}</pre></details>`;

const httpDiscoveryGroups = (metadata: NormalizedPackageVersion): string => {
  const groups = [
    {
      id: "tools",
      title: "Tools",
      items: (metadata.tools ?? []).map(
        (tool) =>
          `<li class="capability-item"><strong>${escapeHtml(tool.name)}</strong><p>${escapeHtml(tool.description ?? "未提供描述")}</p>${httpSchema("输入 schema", tool.inputSchema)}${tool.outputSchema === undefined ? "" : httpSchema("输出 schema", tool.outputSchema)}</li>`,
      ),
    },
    {
      id: "skills",
      title: "Skills",
      items: (metadata.skills ?? []).map(
        (skill) =>
          `<li class="capability-item"><strong>${escapeHtml(skill.name)}</strong><p>${escapeHtml(skill.description ?? "未提供描述")}</p><code>${escapeHtml(skill.uri)}</code></li>`,
      ),
    },
    {
      id: "resources",
      title: "Resources",
      items: (metadata.resources ?? []).map(
        (resource) =>
          `<li class="capability-item"><strong>${escapeHtml(resource.name)}</strong><p>${escapeHtml(resource.description ?? "未提供描述")}</p><code>${escapeHtml(resource.uri)}</code><p>${escapeHtml(resource.mimeType ?? "未提供类型")}${resource.size === undefined ? "" : ` · ${resource.size} bytes`}</p></li>`,
      ),
    },
    {
      id: "templates",
      title: "资源模板",
      items: (metadata.resourceTemplates ?? []).map(
        (template) =>
          `<li class="capability-item"><strong>${escapeHtml(template.name)}</strong><p>${escapeHtml(template.description ?? "未提供描述")}</p><code>${escapeHtml(template.uriTemplate)}</code>${template.mimeType ? `<p>${escapeHtml(template.mimeType)}</p>` : ""}</li>`,
      ),
    },
    {
      id: "prompts",
      title: "Prompts",
      items: (metadata.prompts ?? []).map(
        (prompt) =>
          `<li class="capability-item"><strong>${escapeHtml(prompt.name)}</strong><p>${escapeHtml(prompt.description ?? "未提供描述")}</p>${prompt.arguments.length ? `<ul class="parameter-list">${prompt.arguments.map((argument) => `<li><code>${escapeHtml(argument.name)}</code> <span class="tag">${argument.required ? "必填" : "可选"}</span>${argument.description ? `<p>${escapeHtml(argument.description)}</p>` : ""}</li>`).join("")}</ul>` : `<p>无需参数</p>`}</li>`,
      ),
    },
  ];
  return `<nav class="capability-nav" aria-label="发现能力分组">${groups.map((group) => `<a class="tag ${group.items.length ? "strong" : "muted"}" href="#http-${group.id}">${group.title}：${group.items.length}</a>`).join("")}</nav>${groups.map((group) => (group.items.length ? `<section class="capability-group" id="http-${group.id}" aria-labelledby="http-${group.id}-title"><div class="section-heading"><h3 id="http-${group.id}-title">${group.title}</h3><span class="tag">${group.items.length} 项</span></div><ul class="capability-list">${group.items.join("")}</ul></section>` : `<p class="empty" id="http-${group.id}">${group.title}：未发现条目</p>`)).join("")}`;
};

export const renderHttpSources = (input: {
  csrfToken: string;
  sources: HttpSource[];
  source?: HttpSource;
  preview?: PublicationPreview & { confirmationDigest: string };
  outcome?: MutationOutcome;
  error?: string;
}): string => {
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">`;
  const source = input.source;
  const preview = input.preview;
  return layout(
    "HTTP 源",
    `<main class="http-sources">
<div class="section-heading"><div><h1>HTTP 源</h1><p class="lede">连接 MCP 服务，预览能力清单，确认后发布到连接器。</p></div><a href="/connectors" class="tag">打开连接器列表</a></div>
<p class="lede">保存定义 → 读取预览 → 确认同步</p>
${input.error ? `<div class="panel warn" role="alert"><p class="error">${escapeHtml(input.error)}</p>${source ? "<p>定义已保存，读取或同步未完成；公开版本未更改。可修改定义或重新读取预览。</p>" : ""}</div>` : ""}
${source && !input.outcome ? `<p class="source-state"><span class="tag ${source.latestPublicationId ? "strong" : "muted"}">${source.latestPublicationId ? "已发布" : "未发布"}</span> ${source.latestPublicationId ? "当前公开页面使用已确认快照；修改后需重新预览并确认同步。" : "请检查预览并确认同步，随后会显示在连接器中。"}</p>` : ""}
${input.outcome ? refreshSummary(input.outcome.refresh) + `<details class="panel"><summary>查看同步记录</summary>${changeSummary(input.outcome.change)}</details>` : ""}
<details class="panel definition" ${preview ? "" : "open"}><summary>${source ? "编辑定义" : "新增定义"}${source ? ` · ${escapeHtml(source.displayName)}` : ""}</summary>
<form method="post" action="/admin/http-sources/save">${csrf}
<input type="hidden" name="id" value="${escapeHtml(source?.id ?? "")}">
<div class="form-grid">
<label>Package name<input type="text" name="packageName" required maxlength="128" ${source ? "readonly" : ""} value="${escapeHtml(source?.packageName ?? "")}"><span class="form-note">最多 128 字符，保存后不可改名</span></label>
<label>公开展示名称<input type="text" name="displayName" required maxlength="120" value="${escapeHtml(source?.displayName ?? "")}"></label>
<label class="wide">公开 endpoint<input type="text" name="endpoint" required maxlength="1024" value="${escapeHtml(source?.endpoint ?? "")}"><span class="form-note">地址将公开，请勿包含密钥。HTTP 为明文传输，建议优先使用 HTTPS。</span></label>
<label class="wide">协议<select name="protocol"><option value="2025" ${source?.protocol !== "2026-07-28" ? "selected" : ""}>2025 Streamable HTTP（initialize）</option><option value="2026-07-28" ${source?.protocol === "2026-07-28" ? "selected" : ""}>2026-07-28（server/discover）</option></select></label>
</div><div class="actions"><button type="submit">保存并读取预览</button><span class="lede">不会自动发布</span></div></form></details>
${source && !preview ? `<form method="post" action="/admin/http-sources/preview" class="form-row">${csrf}<input type="hidden" name="id" value="${escapeHtml(source.id)}"><button class="secondary" type="submit">手动读取并预览</button></form>` : ""}
${
  preview
    ? `<section class="panel" aria-labelledby="http-preview-title">
<div class="section-heading"><div><h2 id="http-preview-title">发现结果预览</h2><p class="lede">检查以下内容，确认后公开展示到连接器。</p></div><div class="actions">
<form method="post" action="/admin/http-sources/sync">${csrf}<input type="hidden" name="id" value="${escapeHtml(preview.ref.sourceId)}"><input type="hidden" name="previewDigest" value="${escapeHtml(preview.confirmationDigest)}"><button type="submit">确认同步</button></form>
<form method="post" action="/admin/http-sources/preview">${csrf}<input type="hidden" name="id" value="${escapeHtml(preview.ref.sourceId)}"><button class="secondary" type="submit">重新读取预览</button></form></div></div>
<dl class="kv"><dt>展示名称</dt><dd>${escapeHtml(preview.metadata.displayName ?? preview.metadata.name)}</dd><dt>Package</dt><dd class="mono">${escapeHtml(preview.metadata.name)}</dd>${Object.entries(
        preview.metadata.serverInfo ?? {},
      )
        .map(
          ([key, value]) =>
            `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`,
        )
        .join(
          "",
        )}<dt>声明能力</dt><dd>${escapeHtml(Object.keys(preview.metadata.capabilities ?? {}).join(" / ") || "未声明")}</dd><dt>Endpoint</dt><dd class="mono">${escapeHtml(source?.endpoint ?? preview.metadata.servers[0]?.endpoint ?? "—")}</dd></dl>
${httpDiscoveryGroups(preview.metadata)}
<details class="technical" data-snapshot-details><summary>完整快照与校验摘要</summary><p class="lede">即将公开的完整快照；仅用于技术审查。</p><p class="mono">${escapeHtml(preview.metadataDigest)}</p><pre>${escapeHtml(JSON.stringify(preview.metadata, null, 2))}</pre></details>
<p class="lede" style="margin-top:14px">确认将重新读取；源定义或内容变化必须重新预览。相同内容不会重复生成版本。</p></section>`
    : ""
}
<section class="panel"><div class="section-heading"><h2>已保存的源</h2><a href="/admin/http-sources" class="tag">新增源</a></div>
${input.sources.length ? `<div class="table-scroll" role="region" aria-label="已保存的 HTTP 源" tabindex="0"><table><thead><tr><th scope="col">名称 / Package</th><th scope="col">Endpoint</th><th scope="col">发布状态</th><th scope="col">操作</th></tr></thead><tbody>${input.sources.map((entry) => `<tr><td><strong>${escapeHtml(entry.displayName)}</strong><br><span class="mono">${escapeHtml(entry.packageName)}</span></td><td class="mono endpoint-cell">${escapeHtml(entry.endpoint)}</td><td><span class="tag ${entry.latestPublicationId ? "strong" : "muted"}">${entry.latestPublicationId ? "已发布" : "未发布"}</span></td><td><div class="actions"><a href="/admin/http-sources?id=${encodeURIComponent(entry.id)}">管理 / 预览</a>${entry.latestPublicationId ? `<a href="/market/${escapeHtml(toPackageSlug(entry.packageName, entry.id))}">查看连接器详情</a>` : ""}</div></td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">尚未添加 HTTP 源，填写上方定义即可开始。</p>`}</section>
<details class="technical"><summary>连接范围与发布说明</summary><p class="lede">只读取服务信息及 Tools、Skills、Resources、资源模板、Prompts 清单，不执行工具或读取正文。仅支持无鉴权源。公网支持 HTTP / HTTPS（IPv4）；本地开发需设置 MCPM_HTTP_ALLOW_LOOPBACK=true，仅放行 localhost / 127.0.0.1。</p><p class="lede">endpoint 将公开，禁止放入密钥。远端 instructions 不发布；工具 schema 保存有界标准契约（包括枚举与本地引用），不包含 default、examples 或扩展字段。</p></details>
</main>`,
    input.csrfToken,
  );
};

export const renderAdminNotFound = (csrfToken: string): string =>
  layout(
    "未找到",
    `<h1>未找到</h1><p class="lede">该条目不存在。</p>`,
    csrfToken,
  );
