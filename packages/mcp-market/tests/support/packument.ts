/**
 * Packument builders for tests.
 *
 * These deliberately produce the *untrusted* shape a Registry would return, so
 * the normaliser is exercised exactly as it is in production.
 */

export type AgentFixture = {
  id: string;
  name: string;
  description?: string;
};

export type SkillFixture = {
  uri: string;
  name: string;
  description?: string;
};

export type ServerFixture = {
  id: string;
  transport: string;
  runtime?: string;
};

export type PackumentInput = {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  deprecated?: string;
  integrity?: string;
  tarball?: string;
  unpackedSize?: number;
  fileCount?: number;
  time?: string;
  mcpp?: unknown;
  /** Escape hatch for hostile-input cases. */
  extraVersionFields?: Record<string, unknown>;
  extraPackumentFields?: Record<string, unknown>;
};

export const mcppMetadata = (input: {
  schemaVersion?: number;
  displayName?: string;
  summary?: string;
  agents?: AgentFixture[];
  skills?: SkillFixture[];
  servers?: ServerFixture[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> => ({
  schemaVersion: input.schemaVersion ?? 1,
  ...(input.displayName === undefined
    ? {}
    : { displayName: input.displayName }),
  ...(input.summary === undefined ? {} : { summary: input.summary }),
  ...(input.agents === undefined ? {} : { agents: input.agents }),
  ...(input.skills === undefined ? {} : { skills: input.skills }),
  ...(input.servers === undefined ? {} : { servers: input.servers }),
  ...(input.extra ?? {}),
});

/** A minimal, valid single-version Packument. */
export const packumentFor = (
  input: PackumentInput,
): Record<string, unknown> => {
  const version: Record<string, unknown> = {
    name: input.name,
    version: input.version,
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
    ...(input.deprecated === undefined ? {} : { deprecated: input.deprecated }),
    ...(input.mcpp === undefined ? {} : { mcpp: input.mcpp }),
    dist: {
      ...(input.integrity === undefined
        ? {
            // A real sha512 SRI (88 base64 chars). Keep it realistic: a short
            // placeholder here once hid a validator that rejected every
            // published package.
            integrity:
              "sha512-ySkKdW+6nSh2cvK986z0Cg2Od7YC8mjLglK35WPGgzFQ2ovXScbjMuF42SfzLNTl+4wcvScsBdT8md82I+aOSA==",
          }
        : { integrity: input.integrity }),
      tarball:
        input.tarball ??
        `https://registry.example.com/${input.name}/-/${input.name}-${input.version}.tgz`,
      ...(input.unpackedSize === undefined
        ? {}
        : { unpackedSize: input.unpackedSize }),
      ...(input.fileCount === undefined ? {} : { fileCount: input.fileCount }),
    },
    ...(input.extraVersionFields ?? {}),
  };

  return {
    name: input.name,
    "dist-tags": { latest: input.version },
    versions: { [input.version]: version },
    time: {
      created: "2026-01-01T00:00:00.000Z",
      [input.version]: input.time ?? "2026-08-01T00:00:00.000Z",
    },
    ...(input.extraPackumentFields ?? {}),
  };
};

/** A Packument that omits `mcpp` entirely — a plain Connector. */
export const plainPackument = (input: {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
}): Record<string, unknown> => packumentFor(input);

/** Builds a deeply nested object to trip the depth guard. */
export const deeplyNested = (depth: number): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.child = next;
    cursor = next;
  }
  return root;
};
