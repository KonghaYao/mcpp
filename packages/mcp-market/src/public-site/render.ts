/**
 * Server-rendered HTML for the anonymous Public Market.
 *
 * Every value that originates from a Registry snapshot is escaped on the way
 * out. Nothing from a snapshot is ever interpolated into a URL, an attribute
 * context, or a `<style>`/`<script>` block, so a hostile `description` or
 * `keywords` entry cannot execute or escape its text node.
 *
 * The pages are also the whole interaction model: links and native GET forms
 * only, no script, no external stylesheet, no image. The design system lives in
 * `./styles.ts` and the document skeleton is produced by {@link layout}, so the
 * seven renderers below cannot disagree about the chrome.
 *
 * Two rules keep the surface honest, because a catalogue that dresses up its
 * data is worse than a plain one:
 *
 * - Only projected fields are rendered. There is no author, heat, rating,
 *   installation state or scenario taxonomy in the catalogue, so none appears.
 * - A count is only printed when the number behind it is known. The catalogue
 *   page prints the real total; the search page prints "本页 N 条" and never
 *   claims a total it cannot compute.
 */

import type {
  PackageSummary,
  PublicPackageDetail,
} from "../catalog/service.ts";
import { escapeHtml, safeHref } from "../html.ts";
import type { NormalizedPackageVersion } from "../npm-registry/types.ts";
import { PUBLIC_STYLES } from "./styles.ts";

export { escapeHtml, safeHref };

/** Which primary nav entry the document being rendered belongs to. */
type Section = "market" | "search" | null;

const BRAND = "MCPM Market";
const SEARCH_INPUT_ID = "site-search";
const CHIP_LIMIT = 8;
const CHIP_MAX_LENGTH = 24;

const displayNameOf = (metadata: NormalizedPackageVersion): string =>
  metadata.displayName ?? metadata.name;

const summaryOf = (metadata: NormalizedPackageVersion): string =>
  metadata.summary ?? metadata.description ?? "暂无摘要。";

/**
 * The first code point of a name, for the decorative monogram.
 *
 * Iterating the string rather than indexing it keeps a surrogate pair whole, so
 * an emoji or an astral character cannot be cut in half.
 */
const initialOf = (value: string): string => [...value][0] ?? "?";

/**
 * A stable bucket for a slug, used to pick one of the frozen `.tone-*` classes.
 *
 * Only the class name is derived from data — never a colour, never a style
 * attribute — so a hostile slug cannot reach a style context.
 */
const toneOf = (slug: string): number => {
  let hash = 0;
  for (const character of slug)
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 6;
  return hash;
};

/**
 * A machine-readable time element, but only when the value actually is one.
 *
 * `datetime` is only emitted for an ISO-like timestamp; anything else is
 * rendered as the plain text the Registry published, rather than being dressed
 * up as a date it may not be.
 */
const timeElement = (value: string | null, fallback = "未知"): string =>
  value === null
    ? escapeHtml(fallback)
    : /^\d{4}-\d{2}-\d{2}T/.test(value)
      ? `<time datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>`
      : escapeHtml(value);

const navLink = (href: string, label: string, current: boolean): string =>
  `<a href="${href}"${current ? ` aria-current="page"` : ""}>${label}</a>`;

/**
 * The document skeleton: skip link, brand, primary nav, the one search entry
 * point and the footer.
 *
 * `current` marks the active nav entry for assistive technology. `query`
 * echoes a search term back into the header field, which is what makes the
 * search page usable with no script at all: the form is a plain GET form.
 */
