import { expect, test } from "bun:test";
import { parseStableRoute, stableRoutePath } from "../src/stable-route.ts";

test("builds and parses a stable scoped package route", () => {
  const path = stableRoutePath({
    packageName: "@example/openspec-mcp",
    version: "1.0.1",
    serverId: "default",
    endpointPath: "/openspec/mcp",
  });
  expect(path).toBe(
    "/mcp/npm/%40example%2Fopenspec-mcp%401.0.1/default/openspec/mcp",
  );
  expect(parseStableRoute(path)).toEqual({
    packageName: "@example/openspec-mcp",
    version: "1.0.1",
    serverId: "default",
    suffix: "/openspec/mcp",
  });
});

test("rejects dist-tags in stable routes", () => {
  expect(
    parseStableRoute("/mcp/npm/package%40latest/default/mcp"),
  ).toBeUndefined();
});
