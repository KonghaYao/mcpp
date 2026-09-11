import { AppError } from "../errors.ts";
import type {
  NormalizedPackageVersion,
  SnapshotAgent,
  SnapshotServer,
  SnapshotSkill,
} from "./types.ts";

/**
 * Every bound applied to untrusted Registry input lives here so the limits are
 * auditable in one place and testable as a set. Inputs beyond these bounds are
 * rejected outright rather than truncated: a truncated publish would silently
 * differ from what the Admin previewed.
 */
export const LIMITS = {
  maxJsonDepth: 12,
  maxNameLength: 214,
  maxDescriptionLength: 2048,
  maxSummaryLength: 512,
  maxDisplayNameLength: 120,
  maxKeywords: 32,
  maxKeywordLength: 64,
  maxAgents: 32,
  maxAgentIdLength: 64,
  maxAgentNameLength: 120,
  maxAgentDescriptionLength: 512,
  maxSkills: 64,
  maxSkillUriLength: 512,
  maxSkillNameLength: 128,
  maxSkillDescriptionLength: 512,
  maxServers: 32,
  maxServerIdLength: 64,
  maxTransportLength: 32,
  maxRuntimeLength: 64,
  maxDeprecatedLength: 512,
  maxIntegrityLength: 256,
  maxUrlLength: 2048,
} as const;

export const MAX_PACKAGE_NAME_LENGTH = LIMITS.maxNameLength;

const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Strict exact SemVer. Ranges, tags and partial versions are rejected. */
const EXACT_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const isPackageName = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_PACKAGE_NAME_LENGTH &&
  PACKAGE_NAME_PATTERN.test(value);

export const isExactVersion = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && EXACT_VERSION_PATTERN.test(value);

export const assertPackageName = (value: unknown): string => {
  if (typeof value !== "string" || !isPackageName(value))
    throw new AppError("INVALID_INPUT", "Invalid package name");
  return value;
};

export const assertExactVersion = (value: unknown): string => {
  if (typeof value !== "string" || !isExactVersion(value))
    throw new AppError("INVALID_INPUT", "Invalid exact version");
  return value;
};

/**
 * Iterative depth probe. Never recurses, so hostile nesting cannot exhaust the
 * stack before the bound is reported.
 */
export function exceedsDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { node, depth } = frame;
    if (depth > maxDepth) return true;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
    } else if (typeof node === "object" && node !== null) {
      for (const item of Object.values(node as Record<string, unknown>))
        stack.push({ node: item, depth: depth + 1 });
    }
  }
  return false;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN[ A-Z]*-----/,
  /\bauthorization\b\s*[:=]\s*\S{8,}/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
  /data:[a-z0-9.+-]*\/[a-z0-9.+-]*;base64,/i,
  /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*\S{16,}/i,
  /[A-Za-z0-9+/]{64,}={0,2}/,
];

/**
 * Rejects external text that looks like embedded credentials or inline binary.
 * Snapshot content that trips this is refused rather than redacted, so a
 * published snapshot is always exactly what the Admin previewed.
 */
export const looksLikeSecret = (value: string): boolean =>
  SECRET_PATTERNS.some((pattern) => pattern.test(value));

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const requireString = (
  value: unknown,
  maxLength: number,
  field: string,
): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new AppError("METADATA_INVALID", `Invalid ${field}`);
  if (value.length > maxLength)
    throw new AppError("METADATA_TOO_LARGE", `${field} exceeds limit`);
  if (looksLikeSecret(value))
    throw new AppError("METADATA_INVALID", `${field} looks like a secret`);
  return value;
};

