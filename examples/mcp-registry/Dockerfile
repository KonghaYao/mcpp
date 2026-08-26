FROM node:22-slim AS node-runtime

FROM oven/bun:1
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version \
    && npm --version \
    && npx --version
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY src ./src
ENV REGISTRY_PORT=3000 RUNNER_PORT=3001 MCP_DATA_DIR=/data
EXPOSE 3000 3001
CMD ["bun", "src/registry.ts"]
