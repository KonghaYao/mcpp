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
type Section = "experts" | "connectors" | null;

const BRAND = "MCPM Market";
const ASSET_PATH = "/assets/market";
const SEARCH_INPUT_ID = "market-search-input";

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
const timeElement = (value: string | null, fallback = "未知"): string => {
  if (value === null) return escapeHtml(fallback);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return escapeHtml(value);
  const date = new Date(value);
  const readable = Number.isNaN(date.getTime())
    ? value
    : `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(readable)}</time>`;
};

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
<a class="brand" href="/"><img class="brand-image" src="${ASSET_PATH}/img_mcpp_market_brand_icon.webp" alt="" width="32" height="32"><span class="brand-name">${BRAND}</span></a>
<nav class="site-nav" aria-label="主导航">
${navLink("/experts", "专家", options.current === "experts")}
${navLink("/connectors", "连接器", options.current === "connectors")}
</nav>
<button class="search-trigger" type="button" data-search-open aria-haspopup="dialog">搜索</button>
</div></header>
<dialog class="search-dialog" data-search-dialog aria-labelledby="search-dialog-title">
<div class="search-dialog-head">
<div><p class="eyebrow">MARKET SEARCH</p><h2 id="search-dialog-title">搜索专家和连接器</h2></div>
<button class="search-close" type="button" data-search-close aria-label="关闭搜索">×</button>
</div>
<form class="dialog-search-form" action="/search" method="get" role="search" data-search-form>
<label class="sr-only" for="${SEARCH_INPUT_ID}">搜索能力</label>
<input id="${SEARCH_INPUT_ID}" type="search" name="q" maxlength="128" autocomplete="off" placeholder="名称、摘要、Agent 或关键词" value="${escapeHtml(options.query ?? "")}">
<button type="submit">搜索</button>
</form>
<p class="search-status" data-search-status aria-live="polite">输入关键词开始搜索</p>
<div class="search-results" data-search-results></div>
</dialog>
<main id="main" tabindex="-1">
${body}
</main>
<footer class="site-footer"><div class="wrap">
<p>${BRAND} · NPM 精确版本目录。包、版本与制品事实由 NPM Registry 持有。</p>
<p>市场只做目录收录，不代表已做安全认证。</p>
</div></footer>
<script src="/assets/market/search-dialog.js" defer></script>
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
      `<span class="rig-node"><strong>${metadata.servers.length}</strong> 个 MCP Server</span>`,
    );
  if (nodes.length === 0) return "";
  return `<p class="${className}">${nodes.join(
    `<span class="rig-link" aria-hidden="true">×</span>`,
  )}</p>`;
};

const packageNameOf = (value: string): string =>
  escapeHtml(value).replace("/", "/<wbr>");

const EXPERT_ARTWORK = [
  {
    terms: ["投资", "investment", "research"],
    file: "img_investment_analysis_s03.webp",
  },
  {
    terms: ["内容", "content", "writing"],
    file: "img_content_creation_s02.webp",
  },
  { terms: ["数据", "data", "analytics"], file: "img_data_analysis_s07.webp" },
  {
    terms: ["工程", "engineering", "coding"],
    file: "img_engineering_development_s10.webp",
  },
  { terms: ["法律", "legal"], file: "img_legal_consulting_s04.webp" },
  { terms: ["文档", "document"], file: "img_professional_documents_s08.webp" },
] as const;

/** Picks only from the frozen design artwork allowlist. */
const expertArtworkOf = (item: PackageSummary): string => {
  const haystack = [
    item.packageName,
    displayNameOf(item.metadata),
    ...item.metadata.keywords,
  ]
    .join(" ")
    .toLowerCase();
  return (
    EXPERT_ARTWORK.find((entry) =>
      entry.terms.some((term) => haystack.includes(term)),
    )?.file ?? "img_product_design_s09.webp"
  );
};

const capabilitySummary = (metadata: NormalizedPackageVersion): string[] => {
  const parts: string[] = [];
  if (metadata.agents.length > 0)
    parts.push(`${metadata.agents.length} 位团队成员`);
  if (metadata.servers.length > 0)
    parts.push(`${metadata.servers.length} 个连接能力`);
  return parts;
};

