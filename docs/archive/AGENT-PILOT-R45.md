# R45 可信一次性 Runner 与真实 CLI 接力预检（#29）

开发者：Claude-Developer｜分支 `feat/claude-r45-trusted-runner-pilot`｜起点 `4c198c430806836bb289cd5da57b7fad44c7b0dc`（R44 冻结）。
本文是开发者说明，不是独立审计或 QA。**真实 Claude/Codex CLI 模型调用：NOT_RUN，real_agent_launches = 0。**

## M0 能力与依赖清单

| 项 | 状态 | 依据 |
|---|---|---|
| GitHub-hosted 一次性 Runner 上的 Node 24、git、gh、coreutils `timeout` | VERIFIED（CI） | 专属 workflow 的 `pilot` 作业 |
| Claude Code CLI 2.1.318 在 Runner 上安装，并支持非交互参数 `-p`、`--output-format json`、`--max-budget-usd`、`--permission-mode plan`、`--allowedTools`、`--no-session-persistence` | VERIFIED（CI，仅 `--version` / `--help`） | `preflight.cliStatus`；本地容器同版本同样验证 |
| Codex CLI 0.167.0 安装及 `exec --sandbox / --json` 参数 | 以 CI 实测结果为准（仅 `--help`） | 同上；本地容器未安装，为 NOT_RUN |
| Runner 可用的官方认证（`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY`） | NOT_RUN（未配置） | workflow 不引用任何 secrets；本开发会话自身的会话凭据被显式排除（`host_session_credentials: PRESENT_EXCLUDED`），子进程环境不会继承 |
| 独立门禁 Gate A：R43 `ab3e079` 的 CodeAudit 与 ProductQA 均通过 | BLOCKED（尚无独立结论） | #10 #6688764976 |
| 每次运行的费用上限 | Claude：CLI 原生 `--max-budget-usd`；Codex：无原生单次上限，默认拒绝（`COST_CAP_NOT_ENFORCEABLE`），除非账号级限额经核实 | `policy.authorize` |
| 真实 GitHub 事件 / 10 分钟兜底 | NOT_ENABLED（属 Codex R46；本包只有 fake 时钟测试） | — |
| R43 的 V1 scheduler / V2 executor | 只读参考，未修改 | 其 `cli-runner.js` 的 `LIVE_BUILD_ENABLED=false` |

**真实运行的唯一阻断**：独立 Gate A 尚未通过，且没有授权给一次性 Runner 的官方 CLI 凭据和预算。两者都不是开发者能自己解除的。工程侧的阻断已全部消除，工具会在上述条件满足后按下文流程执行。

## 组件（`tools/agent-pilot-r45/`）

| 文件 | 作用 |
|---|---|
| `contract.js` | 与 R46 的机器契约：`aijavais.pilot.envelope/v1`、`aijavais.pilot.outcome/v1`；规范化 JSON；`dedupe_key`（与触发来源无关）；`envelope_digest` |
| `policy.js` + `config.json` | Ed25519 签名（只信任具有 dispatcher 角色的配置公钥）；校验仓库、Issue、角色、分支（禁止 main 和 `..`）；签发/过期时间与最长有效期；门禁要求同一固定 SHA 的审计 ACCEPT 与 QA PASS（附 GitHub 链接）且无未关闭 P0/P1；费用必须为 `capped` 且不超过策略上限；运行时长上限；拒绝未知字段。**出厂配置不信任任何密钥，`live_enabled=false`，且运行时策略文件不能把 live 打开** |
| `preflight.js` | 只检查是否存在、只读：工具和 CLI 版本、非交互参数是否齐备、凭据是否存在（只报变量名，不读取值）、是否为 GitHub-hosted 一次性 Runner。`model_calls_made` 恒为 0 |
| `journal.js` | 私有状态目录（0700，限 tmp/RUNNER_TEMP）。状态 `CLAIMED → RUNNING → TERMINAL` 只能前进；用独占创建保证同一机器上同一工作只启动一次；同一 dispatch_id 不能用于不同工作；只认领未完成时，进程仍存活为 IN_PROGRESS，否则为 HUMAN_REVIEW_REQUIRED，**绝不自动重启**。能识别僵尸进程。只追加审计日志，日志脱敏 |
| `workspace.js` | 新建私有目录，克隆仓库并固定到精确 SHA（不符则 `WRONG_SHA`）；删除 remote；HOME 与 TMPDIR 私有；结束后检查 HEAD 和工作树未改动，否则 `READONLY_VIOLATION`；最后删除整个目录 |
| `supervisor.js` | 不经 shell；环境变量白名单；子进程独立进程组；时长上限双重保障（supervisor 看门狗 + coreutils `timeout`，即使 supervisor 崩溃也会被杀）；输出上限；取消；脱敏（`sk-`、`sk-ant-`、`ghp_` 等格式、Bearer、凭据值） |
| `runner.js` | 一个 envelope 最多对应一个进程、一个 outcome。模式：`dry_run`（默认，不克隆不启动）、`fake`（仅测试；必须 `allow_fake_cli`，且可执行文件带 `AIJAVAIS_FAKE_CLI` 标记，防止借道运行真实 CLI）、`live` |
| `handoff.js` | 对接 R46：`acceptDispatch({envelope}) → {outcome, settlement}`。settlement 中 `redispatch` 恒为 `never` |
| `templates.json` | 固定的只读任务模板；envelope 只能引用模板 ID，不能携带自由提示词 |
| `cli.js` | `preflight`、`run --envelope F --state-dir D [--live]`、`verify-outcome F`；没有 daemon、定时器或轮询 |

