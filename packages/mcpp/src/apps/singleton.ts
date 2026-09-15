/**
 * Singleton 实例键与 Host 侧索引 helper（MCPP/mcp-apps.md §3.1）。
 */
import type { SingletonInstanceKey } from "./constants.ts";

export function singletonInstanceKey(input: SingletonInstanceKey): string {
  const { authScope, hostConversationId, origin, appId, pageId } = input;
  return [authScope, hostConversationId, origin, appId, pageId].join("\0");
}

export function parseSingletonInstanceKey(
  key: string,
): SingletonInstanceKey | undefined {
  const parts = key.split("\0");
  if (parts.length !== 5) return undefined;
  const [authScope, hostConversationId, origin, appId, pageId] = parts;
  if (!authScope || !hostConversationId || !origin || !appId || !pageId) {
    return undefined;
  }
  return { authScope, hostConversationId, origin, appId, pageId };
}

/** Host 侧：同一 Singleton 键是否应聚焦已有展示而非新建。 */
export function shouldFocusExistingSingleton(
  registry: Map<string, unknown>,
  key: SingletonInstanceKey,
): boolean {
  return registry.has(singletonInstanceKey(key));
}
