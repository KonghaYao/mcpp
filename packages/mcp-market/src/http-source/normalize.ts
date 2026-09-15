import { createHash } from "node:crypto";
import { AppError } from "../errors.ts";
import { looksLikeSecret } from "../npm-registry/normalize.ts";
import type {
  SnapshotTool,
  SnapshotResource,
  SnapshotResourceTemplate,
  SnapshotPrompt,
  SnapshotCapabilities,
} from "../npm-registry/types.ts";

export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("METADATA_INVALID");
  return value as Record<string, unknown>;
};

export const safeText = (value: unknown, max: number): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ||
    looksLikeSecret(value) ||
    /(?:bearer\s+|(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]|https?:\/\/\S*[?@#]|\b(?:sk|ghp|github_pat|AKIA)[_-]?[A-Za-z0-9]{16,}|[A-Za-z0-9_+/=-]{48,})/i.test(
      value,
    )
  )
    throw new AppError("METADATA_INVALID");
  return value;
};
const text = (value: unknown, max = 2048): string =>
  value === "" ? "" : safeText(value, max);
const keyOf = (value: unknown): string => {
  const key = text(value, 256);
  if (["__proto__", "constructor", "prototype"].includes(key))
    throw new AppError("METADATA_INVALID");
  return key;
};
type Budget = { nodes: number };
const bound = (budget: Budget, depth: number) => {
  if (++budget.nodes > 2048 || depth > 12)
    throw new AppError("METADATA_TOO_LARGE");
};
// enum/const 中的嵌套值也必须逐项检查，不能把任意对象直接带入快照。
const literal = (value: unknown, budget: Budget, depth: number): unknown => {
  bound(budget, depth);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return text(value);
  if (Array.isArray(value))
    return value.map((v) => literal(v, budget, depth + 1));
  const input = record(value);
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => {
        if (
          /(?:password|passwd|secret|token|api[_-]?key|authorization)/i.test(
            key,
          )
        )
          throw new AppError("METADATA_INVALID");
        return [keyOf(key), literal(input[key], budget, depth + 1)];
      }),
  );
};
const schema = (
  value: unknown,
  budget: Budget,
  depth = 0,
): Record<string, unknown> | boolean => {
  bound(budget, depth);
  if (typeof value === "boolean") return value;
  const input = record(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const v = input[key];
    if (key === "type") {
      const types = Array.isArray(v) ? v : [v];
      if (
        !types.length ||
        types.some(
          (t) =>
            ![
              "object",
              "array",
              "string",
              "number",
              "integer",
              "boolean",
              "null",
            ].includes(t),
        )
      )
        throw new AppError("METADATA_INVALID");
      out[key] = Array.isArray(v) ? [...new Set(types)].sort() : v;
    } else if (
      [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
      ].includes(key)
    ) {
      const map = record(v);
      if (Object.keys(map).length > 128)
        throw new AppError("METADATA_TOO_LARGE");
      out[key] = Object.fromEntries(
        Object.keys(map)
          .sort()
          .map((k) => {
            const child = schema(map[k], budget, depth + 1);
            if (
              /(?:password|passwd|secret|token|api[_-]?key|authorization)/i.test(
                k,
              ) &&
              /"(?:const|enum)":/.test(JSON.stringify(child))
            )
              throw new AppError("METADATA_INVALID");
            return [keyOf(k), child];
          }),
      );
    } else if (
      [
        "items",
        "additionalItems",
        "additionalProperties",
        "unevaluatedProperties",
        "unevaluatedItems",
        "contains",
        "propertyNames",
        "not",
        "if",
        "then",
        "else",
      ].includes(key)
    ) {
      out[key] =
        key === "items" && Array.isArray(v)
          ? v.map((s) => schema(s, budget, depth + 1))
          : schema(v, budget, depth + 1);
    } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)) {
      if (!Array.isArray(v) || v.length > 128)
        throw new AppError("METADATA_INVALID");
      out[key] = v.map((s) => schema(s, budget, depth + 1));
    } else if (key === "required") {
      if (!Array.isArray(v) || v.length > 128)
        throw new AppError("METADATA_INVALID");
      out[key] = [...new Set(v.map(keyOf))].sort();
    } else if (key === "dependentRequired") {
      const map = record(v);
      out[key] = Object.fromEntries(
        Object.keys(map)
          .sort()
          .map((k) => {
            const list = map[k];
            if (!Array.isArray(list) || list.length > 128)
              throw new AppError("METADATA_INVALID");
            return [keyOf(k), [...new Set(list.map(keyOf))].sort()];
          }),
      );
    } else if (key === "enum" || key === "const") {
      if (key === "enum" && (!Array.isArray(v) || v.length > 128))
        throw new AppError("METADATA_INVALID");
      out[key] = literal(v, budget, depth + 1);
    } else if (["title", "description", "pattern", "format"].includes(key))
      out[key] = text(v);
    else if (key === "$ref") {
      const ref = text(v);
      if (!ref.startsWith("#/") && ref !== "#")
        throw new AppError("METADATA_INVALID");
      out[key] = ref;
    } else if (
      [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "minContains",
        "maxContains",
        "minProperties",
        "maxProperties",
      ].includes(key)
    ) {
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new AppError("METADATA_INVALID");
      out[key] = v;
    } else if (
      ["uniqueItems", "readOnly", "writeOnly", "deprecated"].includes(key)
    ) {
      if (typeof v !== "boolean") throw new AppError("METADATA_INVALID");
      out[key] = v;
    }
    // default/examples、扩展与远端引用不进入可公开快照。
  }
  return out;
};
export const normalizeTool = (value: unknown): SnapshotTool => {
  const tool = record(value);
  const inputSchema = schema(tool.inputSchema, { nodes: 0 });
  if (typeof inputSchema === "boolean" || inputSchema.type !== "object")
    throw new AppError("METADATA_INVALID");
  const name = safeText(tool.name, 128);
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new AppError("METADATA_INVALID");
  return {
    name,
    description: tool.description === undefined ? null : text(tool.description),
    inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: schema(tool.outputSchema, { nodes: 0 }) }),
  };
};
export const normalizeServerInfo = (value: unknown): Record<string, string> => {
  const info = record(value);
  const out: Record<string, string> = {
    name: safeText(info.name, 256),
    version: safeText(info.version, 128),
  };
  for (const key of ["title", "description"])
    if (info[key] !== undefined) out[key] = text(info[key]);
  return out;
};
const descriptionOf = (value: unknown): string | null =>
  value === undefined ? null : text(value);