const layout = (
  title: string,
  body: string,
  options: { current?: Section; query?: string } = {},
): string =>
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PUBLIC_STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main">跳到主要内容</a>
<header class="site-header"><div class="wrap">
<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">M</span><span class="brand-name">${BRAND}</span></a>
<nav class="site-nav" aria-label="主导航">
${navLink("/market", "能力目录", options.current === "market")}
${navLink("/search", "搜索", options.current === "search")}
</nav>
<form class="site-search" action="/search" method="get" role="search">
<label class="sr-only" for="${SEARCH_INPUT_ID}">搜索能力</label>
<input id="${SEARCH_INPUT_ID}" type="search" name="q" maxlength="128" placeholder="名称、摘要、Agent 或关键词" value="${escapeHtml(options.query ?? "")}">
<button type="submit">搜索</button>
</form>
</div></header>
<main id="main" tabindex="-1">
${body}
</main>
<footer class="site-footer"><div class="wrap">
<p>${BRAND} · NPM 精确版本目录。包、版本与制品事实由 NPM Registry 持有。</p>
<p>市场只做目录收录，不代表已做安全认证。</p>
</div></footer>
</body>
</html>
`;

/**
 * The capability rig: experts and connectors on one track.
 *
 * It is drawn from real topology (`metadata.agents` / `metadata.servers`) and
 * only appears on the sides that actually declared members, so it can never
 * print a zero the snapshot does not mean. The track and the junction are
 * decoration and are hidden from assistive technology; the counts are the text.
 */
const rig = (metadata: NormalizedPackageVersion, className = "rig"): string => {
  const nodes: string[] = [];
  if (metadata.agents.length > 0)
    nodes.push(
      `<span class="rig-node"><strong>${metadata.agents.length}</strong> 位专家</span>`,
    );
  if (metadata.servers.length > 0)
    nodes.push(
      `<span class="rig-node"><strong>${metadata.servers.length}</strong> 个连接器</span>`,
    );
  if (nodes.length === 0) return "";
  return `<p class="${className}">${nodes.join(
    `<span class="rig-link" aria-hidden="true">×</span>`,
  )}</p>`;
};

const cardOf = (item: PackageSummary): string => {
  const name = displayNameOf(item.metadata);
  const tags = item.metadata.keywords
    .slice(0, 4)
    .map((keyword) => `<span class="tag">${escapeHtml(keyword)}</span>`)
    .join("");
  const rigged = rig(item.metadata);
  return `<article class="card">
<div class="card-head">
<span class="tone tone-${toneOf(item.slug)}" aria-hidden="true">${escapeHtml(initialOf(name))}</span>
<div class="body">
<h3><a href="/market/${escapeHtml(item.slug)}">${escapeHtml(name)}</a></h3>
<span class="name">${escapeHtml(item.packageName)}</span>
</div>
</div>
<p class="summary">${escapeHtml(summaryOf(item.metadata))}</p>
${rigged}
<div class="meta-row">
${item.isExpertTeam ? `<span class="tag strong">专家团队</span>` : `<span class="tag">连接器</span>`}
<span class="tag">v${escapeHtml(item.latestVersion)}</span>
${tags}
</div>
</article>`;
};

const gridOrEmpty = (
  items: PackageSummary[],
  emptyText = "目录中还没有公开条目。",
): string =>
  items.length === 0
    ? `<p class="empty">${escapeHtml(emptyText)}</p>`
    : `<div class="grid">${items.map(cardOf).join("")}</div>`;

/**
 * Keywords that are actually present on this page, most frequent first.
 *
 * They are search entries, not a taxonomy: the catalogue stores keywords, not
 * categories, so the row is labelled as page content and every chip links to
 * the dynamic search that answers it.
 */
const keywordChips = (items: PackageSummary[]): string => {
  const counts = new Map<string, { label: string; count: number }>();
  for (const item of items) {
    for (const keyword of item.metadata.keywords) {
      const label = keyword.trim();
      if (label.length === 0 || label.length > CHIP_MAX_LENGTH) continue;
      const key = label.toLowerCase();
      const seen = counts.get(key);
      if (seen) seen.count += 1;
      else counts.set(key, { label, count: 1 });
    }
  }
  const top = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, CHIP_LIMIT);
  if (top.length === 0) return "";
  return `<div class="chips">
<p class="chips-label">本页关键词</p>
${top
  .map(
    (entry) =>
      `<a class="tag" href="/search?q=${encodeURIComponent(entry.label)}">${escapeHtml(entry.label)}</a>`,
  )
  .join("")}
</div>`;
};

/** Breadcrumbs. Every href is escaped here, at the one place that writes it. */
const crumbsOf = (parts: { href?: string; label: string }[]): string =>
  `<nav class="crumbs" aria-label="面包屑">${parts
    .map(
      (part, index) =>
        `${index === 0 ? "" : `<span class="sep" aria-hidden="true">/</span>`}${
          part.href
            ? `<a href="${escapeHtml(part.href)}">${escapeHtml(part.label)}</a>`
            : `<span>${escapeHtml(part.label)}</span>`
        }`,
    )
    .join("")}</nav>`;

export const renderHome = (items: PackageSummary[]): string =>
  layout(
    `${BRAND} · NPM 精确版本目录`,
    `<section class="hero">
