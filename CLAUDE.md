# AIJAVAIS V2 — 接力开发须知

> **当前治理（2026-11-09 起，优先于本文件下方所有旧轮次分工）**
> - 负责人决定：ChatGPT 与 Codex 永久退出。**Claude 总指挥是最高指挥官**，拥有项目规划全权和**全部审批权**（包括合并 main、服务器操作），统一调度所有子会话：战略参谋、独立审计、开发工程师、服务器运维，以及按需启用的产品 QA。旧的"Codex 独占 / Claude 待命"条款作废。商业化与许可由负责人自行处理。
> - 必读顺序：GitHub #26（先读顶部 OWNER_STRATEGY_V3，以及评论里的 `[STRATEGY_ADVISOR_CHARTER_V3]`）→ #20 最新 `[CONTEXT_PACK_V2]` 评论（**断点**）→ #10 最新决议。不要重读全部历史。
> - **负责人优先级（2026-11-10，最高，覆盖其它排序）**：**① 自动化**（条件驱动多 AI 自动接力，真实证据）→ **② 平台上线**（V2 部署到负责人服务器，线上用真实模型跑通"建项目→多岗执行→审核→下载成果"，HALOFLUX 显示真实事件）→ **③ 其余一切只"留口子"**：收敛重整、并行内核、DSH 移植、MVP-A Relay Kit、多用户、成果质量、安全加固、首个场景等，只在改动时保留扩展接口，**不排任务、不占权重**。任务清单唯一来源：#10 最新 `[TASK_LIST]`；判断准绳：#26 评论 `[OWNER_PRIORITY_V4]`。
> - 审批自律：改动前先备份并写好回滚；GitHub 留痕；main 只在独立审计 ACCEPT 后合并；停机类操作先在 #24 公告；没有预算就不产生真实付费；战略参谋提出的 ORANGE/RED 必须逐条在 #10 回应。
> - 停止扩张 Runner 和调度层（R45–R57 已足够），只修复经证实的阻断缺陷。
>
> **断点续跑协议（防止额度或上下文耗尽导致丢失）**
> 1. 唯一的持久断点是 #20 中 `[CONTEXT_PACK_V2]` 评论（id 6732197072）里的「断点」表。每完成一步、每次派工前后，都要先更新它，再继续下一步。
> 2. 代码一律先提交并推送：每个有意义的单元完成后立即 commit+push。容器可能被回收，只留在本地的改动视为丢失。
> 3. 任何一次启动（定时任务、唤醒、负责人消息）都先做三件事：读 #20 断点；`list_sessions` 查看子会话状态；`git fetch` 核对 SHA 和 CI。核对完从断点继续，不要从头开始。
> 4. 断点里已记录"已派工"的任务**不重复派工**。只有满足以下条件之一才重发同一任务：对应子会话空闲超过 6 小时且没有任何回报，或者它报告失败。
> 5. 额度耗尽、中途停止时不必补救：服务器端的定时任务会在额度恢复后照常触发，任务会按第 3 条续跑。
>
> **自动接力协议**
> - 派工：用 `send_message` 发给常驻子会话（会话 ID 见 #20 快照）。回报：子会话用 `send_message` 发给值班总指挥 `session_012XvWhUsx2aGQrQjnzjMMyP`，详细结果写在自己的会话或 GitHub 里。
> - 兜底：值班总指挥会话自建的定时任务——每日 08:53 战略复盘转发、09:47 每日推进、每 3 小时兜底巡检（见 #10 评论 6757708502）。
>
> **Token 节约规则（所有会话必须遵守）**
> - **任务卡自带上下文**：总指挥派工时，消息中写清 SHA、分支、差异范围（`git diff A..B -- <路径>`）、相关 Issue 评论链接、验收标准和禁止事项。子会话**只读任务卡指定的内容**，不重读 #26/#10/#20 全文，不全仓扫描，不重读已读过的治理文件。
> - **常驻子会话只做一次入职阅读**：治理文件只在会话首次启动时读。之后的任务只增量读取新内容。规则有变化时，由总指挥在任务卡里写明变化点。
> - **审计只看差异**：只读 `git diff 基线..候选` 涉及的文件，以及上一轮报告中的反例，不重审未改动的代码。
> - **战略复盘只看增量**：只读上次复盘之后的新评论和新提交（GitHub API 带 `since` 参数）。
> - **长输出不进上下文**：CI 日志、测试输出先用 `grep`/`tail` 过滤，只看失败项和计数；大文件用行号范围读取。
> - **上下文超过 60% 先 `/compact`**；同一会话避免重复读同一个文件。
> - **巡检用 Haiku，不克隆仓库**，只调 API 判断条件。总指挥被唤醒后只读 #20 断点和本次增量。

