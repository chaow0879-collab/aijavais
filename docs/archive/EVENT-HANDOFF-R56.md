# R56 GitHub 事件 + 10 分钟兜底自动接力（#39）

开发者：Claude-Developer｜分支 `feat/claude-r56-event-handoff-bridge`｜基线 R55 `8e9584149cccac02fa0b5c39a68c1983ec60170e`。本文是开发者说明，不是独立审计或产品验收。

证据等级：
- E2：纯决策测试。
- E3_FAKE：本地 GitHub 模拟器（HTTP + SQLite）、Git-ref CAS 服务、R50 SQLite 存储、真实 Node 子进程，以及带标记的 Fake CLI。

**真实模型 0 次调用；未使用 Secrets；未改 main；没有安装真实 schedule 或 webhook，也没有写入真实 state-ref。E4/E5：NOT_RUN。**

## 目标与边界

目标：用 GitHub 上可信、结构化的任务变化，加上 10 分钟兜底，取代“负责人手动把提示词复制给下一个 AGENT”。

本包只做**最后一公里的控制平面**，完全复用已有能力：
- R50：可信事件 / OIDC / tick，以及 broker 签名；
- R51：`handleTrusted` 受控入口与官方 CLI 端口（`LIVE_BUILD_DISABLED`）；
- R49：prepare/execute；
- R46：CAS 账本、租约、墓碑与 `after` 链；
- R45：一次性进程。

**不新增**调度器、队列、数据库或签名格式。

**BLOCKED_ACTUAL_RUNNER_IDENTITY**：已经停止的 Claude/Codex 聊天会话不能被 GitHub issue 唤醒。真实接力需要：
- 经审计的官方 CLI 运行身份；
- 可强制执行的费用上限；
- 所有者 GO。

## M0 依赖审计（复用与缺口）

| 能力 | 来源（只读复用） | R56 补充 |
|---|---|---|
| Webhook HMAC、重放墓碑、OIDC tick | R50 `intake/oidc/pipeline`、`identity.isMinted` | 桥只接受 R50 校验后签发的身份（`github_webhook` / `github_actions_oidc`）；普通对象一律视为 `UNTRUSTED_TRIGGER` |
| 结构化报告块 | `agent-scheduler/state.parse`（`[AGENT_REPORT_V1] … [/AGENT_REPORT_V1]`） | 只认可信 actor、OWNER/MEMBER/COLLABORATOR、非 PR 评论；自由文本永远不被当作命令或批准 |
| 签名证明格式 | R46 / agent-executor 的 `{key_id, payload, signature}`（对 canonical(payload) 做 Ed25519 签名） | 审计/QA 结论携带同样结构的签名证明，绑定 `role / verdict / reviewed_sha / work_item / issue / expires_at` |
| 持久去重、租约、墓碑、阶段依赖 | R46 Ledger CAS、`after`、`recover`、`halt` | 阶段 i+1 的 `after` 等于阶段 i 的 idempotency key；租约过期时调用 R46 `recover` 记为 `UNKNOWN / EXPIRED_NO_REPLAY` |
| 受控执行 | R51 `handleTrusted` → R50 broker → R49 → R46 → R45 | `provision(ticket)` 返回准备好的信封，桥先核对绑定再启动 |
| 官方 CLI | R51 `official-port`（`LIVE_BUILD_DISABLED`） | live 模式直接返回 BLOCKED，不读取任何凭据 getter |

真实环境仍缺、因此保持 BLOCKED 的条件：
- GitHub App / webhook secret；
- 默认分支 workflow 与 OIDC；
- KMS/HSM 签名器；
- 评审人公钥；
- 受保护 state-ref 的 CAS；
- 官方 CLI 身份与费用硬上限（R57 `runOnce`）；
- R55/R57 的最终独立审计与 QA；
- 所有者 GO。

`cli.js readiness` 会逐项列出这些阻断。

## 组件（`tools/event-handoff-r56/`）

