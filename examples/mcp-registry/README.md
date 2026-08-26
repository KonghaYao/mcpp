# MCP Registry prototype

Runnable Bun/Hono prototype with dynamic NPM discovery, asynchronous deployment, and a Worker request adapter. Registry and Runner use one application image but run as two role-specific containers with a private HTTP boundary. The optional `src/main.ts` entry remains available for local single-process debugging only. The Worker is a prototype lifecycle boundary, **not a production security sandbox**.

## Run

```sh
cp .env.example .env
docker compose up --build
```

Open `http://localhost:3000`. Verdaccio is available at `http://localhost:4873`.

Compose builds `mcp-registry-app:local` once and starts two containers from that exact image:

- `mcp-registry`: `bun src/registry.ts`, public UI and stable MCP proxy on port 3000;
- `mcp-runner`: `bun src/runner.ts`, private deployment/Worker runtime on the Compose network.

Only Runner mounts `runner-data`; Registry is stateless and can restart independently. In CI/CD, publish one immutable application image and configure both workloads with different commands.

## Publish a hostable MCP plugin

Registry discovery is driven by NPM metadata. A README or `mcp.json` alone does not make a package hostable. The package root `package.json` must contain the discovery keyword and a valid Server runtime declaration:

```json
{
  "name": "@your-org/example-mcp",
  "version": "1.0.0",
  "description": "What this MCP server does",
  "type": "module",
  "keywords": ["mcp-plugin"],
  "files": ["dist", "README.md"],
  "mcpp": {
    "display": {
      "name": "Example MCP",
      "description": "A short market description"
    },
    "servers": {
      "default": {
        "title": "Example MCP Server",
        "runtime": "serverless",
        "entry": "./dist/server.js",
        "endpointPath": "/mcp"
      }
    }
  }
}
```

The entry module must export `fetch(Request)` or `default.fetch(Request)`. Keep `README.md` at the package root; npm copies it into the packument used by Registry details. Registry renders that Markdown server-side and sanitizes the resulting HTML because package README content is untrusted.

Publish in this order:

```sh
npm adduser --registry http://localhost:4873
npm pack --dry-run
npm publish --registry http://localhost:4873
```

After publication, Verdaccio provides the keyword, dist-tags, exact versions, README, integrity and tarball. Registry lists packages carrying `mcp-plugin`; Runner validates `mcpp.servers`, installs the exact version and exposes each declared `endpointPath` through a stable route.

Publish the fixture manually after creating a local Verdaccio user (there is intentionally no seed service):

```sh
npm adduser --registry http://localhost:4873
cd fixtures/echo-mcp
npm publish --registry http://localhost:4873
```

Then find `@example/echo-mcp` in MCP List and deploy server `default`. The UI prompts for `MCP_REGISTRY_ADMIN_TOKEN`; with Compose defaults use `prototype-admin-token`. Clients consume the stable route emitted by Online MCP, for example `/mcp/npm/%40example%2Fecho-mcp%401.0.0/default/mcp`; internal deployment IDs are not part of client configuration.

## Local verification

```sh
bun install
bun test
bunx tsc --noEmit
```

The Registry has no persistent package Store table; it projects Verdaccio's catalog, search, and packument APIs. Runner persists desired deployment records in `/data/runner.sqlite3` using `bun:sqlite`. On restart, previously queued or active deployments retain their resolved exact NPM version, return to `queued`, reinstall, pass the Worker health probe, and become active behind the same stable route. Failed deployments remain diagnostic records and are not retried forever. Installed package files and SQLite both live in the controlled `runner-data` volume.