**live 模式全部前提**（缺一即 BLOCKED 或 REJECTED，且不重试）：
1. 审计后修改源码，把 `config.json` 的 `live_enabled` 设为 true；
2. 显式 `--live`，且 `AIJ_PILOT_LIVE=1`；
3. envelope 由受信任的 dispatcher 签名，并通过全部策略校验；
4. CLI 版本与所需参数验证通过；
5. 已配置官方凭据；
6. 运行在 GitHub-hosted 一次性 Runner 上（默认不允许本地）；
7. kill switch 未触发（`AIJ_PILOT_KILL=1` 或状态目录中的 `KILL` 文件，认领前后各检查一次）。

满足后，Claude 以下列只读参数运行：`-p <模板> --output-format json --max-budget-usd <cap> --permission-mode plan --allowedTools Read,Glob,Grep --disallowedTools Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch --no-session-persistence --strict-mcp-config --bare`。子进程只会收到该 CLI 白名单内的凭据变量，凭据值同时加入脱敏列表。

**outcome 字段**：`run_id`、`dispatch_id`、`dedupe_key`、`envelope_digest`、`source_sha`、`gate_sha`、`state`、`reason`、`retry`、`process{pid, wrapper, exit_code, signal, elapsed_ms, started_by, command_class, runtime_limit_ms}`、`cost{known, usd|null, cap_usd}`（未知时为 null，从不记 0）、`agent_launch{mode, real_agent_launch, actual_agent_launches, process_launches, cli, cli_version}`、`evidence{level, log_sha256, log_file, ci_ref, result_excerpt, previous_run_id}`。

**证据等级**：`dry_run`=E2；`fake`=E3_FAKE_CLI（真实子进程、真实 git 工作区、假 CLI，`actual_agent_launches=0`）；`live`=E4_CANDIDATE_REQUIRES_INDEPENDENT_VERIFICATION（仍需独立核验后才算 E4）。

## 负面回归（`tests/agent-pilot-r45/`，共 65 项）

- **策略**（33）：未签名或被篡改、未知密钥、无 dispatcher 角色的密钥、错误仓库、Issue、main 分支、路径穿越分支、短 SHA；过期、签发时间在未来、有效期过长；门禁 SHA 未固定、缺审计、审计 REJECT、审计的不是同一 SHA、引用不是 GitHub 链接、QA FAIL 或 BLOCKED、未关闭 P1；费用未知或为 0、超过策略、Codex 无法限额；运行时长超限；写模式；未知 CLI；夹带字段（自由提示词）；坏 dispatch id；非对象；出厂策略不信任任何密钥，live 不能被覆盖开启；契约中启动计数不一致、未知费用伪装成 0。
- **runner**（23）：默认 DRY_RUN；fake 成功（参数形态与真实 CLI 完全一致）；环境白名单（不含宿主会话、代理和 GitHub 令牌，HOME 私有）；日志脱敏；非零退出、未授权、访问拒绝、CLI 自报错误、超费、改写工作区、输出超限，每种都保证不重启；超时会杀掉整个进程组（含孙进程）；取消；CLI 不存在；未标记的可执行文件；错误 SHA；重复任务 id，以及 event 与 tick 是同一工作；dispatch id 冲突；崩溃后重启转人工；kill switch；4 个进程并发竞争只启动一次；live 模式的 6 种拒绝路径；未知模板。
- **preflight**（5）：只看凭据是否存在；排除宿主会话凭据；CLI 版本与参数验证；Runner 判定；本机真实 preflight。
- **handoff**（4）：GitHub event + 3 次 10 分钟 tick + 有效期内的重复投递只启动一次，过期重投被拒绝；tick 先到、event 后到再加重启，仍只启动一次；失败后不重派，被拒绝的投递不启动；畸形 outcome 无法结算。

CI 作业 `pilot` 在真实 GitHub-hosted Runner 上安装官方 CLI：运行全部 65 项测试和真实 preflight，并断言 `model_calls=0`、`live_ready=false`；还用真实 CLI 走一遍 `--live`，出厂策略返回 `REJECTED/UNTRUSTED_KEY`，进程启动 0 次。作业 `regression` 运行 `npm test` 和 R44 测试。

## 与 R43 / R46 的边界

- 没有修改 R43 冻结分支、`tools/agent-scheduler/**`、`tools/agent-executor/**`、共用 workflow、server、lib、public、R44 产品文件或 R46 文件。
- R46 负责：可信事件与 10 分钟兜底、跨 Runner 的远端 claim/CAS/lease、结果回写。R46 签发 envelope 并调用 `cli.js run` 或 `handoff.acceptDispatch`，读取 settlement 结算远端 claim。本包的 journal 只是单机最后防线，**不是**分布式锁。
- 合流时需要在 `config.json` 填入 R46 dispatcher 公钥（配置变更），R46 侧需要按本契约产出 envelope。是否开启 live 属于门禁决策，不在本包范围内。

## 已知限制

- Runner 自身被 `SIGKILL` 时，子进程依靠 coreutils `timeout` 在时限内终止；一次性 Runner 在作业结束时也会回收。非 GitHub-hosted 环境默认不允许 live。
- 输出中的成本与错误分类基于官方 JSON 字段和常见文本，未覆盖的错误统一归为 `NONZERO_EXIT` 并转人工，不会重试。
- Codex 的 `exec` 参数仅通过 `--help` 核对，未做真实运行。
