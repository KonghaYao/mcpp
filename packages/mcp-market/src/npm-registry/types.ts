/**
 * Normalised, whitelisted projection of one NPM exact version.
 * This is the only shape Catalog ever stores; raw Packuments never cross the
 * NpmRegistry boundary.
 */
export type SnapshotAgent = {
  id: string;
  name: string;
  description: string | null;
};

export type SnapshotServer = {
  id: string;
  transport: string;
  runtime: string | null;
};

export type NormalizedPackageVersion = {
  name: string;
  version: string;
  description: string | null;
  keywords: string[];
  displayName: string | null;
  summary: string | null;
  agents: SnapshotAgent[];
  servers: SnapshotServer[];
  integrity: string | null;
  /** Recorded for provenance only. Never requested and never rendered. */
  tarballUrl: string | null;
  unpackedSizeBytes: number | null;
  fileCount: number | null;
  deprecated: string | null;
  publishedAt: string | null;
};

export type PackageVersionRef = {
  sourceId: string;
  packageName: string;
  exactVersion: string;
};

export type PublicationPreview = {
  ref: PackageVersionRef;
  metadata: NormalizedPackageVersion;
  metadataJson: string;
  metadataDigest: string;
};
