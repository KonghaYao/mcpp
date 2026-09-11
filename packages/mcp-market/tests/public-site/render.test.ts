/**
 * The public renderers as pure functions.
 *
 * There is no DOM library in this repository and this suite does not add one,
 * so everything provable at the string level is proven here: no script, no
 * external resource, no snapshot value in a style or attribute context, one
 * landmark per page, and the counting rules that keep a number from turning into
 * a claim the catalogue cannot back.
 */

import { describe, expect, test } from "bun:test";
import type {
  PackageSummary,
  PublicPackageDetail,
} from "../../src/catalog/service.ts";
import type { NormalizedPackageVersion } from "../../src/npm-registry/types.ts";
import {
  escapeHtml,
  renderHome,
  renderList,
  renderNotFound,
  renderPackage,
  renderSearch,
  renderUnavailable,
  renderVersion,
} from "../../src/public-site/render.ts";
import { PUBLIC_STYLES } from "../../src/public-site/styles.ts";

/** The seven tokens `src/html.ts` owns; the public site may only inherit them. */
const SHARED_TOKENS = [
  "--ink",
  "--muted",
  "--line",
  "--fog",
  "--cobalt",
  "--paper",
  "--coral",
];

/** Vocabulary the prototypes used for data this catalogue does not have. */
const UNSUPPORTED_VOCABULARY = [
  "作者",
  "热度",
  "最热",
  "评分",
  "下载量",
  "已安装",
  "免费开始",
  "立即体验",
];

