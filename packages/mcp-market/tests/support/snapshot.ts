/**
 * Snapshot builders for tests that exercise the Catalogue without going through
 * the Registry. The shape matches `NormalizedPackageVersion` exactly, because
 * that is the only shape the Catalogue is allowed to store.
 */

import {
  digestSnapshot,
  serializeSnapshot,
} from "../../src/npm-registry/normalize.ts";
import type {
  NormalizedPackageVersion,
  SnapshotAgent,
  SnapshotServer,
} from "../../src/npm-registry/types.ts";

export type SnapshotInput = {
  name: string;
  version: string;
  description?: string | null;
  keywords?: string[];
  displayName?: string | null;
  summary?: string | null;
  agents?: SnapshotAgent[];
  servers?: SnapshotServer[];
  deprecated?: string | null;
};

export const agent = (
  id: string,
  name: string,
  description: string | null = null,
): SnapshotAgent => ({ id, name, description });

export const server = (
  id: string,
  transport = "stdio",
  runtime: string | null = "client-local",
): SnapshotServer => ({ id, transport, runtime });

export const snapshot = (input: SnapshotInput): NormalizedPackageVersion => ({
  name: input.name,
  version: input.version,
  description: input.description ?? null,
  keywords: input.keywords ?? [],
  displayName: input.displayName ?? null,
  summary: input.summary ?? null,
  agents: input.agents ?? [],
  servers: input.servers ?? [],
  integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  tarballUrl: `https://registry.example.com/${input.name}/-/${input.name}-${input.version}.tgz`,
  unpackedSizeBytes: null,
  fileCount: null,
  deprecated: input.deprecated ?? null,
  publishedAt: "2026-08-01T00:00:00.000Z",
});

/** Serialised snapshot plus its digest, as the Registry adapter would produce. */
export async function snapshotRecord(
  input: SnapshotInput,
): Promise<{ metadataJson: string; metadataDigest: string }> {
  const metadataJson = serializeSnapshot(snapshot(input));
  return {
    metadataJson,
    metadataDigest: await digestSnapshot(metadataJson),
  };
}
