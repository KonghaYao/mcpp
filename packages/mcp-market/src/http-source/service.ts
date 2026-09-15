import { id as newId, now, type Db } from "../db/database.ts";
import { AppError } from "../errors.ts";
import {
  assertPackageName,
  assertExactVersion,
} from "../npm-registry/normalize.ts";
import type {
  NormalizedPackageVersion,
  PublicationPreview,
} from "../npm-registry/types.ts";
import {
  HttpMcpClient,
  validateEndpoint,
  type HttpProtocol,
} from "./client.ts";
import { digestOf, safeText } from "./normalize.ts";

export type HttpSource = {
  id: string;
  packageName: string;
  displayName: string;
  endpoint: string;
  revision: number;
  protocol: HttpProtocol;
  latestPublicationId: string | null;
};

const columns =
  "id, source_id AS sourceId, package_name AS packageName, display_name AS displayName, endpoint, http_protocol AS protocol, definition_revision AS revision, latest_publication_id AS latestPublicationId";

export class HttpSourceService {
  constructor(
    readonly db: Db,
    readonly client: HttpMcpClient,
  ) {}

  list(): HttpSource[] {
    return this.db
      .query<
        HttpSource,
        []
      >(`SELECT ${columns} FROM market_packages WHERE source_kind='http' ORDER BY created_at, id`)
      .all();
  }

  get(id: string): HttpSource {
    const source = this.db
      .query<
        HttpSource,
        [string]
      >(`SELECT ${columns} FROM market_packages WHERE id=? AND source_kind='http'`)
      .get(id);
    if (!source) throw new AppError("PUBLICATION_NOT_FOUND");
    return source;
  }

  save(input: {
    id?: string;
    packageName: string;
    displayName: string;
    endpoint: string;
    protocol?: string;
  }): HttpSource {
    const protocol = input.protocol ?? "2025";
    if (protocol !== "2025" && protocol !== "2026-07-28")
      throw new AppError("INVALID_INPUT");
    const packageName = assertPackageName(input.packageName);
    // 给来源编码预留空间，确保静态页面目录名不超过文件系统单段上限。
    safeText(packageName, 128);
    const displayName = safeText(input.displayName, 120);
    const endpoint = validateEndpoint(
      input.endpoint,
      this.client.options.allowLoopback,
    );
    if (input.id) {
      const source = this.get(input.id);
      // 身份不可改名；显示名称与 endpoint 可编辑，revision 使旧预览失效。
      if (source.packageName !== packageName)
        throw new AppError("INVALID_INPUT");
      this.db
        .query(
          "UPDATE market_packages SET display_name=?, endpoint=?, http_protocol=?, definition_revision=definition_revision+1, updated_at=? WHERE id=? AND source_kind='http'",
        )
        .run(displayName, endpoint, protocol, now(), source.id);
      return this.get(source.id);
    }
    const id = `http:${newId()}`;
    const timestamp = now();
    this.db
      .query(
        "INSERT INTO market_packages (id, source_id, package_name, latest_publication_id, source_kind, display_name, endpoint, http_protocol, created_at, updated_at) VALUES (?,?,?,NULL,'http',?,?,?,?,?)",
      )
      .run(
        id,
        id,
        packageName,
        displayName,
        endpoint,
        protocol,
        timestamp,
        timestamp,
      );
    return this.get(id);
  }

  async preview(id: string): Promise<
    PublicationPreview & {
      confirmationDigest: string;
      definitionRevision: number;
    }
  > {
    const source = this.get(id);
    const discovery = await this.client.discover(
      source.endpoint,
      source.protocol,
    );
    if (this.get(id).revision !== source.revision)
      throw new AppError("PREVIEW_CHANGED");
    const content = {
      name: source.packageName,
      displayName: source.displayName,
      description: discovery.serverInfo.description ?? null,
      summary: null,
      keywords: [],
      agents: [],
      servers: [
        {
          id: source.id.replace(":", "-"),
          transport: "streamable-http",
          runtime: null,
          endpoint: source.endpoint,
        },
      ],
      ...discovery,
      sourceKind: "http" as const,
      integrity: null,
      tarballUrl: null,
      unpackedSizeBytes: null,
      fileCount: null,
      deprecated: null,
      publishedAt: null,
    };
    const version = assertExactVersion(
      `0.0.0-http.${digestOf(JSON.stringify(content))}`,
    );
    const metadata: NormalizedPackageVersion = { ...content, version };
    const metadataJson = JSON.stringify(metadata);
    const metadataDigest = `sha256:${digestOf(metadataJson)}`;
    return {
      ref: {
        sourceId: id,
        packageName: source.packageName,
        exactVersion: version,
      },
      metadata,
      metadataJson,
      metadataDigest,
      definitionRevision: source.revision,
      confirmationDigest: digestOf(
        JSON.stringify([id, source.revision, metadataDigest]),
      ),
    };
  }
}
