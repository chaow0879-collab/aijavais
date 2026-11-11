# 零技术门槛 AI 虚拟公司工作台 + HALOFLUX 真实事件投影（#35 R52）

开发者：Claude-Developer｜分支 `feat/claude-r52-universal-halo-workbench`｜基线 `4c198c430806836bb289cd5da57b7fad44c7b0dc`（R44）。
本文是开发者说明，不是独立审计或产品验收。

证据等级：
- E2：纯模块 Node 测试。
- E3_FAKE：真实 `server.js` + 认证 + SQLite + HTTP + 真实 Chromium + **本地 Mock 模型**。

真实模型（E4）与真实用户（E5）均为 **NOT_RUN**。没有使用 Secrets、收费模型、main、生产环境或真实自动执行。

入口：`/haloflux-workbench-r52/index.html`（需登录，与其他页面相同）。

## M0 基线与用户旅程

保留不动的部分：
- R44 动态编队（`universal-team.js`）；
- 立项向导、项目工作台 `workspace.*`；
- HALOFLUX 大屏 `panel.html`。

本包对 R44 唯一的改动，是在 `universal-team.js` 的识别规则里补充了常见词：轮班表、排班表、值班表、定价表、成本表、库存表、通讯录、名录，以及体检、疾病、减压病、伤病。R44 测试仍为 22/22。

**HALOFLUX 视觉授权**：`panel.html` 的 HALOFLUX 采用 PolyForm Noncommercial 许可（见 `NOTICE.md`），禁止商业使用。R52 的光环是**独立编写的 SVG**，没有复制 `panel.html` 的代码或参数；它只沿用“中央光环、光束、粒子、工作节点”的产品概念。HALOFLUX 名称与原视觉能否商用，仍**待所有者授权核查（PENDING）**。

用户旅程（普通用户不需要懂 GitHub、CI 或 SHA）：
1. **一句话目标**：在一个主输入框里写，可选补充领域、对象、成功标准、限制。
2. **系统提出可编辑的团队**，同时如实说明：
   - 理解程度（高 / 一般 / 低）；
   - 团队做不到、需要真人的事：线下实体操作、对外发布或付款、实时信息、账号密码、持证专家审查；
   - 必须补充的信息，点“去填写”直接跳到对应输入框；
   - 阻断与提醒。
3. **编辑**：增删岗位；改名称、职责、边界、验收标准；更换模型。步骤可上移/下移（键盘与触屏都可操作），可改负责岗位、成果和检查标准，可移除工具。验收标准可增删。
4. **授权与预算**：
   - 选择允许的操作。“对外发布、付款、发送消息”永远不允许，界面里是禁用状态。
   - 设置费用和 Token 上限；收费模型需要单独批准，并填写单价。
   - 勾选确认后才能开始。**之后任何编辑都会让确认失效。**
   - 浏览器只生成申请，服务器仍会再次检查一切；服务器拒绝时原文显示拒绝原因。
5. **开始工作**：保存项目、启动运行，都经由已有 API（`POST /api/v2/projects`、`POST /api/v2/projects/:id/runs`）。运行进行中“开始工作”按钮禁用，防止重复派发。
6. **HALOFLUX**：只投影服务器记录的事件。也能导入 R53 格式的事件文件回放，或看明确标注的 DEMO。
7. **成果与验收**：
   - 显示服务器真实生成的文件（带 sha256，可下载），MOCK 和 FIXTURE 文件另有标注；
   - 逐条“人工已验 / 未验 / 不合格”只保存在本浏览器；
   - 有不合格项时不能验收；
   - 可以导出 Word、Excel、演示文稿；
   - 可以要求返工（可指明步骤），返工是一次新的授权；
   - 必须同时满足“有真实文件”和“服务器记录了验收”才显示“已完成”。

## 事件 → 界面语义表（唯一来源：事件）