// URI 仅作为发现标识，不解引用。检查编码后的敏感内容，模板变量则原样保留。
const discoveryUri = (value: unknown): string => {
  const uri = safeText(value, 2048);
  const decoded = decodeURIComponent(uri);
  safeText(decoded, 2048);
  if (
    !/^[a-z][a-z0-9+.-]*:/i.test(uri) ||
    /[\s\\]/.test(uri) ||
    /:\/\/[^/]*@/.test(decoded) ||
    /(?:token|secret|password|api[_-]?key)=/i.test(decoded)
  )
    throw new AppError("METADATA_INVALID");
  return uri;
};
const resourceFields = (input: Record<string, unknown>) => ({
  name: safeText(input.name, 256),
  description: descriptionOf(input.description),
  ...(input.mimeType === undefined
    ? {}
    : { mimeType: safeText(input.mimeType, 128) }),
});
export const normalizeResource = (value: unknown): SnapshotResource => {
  const input = record(value);
  if (
    input.size !== undefined &&
    (!Number.isSafeInteger(input.size) || (input.size as number) < 0)
  )
    throw new AppError("METADATA_INVALID");
  return {
    uri: discoveryUri(input.uri),
    ...resourceFields(input),
    ...(input.size === undefined ? {} : { size: input.size as number }),
  };
};
export const normalizeResourceTemplate = (
  value: unknown,
): SnapshotResourceTemplate => {
  const input = record(value);
  return {
    uriTemplate: discoveryUri(input.uriTemplate),
    ...resourceFields(input),
  };
};
export const normalizePrompt = (value: unknown): SnapshotPrompt => {
  const input = record(value);
  const args = input.arguments ?? [];
  if (!Array.isArray(args) || args.length > 64)
    throw new AppError("METADATA_TOO_LARGE");
  const names = new Set<string>();
  return {
    name: safeText(input.name, 256),
    description: descriptionOf(input.description),
    arguments: args
      .map((value) => {
        const arg = record(value);
        const name = safeText(arg.name, 128);
        if (
          names.has(name) ||
          (arg.required !== undefined && typeof arg.required !== "boolean")
        )
          throw new AppError("METADATA_INVALID");
        names.add(name);
        return {
          name,
          description: descriptionOf(arg.description),
          required: arg.required === true,
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
};
export const normalizeCapabilities = (value: unknown): SnapshotCapabilities => {
  const input = record(value);
  const output: SnapshotCapabilities = {};
  for (const name of ["tools", "resources", "prompts"] as const) {
    if (input[name] === undefined) continue;
    const capability = record(input[name]);
    const flags: Record<string, boolean> = {};
    for (const flag of name === "resources"
      ? ["listChanged", "subscribe"]
      : ["listChanged"]) {
      if (capability[flag] === undefined) continue;
      if (typeof capability[flag] !== "boolean")
        throw new AppError("METADATA_INVALID");
      flags[flag] = capability[flag];
    }
    output[name] = flags;
  }
  return output;
};

export const digestOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
