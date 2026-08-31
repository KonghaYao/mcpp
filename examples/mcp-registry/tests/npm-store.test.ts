import { expect, test } from "bun:test";
import { NpmStore, projectCatalog, projectSearch } from "../src/npm-store.ts";

test("projects only mcp-plugin search records", () => {
  const result = projectSearch({
    objects: [
      {
        package: {
          name: "mcp",
          version: "1.0.0",
          keywords: ["mcp-plugin"],
          description: "ok",
        },
      },
      { package: { name: "other", version: "1.0.0", keywords: [] } },
    ],
  });
  expect(result).toEqual([
    {
      name: "mcp",
      version: "1.0.0",
      keywords: ["mcp-plugin"],
      description: "ok",
      date: undefined,
      publisher: undefined,
    },
  ]);
});
test("projects Verdaccio catalog records for an unfiltered list", () => {
  const result = projectCatalog({
    _updated: 1,
    "@example/openspec-mcp": {
      name: "@example/openspec-mcp",
      "dist-tags": { latest: "1.0.0" },
      keywords: ["mcp-plugin"],
    },
    other: { name: "other", "dist-tags": { latest: "1.0.0" }, keywords: [] },
  });
  expect(result.map((item) => item.name)).toEqual(["@example/openspec-mcp"]);
});
test("projects Verdaccio local search records using latest dist-tag", () => {
  const result = projectSearch({
    objects: [
      {
        package: {
          name: "local-mcp",
          "dist-tags": { latest: "2.0.0" },
          keywords: ["mcp-plugin"],
        },
      },
    ],
  });
  expect(result[0]?.version).toBe("2.0.0");
});
test("store queries configured NPM source", async () => {
  let requested = "";
  const store = new NpmStore("http://npm.test:4873", async (input) => {
    requested = String(input);
    return Response.json({ objects: [] });
  });
  expect(await store.list("echo")).toEqual([]);
  expect(requested).toStartWith("http://npm.test:4873/-/v1/search?text=echo");
});
test("store projects latest packument metadata", async () => {
  const store = new NpmStore("http://npm.test", async () =>
    Response.json({
      name: "echo",
      "dist-tags": { latest: "2.0.0" },
      versions: {
        "2.0.0": {
          description: "latest",
          keywords: ["mcp-plugin"],
          mcpp: { servers: {} },
        },
      },
      readme: "# Echo",
    }),
  );
  expect(await store.detail("echo")).toMatchObject({
    name: "echo",
    version: "2.0.0",
    readmeHtml: "<h1>Echo</h1>\n",
    description: "latest",
  });
});