const optionalString = (
  value: unknown,
  maxLength: number,
  field: string,
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new AppError("METADATA_INVALID", `Invalid ${field}`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return requireString(trimmed, maxLength, field);
};

const optionalUrl = (value: unknown, field: string): string | null => {
  const text = optionalString(value, LIMITS.maxUrlLength, field);
  if (text === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new AppError("METADATA_INVALID", `Invalid ${field}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new AppError("METADATA_INVALID", `${field} must be http or https`);
  return parsed.toString();
};

const optionalNonNegativeInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

const normalizeKeywords = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  if (value.length > LIMITS.maxKeywords)
    throw new AppError("METADATA_TOO_LARGE", "keywords exceeds limit");
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const keyword = entry.trim();
    if (keyword.length === 0) continue;
    if (keyword.length > LIMITS.maxKeywordLength)
      throw new AppError("METADATA_TOO_LARGE", "keyword exceeds limit");
    if (looksLikeSecret(keyword))
      throw new AppError("METADATA_INVALID", "keyword looks like a secret");
    seen.add(keyword);
  }
  return [...seen];
};

const normalizeSkills = (value: unknown): SnapshotSkill[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new AppError("METADATA_INVALID", "mcpp.skills must be an array");
  if (value.length > LIMITS.maxSkills)
    throw new AppError("METADATA_TOO_LARGE", "mcpp skills exceeds limit");
  const seen = new Set<string>();
  const skills: SnapshotSkill[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record)
      throw new AppError(
        "METADATA_INVALID",
        "mcpp.skills entry must be object",
      );
    const uri = requireString(
      record.uri,
      LIMITS.maxSkillUriLength,
      "mcpp.skills[].uri",
    );
    if (!/^skill:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\/SKILL\.md$/.test(uri))
      throw new AppError("METADATA_INVALID", "Invalid mcpp skill URI");
    if (seen.has(uri))
      throw new AppError("METADATA_INVALID", "duplicate mcpp skill URI");
    seen.add(uri);
    skills.push({
      uri,
      name: requireString(
        record.name,
        LIMITS.maxSkillNameLength,
        "mcpp.skills[].name",
      ),
      description: optionalString(
        record.description,
        LIMITS.maxSkillDescriptionLength,
        "mcpp.skills[].description",
      ),
    });
  }
  return skills;
};

const normalizeAgents = (value: unknown): SnapshotAgent[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new AppError("METADATA_INVALID", "mcpp.agents must be an array");
  if (value.length > LIMITS.maxAgents)
    throw new AppError("METADATA_TOO_LARGE", "mcpp.agents exceeds limit");
  const seen = new Set<string>();
  const agents: SnapshotAgent[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record)
      throw new AppError(
        "METADATA_INVALID",
        "mcpp.agents entry must be object",
      );
    const agentId = requireString(
      record.id,
      LIMITS.maxAgentIdLength,
      "mcpp.agents[].id",
    );
    if (seen.has(agentId))
      throw new AppError("METADATA_INVALID", "duplicate mcpp agent id");
    seen.add(agentId);
    agents.push({
      id: agentId,
      name: requireString(
        record.name,
        LIMITS.maxAgentNameLength,
        "mcpp.agents[].name",
      ),
      description: optionalString(
        record.description,
        LIMITS.maxAgentDescriptionLength,
        "mcpp.agents[].description",
      ),
    });
  }
  return agents;
};

const normalizeServers = (value: unknown): SnapshotServer[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new AppError("METADATA_INVALID", "mcpp.servers must be an array");
  if (value.length > LIMITS.maxServers)
    throw new AppError("METADATA_TOO_LARGE", "mcpp.servers exceeds limit");
  const seen = new Set<string>();
  const servers: SnapshotServer[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record)
      throw new AppError(
        "METADATA_INVALID",
        "mcpp.servers entry must be object",
      );
    const serverId = requireString(
      record.id,
      LIMITS.maxServerIdLength,
      "mcpp.servers[].id",
    );
    if (seen.has(serverId))
      throw new AppError("METADATA_INVALID", "duplicate mcpp server id");
    seen.add(serverId);
    servers.push({
      id: serverId,
      transport: requireString(
        record.transport,
        LIMITS.maxTransportLength,
        "mcpp.servers[].transport",
      ),
      runtime: optionalString(
        record.runtime,
        LIMITS.maxRuntimeLength,
        "mcpp.servers[].runtime",
      ),
    });
  }
  return servers;
};

export const SUPPORTED_MCPP_SCHEMA_VERSION = 1;

/**
 * Reads the version entry out of a Packument and copies only whitelisted fields
 * into a new object. Unknown extension fields are deliberately dropped.
 */
export function normalizePackageVersion(
  packument: unknown,
  ref: { packageName: string; exactVersion: string },
): NormalizedPackageVersion {
  const packumentRecord = asRecord(packument);
  if (!packumentRecord)
    throw new AppError("METADATA_INVALID", "Packument must be an object");
  if (exceedsDepth(packumentRecord, LIMITS.maxJsonDepth))
    throw new AppError("METADATA_TOO_LARGE", "Packument nesting exceeds limit");

  const versions = asRecord(packumentRecord.versions);
  if (!versions)
    throw new AppError("METADATA_INVALID", "Packument has no versions");

  const versionEntry = asRecord(versions[ref.exactVersion]);
  if (!versionEntry)
    throw new AppError("VERSION_NOT_FOUND", "Version not found in Packument");

  const name = requireString(versionEntry.name, LIMITS.maxNameLength, "name");
  const version = requireString(versionEntry.version, 128, "version");
  if (name !== ref.packageName || version !== ref.exactVersion)
    throw new AppError(
      "METADATA_INVALID",
      "Packument name/version does not match the request",
    );

  const mcpp = asRecord(versionEntry.mcpp);
  let displayName: string | null = null;
  let summary: string | null = null;
  let agents: SnapshotAgent[] = [];
  let skills: SnapshotSkill[] = [];
  let servers: SnapshotServer[] = [];
  if (mcpp) {
    const schemaVersion = mcpp.schemaVersion;
    if (schemaVersion !== SUPPORTED_MCPP_SCHEMA_VERSION)
      throw new AppError(
        "UNSUPPORTED_SCHEMA_VERSION",
        "Unsupported mcpp.schemaVersion",
        { supported: SUPPORTED_MCPP_SCHEMA_VERSION },
      );
    displayName = optionalString(
      mcpp.displayName,
      LIMITS.maxDisplayNameLength,
      "mcpp.displayName",
    );
    summary = optionalString(
      mcpp.summary,
      LIMITS.maxSummaryLength,
      "mcpp.summary",
    );
    agents = normalizeAgents(mcpp.agents);
    skills = normalizeSkills(mcpp.skills);
    servers = normalizeServers(mcpp.servers);
  }

  const dist = asRecord(versionEntry.dist);
  return {
    name,
    version,
    description: optionalString(
      versionEntry.description,
      LIMITS.maxDescriptionLength,
      "description",
    ),
    keywords: normalizeKeywords(versionEntry.keywords),
    displayName,
    summary,
    agents,
    skills,
    servers,
    integrity: dist
      ? optionalString(
          dist.integrity,
          LIMITS.maxIntegrityLength,
          "dist.integrity",
        )
      : null,
    tarballUrl: dist ? optionalUrl(dist.tarball, "dist.tarball") : null,
    unpackedSizeBytes: dist ? optionalNonNegativeInt(dist.unpackedSize) : null,
    fileCount: dist ? optionalNonNegativeInt(dist.fileCount) : null,
    deprecated: optionalString(
      versionEntry.deprecated,
      LIMITS.maxDeprecatedLength,
      "deprecated",
    ),
    publishedAt: null,
  };
}

export const serializeSnapshot = (metadata: NormalizedPackageVersion): string =>
  JSON.stringify(metadata);

export async function digestSnapshot(metadataJson: string): Promise<string> {
  const bytes = new TextEncoder().encode(metadataJson);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
