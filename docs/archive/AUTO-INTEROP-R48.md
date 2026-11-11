# R48 跨 Runner 协议符合性与自动接力联合演练（#31）

开发者：Claude-Developer｜分支 `feat/claude-r48-cross-runner-conformance`｜base `0b95251133d47fd7c0b9280d3ddb5287c2628307`（R45 冻结）｜R46 源 `a1a258a41c2041ab8d6cebc622cfed0c690c3387`（只读）。
本文是开发者说明，不是独立审计或 QA。证据等级：E2/E3_FAKE，即真实执行冻结源码和真实子进程，CLI 用假程序，没有调用模型。**real_agent_launches = 0，E4/E5 = NOT_RUN，真实事件与 cron 未启用。**

## 做了什么、没做什么

- `tools/agent-interop-r48/sources.js`：
  - 从两个精确的 40 位 SHA 用 `git ls-tree` 和 `git cat-file` 逐个取出文件，并逐一校验 blob id，放入新建的临时目录，文件设为只读。
  - 校验祖先链：R45 ⊇ 4c198c4，R46 ⊇ ab3e079。
  - 校验所有权：两棵树互不包含对方的包。
  - 提交缺失时报 `BLOCKED_SOURCE`，绝不退回到分支或最新版本；目标目录非空时拒绝写入。
- `bridge.js`（**仅测试**）：
  - `TestBroker` 需要显式传入 `testOnly`；私钥只存在于进程内的 WeakMap，不导出；key id 前缀为 `r48-test-broker-`，生产策略不得信任该前缀。
  - `toR45`：没有 broker 时返回 `BLOCKED_TRUSTED_SIGNATURE_BROKER`。
  - `toR46`：只做两字段映射；遇到真实启动或 E4 拒绝映射；DUPLICATE 和 DRY_RUN 报 `BLOCKED_R46_STATE_UNMAPPED`。
- `matrix.js`：36 行兼容矩阵，**全部真实执行**冻结的 R45、R46 代码，fake CLI 是真实子进程；事件与 tick 的竞争用 4 个独立的 R45 runner 进程。
- `gonogo.js`：一次真实 Claude CLI 只读演练的 16 项 GO/NO_GO 契约。只评估事实，不启动任何东西。
- `preflight-loader.js` + `cli.js`：`node tools/agent-interop-r48/cli.js matrix|gonogo [--out DIR] [--facts FILE]`。
- **没有**新建调度器、Runner 或授权系统；**没有**修改 R43、R45、R46、R47、R49、scheduler、executor、server、lib、public 或共用 CI。

## M0 接口对照（每条都由矩阵执行证实）

| 项 | R46 a1a258a | R45 0b95251 | 结论 |
|---|---|---|---|
| dedupe key 与 envelope digest | `pilotWorkKey` / `digest(frame)` | `dedupeKey` / `envelopeDigest` | **一致**（C01、C02；event 与 tick 同 key） |
| R46 内置的 R45 契约副本 | `tests/auto-handoff-r46/r45-contract-v1.fixture.cjs` | `tools/agent-pilot-r45/contract.js` | blob 均为 `a79d3fb8…`，**逐字节相同** |
| 签名 | `prepare()` 输出 `NOT_SIGNED` | 必须有 Ed25519 dispatcher 签名 | **不兼容**（C03）→ `BLOCKED_TRUSTED_SIGNATURE_BROKER` |
| 预算 | 冻结 config `max_cost=0`，frame `cap_usd=0` | cap 必须大于 0 且可强制执行 | **不兼容**（C04）`COST_UNDETERMINED` |
| CLI 类型 | fixture 默认 `codex` | codex 没有原生单次上限，拒绝 | **不兼容**（C05）；首次演练只能用 claude |
| Issue 范围 | 30 | 出厂 `allowed_issues=[29]` | 属配置差异（C06） |
| outcome 字段 | `normalize()` 读 `process.exit` 和 `evidence.level='E3_FAKE'` | 输出 `process.exit_code` 和 `'E3_FAKE_CLI'` | **不兼容**（C07）：R46 自己的测试用的是手写 outcome，而非 R45 真实输出 |
| 两字段映射之后 | — | — | **兼容**（C08、C11 的 3 行；未知费用保持 null） |
| DUPLICATE / DRY_RUN | 无对应状态 | 重复投递时返回 DUPLICATE | **不兼容**（C09） |
| 控制回路 | `reconcile()` 只接受自己的 `FakeR45Runner` | — | **不兼容**（C10）`FAKE_RUNNER_REQUIRED`：R45 的接缝没有接入控制回路 |
| 门禁 SHA | 固定为 `ab3e079`（已被 REJECT） | `pinned_gate_sha` 可配置 | **不兼容**（C13）：R46 无法指向 R47 修复 `3c37035` |
| source 与 gate 绑定 | 恒有 `gate_sha = source_sha` | 只校验 `audit.reviewed_sha == gate_sha`，**不校验 `source.sha == gate_sha`** | **UNSAFE_ACCEPTED（S01）**，属 AUD-R43-01 同类问题 |

## 安全行（S02–S21，全部 SAFE_REFUSAL，真实执行）

