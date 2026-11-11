# R50 可信 GitHub 触发、10 分钟兜底与受信签名授权链（#33）

开发者：Claude-Developer｜分支 `feat/claude-r50-trusted-trigger-signing`｜base `fcf52ed855dfccacb16cef632d0e3eb202510718`（R49 冻结候选，**独立 CodeAudit #2 与 ProductQA #4 尚未签字**）。
本文是开发者说明，不是独立审计或 QA。证据等级：E2/E3_FAKE，即真实 HTTP、真实进程、真实 SQLite CAS，配合带标记的 Fake CLI 和合成密钥。**real_agent_launches = 0；real_schedule = NOT_ENABLED；real_webhook = NOT_INSTALLED；未读取或注入任何 Secrets；E4/E5 = NOT_RUN。**

## M0 复用与缺失

| 能力 | 来源（只读复用） | R50 补充 |
|---|---|---|
| Webhook 的 HMAC、仓库名与 id、fork、发送者、PR 来源的 workflow_run 检查 | R46 `triggers.webhook` | 校验 GitHub 请求头（Hookshot UA、UUID 投递 id）；更窄的事件与 action 白名单（`issue_comment:created`、`workflow_run:completed`，R46 允许 edited/reopened，R50 不允许）；App installation 绑定；新鲜度（15 分钟内，且不晚于当前时间）；**按投递 id 持久拒绝重放**（SQLite，跨进程、跨重启） |
| 10 分钟 tick | R46 `triggers.tick` | tick 必须携带默认分支 workflow 的 OIDC 身份，否则不能签名 |
| 持久去重：work key、CAS、永久墓碑、租约 | R46 `reconcile` + Ledger | 无改动；event 与 tick 落到**同一个** work key 和同一个 CAS 账本 |
| 同 SHA 绑定、签名后 Fake 执行 | R49 `control.prepare/execute`、R45 S01 修复 | broker 再次核对 source = gate = audit = qa = approval 是同一个 SHA |
| 受信签名 | **缺失**（R49 需要外部传入 `signed`） | R50 broker 接缝 |

真实环境中仍缺失、因而保持 BLOCKED 的条件：
- GitHub App 或 webhook 的安装与 secret；
- 默认分支上的 workflow（真实 cron 和 OIDC `id-token: write`）；
- KMS/HSM 签名器；
- owner 审批密钥；
- 受保护的 state-ref 真实写入；
- 官方模型凭据和可强制的费用上限；
- R49/R51 的独立双门禁。

## 组件（`tools/trusted-trigger-r50/`）

- `identity.js`：调用方身份只能由本包的校验器生成（WeakSet 标记），伪装成身份的普通对象永远不被信任。
- `intake.js`：GitHub webhook 接收与校验（见上表）。Issue 正文从不被解析为指令或批准，只用来唤醒与 tick 相同的协调流程；拒绝重放是最后一步，伪造的投递不会消耗真实投递 id。
- `oidc.js`：GitHub Actions OIDC 身份校验。
  - 用调用方提供的 JWKS 做真实 RS256 验签，拒绝 `none` 和 HS256 混淆。
  - 校验 iss、aud、repository 与其 id、`refs/heads/main`、事件（禁止 `pull_request*`）、固定的 `workflow_ref`、`github-hosted` 运行环境、时间和 SHA。
  - 没有 JWKS 时报 `BLOCKED_IDENTITY_PROVIDER`。
- `broker.js`：签名接缝。
  - 输入为三件：已验证的调用方、**结构化且由 Ed25519 签名的 owner 批准**（`aijavais.approval/v1`）、R49 准备好的 frame。
  - 批准与 frame 必须同时满足：
    - 是同一个 candidate SHA；
    - Issue、角色、task 一致；
    - 审计和 QA 引用一致，且审计为 ACCEPT*、QA 为 PASS、无未关闭 P0/P1；
    - 只能是 claude 只读任务；
    - 费用大于 0 且不超过批准值和策略值；运行时长不超过批准值；
    - frame 的有效期不超过批准的有效期。
  - **一个 approval id 只对应一份批准内容和一个工作**：同一工作重复签名是幂等的（event 与 tick 可各签一次）；同一 id 换了内容报 `APPROVAL_ID_REUSED`，换了工作报 `APPROVAL_SCOPE_EXCEEDED`。撤回之后永久拒绝。
  - 不允许使用测试签名器，除非显式声明为测试。broker 的密钥不得与 R46 的 operator/HALT 密钥、V1/V2 审计密钥或审批密钥相同（`KEY_ROLE_CONFLICT`）。
  - `productionSigner()` 报 `BLOCKED_SIGNER_NOT_CONFIGURED`；`LIVE_SIGNING_ENABLED = false`。
- `store.js`：SQLite 私有库（WAL，唯一键事务），记录投递、批准绑定、撤回和审计日志。它**不是**工作账本，工作账本的唯一权威仍是 R46 CAS。
- `pipeline.js`：依次执行 event 或 tick → R49 prepare → broker 签名 → 最后一刻再查撤回和 kill switch → R49 execute。任何环节拒绝都会 fail closed。
- `server.js`：只绑定 127.0.0.1 的接收器，绑定其他地址会被拒绝；用原始请求体校验 HMAC；413/401/409/404；从不回显请求体。
- `cli.js readiness`：列出所有阻断项，不启动任何东西。
- `templates/default-branch-trigger.yml.disabled`：默认分支 workflow 样例（`*/10`、最小权限加 `id-token: write`、受保护 Environment），已禁用。目录和扩展名都不会被 GitHub 加载。