| 事件 `type` | 岗位节点 | 任务阶段 | 光环 |
|---|---|---|---|
| 无事件 | 待命 | 无事件 | IDLE：灰色、无动画，并提示“没有真实事件” |
| `task_created` | — | 任务已创建 | 静止 |
| `approved` | — | 已授权（服务器接受了本轮授权） | 静止 |
| `agent_started` / `work_started` / `tool_used` | 已启动 / 工作中 | 工作中 | 光束点亮；仅当 busy 时环转动、节点脉动 |
| `handoff`（`to_role_id`） | 交接中 | 工作中 | 交接线加粒子，记录 `cause_event_id` |
| 前一岗位 `completed` 后，另一岗位 `work_started` | — | — | **推导**的交接线，记录完成事件与启动事件两个 ID |
| `peer_review` | 审核中 | 审核中 | 紫色 |
| `rework_requested` | 返工中（不带 role 时整个任务进入返工） | 返工中 | 黄色 |
| `blocked` / `failed` | 受阻 / 失败 | 受阻 / 失败 | 红色 |
| `completed` | 已完成本步 | — | 绿色 |
| `delivered` | — | 待验收 | — |
| `accepted` | — | 已验收 | — |
| `cancelled`（带 role 为岗位取消，不带为任务取消） | 已取消（**不会**变成已完成） | 已取消 | 灰色虚线 |
| `interrupted` | 状态未知 | 中断·未知 | 不动画 |
| `cost_reported` | — | — | 费用面板：unknown 保持 null，**不当作 0** |
| `retracted`（`retracts`） | 撤回目标后从头重新计算 | — | 记录里标注“已撤回” |
| 未识别的类型 | 不改变状态 | — | 记录里标注“未识别” |

投影规则（`projector.js`，纯函数、确定性）：
- **幂等**：相同 `event_id` 且内容相同时忽略；内容不同记为冲突，保留首次记录。序号被不同事件占用也记为冲突。
- **有序**：严格按 `seq` 应用。后续事件先缓冲，并报告缺口（例如“缺少事件 #10”）。有缺口时**不显示忙碌**。
- **因果**：`parent_event_id` 尚未出现时标注 `missing_parent`，父事件序号在子事件之后时标注 `parent_after_child`。
- **断线或静默**：显示最后已知状态并标为过期（stale），停止动画，状态**不会自行推进**。
- **busy**：只有当存在已应用的事件、有岗位处于活动状态、连接正常且没有缺口时才显示忙碌。
- **动效**：“静态显示”开关和系统“减少动态效果”设置都会关闭动画，光环降级为静态图。

## 组件（`public/haloflux-workbench-r52/`）

- `contract.js`：
  - 定义三种 DTO：`aijavais.workbench.plan/v1`、`event/v1`、`artifact/v1`，以及证据枚举 `DEMO | FIXTURE | E2_FAKE | E3_FAKE | SERVER_RECORDED | E4 | E5`。
  - `fromV2Run()` 只读适配已有的 `GET /api/v2/runs/:id`：事件、费用账本行、成果文件。
- `planner.js`：一句目标 → 方案 DTO（复用 R44 规则）。包括理解程度、做不到的事、模型与工具状态、阻断项；方案恒为 `SIMULATED`，生成时不调用模型。工具状态可由已有的 `/api/v2/intake/plan`（不调用模型）提供服务器真实结果。
- `editor.js`：不可变编辑（12 岗位、30 步骤上限，字段长度上限）。`toProject()` 生成已有项目 API 的请求体，保留用户调整的步骤顺序。`runRequest()` 生成已有运行 API 的请求体：先报告真正的阻断，再报告“未确认”。
- `projector.js`、`halo.js`（SVG）、`acceptance.js`、`demo.js`（每条事件都标 DEMO，不含 approved 或 accepted）、`app.js`（只用 `textContent`，不用 innerHTML）。

## 与 Codex R53 的集成说明

1. R53 只要按 `aijavais.workbench.event/v1` 输出 append-only 事件流（每个 work 内 `seq` 从 1 起连续），就能直接被 `R52Projector.createProjector().ingest()` 增量消费；成果文件按 `artifact/v1` 提供。字段名见 `contract.js` 的 `validateEvent` 与 `validateArtifact`，样例见 `tests/haloflux-workbench-r52/fixtures.cjs`。
2. **已有的 V2 运行视图是完整快照**：适配器每次都重新编号，所以工作台每次轮询都**重建**投影，不做增量追加。测试里记录了增量追加会产生 seq 冲突。R53 如果改为增量流，序号必须稳定。
3. **发现的后端缺口（交给 R53，R52 不改 `lib/**`）**：服务器平滑关停（SIGTERM）时，`ProjectEngine.close()` 把运行改为 `cancelled`，但**不写 `run_cancelled` 事件**。R52 的适配器在“状态与最后的任务事件不一致”时，补一条 `v2-status:` 开头、明确写着“由服务器运行状态推导”的事件，所以光环不会一直显示“工作中”。建议 R53 在后端补写这个事件。
4. 返工：已有后端只能整轮重做。R52 把指定步骤写进反馈文字，并提示“返工是新的授权”。逐步返工需要 R53 支持。
5. 逐条人工检查标记只存本机；真正的验收以 `POST /api/v2/runs/:id/review` 为准。若要在服务器保存逐条结论，需要 R53 提供接口。
6. 集成时，按 `R44_SHA...R52_SHA` 只 cherry-pick R52 的提交，不合并 R44 祖先链。R52 文件逐字节保留。