覆盖范围：
- **错误或未审计的 SHA**：重签名后的 frame 指向其他候选（S02）；R46 envelope 指向未固定的 SHA（S03）。
- **独立门禁**：真实的 ab3e REJECT，以及 broker 签名的 REJECT（S04、S05）；QA FAIL（S06）。
- **签名与触发**：伪造签名、不受信任的 key、出厂策略（S07）；fork、陌生发送者、PR 触发的 workflow_run、错误 HMAC（S08）。
- **去重与重派**：
  - 同一工作先 tick 后 event，只启动 1 次（S09）。
  - 4 个进程竞争，只启动 1 次（S10）。
  - 丢失 ACK 后重投，不重新启动（S11）。
  - 失败形成永久墓碑（S12）。
- **费用**：费用未知或超出上限（S13）。
- **网络与执行控制**：
  - R46 远端 403/429 时不派发，只读重查（S14）。
  - 超时（S15）；取消（S16）。
  - R45 的 KILL 和 R46 签名的 HALT，runner 调用 0 次（S17）。
- **工作区与运行状态**：
  - **已提交**的越界改动，HEAD 变化被识别为 READONLY_VIOLATION（S18）。
  - 重启后有未完成的认领，转 HUMAN_REVIEW_REQUIRED，启动 0 次（S19）。
  - 输出脱敏（S20）。
  - 出厂配置：R45 live 关闭，R46 为 DISABLED（S21）。

## 交给统一集成人的最小差异（不由 R48 修改）

1. **（P1 候选，阻断 GO）** R45 `policy.authorize()` 增加一条：`source.sha === gate.gate_sha`，否则拒绝。R46 本来就发送相同的值，零代价。修复后矩阵 S01 应变为 SAFE_REFUSAL。
2. 增加一个经过审计的可信 dispatcher 签名环节，在两个门禁通过后签署 R46 frame。私钥只放在控制平面环境中，不使用任何测试 key。
3. R46 → R45 的 outcome 适配：`process.exit ← process.exit_code`，`evidence.level 'E3_FAKE' ← 'E3_FAKE_CLI'`；真实启动另行定义 E4 通道，不能借用 Fake 标签。
4. R46 增加对 R45 `DUPLICATE` 的处理，视同 `RUNNER_WORK_ALREADY_RECORDED`（只读重查、不重派，保留 previous_run_id）。
5. R46 `reconcile()` 增加一个经过审计的 runner 接缝，依次为：claim → prepare → 签名 → R45 runOnce → 第 3 条的适配 → normalize → settle。
6. 配置对齐：R46 `max_cost` 和 `max_daily_cost` 大于 0 且不超过 R45 `max_budget_usd`；首次演练 kind 用 `claude`；R45 的 `allowed_issues` 包含控制平面使用的 Issue。
7. R47 获独立 ACCEPT 后，把 R46 的 `SOURCE` 和 R45 的 `pinned_gate_sha` 都改为那个被接受的 SHA。这是代码改动，需要审计，不能放宽固定。

## GO/NO_GO（M3）

当前结论为 **NO_GO**。

| 状态 | 项目 |
|---|---|
| BLOCKED | G01 R47 独立审计未 ACCEPT；G02 ProductQA 未 PASS；G04 协议差异未关闭；G05 source 未绑定 gate（S01） |
| NOT_RUN | G03 统一候选尚未冻结或审计（Codex #32）；G06 本地不是一次性 Runner（CI 上为 SATISFIED）；G11 真实 ref 的 CAS 未验证 |
| NOT_CONFIGURED | G07 一次性 Runner 内没有官方凭据；G09 没有可信签名 key；G13 kill switch 运行手册未编写 |
| NOT_ENABLED | G10 默认分支上的 event 与 10 分钟 cron |
| 已由 Fake 演练证明的机制 | G08 预算与超时、G12 kill switch 机制、G14 重复任务审计轨迹、G15 生产隔离、G16 live 开关保持 OFF |

**真实运行前**，审核方需要拿到以下证据：
- 统一候选的 40 位 SHA，以及该 SHA 上的 CI（列出全部 job）；
- 在该 SHA 上重跑的本矩阵，要求 0 行不兼容、0 行不安全；
- 同一 Runner 上的 R45 preflight 结果；
- 单次真实运行的 R45 outcome（pid、exit、cost、log 哈希），以及 R46 settlement（redispatch=never）；
- 对同一工作的第二次触发返回 DUPLICATE，且没有新增启动。

## 测试（`tests/agent-interop-r48/`，49 项）

| 文件 | 项数 | 内容 |
|---|---|---|
| `sources-bridge.test.js` | 7 | 精确 SHA 装配与只读、缺失 SHA 时 BLOCKED_SOURCE、不覆盖非空目录、门禁事实区分、TestBroker、bridge 正反例 |
| `matrix.test.js` | 40 | 36 行逐行固定 verdict（已知差距按差距断言，不隐藏）、关键事实、GO/NO_GO 真实矩阵为 NO_GO、全部满足才 GO 且任何单项缺失都是 NO_GO |
| `frozen-suites.test.js` | 2 | R46 自有测试在精确 SHA 树中重跑 101/101；R45 在本分支与 0b95251 逐字节一致，65/65 |

运行方式：`node --test tests/agent-interop-r48/*.test.js`（需要可访问的 0b95251、a1a258a、ab3e079 提交）。