## 默认配置（`config.json`）
`enabled=false`，`trusted_callers=[]`，`approver_keys={}`，`allow_test_signer=false`，`installation_id=null`。启用需要经过审计的改动，并补入：App installation id、默认分支 workflow ref、owner 审批公钥、KMS/HSM 签名器。

## 测试（`tests/trusted-trigger-r50/`，77 项；本地 77/77）

| 文件 | 项数 | 内容 |
|---|---|---|
| `intake.test.js` | 24 | 真实 loopback HTTP；合法的 `issue_comment` 与 `workflow_run`；重放 409，重启后仍拒绝；伪造投递不消耗 id；19 种拒绝（错误 HMAC、非 Hookshot、非 UUID、push、PR、edited、fork、仓库 id、陌生发送者、PR 评论、其他 Issue、installation 错误或缺失、过期或来自未来的事件、PR、错误 SHA、fork 或失败的 workflow_run）；413/404；非 loopback 地址拒绝 |
| `oidc-broker.test.js` | 44 | OIDC 有效与无 IdP；17 种 OIDC 拒绝；broker 正例（R45 用 broker 密钥认可签名）；22 种 broker 拒绝，包括 **S01 跨 SHA 重签**、frame 或 gate SHA 被移动、审计引用不一致、范围、预算 0 或过大、超出批准、codex、写模式、过期、有效期过长、批准里夹带自由文本字段、签名被篡改、不受信任的审批人、用 Issue 文字冒充批准、伪装的普通对象调用方、禁止合成 OIDC、已签名的 frame；一个批准对应一个工作（id 复用）与撤回；密钥分离与出厂默认值 |
| `e3.test.js` | 9 | 见下 |

E3 联合演练（真实 R49、R46、R45 模块）：

| 场景 | 实际结果 |
|---|---|
| event（真实 HTTP）后接 3 次 10 分钟 tick（fake 时钟） | SUCCEEDED，随后 3 次均为 `DUPLICATE_NO_REPLAY`；Fake CLI 启动 1 次；R46 job 1 个；4 次签名均对应同一个 work |
| **独立进程**：webhook 接收器进程与 tick 进程竞争同一个 HTTP/SQLite CAS 服务 | 只启动 1 次；只有 1 个进程越过 R45 接缝 |
| CAS 提交成功但 ACK 丢失 | 此后所有触发都启动 0 次，保留已提交的 claim |
| 接收器在运行中被 **SIGKILL** | 下一次 tick 转为 `UNKNOWN/EXPIRED_NO_REPLAY`，保留预留费用 0.1，不重新启动；悬挂的 Fake CLI 由 coreutils timeout 终止 |
| 撤回、新的审计 REJECT、QA FAIL、R46 签名 HALT、R50 KILL 文件 | 全部在启动前拦截，启动 0 次 |
| CAS 返回 403、429、500 或超时 | BLOCKED，启动 0 次，不泄露哨兵串 |
| 时钟回拨，以及费用未知（`nocost`） | 不会第二次启动；费用未知保持 null，转为 UNKNOWN |
| 缺 broker、缺批准、tick 没有 IdP、调用方未验证 | 对应 BLOCKED 原因，启动 0 次，不产生 job |
| workflow 检查 | 本分支 CI 没有 schedule、事件触发、secrets 或 `id-token: write`；默认分支样例保持禁用 |

回归：
- R49、R45、R46 冻结代码与 `fcf52ed` 逐字节一致（`git diff --quiet`）。
- R49 + R45 + R46 套件 253/253。

**E3 能证明的**：协议组合、HTTP 与 HMAC、重放、跨进程 CAS、去重和故障路径。

**E3 不能证明的**：
- 真实 GitHub App 或 webhook 投递与签名（GitHub 侧的签名链）；
- GitHub OIDC 的真实 JWKS 和 token 签发；
- GitHub schedule 的实际调度（可能延迟）；
- 跨主机的真实 ref CAS；
- KMS/HSM 签名；
- 真实模型调用与计费。

## 交给 Codex R51 的集成说明（不由 R50 修改共享代码）
1. 在 R51 分支上，只精确 cherry-pick 本包的新增内容：`tools/trusted-trigger-r50/**`、`tests/trusted-trigger-r50/**`、本文、专属 workflow。
2. 把 R51 的真实 runner 接缝放在 `pipeline.handle` 调用 `R49.execute` 的位置之后。真实运行仍需要经过审计后打开 `LIVE_*` 开关，不能只靠环境变量打开。
3. 配置真实 broker：KMS/HSM 签名器实现与 `TestSigner` 相同的接口（`keyId`、`publicPem`、`sign(bytes)`）；签名公钥写入 R45 policy；owner 审批公钥写入 `approver_keys`；R46 的 operator/HALT 密钥作为 `separatedKeys` 传入。
4. 默认分支 workflow 以 `templates/default-branch-trigger.yml.disabled` 为起点。只有在 owner 明确 GO、合入默认分支并配置受保护 Environment 之后才能启用；启用后才有真实 10 分钟兜底。
5. R46 的 `allowed_issues` 与 `allowed_senders`、R45 的 `allowed_issues` 与 `pinned_gate_sha`、R50 的 `trusted_callers`，三者要按同一个最终候选对齐。
