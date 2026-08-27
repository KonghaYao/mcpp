# AnyDoc MCP demo

受限的 stdio MCP Server，使用 `@firecrawl/anydoc` 0.2.3 将本地文档转换为 Markdown。

运行前必须设置 `ANYDOC_ALLOWED_ROOTS`，值为允许读取的本地目录列表（macOS/Linux 以 `:` 分隔，Windows 以 `;` 分隔）。输入必须是该目录 realpath 范围内的绝对路径；URL、symlink、非普通文件、不支持格式以及超过 25 MiB 的文件均会被拒绝。输出超过 200,000 字符时会截断。Server 不向 stdout 输出日志，以免破坏 stdio MCP 协议。

```sh
ANYDOC_ALLOWED_ROOTS=/safe/documents node dist/server.js
```

## 过渡依赖

当前为已确认的“双依赖暂时过渡”：MCPP (`@peri-code/mcpp`) 负责 `createMcppServerFactory`、`startServer` 和完整 stdio 生命周期；底层 `@modelcontextprotocol/server` 只用于创建 `McpServer` 和注册 tool。未来 MCPP Tool API 可用后，将移除对底层 MCP SDK 的直接依赖并迁移 tool 注册。