- **`facts.js`**：从 GitHub 快照提取可信事实。
  - **候选**：取工作项 issue 上候选角色**最新一条**可信报告。状态为 READY_FOR_REVIEW 且 head_sha 为 40 位时才算候选；其他状态视为撤回。
  - **撤回 / 拒绝**：所有者的撤回块，以及审计/QA 的 REJECT/FAIL，无论顺序都优先于任何 ACCEPT。
  - **审计/QA**：只认同 SHA、带已注册评审公钥签名、绑定 work_item 的结论。评审人必须是两个不同的人，使用不同的公钥，且不是作者。
  - **CI**：要求同 SHA、同分支、push 或 workflow_dispatch、非 fork、白名单 workflow，且必需的 job 全部成功。
  - 快照不完整或过期时返回 UNKNOWN，不会当作“无事可做”。
- **`machine.js`**：纯决策函数，依次检查：
  `WAIT_CANDIDATE` → `BLOCKED_CANDIDATE_WITHDRAWN / BLOCKED_REVOKED / BLOCKED_SHA_MOVED / BLOCKED_REJECTED` → `WAIT_CI` → `WAIT_AUTHORIZED_REVIEWER`（附待办，绝不由 bot 伪造 ACCEPT）→ `BLOCKED_REVIEW_INDEPENDENCE` → 按阶段逐个处理：
  `READY_STAGE`（生成工单）/ `WAIT_STAGE_RUNNING` / `BLOCKED_STAGE_UNKNOWN`（含租约过期）/ `BLOCKED_STAGE_*` → `HANDOFF_COMPLETE`。
  工单只包含结构化字段：SHA、引用、`after`、idempotency key，不含粘贴的提示词。
- **`bridge.js`**：一次 reconcile 的流程是：kill switch → 可信触发 → 读快照 → 读 R46 账本 → 决策 → 需要时调用 R46 recover → `provision` → 核对绑定（identity、after、SHA、分支、issue、角色、阶段、kind、审计与 QA 引用）→ 启动 → 核对 R50 work_key → 发布结构化阶段报告。
  报告只是给人看的证据，权威状态始终在 R46 账本里。`LIVE_HANDOFF_ENABLED = false`。
- **`github.js`**：固定路由的读取客户端，外加一条报告路由（POST 到 issue 评论，请求体只允许 `body`）。live transport 在编译期关闭。
- **`cli.js`**：
  - `readiness`：列出阻断项与“所有者一次性激活清单”；
  - `next --role`：各角色的包装入口，从工作项拉取结构化工单或等待原因；
  - `tick`：live 下返回 BLOCKED。
- **`pipeline.json`**：默认关闭，actor、评审公钥、CI 策略、工作项都为空。
- **`templates/r56-event-handoff.yml.disabled`**：未来的默认分支 workflow 样例，**已禁用**，GitHub 不会加载。内容包括：`*/10` cron、workflow_run / issue_comment / 手动 HALT 触发、最小权限（`contents: read`、`issues: write`、`id-token: write`）、`concurrency` 设为不取消（以 CAS 结果为准，而不是 runner）、受保护的 Environment。GitHub 的定时任务可能延迟，正确性不依赖 10 分钟的准时程度。

## 状态机迁移与人工动作统计

`开发者/集成者 READY 报告（人，必需）` → 事件唤醒 → `WAIT_CI` → `workflow_run` 事件 → `WAIT_AUTHORIZED_REVIEWER`（等待真人独立评审）→ `审计 + QA 签名结论（人，必需）` → tick → 阶段 1 → tick/事件 → 阶段 2 → 阶段 3 → `HANDOFF_COMPLETE`。

E3 中的人工动作：1 条候选报告 + 2 条签名评审（都是真实决策）。**每个阶段需要的提示词粘贴：0 次。** 阶段推进完全由事件和 tick 驱动。真实运行中这些动作还没有发生（NOT_RUN）。

## 测试（`tests/event-handoff-r56/`，9 项）