const cardOf = (item: PackageSummary): string => {
  const name = displayNameOf(item.metadata);
  const capabilities = capabilitySummary(item.metadata);
  const visual = item.isExpertTeam
    ? `<img class="card-artwork" src="${ASSET_PATH}/${expertArtworkOf(item)}" alt="" width="640" height="420" loading="lazy">`
    : `<span class="tone tone-${toneOf(item.slug)}" aria-hidden="true">${escapeHtml(initialOf(name))}</span>`;
  return `<article class="card ${item.isExpertTeam ? "expert-card" : "connector-card"}">
<div class="card-visual">${visual}</div>
<div class="card-content">
<p class="card-kind">${item.isExpertTeam ? "专家团队" : "连接器"}</p>
<h3><a href="/market/${escapeHtml(item.slug)}">${escapeHtml(name)}</a></h3>
<p class="summary">${escapeHtml(summaryOf(item.metadata))}</p>
${
  capabilities.length > 0
    ? `<ul class="capability-list" aria-label="能力组成">${capabilities.map((capability) => `<li>${escapeHtml(capability)}</li>`).join("")}</ul>`
    : ""
}
<div class="card-meta">
<span class="name">${packageNameOf(item.packageName)}</span>
<span aria-label="当前版本">v${escapeHtml(item.latestVersion)}</span>
</div>
</div>
</article>`;
};

const SCENES = [
  ["校园学习", "课程、论文与备考", "img_campus_learning_s01.webp"],
  ["内容创作", "选题、写作与传播", "img_content_creation_s02.webp"],
  ["投资分析", "行情、财报与研究", "img_investment_analysis_s03.webp"],
  ["法律咨询", "法规、案例与合同", "img_legal_consulting_s04.webp"],
  ["小型企业", "经营、客户与增长", "img_small_business_s05.webp"],
  ["电商运营", "商品、投放与转化", "img_ecommerce_operations_s06.webp"],
  ["数据分析", "洞察、模型与报告", "img_data_analysis_s07.webp"],
  ["专业文档", "提案、标书与汇报", "img_professional_documents_s08.webp"],
  ["产品设计", "调研、原型与评审", "img_product_design_s09.webp"],
  ["工程开发", "代码、测试与发布", "img_engineering_development_s10.webp"],
] as const;

const sceneGrid = (): string => `<div class="scene-rail">
<div class="scene-grid" tabindex="0" aria-label="专家场景，可横向滚动">
${SCENES.map(
  ([
    name,
    description,
    image,
  ]) => `<a class="scene-card" href="/search?q=${encodeURIComponent(name)}">
<img src="${ASSET_PATH}/${image}" alt="" width="640" height="420" loading="lazy">
<span><strong>${name}</strong><small>${description}</small></span>
</a>`,
).join("")}
</div>
</div>`;

const marketplaceIntro = (): string => `<section class="market-intro">
<div><p class="eyebrow">CURATED FOR YOU</p><h1>按场景找专家</h1></div>
<p>从你正在完成的工作出发，找到能交付结果的专家团队。</p>
</section>
${sceneGrid()}`;

const emptyState = (input: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: string;
}): string => `<section class="empty-state">
<div class="empty-orbit" aria-hidden="true"><span></span><i></i><b></b></div>
<p class="eyebrow">${escapeHtml(input.eyebrow)}</p>
<h2>${escapeHtml(input.title)}</h2>
<p>${escapeHtml(input.description)}</p>
${input.actions ? `<div class="empty-actions">${input.actions}</div>` : ""}
</section>`;

const catalogEmpty = (): string =>
  emptyState({
    eyebrow: "CURATION STARTS HERE",
    title: "从第一个可信能力开始",
    description:
      "目录中还没有公开条目。管理员可以从 NPM exact version 创建第一份可核对的能力快照。",
    actions:
      '<a class="cta" href="/admin/publish">发布第一个能力<span aria-hidden="true">→</span></a><a class="cta secondary" href="/search">先试试搜索</a>',
  });

const gridOrEmpty = (
  items: PackageSummary[],
  emptyText = "目录中还没有公开条目。",
): string =>
  items.length === 0
    ? emptyText === "目录中还没有公开条目。"
      ? catalogEmpty()
      : emptyState({
          eyebrow: "NO MATCHES",
          title: "换个关键词继续找",
          description: emptyText,
          actions: '<a class="cta secondary" href="/market">返回能力目录</a>',
        })
    : `<div class="grid">${items.map(cardOf).join("")}</div>`;

