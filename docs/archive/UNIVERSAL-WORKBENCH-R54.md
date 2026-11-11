# 通用 AI 工作台接入 R53 后端：逐岗授权、定向返工、服务器验收与真实事件（#37 R54）

开发者：Claude-Developer｜分支 `feat/claude-r54-workbench-live-contract-ux`｜基线 R52 `0532f606258d06bf5215907b1566dc419a86cab5`｜后端契约（只读依据）`integrate/codex-r53-universal-workflow@397b46c18e25aaddc3e92886693da4ef3f2528d3`。
本文是开发者说明，不是独立审计或产品验收。

证据等级：
- E2：纯模块测试。
- E3_FAKE：真实 Chromium + R53 真实后端代码（HTTP + 认证 + SQLite）+ 本地 Mock 模型。

E4（真实厂商）与 E5（真实用户或领域专家）**NOT_RUN**。没有使用 Secrets、收费模型、main、生产或真实调度。

本包只修改 Claude 独占路径：`public/haloflux-workbench-r52/**`、`tests/haloflux-workbench-r52/**`（仅在 R52 范围测试的允许列表中加入 R54 路径）、`tests/haloflux-workbench-r54/**`、本文，以及 `.github/workflows/claude-r54-workbench.yml`。

**不提交任何 R53 后端文件**。E3 测试运行时，把 R53 固定提交以临时本地 clone（`git clone --shared`，不是 worktree）的方式检出到临时目录，只把 Claude 独占的前端文件覆盖进去，然后启动真实服务器。

## M0 字段对齐（R52 页面 → R54 页面）

| 能力 | R52 使用 | R54 使用（R53 契约） | 说明 |
|---|---|---|---|
| 方案 | 本地离线规则 + `/api/v2/intake/plan` 查工具 | `POST /api/v2/universal/plan` → `PLAN_SIMULATED / E2_RULES_NOT_AI`；岗位、步骤（`kind: work/peer_review`）、验收标准 `criterion-N` 以服务器为准 | 本地规则只保留诚实信息：理解程度、做不到的事。模型只从服务器 `modelRecommendations` 中选取 |
| 保存 | `POST /api/v2/projects`（每次新建） | 首次 `POST /universal/projects`；之后 `PUT /projects/:id` 并带 `expectedVersion` | 版本冲突返回 409 时提示“方案已被修改，请重新载入”，不自动覆盖 |
| 授权 | 全局上限 + 允许的操作 | `rolePermissions[roleId] = {approved, connectionId, allowedTools, maxTokens, maxCost}`，外加全局 `approved/maxTokens/maxCost`，还有 `requestId` | 每个岗位显示 `approved`、`blocked`（无模型 / 远程收费模型 `BLOCKED_UNENFORCEABLE_COST_CAP`）、`待批准`，以及 `unknown_cost` 标记。**修改团队、步骤或模型会撤销所有岗位的批准**；只改某个岗位的上限时保留其他岗位的批准 |
| 幂等 | 无 | `requestId` = 动作 + 规范化内容 + 生成计数的哈希 | 网络中断后，同内容重试复用同一个 ID，服务器返回 `duplicate/noReplay`，不会重复派发。同 ID 不同内容返回 `idempotency_key_reused`，页面会解释原因 |
| 事件 | V2 快照，每次重建 | `GET /universal/runs/:id/workbench?after=&limit=`：服务器稳定的单工作 seq，按游标增量拉取 | 断线重连时重叠的事件被去重；游标倒退直接报错。先拉事件、再读运行状态，保证控制按钮的状态不比事件旧 |
| 状态与轮次 | run.status | `GET /universal/runs/:id`：`round`、`reviews`、`executionActive`、`cost{usd:null, estimatedUpperBound, unknown}`、`projectSnapshot` | 刷新时 `?run=` 从服务器重建快照方案、事件、文件和逐项检查 |
| 返工 | 整轮返工，步骤只写进反馈文字 | `POST /universal/runs/:id/rework`：`fromStepId` + 反馈 + **新的完整授权** + `requestId` | 起始步骤之前的步骤复用服务器保存的成果；页面显示轮次变化和审查记录 |
| 逐项检查 | 只存浏览器本地 | `POST /universal/runs/:id/criteria`：`{requestId, expectedRound, checks}`，以不可变 JSON 文件和事件形式存档 | 刷新后从服务器读回；页面显示“有未保存的修改”或“服务器已保存第 N 轮” |
| 交付文件 | `/runs/:id/export` | `POST /universal/runs/:id/deliver` → `{artifact: round, sha256, sourceArtifactId}` | 文件按轮次列出。旧轮次标为“旧轮次，不能验收”，下载后的 SHA-256 与服务器一致 |
| 验收 | 本地“验收通过” | `POST /universal/runs/:id/accept`：`{artifactId, sha256, confirmCriteria, acknowledgeSimulation, acknowledgeUnknownCost?, expertReviewNote?}` | 只能选当前轮次的交付文件。人工验收与“专业质量：NOT_VERIFIED”分开显示 |
| 取消 | `/runs/:id/cancel` | `POST /universal/runs/:id/cancel` | 取消后岗位不会显示为“已完成”；已发生的费用以账本为准 |

