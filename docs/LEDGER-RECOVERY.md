# #6 + #8 持久请求与异常账本设计

状态：设计检查点；实施和验证结果另见 HANDOFF。授权：Issue #6 第十轮评论 6660869089；唯一开发者 Codex。分支 feat/codex-v2-p1-ledger-recovery，精确基线 b71faaa65bb66e04ea2a015c9238a3a129bdb68e。仅测试临时 SQLite，无生产迁移授权。

## Schema v4

新增 model_requests：PRIMARY KEY(owner_id,kind,request_id)，params_hash、state、唯一 ledger_id 外键引用 system_usage、created_at/updated_at/dispatched_at/settled_at。现有 runs、usage_ledger 及其 ProjectEngine 预算与恢复算法保持原语义。params_hash 为规范化服务器输入与目标配置快照的 SHA-256：description、prompt版本、connectionId、baseUrl/modelId/protocol/pricingMode/updatedAt、批准与Token/金额上限、USD价格。忽略无效额外字段和批准时间，密钥、提示词不存入请求表；摘要绑定完整描述但不公开。

按 owner + kind + requestId 隔离。当前产品为单管理员，仍使用认证 userId，以免未来主体串键。重复同参数返回409 duplicate_request与安全状态；不同参数返回409 idempotency_key_reused；任何状态均不得重发。请求ID/墓碑永久保留，本阶段无清理、无结果自动重放。

## 事务与状态机

1. 先执行共享 budget 的授权、目标、Token/金额检查。拒绝不派发、不预留。
2. claimModelRequest 在首个 await 前以 BEGIN IMMEDIATE 同时插入 system_usage reserved 与 model_requests claimed；失败全部回滚、不调用模型。SQLite唯一键是权威，active仅管理取消；删除seen淘汰机制。
3. 再校验目标与取消状态；网络调用前必须提交 claimed -> dispatching，记录派发时间。dispatching 仅表示可能已发送，即使在下一条网络语句前崩溃也按未知处理。
4. settleSystemUsage 在同一事务条件更新预留账行和请求行：claimed且已证实未调用 -> not_dispatched；dispatching -> completed/failed。一次ledgerId只结算一次，原始预留上界保留。费用未知时cost=null，不将预算上界当账单。结算写失败两表均保留原状态；保留#5的HTTP202/ok:false/usageRecorded:false/financiallyComplete:false与可编辑草案，不为补记账重新调用。
5. 启动恢复只在现有DATA独占锁下事务执行：claimed -> not_dispatched（实际费用0）；dispatching -> interrupted_unknown（cost=null，保留Token/费用预留和上界、model、requestId、时间）。重复恢复幂等；无模型重放。

## 迁移与历史

沿用VACUUM INTO一致备份、0600、schema_migrations、PRAGMA user_version、事务和schema_newer失败关闭。建表与历史转换在同一迁移事务内。v3 intake_draft reserved没有派发证据，一律保守恢复为未知待核对，绝不归零。

所有可识别历史intake请求（含成功/失败）建立永久墓碑：若旧记录无owner，以保留主体*匹配任意真实管理员，拒绝旧ID再次收费；旧摘要不可重建，任何参数都拒绝。历史重复ID的所有账行完整保留，仅一个墓碑关联其中一行，其他行仍可单独查询核对；不删除或覆盖账单。无requestId的历史行仍恢复异常账本，但无法重建丢失的键，列为历史限制。新请求主体禁止使用保留*。

## 只读异常查询与人工核对

管理员现有认证门禁提供只读异常列表，按owner隔离（历史未知owner对管理员可见）。响应仅白名单：ledgerId、requestId、connectionId/modelId、UTC时间、请求与账本状态、cost及预算上界；不返回prompt、密钥、原始错误。能力中心提供待核对提示。估算不是厂商账单。本轮不新增写账/调余额/人工reconcile接口。

人工核对步骤：停止重复提交；记录ledgerId/requestId/UTC时间/model/上界；由负责人在厂商后台核对原始账单，留存脱敏证据；未知账单保持未知。若需实际改账，另行设计并申请授权，不能直接SQL改余额或重新生成作为补记账。

## 回滚

不自动降级。停唯一实例，归档当前完整DATA（含SQLite/WAL/JSON/密钥，勿提交Git），将迁移前一致备份恢复到隔离DATA并使用匹配v3代码验证。v3代码面对v4库必须schema_newer失败关闭。迁移后若已派发任何请求，直接恢复旧备份会丢失幂等墓碑并可能重复收费：此时不可恢复到旧库对外服务，先保留v4全部账本/墓碑，制定受审计前向修复或完整幂等数据保留方案。仅无后续请求的临时迁移实验可直接备份回退。

## 测试与范围

Mock模型+临时SQLite断言底层派发次数：并发同ID、异参、跨owner、重启和1000历史后；claim与dispatching崩溃边界；子进程强杀/重启、第二活进程锁拒绝；预留/结算事务故障；重复恢复；v3历史、备份/迁移失败、损坏库/未来版本；只读认证/脱敏；#5 HTTP202与原ProjectEngine预算恢复回归。运行npm test、test:intake、适用浏览器测试和本分支Actions。全部报告真实计数、失败/跳过与Mock次数。

不涉及#7底层忽略AbortSignal的取消生命周期或#9，不新增人工改账，不调用真实收费API，不改main/生产库/服务器/Caddy/S-UI。若必要依赖越界则BLOCKED。