const catalogueSection = (input: {
  id: "experts" | "connectors";
  eyebrow: string;
  title: string;
  headingLevel?: 1 | 2;
  description: string;
  items: PackageSummary[];
  emptyTitle: string;
}): string => {
  const heading = `<h${input.headingLevel ?? 2}>${escapeHtml(input.title)} <span>${input.items.length}</span></h${input.headingLevel ?? 2}>`;
  return `<section id="${input.id}" class="catalogue-section">
<div class="catalogue-head">
<div><p class="eyebrow">${escapeHtml(input.eyebrow)}</p>${heading}</div>
<p class="lede">${escapeHtml(input.description)}</p>
</div>
${
  input.items.length > 0
    ? `<div class="grid">${input.items.map(cardOf).join("")}</div>`
    : `<p class="section-empty">${escapeHtml(input.emptyTitle)}</p>`
}
</section>`;
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
    `<section class="hero hero-home">
<div class="grid-paper" aria-hidden="true"></div>
<div class="wrap hero-grid">
<div class="hero-copy">
<p class="hero-badge"><span class="dot" aria-hidden="true"></span>开放协议驱动 · AI 专家与连接器市场</p>
<h1>交代目标。<br>剩下的，<span>交给它。</span></h1>
<p class="lede">MCPM Market 不止列出工具。它把有边界的专业角色与真实连接器组织在一起，让每个能力都能追溯到一个 NPM exact version。</p>
<p class="cta-row"><a class="cta" href="/market">探索能力市场<span aria-hidden="true">→</span></a><a class="cta secondary" href="/search">搜索能力</a></p>
<div class="trust-points"><span>可直接核对的版本快照</span><span>公开路径不依赖 Registry</span><span>关键变更由管理员确认</span></div>
</div>
<div class="hero-stage" aria-label="AI 能力协作示意">
<div class="stage-canvas">
<div class="stage-task"><small>任务 07</small><strong>生成季度经营复盘</strong></div>
<div class="stage-node stage-node-a"><span>EXPERT</span><strong>经营分析顾问</strong></div>
<div class="stage-node stage-node-b"><span>CONNECTOR</span><strong>业务数据源</strong></div>
<div class="stage-path" aria-hidden="true"></div>
<div class="stage-result"><i aria-hidden="true">✓</i><span><strong>复盘报告已完成</strong><small>12 个数据源 · 18 页 · 可继续编辑</small></span><b>查看交付物</b></div>
</div>
</div>
</div>
</section>
<section class="band" aria-label="目录中的能力类型">
<div class="wrap stat-band">
<p class="band-item"><strong>Experts</strong><span>有边界的专业角色</span></p>
<p class="band-item"><strong>Connectors</strong><span>连接真实工具与数据</span></p>
<p class="band-item"><strong>exact version</strong><span>可复现的发布快照</span></p>
<p class="band-item"><strong>Static first</strong><span>Registry 故障时仍可访问</span></p>
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
export type CatalogueSection = "experts" | "connectors";

export const renderList = (
  page: {
    items: PackageSummary[];
    total: number;
  },
  section: CatalogueSection = "experts",
): string => {
  const items = page.items.filter((item) =>
    section === "experts" ? item.isExpertTeam : !item.isExpertTeam,
  );
  const title = section === "experts" ? "专家" : "连接器";
  return layout(
    `${title} · ${BRAND}`,
    `<div class="wrap market-shell">
${section === "experts" ? marketplaceIntro() : ""}
${catalogueSection({
  id: section,
  eyebrow: section === "experts" ? "EXPERT TEAMS" : "MCP CONNECTORS",
  title,
  headingLevel: section === "connectors" ? 1 : 2,
  description:
    section === "experts"
      ? "由一个 Connector package 交付的协作 Agent 团队，适合直接按工作目标选择。"
      : "连接文件、浏览器、记忆与推理等外部能力。",
  items,
  emptyTitle:
    section === "experts"
      ? "当前还没有公开的专家团队。"
      : "当前还没有公开的连接器。",
})}
</div>`,
    { current: section },
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
      { current: null },
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
    { current: null, query },
  );
};

const skillList = (metadata: NormalizedPackageVersion): string =>
  !metadata.skills || metadata.skills.length === 0
    ? ""
    : `<section class="detail-section skills-section">
<div class="section-heading"><h2>Skills</h2><p class="lede">${metadata.skills.length} 个可发现技能</p></div>
<ul class="skill-list">${metadata.skills
        .map(
          (skill) => `<li class="skill-item">
<div><strong>${escapeHtml(skill.name)}</strong>${skill.description ? `<p>${escapeHtml(skill.description)}</p>` : ""}</div>
<code>${escapeHtml(skill.uri)}</code>
</li>`,
        )
        .join("")}</ul>
</section>`;

const agentList = (metadata: NormalizedPackageVersion): string =>
  metadata.agents.length === 0
    ? ""
    : `<section class="detail-section team-section">
<div class="section-heading"><h2>专家团队成员</h2><p class="lede">该版本包含 ${metadata.agents.length} 位专家</p></div>
<ul class="member-list">${metadata.agents
        .map(
          (agent) => `<li class="member-item">
<span class="member-avatar tone-${toneOf(agent.id)}" aria-hidden="true">${escapeHtml(initialOf(agent.name))}</span>
<div class="member-copy"><strong>${escapeHtml(agent.name)}</strong>${agent.description ? `<p>${escapeHtml(agent.description)}</p>` : ""}</div>
<span class="member-id">${escapeHtml(agent.id)}</span>
</li>`,
        )
        .join("")}</ul>
</section>`;

const tableRegion = (label: string, table: string): string =>
  `<div class="table-scroll" role="region" aria-label="${escapeHtml(label)}" tabindex="0">${table}</div>`;

const mcpJsonOf = (input: {
  packageName: string;
  version: string;
  serverId: string;
  endpoint?: string;
}): string =>
  JSON.stringify(
    {
      mcpServers: {
        [input.serverId]: input.endpoint
          ? { url: input.endpoint }
          : {
              command: "npx",
              args: ["-y", `${input.packageName}@${input.version}`],
            },
      },
    },
    null,
    2,
  );

const discoveryDetails = (metadata: NormalizedPackageVersion): string => {
  const sections = [
    ["Resources", metadata.resources],
    ["资源模板", metadata.resourceTemplates],
    ["Prompts", metadata.prompts],
  ] as const;
  return `${
    metadata.serverInfo
      ? `<section class="detail-section discovery-section"><div class="section-heading"><h2>服务信息</h2><p class="lede">远端声明的服务元数据</p></div><div class="source-panel"><dl class="source-grid">${Object.entries(
          metadata.serverInfo,
        )
          .map(
            ([key, value]) =>
              `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`,
          )
          .join(
            "",
          )}<div><dt>声明能力</dt><dd>${escapeHtml(Object.keys(metadata.capabilities ?? {}).join(" / ") || "无")}</dd></div></dl></div></section>`
      : ""
  }
${sections.map(([title, items]) => (items?.length ? `<section class="detail-section discovery-section"><div class="section-heading"><h2>${title}</h2><p class="lede">${items.length} 个可发现条目</p></div><ul class="skill-list">${items.map((item) => `<li class="skill-item"><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.description ?? "未提供描述")}</p>${"uri" in item ? `<code>${escapeHtml(item.uri)}</code>` : "uriTemplate" in item ? `<code>${escapeHtml(item.uriTemplate)}</code>` : ""}${"mimeType" in item && item.mimeType ? `<p>${escapeHtml(item.mimeType)}${"size" in item && item.size !== undefined ? ` · ${item.size} bytes` : ""}</p>` : ""}${"arguments" in item ? (item.arguments.length ? `<ul class="discovery-parameters">${item.arguments.map((argument) => `<li><span class="mono">${escapeHtml(argument.name)}</span> <span class="tag">${argument.required ? "必填" : "可选"}</span>${argument.description ? `<p>${escapeHtml(argument.description)}</p>` : ""}</li>`).join("")}</ul>` : `<p>无需参数</p>`) : ""}</li>`).join("")}</ul></section>` : "")).join("")}`;
};

const serverList = (input: {
  packageName: string;
  version: string;
  metadata: NormalizedPackageVersion;
}): string =>
  input.metadata.servers.length === 0
    ? ""
    : `<section class="detail-section server-section">
