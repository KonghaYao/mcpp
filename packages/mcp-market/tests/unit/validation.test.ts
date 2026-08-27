import { describe,expect,test } from "bun:test";
import * as v from "../../src/validation.ts";

describe("validation",()=>{
  test("accepts only canonical ISO timestamps for API key expiry",()=>{
    expect(v.expiresAt("2030-01-02T03:04:05.000Z")).toBe("2030-01-02T03:04:05.000Z");
    expect(v.expiresAt(null)).toBeNull();
    for(const value of ["zzz","2030-01-02",123])expect(()=>v.expiresAt(value)).toThrow();
  });

  test("keeps backend locators opaque while rejecting invalid shapes",()=>{
    expect(v.backendLocator("opaque:value")).toBe("opaque:value");
    expect(v.backendLocator({registryId:"anything"})).toEqual({registryId:"anything"});
    expect(()=>v.backendLocator(["not","opaque"])).toThrow();
  });

  test("rejects HTTP server definitions",()=>{
    expect(()=>v.serverDefinition({url:"https://example.test/mcp",transport:"http"})).toThrow();
    expect(v.serverDefinition({command:"node",args:["server.js"]})).toEqual({command:"node",args:["server.js"]});
  });
});
