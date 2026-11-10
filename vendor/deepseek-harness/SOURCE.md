# DeepSeek Harness 参考源码（MIT）

- 来源：https://github.com/deepseek-ai/deepseek-harness
- 提交：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（2026-11-04）
- 许可证：MIT，原文见同目录 `LICENSE`（Copyright (c) 2026 DeepSeek）。依 MIT 条款保留版权与许可声明。
- 拉取日期：2026-11-10，由 AIJAVAIS 总指挥执行。

## 性质

本目录**只放参考源码**，运行时不加载，也不参与 `npm test`。文件保持上游原样（TypeScript），目录结构与上游一致，便于日后对照升级。

## 移植规则

- AIJAVAIS 坚持零生产依赖（纯 JS、Node 24、`node:sqlite`），因此移植时**重写为纯 JS**：去掉 TypeScript 类型；schemastery/zod 换成手写校验；Cordis `ctx` 换成我们自己的 store/engine；`eventsource-parser` 换成 `lib/sse.js`。
- 移植后的文件，文件头必须写明 `Portions adapted from DeepSeek Harness (MIT), <上游路径>@fcc0ad4`。
- 下列内容**不拉取、不移植**：Cordis 插件运行时、`subagent/manager.ts`、`agent-loop`、`mcp-client` 主体（依赖 `@modelcontextprotocol/client`），以及任何非 MIT 的可选依赖（libreoffice-kit 为 MPL-2.0，claude-agent-sdk 为专有许可）。

## 文件清单与用途

| 上游路径 | 行数（约） | 用途 |
|---|---|---|
| packages/team/agent-team/src/task-graph.ts、task-view.ts | 125 | 任务依赖图：环检测、就绪判定 → 项目内多岗位并行（DAG） |
| packages/team/agent-team/src/task-board.ts、types.ts | 280+ | 任务板状态机：领取、释放、完成、重开、指派、依赖 → 多 Agent 共享任务板 |
| packages/subagent/subagent/src/activation.ts | 30 | 激活槽位池 → 用"按项目、按用户的并发池"替换全局"最多 3 个" |
| packages/core/tools/src/batch.ts | 285 | 有界并行调度，带互斥屏障 → 同一步内多工具 / 多岗位并行 |
| packages/llm/llm-deepseek/src/{transport,sse,translate,serialize,request-pricing,defaults}.ts | ~450 | DeepSeek 原生客户端：错误分类、流式解析、用量与缓存 token、计价 |
| packages/llm/llm-retry/src/index.ts、llm/src/retry-policy.ts | ~250 | 退避重试策略（含抖动、retry-after） |
| packages/llm/llm/src/assembler.ts | 208 | 流式分片组装成完整消息 |
| packages/compaction/compaction-tool-result-pruner/src/index.ts、token-meter/src/estimate.ts | ~290 | 长工具输出裁剪、token 估算 → 降低上下文开销 |
| packages/compaction/compaction-basic/src/summarizer.ts | 221 | 历史摘要压缩：复用其提示词与框架 |
| packages/session/session-checkpoint-policy/src/index.ts | 83 | 检查点策略：请求前、副作用前、每步后落盘；崩溃后"结果未知、不自动重放" |
| packages/mcp/mcp-client/src/transport.ts | — | 远程 MCP（streamable-http）传输参考 → 用第三方托管的 MCP 工具，算力不占我们的服务器 |