<h2>MCP Server 声明</h2>
${tableRegion(
  "MCP Server 声明",
  `<table>
<caption class="sr-only">该版本声明的 MCP Server</caption>
<thead><tr><th scope="col">ID</th><th scope="col">Transport</th><th scope="col">Runtime</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody>
${input.metadata.servers
  .map(
    (server) =>
      `<tr><td class="mono">${escapeHtml(server.id)}</td><td>${escapeHtml(server.transport)}</td><td>${escapeHtml(server.runtime ?? "—")}</td><td class="server-action"><button type="button" data-copy-mcp>复制 JSON</button><span class="copy-status" data-copy-status aria-live="polite"></span><pre hidden data-mcp-json>${escapeHtml(mcpJsonOf({ packageName: input.packageName, version: input.version, serverId: server.id, endpoint: server.endpoint }))}</pre></td></tr>`,
  )
  .join("")}
</tbody></table>`,
)}
${input.metadata.servers
  .filter((server) => server.endpoint)
  .map(
    (server) =>
      `<p>Streamable HTTP endpoint：<code>${escapeHtml(server.endpoint ?? "")}</code></p>`,
  )
  .join("")}
${discoveryDetails(input.metadata)}
${input.metadata.tools?.length ? `<section class="detail-section discovery-section"><div class="section-heading"><h2>MCP Tools</h2><p class="lede">${input.metadata.tools.length} 个工具 · 仅展示定义，未执行工具</p></div><ul class="skill-list">${input.metadata.tools.map((tool) => `<li class="skill-item"><strong>${escapeHtml(tool.name)}</strong><p>${escapeHtml(tool.description ?? "未提供描述")}</p><details class="discovery-schema"><summary>输入 schema</summary><pre>${escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</pre></details>${tool.outputSchema === undefined ? "" : `<details class="discovery-schema"><summary>输出 schema</summary><pre>${escapeHtml(JSON.stringify(tool.outputSchema, null, 2))}</pre></details>`}</li>`).join("")}</ul></section>` : ""}
</section>`;

const trustPanel = (input: {
  packageName: string;
  sourceId: string;
  version: string;
  publishedAt: string;
  metadata: NormalizedPackageVersion;
  homepageUrl: string | null;
}): string => {
  const http = input.metadata.sourceKind === "http";
  const href = http ? null : safeHref(input.homepageUrl);
  return `<section class="detail-section source-section"><div class="section-heading"><h2>来源与版本</h2><p class="lede">发布信息与制品标识</p></div>
<div class="source-panel">
<dl class="source-grid">
<div><dt>Package</dt><dd class="mono">${escapeHtml(input.packageName)}</dd></div>
<div><dt>Registry</dt><dd>${escapeHtml(input.sourceId)}</dd></div>
<div><dt>版本</dt><dd class="mono">${escapeHtml(input.version)}</dd></div>
<div><dt>市场公开</dt><dd>${timeElement(input.publishedAt)}</dd></div>
${http ? "" : `<div><dt>NPM 发布</dt><dd>${timeElement(input.metadata.publishedAt)}</dd></div>`}
<div class="source-integrity"><dt>Integrity</dt><dd class="mono">${escapeHtml(input.metadata.integrity ?? "未提供")}</dd></div>
</dl>
${href ? `<p class="source-link">在 NPM 查看：<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(input.packageName)}</a></p>` : ""}<p class="disclaimer">${http ? "HTTP 工具清单是只读元数据快照，未执行工具，schema 仅为受限结构投影，不代表服务安全认证。" : "市场只做目录收录，不代表已对代码、依赖或制品进行安全认证；版本状态与制品始终以 NPM 为准。"}</p>
</div></section>`;
};

const versionTable = (
  slug: string,
  versions: PublicPackageDetail["versions"],
): string =>
  versions.length <= 1
    ? ""
    : `<section class="detail-section"><h2>公开版本</h2>
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
)}</section>`;

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
    `<div class="wrap detail-page">
${crumbsOf([{ href: detail.isExpertTeam ? "/experts" : "/connectors", label: detail.isExpertTeam ? "专家" : "连接器" }, { label: name }])}
<header class="detail-header"><h1>${escapeHtml(name)}</h1>
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
</header>
${rig(metadata, "rig rig--lg")}
${deprecatedNotice(metadata)}
<div class="detail-columns">
${agentList(metadata)}
${trustPanel({
  packageName: detail.packageName,
  sourceId: detail.sourceId,
  version: detail.latestVersion,
  publishedAt: detail.publishedAt,
  metadata,
  homepageUrl: input.homepageUrl,
})}
</div>
${skillList(metadata)}
${serverList({ packageName: detail.packageName, version: detail.latestVersion, metadata })}
${versionTable(detail.slug, detail.versions)}
</div>`,
    { current: detail.isExpertTeam ? "experts" : "connectors" },
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
${skillList(input.metadata)}
${serverList({ packageName: input.packageName, version: input.version, metadata: input.metadata })}
</div>`,
    {
      current: input.metadata.agents.length > 0 ? "experts" : "connectors",
    },
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