const metadata = (
  overrides: Partial<NormalizedPackageVersion> = {},
): NormalizedPackageVersion => ({
  name: "acme-investment-team",
  version: "1.0.0",
  description: "投资研究专家团队",
  keywords: ["investment", "research"],
  displayName: "投资研究专家团队",
  summary: "连接市场数据，完成财报与行业研究",
  agents: [
    {
      id: "financial-analyst",
      name: "财报解读顾问",
      description: "分析财务指标",
    },
  ],
  servers: [{ id: "market-data", transport: "stdio", runtime: "node" }],
  integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  tarballUrl: null,
  unpackedSizeBytes: null,
  fileCount: null,
  deprecated: null,
  publishedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const summaryOf = (
  overrides: Partial<PackageSummary> = {},
): PackageSummary => ({
  slug: "acme-investment-team",
  sourceId: "npm",
  packageName: "acme-investment-team",
  metadata: metadata(),
  isExpertTeam: true,
  latestVersion: "1.0.0",
  publishedAt: "2026-08-02T00:00:00.000Z",
  firstPublishedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const detailOf = (
  overrides: Partial<PublicPackageDetail> = {},
): PublicPackageDetail => ({
  ...summaryOf(),
  versions: [
    {
      version: "1.0.0",
      publishedAt: "2026-08-02T00:00:00.000Z",
      firstPublishedAt: "2026-08-01T00:00:00.000Z",
      isLatest: true,
    },
    {
      version: "0.9.0",
      publishedAt: "2026-07-01T00:00:00.000Z",
      firstPublishedAt: "2026-07-01T00:00:00.000Z",
      isLatest: false,
    },
  ],
  ...overrides,
});

/** Every public page, so a shared invariant is checked against all of them. */
const allPages = (
  item: PackageSummary = summaryOf(),
): Record<string, string> => {
  const detail: PublicPackageDetail = {
    ...item,
    versions: [
      {
        version: item.latestVersion,
        publishedAt: item.publishedAt,
        firstPublishedAt: item.firstPublishedAt,
        isLatest: true,
      },
    ],
  };
  return {
    home: renderHome([item]),
    list: renderList({ items: [item], total: 1 }, "experts"),
    search: renderSearch({
      q: "investment",
      items: [item],
      limit: 24,
      offset: 0,
    }),
    package: renderPackage({ detail, homepageUrl: null }),
    version: renderVersion({
      slug: detail.slug,
      packageName: detail.packageName,
      sourceId: detail.sourceId,
      version: detail.latestVersion,
      publishedAt: detail.publishedAt,
      isLatest: true,
      metadata: detail.metadata,
      homepageUrl: null,
    }),
    notFound: renderNotFound(),
    unavailable: renderUnavailable(),
  };
};

/** Attribute-bearing tags, used to check for event handlers in any of them. */
const tagsOf = (html: string): string[] => html.match(/<[^>]*>/g) ?? [];

describe("design system", () => {
  test("inlines one stylesheet and only loads allowlisted same-origin images", () => {
    for (const [name, html] of Object.entries(allPages())) {
      expect(html.match(/<style>/g)?.length, name).toBe(1);
      expect(html, name).toContain(
        '<script src="/assets/market/search-dialog.js" defer></script>',
      );
      expect(html, name).not.toContain("<link");
      expect(html, name).not.toContain("<iframe");
      expect(html, name).not.toContain("@import");
      expect(html, name).not.toContain("url(");
      expect(html, name).not.toContain("http://");
      expect(html, name).not.toContain("https://");
      expect(html, name).not.toContain("//cdn");
      for (const image of html.matchAll(/<img[^>]+src="([^"]+)"/g))
        expect(image[1], name).toMatch(/^\/assets\/market\/[a-z0-9_]+\.webp$/);
    }
  });

  test("carries no event handler attribute on any tag", () => {
    for (const [name, html] of Object.entries(allPages())) {
      for (const tag of tagsOf(html))
        expect(tag, `${name}: ${tag}`).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });

  test("inherits the shared tokens and adds only namespaced tokens", () => {
    const defined = PUBLIC_STYLES.match(/--[a-z0-9-]+(?=\s*:)/g) ?? [];
    for (const token of SHARED_TOKENS)
      expect(
        defined.filter((candidate) => candidate === token).length,
        token,
      ).toBe(1);
    for (const token of defined) {
      if (SHARED_TOKENS.includes(token)) continue;
      expect(token.startsWith("--m-"), token).toBe(true);
    }
  });

  test("generates no text from CSS", () => {
    // A `content:"…"` would put words on the page that no snapshot contains and
    // no screen reader can be relied on to announce.
    expect(PUBLIC_STYLES).not.toMatch(/content:\s*"[^"]+"/);
  });

  test("stays inside the inline-style budget", () => {
    // The search dialog and responsive hierarchy remain within a small
    // uncompressed visual-system budget.
    expect(Buffer.byteLength(PUBLIC_STYLES)).toBeLessThanOrEqual(21 * 1024);
  });
});

describe("escaping", () => {
  const payloads = [
    "<script>alert(1)</script>",
    `"><img src=x onerror=alert(1)>`,
    "</style><style>body{display:none}</style>",
    "' onmouseover='alert(1)",
  ];

  test("a hostile snapshot cannot leave its text node", () => {
    for (const payload of payloads) {
      const item = summaryOf({
        packageName: payload,
        slug: "acme-investment-team",
        latestVersion: payload,
        sourceId: payload,
        publishedAt: payload,
        metadata: metadata({
          name: payload,
          version: payload,
          displayName: payload,
          summary: payload,
          description: payload,
          keywords: [payload],
          deprecated: payload,
          integrity: payload,
          publishedAt: payload,
          agents: [{ id: payload, name: payload, description: payload }],
          servers: [{ id: payload, transport: payload, runtime: payload }],
        }),
      });

      // The constant pages carry no data, so only the data-bearing ones can
      // show an escaping defect.
      const { notFound: _404, unavailable: _503, ...rendered } = allPages(item);
      for (const [name, html] of Object.entries(rendered)) {
        expect(html, name).not.toContain(payload);
        expect(html, name).not.toContain("<script>alert");
        expect(html, name).not.toContain("onerror=alert(1)>");
        // The hostile text survives as text, escaped by the one primitive.
        expect(html, name).toContain(escapeHtml(payload));
        for (const tag of tagsOf(html))
          expect(tag, `${name}: ${tag}`).not.toMatch(/\son[a-z]+\s*=/i);
      }
    }
  });

  test("escapes the search query in text, in an attribute and in the title", () => {
    const hostile = `</title><script>alert(1)</script>`;
    const html = renderSearch({
      q: hostile,
      items: [],
      limit: 24,
      offset: 0,
    });

    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("</title><script");
    // Title context, text context and `value="…"` context, one by one.
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
    expect(html).toContain('value="&lt;/title&gt;&lt;script&gt;');
    expect(html.match(/<title>/g)?.length).toBe(1);
  });

  test("marks up a date only when the value really is one", () => {
    const dated = renderPackage({ detail: detailOf(), homepageUrl: null });
    expect(dated).toContain('<time datetime="2026-08-02T00:00:00.000Z">');

    const undated = renderPackage({
      detail: detailOf({
        metadata: metadata({ publishedAt: "last tuesday" }),
      }),
      homepageUrl: null,
    });
    expect(undated).toContain("last tuesday");
    expect(undated).not.toContain('<time datetime="last tuesday">');
  });
});

describe("outbound links", () => {
  const detail = detailOf();

  test("renders no link at all when the homepage is not configured", () => {
    const html = renderPackage({ detail, homepageUrl: null });
    expect(html).not.toContain("在 NPM 查看");
  });

  test.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example.com/x",
    "/market/acme-investment-team",
    "not a url",
  ])("drops %s", (homepageUrl) => {
    const html = renderPackage({ detail, homepageUrl });
    expect(html).not.toContain("在 NPM 查看");
    expect(html).not.toContain('target="_blank"');
  });

  test("keeps an http(s) homepage with the hardened rel and target", () => {
    const html = renderPackage({
      detail,
      homepageUrl: "https://www.npmjs.com/package/acme-investment-team",
    });
    expect(html).toContain(
      'href="https://www.npmjs.com/package/acme-investment-team"',
    );
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });
});

describe("accessibility", () => {
  test("gives every page the same landmarks and one h1", () => {
    for (const [name, html] of Object.entries(allPages())) {
      expect(html, name).toContain('<html lang="zh-CN">');
      expect(html, name).toContain('name="viewport"');
      expect(html.match(/<h1[ >]/g)?.length, name).toBe(1);
      expect(html, name).toContain('<main id="main" tabindex="-1">');
      expect(html, name).toContain('<header class="site-header">');
      expect(html, name).toContain(
        '<nav class="site-nav" aria-label="主导航">',
      );
      expect(html, name).toContain("<footer");
    }
  });

  test("puts a skip link before everything else and points it at the main landmark", () => {
    for (const [name, html] of Object.entries(allPages())) {
      const firstLink = html.indexOf("<a ");
      expect(html.slice(firstLink, firstLink + 40), name).toContain(
        'class="skip-link" href="#main"',
      );
    }
  });

  test("renders experts and connectors as separate primary navigation pages", () => {
    const expert = summaryOf();
    const connector = summaryOf({
      slug: "connector",
      packageName: "connector",
      isExpertTeam: false,
      metadata: metadata({ displayName: "测试连接器", agents: [] }),
    });
    const page = { items: [expert, connector], total: 2 };
    const experts = renderList(page, "experts");
    const connectors = renderList(page, "connectors");

    expect(experts).toContain(
      '<a href="/experts" aria-current="page">专家</a>',
    );
    expect(experts).toContain('<a href="/connectors">连接器</a>');
    expect(experts).toContain("投资研究专家团队");
    expect(experts).not.toContain("测试连接器");

    expect(connectors).toContain('<a href="/experts">专家</a>');
    expect(connectors).toContain(
      '<a href="/connectors" aria-current="page">连接器</a>',
    );
    expect(connectors).toContain("测试连接器");
    expect(connectors).not.toContain("投资研究专家团队");

    for (const html of [experts, connectors]) {
      expect(html).not.toContain(">能力目录</a>");
      expect(html).not.toContain(
        '<a href="/search" aria-current="page">搜索</a>',
      );
    }
  });

  test("opens search from a button and renders an accessible dialog", () => {
    const html = renderHome([]);
    expect(html).toContain(
      'data-search-open aria-haspopup="dialog">搜索</button>',
    );
    expect(html).toContain(
      '<dialog class="search-dialog" data-search-dialog aria-labelledby="search-dialog-title">',
    );
    expect(html).toContain(
      '<label class="sr-only" for="market-search-input">搜索能力</label>',
    );
    expect(html).toContain('id="market-search-input"');
    expect(html).toContain('role="search"');
    expect(html).toContain('<button type="submit">搜索</button>');
  });

  test("echoes the query back into the field on the search page", () => {
    const html = renderSearch({
      q: `a & "b"`,
      items: [],
      limit: 24,
      offset: 0,
    });
    expect(html).toContain('value="a &amp; &quot;b&quot;"');
  });

  test("defines a visible focus ring, reduced motion, and no CSS-generated text", () => {
    expect(PUBLIC_STYLES).toContain(":focus-visible");
    expect(PUBLIC_STYLES).toContain("outline:2px solid var(--cobalt)");
    expect(PUBLIC_STYLES).toContain("@media (prefers-reduced-motion:reduce)");
    expect(PUBLIC_STYLES).toContain("transition:none !important");
    expect(PUBLIC_STYLES).not.toContain("outline:none");
  });

  test("hides decoration from assistive technology", () => {
    const html = renderHome([summaryOf()]);
    expect(html).toContain(
      '<img class="brand-image" src="/assets/market/img_mcpp_market_brand_icon.webp" alt=""',
    );
    expect(html).toContain('class="grid-paper" aria-hidden="true"');
    expect(html).toContain('class="card-artwork"');
    for (const tag of tagsOf(html).filter((tag) =>
      tag.includes('class="card-artwork"'),
    ))
      expect(tag).toContain('alt=""');
  });

  test("gives every table a caption and column scopes inside one scroll region", () => {
    const html = renderPackage({ detail: detailOf(), homepageUrl: null });
    expect(html.match(/<table>/g)?.length).toBe(2);
    expect(html.match(/<caption class="sr-only">/g)?.length).toBe(2);
    expect(html.match(/scope="col"/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html.match(/role="region"/g)?.length).toBe(2);
    expect(html.match(/tabindex="0"/g)?.length).toBe(2);
  });

  test("can be navigated by the native form alone", () => {
    const html = renderSearch({
      q: "investment",
      items: [],
      limit: 24,
      offset: 0,
    });
    expect(html).toContain('action="/search"');
    expect(html).toContain('method="get"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('method="post"');
  });
});

describe("honesty", () => {
  test("the search page counts only what it shows and claims no total", () => {
    const html = renderSearch({
      q: "investment",
      items: [summaryOf()],
      limit: 24,
      offset: 0,
    });
    expect(html).toContain("本页 1 条");
    expect(html).not.toMatch(/共\s*\d+\s*条/);
    expect(html).not.toContain("全部结果");
  });

  test("gives the home page the designed product hero", () => {
    const html = renderHome([]);
    expect(html).toContain("交代目标。");
    expect(html).toContain("剩下的，<span>交给它。</span>");
    expect(html).toContain('class="hero-stage"');
    expect(html).toContain("复盘报告已完成");
  });

  test("uses the designed scene artwork and separates experts from connectors", () => {
    const connector = summaryOf({
      slug: "filesystem",
      packageName: "@modelcontextprotocol/server-filesystem",
      isExpertTeam: false,
      metadata: metadata({
        displayName: "Filesystem Connector",
        agents: [],
      }),
    });
    const experts = renderList({ items: [summaryOf(), connector], total: 2 });
    const connectors = renderList(
      { items: [summaryOf(), connector], total: 2 },
      "connectors",
    );
    expect(experts).toContain("按场景找专家");
    expect(experts.match(/class="scene-card"/g)?.length).toBe(10);
    expect(experts).toContain(
      'src="/assets/market/img_investment_analysis_s03.webp"',
    );
    expect(experts).toContain("专家 <span>1</span>");
    expect(experts).not.toContain("Filesystem Connector");
    expect(connectors).toContain("连接器 <span>1</span>");
    expect(connectors).not.toContain("投资研究专家团队");
  });

  test("each category page prints only its visible category count", () => {
    const experts = Array.from({ length: 3 }, (_, index) =>
      summaryOf({ slug: `item-${index}`, packageName: `item-${index}` }),
    );
    const connector = summaryOf({
      slug: "connector",
      packageName: "connector",
      isExpertTeam: false,
      metadata: metadata({ agents: [] }),
    });
    const page = { items: [...experts, connector], total: 4 };
    const expertPage = renderList(page, "experts");
    const connectorPage = renderList(page, "connectors");
    expect(expertPage).toContain('<div class="wrap market-shell">');
    expect(expertPage).toContain("专家 <span>3</span>");
    expect(expertPage).not.toContain('class="directory-summary"');
    expect(connectorPage).toContain("连接器 <span>1</span>");
  });

  test("never mentions data the catalogue does not hold", () => {
    for (const [name, html] of Object.entries(allPages())) {
      for (const word of UNSUPPORTED_VOCABULARY)
        expect(html, `${name}: ${word}`).not.toContain(word);
    }
  });

  test("only renders the fields the snapshot actually carries", () => {
    const bare = summaryOf({
      isExpertTeam: false,
      metadata: metadata({
        displayName: null,
        summary: null,
        description: null,
        keywords: [],
        agents: [],
        servers: [],
        deprecated: null,
      }),
    });
    const html = renderPackage({
      detail: { ...bare, versions: [] },
      homepageUrl: null,
    });
    expect(html).not.toContain("专家团队成员");
    expect(html).not.toContain("MCP Server 声明");
    expect(html).not.toContain("公开版本");
    expect(html).not.toContain("deprecated");
    // A package with no servers is presented as a plain connector.
    expect(html).toContain('<span class="tag">连接器</span>');
  });

  test("says nothing about a withdrawn version", () => {
    const html = renderPackage({
      detail: detailOf({
        metadata: metadata({ deprecated: "use acme-tools" }),
      }),
      homepageUrl: null,
    });
    expect(html).toContain("deprecated：use acme-tools");
    expect(renderUnavailable()).toContain("暂时不可用");
    expect(renderUnavailable()).not.toContain("下架");
  });
});

describe("capability rig", () => {
  const rigOf = (agents: number, servers: number): string => {
    const html = renderPackage({
      detail: detailOf({
        metadata: metadata({
          agents: Array.from({ length: agents }, (_, index) => ({
            id: `agent-${index}`,
            name: `角色 ${index}`,
            description: null,
          })),
          servers: Array.from({ length: servers }, (_, index) => ({
            id: `server-${index}`,
            transport: "stdio",
            runtime: null,
          })),
        }),
      }),
      homepageUrl: null,
    });
    return /<p class="rig[^>]*">[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";
  };

  test("draws both sides when both declared members", () => {
    const rig = rigOf(2, 3);
    expect(rig).toContain("<strong>2</strong> 位专家");
    expect(rig).toContain("<strong>3</strong> 个 MCP Server");
    expect(rig).toContain('class="rig-link" aria-hidden="true"');
  });

  test("omits the side that declared nothing", () => {
    const expertsOnly = rigOf(2, 0);
    expect(expertsOnly).toContain("位专家");
    expect(expertsOnly).not.toContain("连接器");
    expect(expertsOnly).not.toContain("rig-link");

    const serversOnly = rigOf(0, 1);
    expect(serversOnly).toContain("个 MCP Server");
    expect(serversOnly).not.toContain("位专家");
  });

  test("is not rendered at all when there is nothing to connect", () => {
    expect(rigOf(0, 0)).toBe("");
  });

  test("never prints a zero", () => {
    for (const [agents, servers] of [
      [0, 0],
      [1, 0],
      [0, 2],
      [2, 2],
    ] as const) {
      const rig = rigOf(agents, servers);
      expect(rig).not.toContain("<strong>0</strong>");
      expect(rig).not.toContain("0 位专家");
      expect(rig).not.toContain("0 个 MCP Server");
    }
  });
});

describe("catalogue pagination", () => {
  const items = (count: number): PackageSummary[] =>
    Array.from({ length: count }, (_, index) =>
      summaryOf({ slug: `item-${index}`, packageName: `item-${index}` }),
    );

  /**
   * The cached catalogue document is answered for any query string, so a page
   * number there would be a control that silently does nothing. It must not be
   * offered at all.
   */
  test("offers no offset or page control on the catalogue page", () => {
    const html = renderList({ items: items(60), total: 120 });
    expect(html).not.toContain("offset=");
    expect(html).not.toContain('class="pager"');
    expect(html).not.toContain("上一页");
    expect(html).not.toContain("下一页");
    expect(html).not.toContain("limit=");
  });

  test("pages forward only while the current page came back full", () => {
    const full = renderSearch({
      q: "investment",
      items: items(24),
      limit: 24,
      offset: 0,
    });
    expect(full).toContain('rel="next"');
    expect(full).toContain('href="/search?q=investment&amp;offset=24"');
    expect(full).not.toContain('rel="prev"');

    const partial = renderSearch({
      q: "investment",
      items: items(3),
      limit: 24,
      offset: 0,
    });
    expect(partial).not.toContain('class="pager"');
  });

  test("pages back with an offset that was actually applied", () => {
    const back = renderSearch({
      q: "investment",
      items: items(3),
      limit: 24,
      offset: 24,
    });
    expect(back).toContain('rel="prev"');
    expect(back).toContain('href="/search?q=investment&amp;offset=0"');
    expect(back).not.toContain('rel="next"');
    expect(back).toContain("本页 3 条");
  });

  test("percent-encodes the query in every pager link", () => {
    const html = renderSearch({
      q: "a b&c=d",
      items: items(24),
      limit: 24,
      offset: 24,
    });
    expect(html).toContain("q=a%20b%26c%3Dd&amp;offset=48");
    expect(html).toContain("q=a%20b%26c%3Dd&amp;offset=0");
  });
});

describe("empty states", () => {
  test("renders a category-specific empty state", () => {
    const html = renderList({ items: [], total: 0 });
    expect(html).toContain("当前还没有公开的专家团队。");
    expect(html).toContain('class="section-empty"');
  });

  test("distinguishes an empty category from an empty search", () => {
    expect(renderList({ items: [], total: 0 }, "connectors")).toContain(
      "当前还没有公开的连接器。",
    );
    expect(
      renderSearch({ q: "nothing", items: [], limit: 24, offset: 0 }),
    ).toContain("没有匹配的公开条目。");
  });

  test("asks for a keyword before searching", () => {
    const blank = renderSearch({ q: "   ", items: [], limit: 24, offset: 0 });
    expect(blank).toContain("请输入关键词。");
    expect(blank).not.toContain('class="grid"');
  });
});

describe("constant pages", () => {
  test("renders the not-found page byte-for-byte identically", () => {
    expect(renderNotFound()).toBe(renderNotFound());
    expect(renderNotFound()).toContain("未找到");
  });

  test("reports an unreadable catalogue as temporary", () => {
    const html = renderUnavailable();
    expect(html).toBe(renderUnavailable());
    expect(html).toContain("暂时不可用");
    expect(html).toContain("请稍后重试");
  });
});
