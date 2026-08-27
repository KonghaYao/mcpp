import { afterEach,beforeEach,describe,expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../../src/app.ts";
import { migrate } from "../../src/db/database.ts";

const adminSecret="integration-admin-secret";
const adminHeaders={authorization:`Bearer ${adminSecret}`,"content-type":"application/json","x-request-id":"integration-request"};
let db:Database;
let app:ReturnType<typeof createApp>;

async function request(path:string,init:RequestInit={}){return app.request(path,init)}
async function admin(path:string,body?:unknown){return request(`/api/v1/admin${path}`,{method:"POST",headers:adminHeaders,body:body===undefined?undefined:JSON.stringify(body)})}
async function setupPublisher(){
  expect((await admin("/backends",{slug:"registry",displayName:"Registry"})).status).toBe(201);
  expect((await admin("/publishers",{slug:"publisher",displayName:"Publisher"})).status).toBe(201);
  const response=await admin("/publishers/publisher/api-keys",{name:"integration"});
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
}
function publisher(token:string,path:string,method="GET",body?:unknown){return request(`/api/v1/publisher${path}`,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json","x-request-id":"publisher-request"},body:body===undefined?undefined:JSON.stringify(body)})}
const item={slug:"demo-item",backend:"registry",displayName:"Demo",revision:{version:"1.0.0",backendLocator:{id:"opaque"},serverDefinition:{command:"demo"}}};

beforeEach(async()=>{db=new Database(":memory:");db.exec("PRAGMA foreign_keys=ON");await migrate(db);app=createApp(db,{adminSecret,dbPath:":memory:",publicUrl:new URL("http://localhost/"),port:3000,host:"localhost"})});
afterEach(()=>db.close());

describe("directory HTTP lifecycle",()=>{
  test("creates pending, approves first revision, publishes and rolls back latest",async()=>{
    const token=await setupPublisher();
    expect((await publisher(token,"/items","POST",item)).status).toBe(201);
    expect((await request("/api/v1/items/demo-item")).status).toBe(404);
    expect((await admin("/reviews/demo-item/approve",{})).status).toBe(200);
    let publicItem=await request("/api/v1/items/demo-item");
    expect(publicItem.status).toBe(200);
    expect((await publicItem.json() as any).latestVersion).toBe("1.0.0");
    expect((db.query("SELECT count(*) n FROM mcp_item_latest").get() as any).n).toBe(1);

    const revision={version:"1.1.0",backendLocator:"opaque-locator",serverDefinition:{command:"demo",args:["next"]}};
    expect((await publisher(token,"/items/demo-item/revisions","POST",revision)).status).toBe(201);
    expect((await (await request("/api/v1/items/demo-item")).json() as any).latestVersion).toBe("1.1.0");
    expect((await publisher(token,"/items/demo-item/latest","PUT",{version:"1.0.0"})).status).toBe(200);
    expect((await (await request("/api/v1/items/demo-item")).json() as any).latestVersion).toBe("1.0.0");
    expect((db.query("SELECT count(*) n FROM latest_revision_events").get() as any).n).toBe(3);
  });

  test("admin item suspend and restore preserve status and block publishing",async()=>{
    const token=await setupPublisher();
    await publisher(token,"/items","POST",item);await admin("/reviews/demo-item/approve",{});
    const suspended=await admin("/items/demo-item/suspend");
    expect(suspended.status).toBe(200);expect((await suspended.json() as any).status).toBe("suspended");
    expect((await request("/api/v1/items/demo-item")).status).toBe(404);
    expect((await publisher(token,"/items/demo-item/revisions","POST",{...item.revision,version:"1.1.0"})).status).toBe(409);
    const restored=await admin("/items/demo-item/restore");
    expect(restored.status).toBe(200);expect((await restored.json() as any).status).toBe("active");
  });

  test("publisher archive is atomic and duplicate transition has no event",async()=>{
    const token=await setupPublisher();await publisher(token,"/items","POST",item);await admin("/reviews/demo-item/approve",{});
    expect((await publisher(token,"/items/demo-item/archive","POST")).status).toBe(200);
    expect((await publisher(token,"/items/demo-item/archive","POST")).status).toBe(409);
    expect((db.query("SELECT count(*) n FROM item_status_events WHERE actor_type='publisher'").get() as any).n).toBe(1);
  });

  test("publisher and backend governance block revisions without partial writes",async()=>{
    const token=await setupPublisher();await publisher(token,"/items","POST",item);await admin("/reviews/demo-item/approve",{});
    const before=(db.query("SELECT count(*) n FROM mcp_item_revisions").get() as any).n;
    await admin("/backends/registry/disable");
    expect((await publisher(token,"/items/demo-item/revisions","POST",{...item.revision,version:"1.1.0"})).status).toBe(409);
    expect((db.query("SELECT count(*) n FROM mcp_item_revisions").get() as any).n).toBe(before);
    await admin("/backends/registry/restore");await admin("/publishers/publisher/suspend");
    expect((await publisher(token,"/items/demo-item/revisions","POST",{...item.revision,version:"1.2.0"})).status).toBe(403);
    expect((db.query("SELECT count(*) n FROM mcp_item_revisions").get() as any).n).toBe(before);
  });

  test("validates key expiry and returns request ids without exposing tokens",async()=>{
    await setupPublisher();
    const invalid=await admin("/publishers/publisher/api-keys",{name:"bad",expiresAt:"zzz"});
    expect(invalid.status).toBe(422);expect(invalid.headers.get("x-request-id")).toBe("integration-request");
    expect(JSON.stringify(await invalid.json())).not.toContain("mcpm_");
    expect((db.query("SELECT count(*) n FROM api_keys WHERE name='bad'").get() as any).n).toBe(0);
  });
});