<div class="grid-paper" aria-hidden="true"></div>
<div class="wrap">
<p class="hero-badge"><span class="dot" aria-hidden="true"></span>管理员策展 · exact version 快照</p>
<h1>让 AI 使用真实工具与数据</h1>
<p class="lede">这里收录管理员从 NPM 精选并公开发布的版本。每个条目展示某个 exact version 的元数据快照，代码与制品始终由 NPM 持有。</p>
<p class="cta-row"><a class="cta" href="/market">浏览能力目录<span aria-hidden="true">→</span></a><a class="cta secondary" href="/search">搜索能力</a></p>
</div>
</section>
<section class="band" aria-label="目录中的能力类型">
<div class="wrap">
<p class="band-item"><strong>专家</strong><span>有边界的专业角色，由快照的 agents 声明</span></p>
<p class="band-item"><strong>连接器</strong><span>由快照声明的 MCP Server 连接真实工具与数据</span></p>
<p class="band-item"><strong>exact version</strong><span>每个条目对应一个已发布的精确版本</span></p>
</div>
</section>
<section class="section"><div class="wrap">
<h2>目录如何工作</h2>
<div class="steps">
<article class="step"><span class="step-no">STEP 01</span><h3>策展收录</h3><p>管理员在控制台预览某个 package 的 exact version，确认后再发布到市场。</p></article>
<article class="step"><span class="step-no">STEP 02</span><h3>写入静态页</h3><p>发布后市场把该版本渲染成静态页面并落盘。访客读取页面时不再访问 NPM Registry。</p></article>
<article class="step"><span class="step-no">STEP 03</span><h3>浏览与核对</h3><p>访客按能力目录浏览或用动态搜索查找，页面展示来源、公开时间与 integrity。</p></article>
</div>
</div></section>
<section class="section"><div class="wrap">
<h2>最近公开</h2>
<p class="lede">按市场公开时间倒序的最新公开条目。</p>
${gridOrEmpty(items)}
</div></section>
<section class="section"><div class="wrap">
<h2>浏览全部能力</h2>
<p class="lede">能力目录列出全部公开条目，每个 package 只展示一个当前版本。</p>
<p class="cta-row"><a class="cta" href="/market">进入能力目录<span aria-hidden="true">→</span></a></p>
</div></section>`,
  );

/**
 * The catalogue page.
 *
 * It carries no pager and no `offset` control on purpose. The page is a
 * pre-rendered cache, so a page number in the URL would be answered with the
 * same document every time — a control that silently does nothing. The real
 * total is printed because the catalogue actually counts it; when the cache
 * holds fewer entries than the catalogue, the page says so instead of implying
 * that what it shows is everything.
 */
export const renderList = (page: {
  items: PackageSummary[];
  total: number;
}): string => {
  const shown = page.items.length;
  const countText =
    page.total > shown
      ? `共 ${page.total} 个公开条目，每个 package 只展示一个当前版本。本页列出 ${shown} 条，其余条目可用搜索按名称查找。`
      : `共 ${page.total} 个公开条目，每个 package 只展示一个当前版本。`;
  return layout(
    `能力目录 · ${BRAND}`,
    `<div class="wrap">
<h1>能力目录</h1>
<p class="lede">${countText}</p>
${keywordChips(page.items)}
${gridOrEmpty(page.items)}
</div>`,
    { current: "market" },
  );
};

/**
 * Search results.
 *
 * The catalogue search returns the rows it found, not how many exist, so the
 * page states "本页 N 条" and nothing about a total. Paging is therefore driven
 * by what is observable: a previous page exists once an offset was applied, and
 * a next page may exist while the current page came back full.
 */
const searchPager = (
  query: string,
  limit: number,
  offset: number,
  shown: number,
): string => {
  const href = (next: number): string =>
    escapeHtml(`/search?q=${encodeURIComponent(query)}&offset=${next}`);
  const links: string[] = [];
  if (offset > 0)
    links.push(
      `<a rel="prev" href="${href(Math.max(0, offset - limit))}">← 上一页</a>`,
    );
  if (shown >= limit)
    links.push(`<a rel="next" href="${href(offset + limit)}">下一页 →</a>`);
  return links.length === 0
    ? ""
    : `<nav class="pager" aria-label="搜索结果分页">${links.join("")}</nav>`;
};

export const renderSearch = (input: {
  q: string;
  items: PackageSummary[];
  limit: number;
  offset: number;
}): string => {
  const query = input.q.trim();
  if (query.length === 0)
    return layout(
      `搜索 · ${BRAND}`,
      `<div class="wrap">
