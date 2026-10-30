import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import snapshot from "./vendor/schema-2026-07-28.json";

const provider = new AjvJsonSchemaValidator();
const validators = new Map<string, ReturnType<typeof provider.getValidator>>();

/** 固定发布快照的原始定义；npm core/v2 只提供 TS 类型和结果投影，不是验收依据。 */
export function matchesTaskSchema(
  definition: keyof typeof snapshot.$defs,
  value: unknown,
): boolean {
  let validate = validators.get(definition);
  if (!validate) {
    const { $id: _, ...schema } = snapshot;
    validate = provider.getValidator({
      ...schema,
      $ref: `#/$defs/${definition}`,
    } as unknown as JsonSchemaType);
    validators.set(definition, validate);
  }
  return validate(value).valid;
}