身份与权限：所有请求复用现有管理员会话和同源门禁。未登录访问页面会跳到登录页，API 返回 401。浏览器不能声明“已验收”：“已完成”必须同时满足两点——服务器记录了 `run_approved`，而且存在服务器真实生成的文件。

## M1–M4 用户旅程

1. 写一句目标，系统生成服务器草案（PLAN_SIMULATED），并列出团队做不到的事。
2. 编辑岗位、步骤和步骤类型。至少要有一个独立复核步骤，而且必须排在其他岗位的工作之后，前端校验规则与服务器一致。
3. 在“逐岗授权”里逐个批准岗位（支持键盘和触屏），再确认整体授权，然后开始工作。
4. HALOFLUX 只投影服务器事件：
   - `agent_started` 只代表派发尝试，显示为“已启动”；只有服务器收到首个输出片段后才有 `work_started`，显示为“工作中”。Mock 挂起时，节点一直显示“已启动”，**不会伪装成工作中**。
   - 显式交接线带来源事件 ID；接收方开始工作后，交出方显示为“已完成”。
5. 交付后：
   - 生成 Word / Excel / 演示文件；
   - 逐项检查并保存到服务器，任何一项未通过都会被服务器拒绝验收，页面用人话解释原因；
   - 可以从指定步骤定向返工（需要重新批准）；
   - 只能验收当前轮次的文件；
   - 费用未知时需要额外确认；高风险任务需要填写人工审查说明（平台不认证）。
6. 费用：每笔事件的厂商账单都是未知（`usd:null`），合计显示“未知（不是 0）”；本地估算上界单独显示。

## 交给 Codex R55 的后端观察（R54 不改后端）

1. **R53 自带测试在没有 `.git` 的导出目录中会失败**：`workflow.test.js` 第 34 行要求 `source_sha` 为 40 位。`git archive` 导出的目录里没有 `.git`，后端如实返回 null，因此 31 项中有 2 项失败。在纯 R53 导出目录中复现结果相同，与 R54 无关。R54 的测试改用临时本地 clone，31/31 通过。建议：测试区分“无 git 元数据”的情况，或者文档注明测试必须在 git 检出目录中运行。
2. `workbench` 快照里的 artifact 没有 `round` 和 `format`，前端需要与 `GET /universal/runs/:id` 的 `artifacts` 合并才能判断当前轮次。建议直接在 DTO 中提供。
3. 逐项检查结果只能通过下载 `human_criteria` JSON 文件读回。建议在运行视图中直接返回当前轮次的检查结果。
4. `accept` 和 `cancel` 不接受 `requestId`：它们靠状态机挡住重复调用（重复调用返回 409），前端会提示，但不是请求级幂等。
5. 显式 `handoff` 事件的 `role_id` 是交出方。R54 的投影规则是：接收方开始工作时，交出方转为“已完成”。这个规则对 R52 的 fixture 同样成立。