> **编号与命名规范**
> - 常设 Issue（固定编号，不再为每轮新开 Issue）：#26【01-战略】、#10【02-总控】、#20【03-交接】、#2【04-审计】、#4【05-测试】、#24【06-运维】。缺陷和待办另开 Issue，标题前缀用【缺陷-Pn】或【待办】。旧的 R 轮次 Issue 已归档关闭（标签 `archived-r-series`）。
> - 分支：开发用 `claude/dev/<主题>`（当前主干开发分支为 `claude/beautiful-pascal-xj5qd0`），审计证据用 `audit/<sha7>-<yyyymmdd>`，QA 用 `qa/<sha7>-<yyyymmdd>`。旧分支保留作为历史证据，不删除。
> - 报告标记：`[AGENT_REPORT_V1]`（审计 / QA / 子会话）、`[STRATEGY_REVIEW_V3]`（战略参谋）、`[PLANNER_DECISION_V5]`（总指挥）、`[SERVER_CHANGE_LOG]`（运维）。
> - 文件：新文档统一用 `docs/<领域>-<主题>.md`，全部 UTF-8、LF 换行。C1（2026-11-11）起当前文档只有 5 份：`docs/PRODUCT.md`、`ARCHITECTURE.md`、`DEV-PROCESS.md`、`TESTING.md`、`DEPLOYMENT.md`；R 编号等历史文档已移到 `docs/archive/`。relay（R43–R57）代码冻结在 `tools/relay/`，R57 来源守卫不再约束产品代码。

以下为代码层面的长期约束。需要时按任务卡指定的范围查阅 `docs/PRODUCT.md`（含功能实况）、`docs/ARCHITECTURE.md`、`docs/DEV-PROCESS.md`、`docs/TESTING.md`、`docs/DEPLOYMENT.md`。文档描述的是当前实现，未经验证的项不等于已完成。

## 正确开始

1. `git status --short --branch`，保护现存修改；`git fetch origin` 后核对交接 SHA。
2. （历史）旧轮次的分支所有权已作废；当前分支与 SHA 以 #20 最新快照为准。
3. 检查三个来源分支的最新提交，不要用某分支旧版整份文件覆盖已集成代码。两份原始功能分支都保留在合并历史中。
4. 云任务已隔离；使用现有 checkout，不创建 worktree，除非用户明确要求。
5. Node.js **24+**（使用 `node:sqlite`、`AbortSignal.any`），零生产 npm 依赖，无 lockfile，无需 `npm install`。`npm start` 默认本机 8787；不要运行已有的桌面自动打开脚本作为云健康检查。
6. 首次部署用服务器生成的 `data/setup-code.txt` 设置管理员密码；不要打印设置码/会话/API Key 到日志或报告。已有数据不可重置。`AIJ_DATA_DIR` 可配置独立数据目录。
7. 运行 `npm test`，再按 TESTING 文档执行两个浏览器测试；检查测试数量，不能把没有实际子测试的 exit 0 当通过。

## 架构与目录