## 测试

**`tests/haloflux-workbench-r52/workbench.test.js`**（Node，12 项）：
- 8 个盲测陌生或跨界任务：赛鸽竞翔、皮影课程（涉及未成年人）、冰雕节安全（线下操作）、古籍修复档案、潜水急救（医疗加安全）、酒窖税务融资（金融）、渔船队（个人信息与对外上架）、养蜂短视频。
  - 测试先 grep 确认这些领域词在 `public`、`lib`、`catalog`、`server.js` 中**从未出现**。
  - 8 个任务的团队与成果签名两两不同；其中 ≥3 个是跨界的专业风险任务。
- 低信息量目标：理解程度为低，并要求澄清；XSS 文本按纯文本保留。
- 编辑正例与 9 类反例；不可变性；岗位与步骤上限。
- 授权：确认、编辑后失效、收费模型的单价与上限、禁止的对外操作。
- 投影：IDLE、乱序、重复、冲突、缺口、因果、撤回、未识别类型、断线、静默。
- 取消、失败、中断、费用未知、同一账本行重放只计一次。
- R53 fixture 正序与倒序投影结果一致。
- 验收规则；光环布局与 DEMO 标签；V2 适配器。
- 范围检查：只写入允许的路径，不使用 innerHTML，不加载外部主机。
- **E3_FAKE**：
  - 真实服务器 + 本地 Mock：工作台方案经已有 API 保存（步骤顺序保留，0 次模型调用）。
  - 未授予工具时服务器返回 403 `tool_permission`，0 次调用。
  - 授权后真实运行：事件投影为每个岗位“已完成”并画出交接线；费用 $0（本地连接）。
  - 导出真实 DOCX（PK 头）；返工是新的授权，再验收后才显示已完成。
  - 运行中取消：岗位显示已取消，不是已完成。
  - SIGKILL 后重启：状态为 `interrupted`，投影为“未知”，不自动重放。
  - SIGTERM：适配器补出推导的已取消事件。

**`tests/haloflux-workbench-r52/workbench.e2e.js`**（真实 Chromium，11 个检查，本地全部通过）：

| 检查 | 场景 |
|---|---|
| `idle-without-events` | 没有事件时显示 IDLE |
| `low-confidence-and-clarification` | 低理解程度与澄清；“去填写”跳转 |
| `blind-tasks-distinct-teams` | 8 个盲测任务在页面里生成不同团队；没有模型时“开始工作”被阻断 |
| `keyboard-editing-and-xss` | 键盘改岗位名、用 Enter 移动步骤且焦点保持；XSS 不执行；修改上限后确认失效 |
| `demo-labelled` | DEMO 有标注，不显示费用 |
| `fixture-replay-order-gap-retraction-unknown-cost` | 导入 R53 fixture：有缺口时暂缓后续事件，补齐后显示撤回、未识别类型、“未知（不是 0）”、FIXTURE 文件下载；回放不能验收 |
| `static-toggle` | 静态开关关闭动画 |
| `reduced-motion-and-phone` | 减少动效设置下为静态；手机 390px 宽无横向滚动，触屏移动步骤 |
| `live-busy-only-from-server-events` | 真实 Mock 运行时，“工作中”节点带 `v2:` 来源事件；运行中“开始工作”禁用 |
| `disconnect-and-reconnect` | 断网时显示断线横幅且不忙碌；恢复后重连 |
| `export-download-acceptance` | 导出 DOCX → 下载 → python-docx 独立解析，内容带“R52 MOCK”标识；有不合格项时不能验收，标记已验后验收显示“已完成” |

**回归**：`npm test` 276/276；R44 Node 测试 22/22；浏览器套件 admin、workspace、intake-draft、industry、R44 universal-intake 全部通过。

专属 CI：`.github/workflows/claude-r52-workbench.yml`。只在 push 和手动触发时运行，权限 `contents: read`，包含范围检查。

## 已知限制与 NOT_RUN

- 规则以中文关键词为主；识别不到时理解程度为低并要求澄清，不会套用模板。没有真实模型生成团队（E4 NOT_RUN）。
- E3 中的成果内容来自本地 Mock，并标有“R52 MOCK”，**不是**专业成果。真实模型质量与真实用户可用性（E5）未验证。
- 浏览器与服务器时钟不同步时，“事件延迟”的判断以“快照多久没有变化”为准，不依赖服务器时间戳。
- HALOFLUX 原视觉的商业授权：PENDING。