## 测试（`tests/haloflux-workbench-r54/`）

- `overlay.cjs`：在临时本地 clone 中检出 R53 `397b46c`，覆盖 Claude 独占的前端文件，再启动真实服务器并接入本地 Mock（模式 ok / hang / unknown）。缺少 R53 提交时直接报 BLOCKED，不会静默跳过。
- `live-contract.test.js`（4 项）：
  - **纯 E2**：契约映射、远程收费模型阻断、复核规则、授权撤销与保留、请求体、请求 ID 稳定性、错误码解释；游标分页、重叠去重、游标倒退报错。
  - **E3 主流程**：
    - 8 个盲测目标经服务器方案后得到不同团队，0 次调用；未登录返回 401；
    - 带版本的保存与 409 冲突；5 种逐岗拒绝都是 0 次派发；
    - 相同请求重试返回 duplicate；同 ID 不同内容返回 409；
    - 小页增量拉取、倒序与重复输入投影一致；各岗位显示已完成并有显式交接线；厂商账单未知；
    - 交付文件的下载 SHA 与服务器一致；逐项检查不通过时拒绝验收；
    - 从第 3 步返工后服务器只重跑后缀（6/8 步）；旧轮次文件返回 409；第 2 轮验收后专业质量为 `NOT_VERIFIED`；
    - DOCX 用 python-docx 独立解析，内容带 E3 标记。
  - **E3 异常**：用量未知时必须确认费用未知；运行中取消；高风险任务必须填写人工审查说明。
- `r53-compat.cjs`：在 overlay 中运行 Codex 自己的 R53 套件，31/31 通过。这证明 R54 对 `contract.js` 和 `projector.js` 的改动不会破坏 R53 后端与互通测试。
- `workbench-live.e2e.js`（真实 Chromium，11 项检查）：

| 检查 | 场景 |
|---|---|
| `unauthenticated-redirect` | 未登录跳转登录页 |
| `blind-goals-live-plan` | 8 个盲测目标，生成至少 6 种不同团队 |
| `live-started-not-faked-as-working` | 挂起时节点只显示“已启动”，不伪装工作中 |
| `refresh-recovery` | 刷新后从服务器快照恢复 |
| `network-interruption` | 断网横幅，且不显示忙碌 |
| `deliver-and-download-sha` | 下载的 SHA 与服务器一致 |
| `server-criteria-block-acceptance` | 服务器保存的逐项检查阻止验收；刷新后从服务器读回 |
| `targeted-rework-and-acceptance` | 从第 3 步返工，第 2 轮验收后显示“已完成”，专业质量未验证 |
| `cancel-mid-run` | 运行中取消 |
| `unknown-cost-acknowledgement` | 费用未知需要确认 |
| `phone-and-reduced-motion` | 手机 390px 加减少动效 |

- 回归：
  - R52 Node 测试 12 项，R44 加立项测试 22 项，共 34/34；
  - R52 Chromium 11/11（旧 V2 路径）；
  - `npm test` 全量。
  - 测试数量以本分支 CI 为准。

## 已知限制

- 返工和验收都只在 R53 后端可用；旧服务器自动回退到 R52 的 V2 行为，并保留原有文案说明。
- 刷新后恢复的方案是服务器运行快照，只读，不能另存。返工需要在“逐岗授权”里重新批准。
- 截图证据：侧栏固定时，整页截图拍不到侧栏，所以改用元素截图。
- 真实厂商模型、远程费用硬上限、领域专家评审：NOT_RUN 或 BLOCKED，等待所有者 GO。