- `server.js`：原模型 HTTP/SSE 适配器、认证、静态页面、兼容接口；`/api/v2/*` 在管理员门禁后交给 `lib/v2-api.js`。
- `lib/auth.js` / `access.js` / `permissions.js`：单管理员密码登录、服务端会话、只读大屏、上报凭证分离。不是企业多用户账户系统。
- `lib/security.js` / `sse.js`：出站协议/端口/IP/密钥主机约束、HTTPS 代理、响应限制、流解析。
- `lib/models.js` / `teams.js` / `matcher.js`、`catalog/`：模型注册、凭据分离、可编辑岗位与备用连接、基于声明能力的推荐。
- `lib/project-store.js`：SQLite schema v4（含资料、system_usage与model_requests持久幂等表），项目、运行、步骤、消息、事件、真实成果 BLOB、费用账本、Skills 设置。DATA 独占 PID 锁、WAL、原子事务。
- `lib/project-engine.js`：有限顺序多岗位调度、前序真实输出交接、工具/Skills、质量检查、人工审核/返工、取消和费用预留。
- `lib/tools-v2.js` / `skills-v2.js`：精确授权的工具、受信 MCP stdio 子进程、版本化声明式 Skill。
- `lib/deliverables.js`：真实 DOCX/XLSX/PPTX、CSV、文本、JSON、代码 ZIP；禁止冒充文件、穿越路径和公式注入。
- `public/workspace.*`：V2 项目/执行/资源工作台；`public/project-intake*`：OpenAI 六步立项向导及纯规则引擎；`public/admin.html`：模型/团队/账户管理；`panel.html`：保留的 HALOFLUX 大屏。
- `tools/database.js`：只读查看和在线一致 SQLite 备份；`tests/`：保留全部原测试并加入 V2 测试；`collab/`：协议、决策、交接。

## 模型、团队、岗位、Skill 和工具的关系

模型连接提供厂商通信和凭据；团队是岗位到连接的可编辑配置；项目保存其独立岗位及步骤快照。一个连接可以承担多个岗位，但岗位 ID、运行实例与连接 ID 不可混为一谈。每步产生真实模型请求、持久消息及成果；下一岗位读取前序完整输出。

Skill 是版本化 prompt/tool/check 配方，不能执行任意脚本。工具是独立执行器，MCP 工具只是其中一种。注册工具不等于获准调用；每次运行的 `allowedTools` 必须明确包含精确 ID。模型输出文字不能被当作工具实际执行证据。

## 不得破坏的约束

- 默认拒绝未登录数据访问；观看会话仅能看脱敏大屏；上报凭证不能登录或读取项目。
- 不授予 localhost Host 头管理员权限。保留同源/JSON 门禁、scrypt、HttpOnly/SameSite Cookie、会话撤销、HTTPS 生产要求和限流。
- 新字段默认不进入只读大屏；项目明文只从管理员 API 获取。
- 不移除 SSRF/DNS/密钥目标绑定，不能关闭 TLS 验证。严格 DNS 模式直连固定 IP；显式委托代理 DNS 时，必须如实记录信任边界。
- 默认不调用收费/未知/未验证免费资格的远程模型；每次运行/返工要新的显式批准、USD 价格、Token 和金额上限。不得从前一次运行隐式继承同意。
- 失败、取消、部分用量与重启未知账单保守结算。估算不是供应商账单；停止后仍可能有已发生费用，不能声称撤销收费。
- 并发最多 3 个运行，每项目 1–12 岗位、1–30 步骤、0–5 次返工。不能改成无界自主循环。未明确授权不能合并 main 或触发付费部署。
- 项目版本冲突返回 409，历史运行保存项目/目标配置快照；不可拿当前配置重写历史。模型配置变化须让尚未发出的步骤停止。
- 重启只恢复证据和中断状态，不自动重放模型/工具。单进程、单 DATA 目录；锁失败先调查，不盲删活锁。
- 不删测试掩盖问题，不把 Mock/模拟事件叫真实厂商行为。保留许可证和上游署名。

