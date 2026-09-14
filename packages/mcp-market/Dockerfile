# Bun executes TypeScript directly, so the image ships sources instead of a
# build artifact and the dependency stage only has to materialise `node_modules`.
#
# `BUN_IMAGE` is an ARG so a build can switch to the Alpine variant
# (`oven/bun:1-alpine`) and drop roughly 130 MB. The Debian default is kept for
# the reference deployment: `bun:sqlite` is compiled into the runtime on both,
# and glibc is the better-tested of the two.

ARG BUN_IMAGE=oven/bun:1

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS deps

WORKDIR /app

# Optional registry for dependency installs: an internal mirror, or a private
# registry that also serves the public packages this image needs. Empty keeps
# `bun install` on its default. Credentials do not belong here — an argument is
# readable in `docker history` — they go in the secret below.
ARG NPM_REGISTRY=""

# Every workspace package.json has to be present: `--frozen-lockfile` compares
# the lockfile against all `workspaces` entries and fails on a missing one
# rather than skipping it. Only the server's dependency tree is installed, so
# the examples' toolchains never reach the image.
COPY package.json bun.lock ./
COPY packages ./packages
COPY examples ./examples

# The `.npmrc` arrives as a build secret and lives only for this instruction:
# `--mount=type=secret` never commits to a layer, so a token written here cannot
# be recovered from the published image. The file is an ordinary `.npmrc` —
# `//host/:_authToken=...`, plus `@scope:registry=...` when the private registry
# serves only part of the tree.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    if [ -n "$NPM_REGISTRY" ]; then set -- "--registry=$NPM_REGISTRY"; fi; \
    bun install --frozen-lockfile --production --filter '@open-mcp-market/server' "$@"

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS runtime

# `PORT` overrides a default of 0 in `config.ts`, which would bind a random
# port and leave the container unreachable. `MCPM_DB_PATH` and `MCPM_STATIC_DIR`
# are absolute so the write path is the volume, not the read-only image layer.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MCPM_DB_PATH=/data/mcpm.sqlite \
    MCPM_STATIC_DIR=/data/public-static

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
# With `--filter`, bun hoists the real packages into `node_modules/.bun` and
# links them into the filtered package's own `node_modules`. Copying only the
# root directory ships the symlink targets without the symlinks.
COPY --from=deps /app/packages/mcp-market/node_modules ./packages/mcp-market/node_modules
COPY package.json ./
COPY packages/mcp-market/package.json ./packages/mcp-market/package.json
# Paths are load-bearing: `src/app.ts` resolves `../assets/market/*` from its own
# URL, and `src/db/database.ts` resolves `../../migrations` from `import.meta.dir`.
COPY packages/mcp-market/src ./packages/mcp-market/src
COPY packages/mcp-market/assets ./packages/mcp-market/assets
COPY packages/mcp-market/migrations ./packages/mcp-market/migrations

# The database and the pre-rendered pages share one volume on purpose: the page
# store renames a temporary file onto its target, which is only atomic inside a
# single filesystem. Creating /data in the image makes a fresh named volume
# inherit the `bun` uid, so no host-side chown is needed.
RUN mkdir -p /data && chown bun:bun /data

USER bun
WORKDIR /app/packages/mcp-market

EXPOSE 3000

# `/health/ready` reports a missing FTS5 build as unavailable, which `/live`
# deliberately does not: a container that can serve pages but not search is not
# ready. No curl or wget in the image, so the probe uses the runtime itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const port = process.env.PORT ?? 3000; const res = await fetch(`http://127.0.0.1:${port}/health/ready`); if (!res.ok) { console.error(await res.text()); process.exit(1); }"]

CMD ["bun", "src/main.ts"]