- **E2 决策**：
  - 门禁顺序与 `after` 链；租约过期；UNKNOWN / FAILED；账本不可读。
  - 撤回、所有者撤销、SHA 被移动、晚到的 REJECT 或 FAIL 都优先于批准。
  - fork、PR、job 失败、SHA 不同的 CI 都不算。
  - 以下 9 种评审都不被接受：不可信账号、PR 评论、关联身份为 NONE、未注册公钥、错误签名、未知 key_id、篡改绑定、已过期、只有 ACCEPT 文字没有签名。
  - 独立性三种情况：同一人、评审人是作者、两个角色用同一把公钥。
  - 自由文本里的“命令”不算报告；快照过期或不完整；无效工作项（含 main 分支）。
- **E2 bridge/cli**：live 模式返回 `BLOCKED_ACTUAL_RUNNER_IDENTITY`，且不访问任何 getter；伪造的触发对象被拒；路由白名单；模板已禁用；专属 CI 不含 schedule、secret 或 OIDC。
- **范围**：只写入 R56 自己的路径。
- **E3 全链**：开发者报告事件 → CI 事件 → 等待评审 → 签名评审 → tick 推进 3 个阶段（integration → audit → qa）→ 完成。重复的 tick 和事件不会再次启动。结果是 3 次 Fake 启动、3 条机器报告，R46 账本里 3 个 job 全部 SUCCEEDED。
- **E3 角色包装**：`next --role` 在进程内和真实 CLI 进程中返回同一张工单；工单内容只有引用和 SHA。
- **E3 故障**（都在启动前或零重放地失败关闭）：

| 场景 | 结果 |
|---|---|
| SHA 被移动 | `BLOCKED_SHA_MOVED` |
| 第 1 阶段后出现晚到的 REJECT | 永久 `BLOCKED_REJECTED` |
| 费用未知 | R46 `COST_UNKNOWN_NO_REPLAY`，链条停止 |
| 运营者签名的 R46 HALT | `PERSISTENT_HALT`，0 次启动 |
| kill 文件 | 在读取任何数据之前就拒绝 |
| GitHub 返回 500/403/429 或超时 | UNKNOWN，0 次启动 |
| CAS 丢失 ACK | 0 次启动 → `WAIT_STAGE_RUNNING` → 租约到期后 `EXPIRED_NO_REPLAY` |
| 同一工作被另一个 runner 用不同任务名领取 | R46 `RUNNER_WORK_ALREADY_RECORDED` |

- **E3 多进程**：
  - 4 个 OS 进程同时竞争阶段 1（2 个用同一投递的事件 + 2 个 tick）：只启动 1 次；其余进程分别被重放墓碑、CAS 冲突和参数不同的墓碑拦下。
  - 阶段进行中 SIGKILL 子进程（Fake CLI 处于挂起状态）：先是 `WAIT_STAGE_RUNNING`；租约到期后由 R46 recover 记为 `UNKNOWN / EXPIRED_NO_REPLAY`，不会重新派发。
- **回归**：R46 + R49 + R50 + R51 共 364/364；`npm test` 276/276（本地）。

## 交给 Codex R57 的集成说明（R56 不修改共享代码）

1. 只精确 cherry-pick 本包新增的提交：`tools/event-handoff-r56/**`、`tests/event-handoff-r56/**`、本文、专属 workflow。
2. R57 的 `runOnce` 接在 `bridge.step` 的 `provision(ticket, trigger)` 返回的 `launch` 上。live 版本必须先通过 R51 `official-port` 的编译期开关、provider 费用上限与所有者 GO；R56 自身的 `LIVE_HANDOFF_ENABLED` 和 `LIVE_TRANSPORT_ENABLED` 只能通过经审计的源码修改打开。
3. 真实 `provision` 应由运营者授权的 R49 manifest 与 R50 审批生成信封；R56 只核对它与工单完全一致。
4. 上游变更请求（R56 未修改）：
   - R46 envelope 的 `audit_refs` 固定要求 #2 / #4 评论，适合当前流程；如需新的评审 issue，需要在 R46 契约层扩展。
   - 多进程竞争时，各进程独立准备的信封参数不同，会触发 `TASK_PARAMETERS_CHANGED` 墓碑。这是失败关闭的正确行为，但真实部署应由同一份运营者签名准备，使信封字节一致，从而走到 `DUPLICATE_NO_REPLAY`。