## 数据迁移与回滚

旧 `config/providers` 通过现有模型迁移逻辑转为 `models.json` + `credentials.json`，其余旧 JSON/认证仍保留。V2 **不把旧内存任务伪装成 SQLite 项目历史**。SQLite 新库以事务建立当前schema v4；已有v1/v2/v3库按版本前向迁移、先备份（`PRAGMA user_version`、`schema_migrations`）。以后每次结构变更新增迁移，先备份并测升级；拒绝高于本程序版本的数据库。

`npm run db:info`；`npm run db:backup -- /secure/new.sqlite` 为在线 SQLite 一致备份。完整灾备还须包含全部私有 DATA（JSON、凭据、认证），不要提交到 Git。回滚必须先停止唯一实例，归档当前完整 DATA，再恢复匹配代码版本的完整备份；不要复制一个主 SQLite 文件而遗漏活跃 WAL。具体见 DEPLOYMENT。

## 测试与常见问题

- `npm test`：无付费 API 的单元、真实本地 HTTP、SQLite、MCP fixture、OOXML/ZIP 校验。
- `npm run test:ui`；`npm run test:workspace`：额外需要可解析的 Playwright 和 Chromium。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定浏览器。
- EPERM listen/socket 或受限子进程导致未真正执行测试：用云环境支持的执行授权机制，不绕过网络策略；核查测试计数。
- `node:sqlite` 不存在：换 Node 24+，不是安装同名 npm 包。
- `data_locked`：确认是否有同目录实例运行。异常崩溃仅死 PID 可恢复；容器 PID 复用/残留 recovery 锁需全部停机人工检查。
- 向导工具/能力未就绪：允许保存草案，但不能编造验证字段或删除门禁让其显示可执行。按需实现所需工具并记录证据。
- Google Fonts 不可访问会使用本地备用字体，不阻止功能。真实厂商/API/MCP 服务需要另外的授权和配置。
- 在平台代理环境本地 DNS 不可用时，可在可信代理负责 DNS/IP 防护的前提下显式设置 `AIJ_PROXY_DNS=delegate`，并限制 `ALLOWED_BASE_HOSTS`。不能用它绕过出口策略。

接力优先级：真实供应商协议回归（需负责人授权额度）→ 专业工具/文件读取与专业能力测试 → 更多 UI 异常路径 → 性能与保留策略 → 企业多用户/持久队列。如需自主工具选择，先设计有界授权及预算状态机，不直接执行模型返回的 shell。

工作单元2使用 `lib/budget.js` 共享授权/预留/结算策略；`lib/planner/ai-draft.js`（原 lib/intake-draft.js）只提一次模型草案，使用system_usage单行预留和结算。`public/project-intake/ai-draft.js`保留规则向导并提供编辑/确认保存。不得把生成草案当执行或绕过预算。新增浏览器命令`npm run test:intake`。接口、12类测试和待验证边界见`docs/ARCHITECTURE.md`「AI 草案」一节。


第十轮安全约束：草案请求按owner+kind+requestId永久占位，摘要绑定规范化参数与模型目标。claim和费用预留同事务；网络前必须提交dispatching；一次ledgerId仅结算一次。启动恢复claimed可证明未调用记0；dispatching和v3无证据预留按未知费用null保留上界，不重放。旧ID迁移为通配墓碑，不能清理后复用。管理员只读异常查询`GET /api/v2/usage/system/exceptions`，能力中心显示警示。无人工改账写接口。

本轮不修#7取消底层Promise生命周期或#9。`abortable/close`行为仍有独立待整改P1，不将此交付当全部安全门禁通过。恢复算法仅启动时在DATA锁下调用，不得针对活跃请求手动调用恢复。迁移后有新请求时，不可丢失v4墓碑回滚旧备份再开放服务。完整状态机、迁移/回滚和核对步骤见[DEPLOYMENT 账本恢复一节](docs/DEPLOYMENT.md)。
