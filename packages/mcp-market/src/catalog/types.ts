export type MarketPackage = {
  id: string;
  sourceId: string;
  packageName: string;
  sourceKind: "npm" | "http";
  latestPublicationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Publication = {
  id: string;
  packageId: string;
  exactVersion: string;
  metadataJson: string;
  metadataDigest: string;
  firstPublishedAt: string;
  publishedAt: string;
  unpublishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminOperationAction = "publish" | "restore" | "unpublish";

export type PublicationChange = {
  /** `noop` means the request was already satisfied; nothing was written. */
  action: AdminOperationAction | "noop";
  packageId: string;
  packageName: string;
  packageSlug: string;
  publicationId: string;
  exactVersion: string;
  previousLatestPublicationId: string | null;
  latestPublicationId: string | null;
  /** Version pages whose rendered content may have changed. */
  affectedVersions: string[];
};

export type PublishInput = {
  sourceId: string;
  packageName: string;
  exactVersion: string;
  metadataJson: string;
  metadataDigest: string;
  requestId: string;
};

export type UnpublishInput = {
  sourceId: string;
  packageName: string;
  exactVersion: string;
  requestId: string;
};