<h1>搜索</h1>
<p class="lede">按名称、摘要、Agent 或关键词检索能力目录中的公开条目。</p>
<p class="empty">请输入关键词。</p>
</div>`,
      { current: "search" },
    );

  const shown = input.items.length;
  return layout(
    `${query} · 搜索 · ${BRAND}`,
    `<div class="wrap">
<h1>搜索</h1>
<p class="lede">“${escapeHtml(query)}” 的搜索结果：本页 ${shown} 条。搜索是实时查询，只统计本页返回的条目。</p>
${gridOrEmpty(input.items, "没有匹配的公开条目。")}
${searchPager(query, input.limit, input.offset, shown)}
</div>`,
    { current: "search", query },
  );
};

const agentList = (metadata: NormalizedPackageVersion): string =>
  metadata.agents.length === 0
    ? ""
    : `<h2>专家团队成员</h2>
<p class="lede">以下角色由该 exact version 的快照声明。</p>
<div class="grid">${metadata.agents
        .map(
          (agent) => `<article class="card">
<div class="card-head">
<span class="tone tone-${toneOf(agent.id)}" aria-hidden="true">${escapeHtml(initialOf(agent.name))}</span>
<div class="body">
<h3>${escapeHtml(agent.name)}</h3>
<span class="name">${escapeHtml(agent.id)}</span>
</div>
</div>
${agent.description ? `<p class="summary">${escapeHtml(agent.description)}</p>` : ""}
</article>`,
        )
        .join("")}</div>`;

const tableRegion = (label: string, table: string): string =>
  `<div class="table-scroll" role="region" aria-label="${escapeHtml(label)}" tabindex="0">${table}</div>`;

const serverList = (metadata: NormalizedPackageVersion): string =>
  metadata.servers.length === 0
    ? ""
    : `<h2>MCP Server 声明</h2>
${tableRegion(
  "MCP Server 声明",
  `<table>
<caption class="sr-only">该版本声明的 MCP Server</caption>
<thead><tr><th scope="col">ID</th><th scope="col">Transport</th><th scope="col">Runtime</th></tr></thead><tbody>
${metadata.servers
  .map(
    (server) =>
      `<tr><td class="mono">${escapeHtml(server.id)}</td><td>${escapeHtml(server.transport)}</td><td>${escapeHtml(server.runtime ?? "—")}</td></tr>`,
  )
  .join("")}
</tbody></table>`,
)}`;

const trustPanel = (input: {
  packageName: string;
  sourceId: string;
  version: string;
  publishedAt: string;
  metadata: NormalizedPackageVersion;
  homepageUrl: string | null;
}): string => {
  const href = safeHref(input.homepageUrl);
  return `<h2>来源与版本</h2>
<div class="panel">
<dl class="kv">
<dt>Package</dt><dd class="mono">${escapeHtml(input.packageName)}</dd>
<dt>Registry</dt><dd>${escapeHtml(input.sourceId)}</dd>
<dt>Exact version</dt><dd class="mono">${escapeHtml(input.version)}</dd>
<dt>市场公开时间</dt><dd>${timeElement(input.publishedAt)}</dd>
<dt>NPM 发布时间</dt><dd>${timeElement(input.metadata.publishedAt)}</dd>
<dt>Integrity</dt><dd class="mono">${escapeHtml(input.metadata.integrity ?? "未提供")}</dd>
</dl>
${href ? `<p class="disclaimer">在 NPM 查看：<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(input.packageName)}</a></p>` : ""}<p class="disclaimer">市场只做目录收录，不代表已对代码、依赖或制品进行安全认证；版本状态与制品始终以 NPM 为准。</p>
</div>`;
};

const versionTable = (
  slug: string,
  versions: PublicPackageDetail["versions"],
): string =>
  versions.length <= 1
    ? ""
    : `<h2>公开版本</h2>
