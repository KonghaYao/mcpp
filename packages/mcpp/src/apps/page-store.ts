/**
 * Server 状态 helper：revision、CAS、operation_id 幂等（MCPP/mcp-apps.md §3.4）。
 */
import { MCP_APP_ERROR } from "./constants.ts";
import { appStateUri } from "./uri.ts";

export type AppPageRecord = {
  pageId: string;
  stateUri: string;
  revision: number;
  schemaVersion?: string;
  snapshot: unknown;
  updatedAt: number;
};

export type AppPageStoreOptions = {
  /** 按授权作用域隔离（§3.4 去重键）。 */
  authScope: string;
  initialRevision?: number;
};

type OperationRecord = {
  requestHash: string;
  result: unknown;
};

export class AppPageStore {
  readonly #authScope: string;
  readonly #pages = new Map<string, AppPageRecord>();
  readonly #operations = new Map<string, OperationRecord>();
  readonly #initialRevision: number;

  constructor(options: AppPageStoreOptions) {
    this.#authScope = options.authScope;
    this.#initialRevision = options.initialRevision ?? 0;
  }

  get authScope(): string {
    return this.#authScope;
  }

  getPage(pageId: string): AppPageRecord | undefined {
    return this.#pages.get(pageId);
  }

  /** 创建页面；已存在则返回现有记录（不重复创建，§3.2）。 */
  createPage(input: {
    pageId: string;
    snapshot: unknown;
    schemaVersion?: string;
  }): AppPageRecord {
    const existing = this.#pages.get(input.pageId);
    if (existing) return existing;

    const revision = this.#initialRevision + 1;
    const record: AppPageRecord = {
      pageId: input.pageId,
      stateUri: appStateUri(input.pageId),
      revision,
      schemaVersion: input.schemaVersion,
      snapshot: input.snapshot,
      updatedAt: Date.now(),
    };
    this.#pages.set(input.pageId, record);
    return record;
  }

  readSnapshot(pageId: string): AppPageRecord | undefined {
    return this.#pages.get(pageId);
  }

  /**
   * 带 expected_revision 的 CAS 写入；同一 operation_id + 相同请求体重试返回原结果。
   */
  commitWrite(input: {
    pageId: string;
    expectedRevision: number;
    operationId: string;
    requestHash: string;
    nextSnapshot: unknown;
    schemaVersion?: string;
  }):
    | { ok: true; record: AppPageRecord; deduplicated?: boolean }
    | { ok: false; code: string; message: string; current?: AppPageRecord } {
    const opKey = `${this.#authScope}:${input.pageId}:${input.operationId}`;
    const prior = this.#operations.get(opKey);
    if (prior) {
      if (prior.requestHash !== input.requestHash) {
        return {
          ok: false,
          code: MCP_APP_ERROR.OPERATION_ID_MISMATCH,
          message: "operation_id reused with different payload",
        };
      }
      const record = this.#pages.get(input.pageId);
      if (!record) {
        return {
          ok: false,
          code: MCP_APP_ERROR.PAGE_NOT_FOUND,
          message: `Page ${input.pageId} not found`,
        };
      }
      return { ok: true, record, deduplicated: true };
    }

    const current = this.#pages.get(input.pageId);
    if (!current) {
      return {
        ok: false,
        code: MCP_APP_ERROR.PAGE_NOT_FOUND,
        message: `Page ${input.pageId} not found`,
      };
    }
    if (current.revision !== input.expectedRevision) {
      return {
        ok: false,
        code: MCP_APP_ERROR.REVISION_CONFLICT,
        message: `Expected revision ${input.expectedRevision}, current ${current.revision}`,
        current,
      };
    }

    const record: AppPageRecord = {
      ...current,
      revision: current.revision + 1,
      snapshot: input.nextSnapshot,
      schemaVersion: input.schemaVersion ?? current.schemaVersion,
      updatedAt: Date.now(),
    };
    this.#pages.set(input.pageId, record);
    this.#operations.set(opKey, {
      requestHash: input.requestHash,
      result: record,
    });
    return { ok: true, record };
  }
}

/** 稳定序列化用于 operation 去重（不含凭据）。 */
export function hashWritePayload(payload: unknown): string {
  return Bun.hash(JSON.stringify(payload)).toString(16);
}
