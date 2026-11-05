# 协作与接力规则

AIJAVAIS 的产品定位是**全行业通用型 AI 工作操作系统**。不要把用户历史职业、某一行业或某品牌模型当作产品中心。行业模板是可选配置，岗位、工具、Skills 和模型必须解耦。

开发前阅读 `CLAUDE.md`、`docs/PRODUCT.md`、`docs/FEATURE-STATUS.md`、`collab/HANDOFF.md`。

- 使用现有隔离 checkout，未经用户要求不建立 worktree。
- 不直接修改/合并 main；不得覆盖未集成来源分支的代码。
- 一条开发分支同一时间只有一位主要开发者；Claude 从交接提交创建 `feat/claude-v2-followup` 再开始写入。
- 不删除测试掩盖问题；Mock、真实 API、协议 fixture、实际文件、未验证能力必须分别报告。
- 未获明确授权不得消耗收费 API 或部署额度，不得为跑通而关闭 TLS、预算或权限门禁。
- Node 24+，`npm test`；浏览器验证 `npm run test:ui` 和 `npm run test:workspace`。详情见 TESTING。
- 私有 DATA、API Key、设置码、Cookie、数据库和截图不得提交到 Git。
- 更改数据库先备份并增加迁移；单进程独占 DATA，禁止盲删活锁。
- 最新第十轮授权：Codex独占 `feat/codex-v2-p1-ledger-recovery` 的#6+#8；Claude待命。完成推送/CI并在两Issue交付READY_FOR_REVIEW后停止写入，等待#2独立审计；不得自行开#7/#9或关闭Issue。历史Claude接力指令不覆盖本轮授权。
