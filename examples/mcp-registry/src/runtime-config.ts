const internalToken = process.env.MCP_RUNNER_INTERNAL_TOKEN ?? "";
delete process.env.MCP_RUNNER_INTERNAL_TOKEN;

export { internalToken };
