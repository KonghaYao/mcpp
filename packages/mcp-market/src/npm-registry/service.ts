import { AppError } from "../errors.ts";
import {
  digestSnapshot,
  normalizePackageVersion,
  serializeSnapshot,
} from "./normalize.ts";
import type {
  NormalizedPackageVersion,
  PackageVersionRef,
  PublicationPreview,
} from "./types.ts";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type NpmRegistryOptions = {
  /** Fixed Registry origin. Callers can never supply a URL. */
  baseUrl: string;
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: FetchLike;
};

const MAX_REDIRECTS = 2;

/**
 * Human-facing package page. Returns null when no homepage is configured, so
 * the UI renders the source as text rather than inventing a URL.
 */
export const packagePageUrl = (
  homepageUrl: string | null,
  name: string,
  version: string,
): string | null => {
  if (!homepageUrl) return null;
  const base = homepageUrl.replace(/\/+$/, "");
  return `${base}/package/${encodeURIComponent(name)}/v/${encodeURIComponent(version)}`;
};

const concatChunks = (chunks: Uint8Array[], total: number): Uint8Array => {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
};

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(
          "METADATA_TOO_LARGE",
          "Registry response exceeds limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatChunks(chunks, total));
}

const statusToError = (status: number): AppError => {
  if (status === 404) return new AppError("PACKAGE_NOT_FOUND");
  if (status === 429) return new AppError("REGISTRY_RATE_LIMITED");
  return new AppError("REGISTRY_UNAVAILABLE", `Registry returned ${status}`);
};

/**
 * Read-only anti-corruption layer over a single configured NPM-compatible
 * Registry. It owns no business state and exposes no generic URL fetching: the
 * request path is always derived from a validated package name.
 */
export class NpmRegistryService {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #fetch: FetchLike;

  constructor(options: NpmRegistryOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs;
    this.#maxBytes = options.maxBytes;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async preview(ref: PackageVersionRef): Promise<PublicationPreview> {
    const url = `${this.#baseUrl}/${encodeURIComponent(ref.packageName)}`;
    const packument = await this.#fetchPackument(url);
    const metadata = normalizePackageVersion(packument, ref);
    const publishedAt = this.#readPublishedAt(packument, ref.exactVersion);
    const snapshot: NormalizedPackageVersion = { ...metadata, publishedAt };
    const metadataJson = serializeSnapshot(snapshot);
    return {
      ref,
      metadata: snapshot,
      metadataJson,
      metadataDigest: await digestSnapshot(metadataJson),
    };
  }

  #readPublishedAt(packument: unknown, version: string): string | null {
    if (typeof packument !== "object" || packument === null) return null;
    const time = (packument as Record<string, unknown>).time;
    if (typeof time !== "object" || time === null) return null;
    const value = (time as Record<string, unknown>)[version];
    if (typeof value !== "string") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  async #fetchPackument(url: string): Promise<unknown> {
    const origin = new URL(this.#baseUrl).origin;
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.#request(current);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location)
          throw new AppError(
            "REGISTRY_UNAVAILABLE",
            "Registry redirect without location",
          );
        // Only same-origin redirects are followed, so the fixed Registry origin
        // cannot be redirected away to an attacker-controlled host.
        let target: URL;
        try {
          target = new URL(location, current);
        } catch {
          throw new AppError("REGISTRY_UNAVAILABLE", "Invalid redirect target");
        }
        if (target.origin !== origin)
          throw new AppError(
            "REGISTRY_UNAVAILABLE",
            "Cross-origin redirect rejected",
          );
        current = target.toString();
        continue;
      }
      if (!response.ok) throw statusToError(response.status);
      const text = await readBounded(response, this.#maxBytes);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AppError("METADATA_INVALID", "Registry response is not JSON");
      }
    }
    throw new AppError("REGISTRY_UNAVAILABLE", "Too many redirects");
  }

  async #request(url: string): Promise<Response> {
    try {
      return await this.#fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("REGISTRY_UNAVAILABLE", "Registry request failed", {
        // Only the error class name is surfaced; upstream text may echo request
        // details and is never propagated.
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
