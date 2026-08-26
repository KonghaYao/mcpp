import { renderReadme } from "./readme.ts";

export type RegistryPackage = {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  date?: string;
  publisher?: string;
};

type SearchResult = { objects?: Array<{ package?: Record<string, unknown> }> };
type PackageRecord = Record<string, unknown>;

function projectPackage(item: PackageRecord): RegistryPackage | undefined {
  if (typeof item.name !== "string") return undefined;
  const distTags = item["dist-tags"];
  const latest = distTags && typeof distTags === "object" && "latest" in distTags
    ? (distTags as { latest: unknown }).latest : undefined;
  const version = typeof item.version === "string" ? item.version : typeof latest === "string" ? latest : undefined;
  if (!version) return undefined;
  const keywords = Array.isArray(item.keywords) ? item.keywords.filter((word): word is string => typeof word === "string") : [];
  if (!keywords.includes("mcp-plugin")) return undefined;
  const publisher = item.publisher && typeof item.publisher === "object" && "username" in item.publisher
    ? String((item.publisher as { username: unknown }).username) : undefined;
  const time = item.time && typeof item.time === "object" && "modified" in item.time
    ? String((item.time as { modified: unknown }).modified) : undefined;
  return { name: item.name, version, description: typeof item.description === "string" ? item.description : "", keywords, date: typeof item.date === "string" ? item.date : time, publisher };
}

export function projectSearch(value: unknown): RegistryPackage[] {
  const objects = (value as SearchResult)?.objects;
  if (!Array.isArray(objects)) return [];
  return objects.flatMap(({ package: item }) => item ? [projectPackage(item)].filter((entry): entry is RegistryPackage => Boolean(entry)) : []);
}

export function projectCatalog(value: unknown): RegistryPackage[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([name]) => name !== "_updated")
    .flatMap(([, item]) => item && typeof item === "object" ? [projectPackage(item as PackageRecord)].filter((entry): entry is RegistryPackage => Boolean(entry)) : []);
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class NpmStore {
  private readonly listCache = new Map<string, { expiresAt: number; value: RegistryPackage[] }>();
  private readonly detailCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();

  constructor(
    private readonly sourceUrl: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly cacheTtlMs = 30_000,
  ) {}
  private url(path: string) { return new URL(path, this.sourceUrl).toString(); }
  async list(text = "") {
    const search = text.trim();
    const cached = this.listCache.get(search);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const path = search
      ? `/-/v1/search?text=${encodeURIComponent(search)}&size=100`
      : "/-/all";
    try {
      const response = await this.fetcher(this.url(path), { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(search ? "NPM_SEARCH_FAILED" : "NPM_CATALOG_FAILED");
      const value = search ? projectSearch(await response.json()) : projectCatalog(await response.json());
      this.listCache.set(search, { expiresAt: Date.now() + this.cacheTtlMs, value });
      return value;
    } catch (error) {
      if (cached) return cached.value;
      throw error;
    }
  }
  async detail(name: string) {
    const cached = this.detailCache.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const response = await this.fetcher(this.url(encodeURIComponent(name)), { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(response.status === 404 ? "PACKAGE_NOT_FOUND" : "NPM_PACKUMENT_FAILED");
      const packument = await response.json() as Record<string, any>;
      const latestVersion = packument["dist-tags"]?.latest;
      const latest = packument.versions?.[latestVersion] ?? {};
      const readme = typeof packument.readme === "string" ? packument.readme : "";
      const value = { name: packument.name, version: latestVersion, description: latest.description ?? packument.description ?? "", keywords: latest.keywords ?? packument.keywords ?? [], readmeHtml: renderReadme(readme), mcpp: latest.mcpp };
      this.detailCache.set(name, { expiresAt: Date.now() + this.cacheTtlMs, value });
      return value;
    } catch (error) {
      if (cached) return cached.value;
      throw error;
    }
  }
}
