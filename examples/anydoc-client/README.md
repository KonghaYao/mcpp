# MCPM Directory E2E Client

这是 MCPM 目录与治理控制面的端到端测试 harness。它会启动一个使用临时 SQLite 和随机端口的 MCPM 实例，通过真实 HTTP API 验证完整目录生命周期：

1. Admin 创建不透明 Backend、Publisher 和 API Key；
2. Publisher 创建 AnyDoc Item 与首个 Revision；
3. 首次审核前 Public API 不可见；
4. Admin 首次批准后自动发布并设置 `latest`；
5. 匿名用户获取完整 `mcpServers` JSON；
6. Publisher 发布后续 Revision，免审并自动更新 `latest`；
7. Publisher 回滚 `latest`、修改展示信息、archive/restore；
8. Admin suspend/restore，并验证暂停期间写操作和公开读取受限。

Backend 使用不可达的展示 URL，E2E 不会请求它，以证明 MCPM 不查询、代理或验证 Backend artifact。

```bash
bun run --cwd examples/anydoc-client e2e
```

测试进程会自动清理子进程和临时数据库，不读取或保存真实 Publisher、Admin 或 Consumer secret。
