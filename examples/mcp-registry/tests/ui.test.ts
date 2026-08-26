import { expect, test } from "bun:test";
import { ui } from "../src/ui.ts";

test("online MCP opens usage details instead of navigating to a protocol route", () => {
  expect(ui).toContain("onclick=\"showDeployment('+i+')\"");
  expect(ui).toContain("Add the configuration below to an MCP Client");
  expect(ui).toContain("Copy endpoint");
  expect(ui).not.toContain("Open route");
});

test("deploy buttons reference cached package indexes", () => {
  expect(ui).toContain("onclick=\"deployPackage('+i+',this)\"");
  expect(ui).not.toContain("onclick=\"deploy('+JSON.stringify(p.name)");
});