${tableRegion(
  "公开版本",
  `<table>
<caption class="sr-only">该 package 在市场中可见的版本</caption>
<thead><tr><th scope="col">版本</th><th scope="col">市场公开时间</th><th scope="col">状态</th></tr></thead><tbody>
${versions
  .map(
    (version) => `<tr>
<td class="mono"><a href="/market/${escapeHtml(slug)}/v/${encodeURIComponent(version.version)}">${escapeHtml(version.version)}</a></td>
<td>${timeElement(version.publishedAt)}</td>
<td>${version.isLatest ? `<span class="tag strong">latest</span>` : ""}</td>
</tr>`,
  )
  .join("")}
</tbody></table>`,
)}`;

const deprecatedNotice = (metadata: NormalizedPackageVersion): string =>
  metadata.deprecated === null
    ? ""
    : `<p class="notice">NPM 已标记该版本为 deprecated：${escapeHtml(metadata.deprecated)}</p>`;

export const renderPackage = (input: {
  detail: PublicPackageDetail;
  homepageUrl: string | null;
}): string => {
  const { detail } = input;
  const metadata = detail.metadata;
  const name = displayNameOf(metadata);
  return layout(
    `${name} · ${BRAND}`,
    `<div class="wrap">
${crumbsOf([{ href: "/market", label: "能力目录" }, { label: name }])}
<h1>${escapeHtml(name)}</h1>
<p class="lede">${escapeHtml(summaryOf(metadata))}</p>
<div class="meta-row">
${
  detail.isExpertTeam
    ? `<span class="tag strong">专家团队</span>`
    : `<span class="tag">连接器</span>`
}
<span class="tag">latest v${escapeHtml(detail.latestVersion)}</span>
${metadata.keywords.map((k) => `<span class="tag">${escapeHtml(k)}</span>`).join("")}
</div>
${rig(metadata, "rig rig--lg")}
${deprecatedNotice(metadata)}
${trustPanel({
  packageName: detail.packageName,
  sourceId: detail.sourceId,
  version: detail.latestVersion,
  publishedAt: detail.publishedAt,
  metadata,
  homepageUrl: input.homepageUrl,
})}
${agentList(metadata)}
${serverList(metadata)}
${versionTable(detail.slug, detail.versions)}
</div>`,
    { current: "market" },
  );
};

export const renderVersion = (input: {
  slug: string;
  packageName: string;
  sourceId: string;
  version: string;
  publishedAt: string;
  isLatest: boolean;
  metadata: NormalizedPackageVersion;
  homepageUrl: string | null;
}): string =>
  layout(
    `${displayNameOf(input.metadata)} ${input.version} · ${BRAND}`,
    `<div class="wrap">
${crumbsOf([
  { href: "/market", label: "能力目录" },
  { href: `/market/${input.slug}`, label: displayNameOf(input.metadata) },
  { label: input.version },
])}
<h1>${escapeHtml(displayNameOf(input.metadata))} <span class="mono">${escapeHtml(input.version)}</span></h1>
<p class="lede">${escapeHtml(summaryOf(input.metadata))}</p>
<div class="meta-row">
${
  input.isLatest
    ? `<span class="tag strong">当前 latest</span>`
    : `<span class="tag">历史版本</span>`
}
${
  input.metadata.agents.length > 0
    ? `<span class="tag strong">专家团队</span>`
    : `<span class="tag">连接器</span>`
}
</div>
${rig(input.metadata, "rig rig--lg")}
${deprecatedNotice(input.metadata)}
${trustPanel(input)}
${agentList(input.metadata)}
${serverList(input.metadata)}
</div>`,
    { current: "market" },
  );

export const renderNotFound = (): string =>
  layout(
    `未找到 · ${BRAND}`,
    `<div class="wrap">
<h1>未找到</h1>
<p class="lede">该内容不存在或已从市场下架。</p>
<p class="lede"><a href="/market">返回能力目录</a></p>
</div>`,
  );

/**
 * Shown when the catalogue cannot be read and no page was ever written. It is a
 * temporary failure, not a missing package, so it must not be rendered as 404.
 */
export const renderUnavailable = (): string =>
  layout(
    `暂时不可用 · ${BRAND}`,
    `<div class="wrap">
<h1>暂时不可用</h1>
<p class="lede">目录数据暂时无法读取，请稍后重试。</p>
</div>`,
  );
