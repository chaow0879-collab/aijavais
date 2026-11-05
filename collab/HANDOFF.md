# 工作单元2：Codex独立开发登记

- 共同基线：`4560c8a8ddb6fb1deceac753eea6fcb5e2627c71`。
- 当前分支：`feat/codex-v2-ai-draft`，唯一主开发及集成人Codex；Claude在独立 `fix/claude-audit-truth` 修复其四个保留文件。完整所有权见ACTIVE-DEVELOPMENT。
- 按GPT正式指令依次完成A共享预算、B动态团队草案API、C保留规则向导的编辑交互、D测试/集成。草案绝不自动保存/执行或授权工具。
- 不调用真实付费API、不修改main/生产服务器/S-UI/Caddy、不启用生产代码执行。
- 共同基线在本实例实际测试189/189，0失败/跳过；A阶段共享预算提取后193/193通过。两个指定SHA的GitHub Actions读取均返回403，当前环境尚未独立核实远程CI，不能沿用前开发者报告当作已核查。
- A检查点：新增`lib/budget.js`纯策略函数（本地识别/授权/预留/完整与未知结算），ProjectEngine持久化适配后复用；没有改Claude保留的四文件，也没有数据库结构迁移。

- B检查点：`POST /api/v2/intake/ai-draft` + `/estimate`（不发送模型请求）+ `/cancel`；`lib/intake-draft.js`只调用一次模型，严格白名单JSON、服务器模型推荐、草案不自动保存或执行。system_usage在调用前持久预留、调用后同一行结算，未知远程费用为null，另保留budgetCost；先写失败则不调用，后写失败明确usageRecorded:false。无schema升级（仍v3）。相关49项回归通过。

- C检查点：向导第二步新增“让AI帮我设计团队”，模板入口保留；先估算、不自动调用、一次授权、可增删编辑岗位/步骤、工具/Skills和人工事项展示、独立确认后保存。新`test:intake`真实Chromium E2E与原`test:workspace`均通过，包含取消、未知费用、非法JSON回退与文本XSS检查。
- Claude修复：用户已确认`e74adee5c3d6c5b95b7b568385f278983adcf8a1`为最终提交且停写，审核仅四个指定文件，无冲突cherry-pick为`c2cded1`；43项相关回归通过。
- CI独立核查：API通道403后改读允许的GitHub页面；06b540f对应run 42023627459，三任务均cancelled，不能算失败或通过；4560c8a对应run 42023677352，tests/browser/container均success。具体测试日志公开链接404，因此该远程run子测试计数未独立核实，不将旧文档计数冒称为本次核查。

---

# AIJAVAIS V2.0 · 当前交接（Claude Code 接力开发中）

- 开发分支：`feat/claude-v2-followup`（基于 Codex 交接提交 `29630a2`，代码检查点 `3623247`）。最新提交以 `git log origin/feat/claude-v2-followup -1` 为准。
- 当前开发者：Claude Code（唯一写入者，见 `collab/ACTIVE-DEVELOPMENT.md`）。未合并 `main`；未调用收费 API；未在负责人服务器上部署。
- 产品定位：全行业通用 AI 工作操作系统；默认文案、示例、模板排序已去除职业偏向，并有回归测试。

## 本轮完成（均有测试，已推送）

1. 测试基线：浏览器测试收尾竞态、UTF-8 下载文件名；CI 拆分并安装 poppler、LibreOffice、Python 解析器。
2. Anthropic 模型列表发现缺陷修复（请求 URL 可带查询参数，Base URL 仍禁止）。
3. 去职业偏向 + 5 个通用团队模板（共 11 个）。
4. 项目资料：上传、类型核验、零依赖解析 DOCX/XLSX/PPTX/文本，PDF 经 pdftotext；SQLite schema v2（迁移前自动备份）；资料按预算交给岗位并记录证据；工作台资料卡片。
5. 能力中心 `/capabilities.html`：系统就绪检查 + 《缺失配置清单》、全部能力分类、MCP 管理。
6. 内置工具：`project_file_read`、`data_analysis`、`chart_generation`（SVG）、`document_convert`（LibreOffice→PDF）、`document_render`（PNG + 空白页检查）。
7. MCP：远程 Streamable HTTP（静态令牌）、启停、连接/调用测试、诊断、运行日志、移除；审核目录 `catalog/mcp-servers.v1.json`。
8. 立项向导结果页显示服务端实时工具检查；立项工具 ID 映射到真实工具。
9. 步骤可接收全部前序成果（handoff:'all'）；受控 JavaScript 执行（默认关闭，网络命名空间 + Node 权限模型）。
10. 文档：`docs/USER-GUIDE.md`（普通用户）、`docs/DEPLOYMENT-PARALLEL.md`（与第一代并行部署）、FEATURE-STATUS / ARCHITECTURE / TESTING 更新。

## 测试

`npm test` 189/189（本地 0 跳过）；`test:ui`、`test:workspace` 通过。全部为本地 Mock 模型、本地 MCP fixture、真实文件与系统程序；真实厂商 API 与第三方生产 MCP 未测。

## GPT 审核（2026-11-05）后的状态

结论“有条件通过”。授权范围：继续开发；**不授权**付费 API、生产代码执行、停止/修改 S-UI、未经批准切换 HTTPS、合并 main。

| 工作单元 | 状态 |
|---|---|
| 1 外部工具权限与费用保护（P1-01、P1-03） | **完成** `de11c14`：工具风险级别；有副作用工具的手动调用需服务端一次性确认（绑定工具+参数，120 秒，单次）；运行中外部/代码执行工具需 `approveExternalTools`；连接测试记入 schema v3 `system_usage`（未知费用为 null） |
| 修复 A：账本写入失败保护 | **完成** `9577311`：`lib/usage-ledger.js`，写入失败写审计事件 `usage_ledger_write_failed`（不含错误原文/密钥），接口返回 `usageRecorded:false` + `usageWarning`；未知费用仍为 null |
| CI 核查 | `de11c14` → run 42020725591；`69308c6` → run 42020974113：tests / browser / container 均 success；tests 187 项中 186 通过、0 失败、1 跳过（代码执行隔离测试：GitHub Runner 不允许非特权命名空间，工具按设计拒绝运行） |
| 修复 A 后续（GPT 第三轮） | **完成** `06b540f`：审计成功与否如实表达（`audited`）；账本写入失败的试连标为 `usageRecorded:false`、连接状态为 `untested`（V2 执行校验仍拦截），保存前试连不缓存为通过；接口级回归测试。CI：`9577311` run 42022572783 因新推送被取消（cancelled，非失败）；`6381aac` run 42022674886 tests/browser/container 均 success，188 项中 187 通过、0 失败、1 跳过（代码执行隔离，Runner 限制） |
| 6 部署文档与服务器适配（P1-04、P2-01、P2-02） | 已提交 `69308c6`；**负责人指令：部署文档后续移交部署分支，本开发分支不再承担部署**：并行部署手册按 Debian 13 / 2GB / S-UI / Caddy / 独立 Node 24 / systemd 修订，含资源限制与升级步骤；文档矛盾已统一 |
| P1-02 代码执行 | 保持：生产关闭（D1=a），能力中心已标明“非强安全沙箱” |
| 2 动态 AI 团队草案生成（D2） | **GPT 已批准，移交 Codex 执行（Claude 本会话上下文不足，未开工）**。另按 GPT 要求：不要复制 ProjectEngine 私有方法，先把预算校验/预留/结算提取为共享模块（如 `lib/budget.js`）并加回归测试，ProjectEngine 改用该模块且原有测试全部通过。规格见下方「工作单元 2 实施说明」。要求：规则引擎无合适模板时，经用户批准（显示预计费用、独立 Token/金额上限）调用一次模型；输出经结构化校验后作为可编辑草案；模型不能创建任务或扩大权限/预算；记录用量；失败回退手工/通用模板。建议实现：`POST /api/v2/intake/ai-draft` 复用 `_approval/_reserve/_settle` 式预留结算并写入 `system_usage`（kind `intake_draft`），用 `normalizeProject` 校验后返回草案，前端在向导第 2 步“没有合适模板”时提供入口 |
| 3 备用模型自动切换 | 未开始。仅切换到本次运行已批准（含价表）的备用连接；未批准则暂停提示；不重放有副作用的工具调用 |
| 4 联网检索 | 未开始。优先复用 MCP（远程 HTTP 或审核目录中的 fetch）；保存来源、标题、链接、时间与执行记录；无配置时明确不可用 |
| 5 Office 文件编辑 | 未开始。先 DOCX：读取→定位→编辑→另存新版本→保留原件→重新解析验证→下载 |
| 7 服务器独立部署与联调 | 需负责人批准执行时机与访问方式；按 `docs/DEPLOYMENT-PARALLEL.md` |

真实付费验收（D4）：暂不执行；完成上述保护后准备方案，建议首次总预算 1 美元，需负责人批准。

## 工作单元 2 实施说明（供下一会话直接执行）

1. 接口 `POST /api/v2/intake/ai-draft`：入参 `{ description, connectionId, approvePaid, maxTokens, maxCost, maxOutputTokens, price:{inputPerMillion,outputPerMillion} }`。本机目标免费；远程需 `approvePaid:true`、正数 `maxCost` 和 USD 价格，否则 402 且**不调用模型**（复用 `ProjectEngine._localFree` / `_approval` 的判定逻辑）。
2. 预留与结算：按 `_reserve` 同样的保守上界（输入字节+256，输出上限）先检查 Token/金额上限，超限 402 不发请求；调用后按 `_settle` 规则结算；用量写入 `system_usage`（kind `intake_draft`，通过 `recordSystemCall`），未知费用为 null，失败也记账。
3. 调用：`callModel(models.runtime(id), { system, prompt, maxTokens, signal })`；system 提示要求只输出 JSON，字段：`goal, roles[{roleId,name,duty,boundary,standard,requiredCapabilities}], steps[{stepId,roleId,title,prompt,deliverable,quality,handoff}], deliverables[], acceptance[], tools[], humanDecisions[]`。不传工具、不执行任何工具或代码。支持 AbortSignal（用户取消）与超时。
4. 校验：剥离 ``` 围栏后 `JSON.parse`；失败返回 `{ ok:false, code:'invalid_draft', fallback:'manual' }`（附通用模板，不保存项目）。通过 `normalizeProject` 校验岗位 1–12、步骤 1–30、引用的岗位存在；把 `tools` 用 `CAP.resolveIntakeTools` 映射为真实工具及可用状态；**丢弃**模型给出的任何预算、`allowedTools`、`approvePaid`、`connectionId` 以外的执行字段。推荐模型连接由服务端按 `matcher.recommend` 给出，不信任模型输出。
5. 返回草案（不保存）；用户在向导/工作台修改后，走现有 `POST /api/v2/projects` 保存；**任何情况下不自动创建或运行项目**。
6. 前端：向导第 2 步“没有合适模板”时显示“让 AI 提出团队方案”卡片：选择模型、显示预计 Token 与金额上限、勾选批准后调用；结果进入可编辑岗位/步骤界面；失败时提示并保留手工编辑。
7. 测试（本地 Mock）：未授权不调用；合法草案；非法 JSON；缺岗位/步骤；超 Token/金额上限不发请求；超时/失败（记账且不隐瞒费用）；取消；修改后保存；不自动执行；模型返回的预算/权限字段被丢弃；`system_usage` 记录；原向导与 `intake/plan` 回归。

## 约束提醒

见 `CLAUDE.md`“不得破坏的约束”。零 npm 生产依赖；可选系统程序缺失时如实显示“需要配置”。Mock、fixture、真实文件、真实 API 分开报告。

---

以下为 Codex 交接原文（历史记录）。

# AIJAVAIS V2.0 · Codex → Claude Code 完整开发交接报告

状态：**WIP / 安全检查点交接，停止扩展功能**。用户已要求由Claude Code接管；Codex完成提交推送与SHA核对后停止写入此分支。

## 产品与接手位置

- 产品定位：**全行业通用型 AI 工作操作系统**，不围绕用户历史职业或某个特定行业。
- 仓库：https://github.com/chaow0879-collab/aijavais
- 开发分支：`feat/codex-v2-integration`。
- 完整有效代码检查点 SHA：`3623247266c29284ce86828c9da8b586ac7b22ae`（代码、测试和完整WIP文档已提交并成功推送）。随后仅补充本报告的SHA记录；最终文档提交完整SHA以本报告所在提交及最终交接消息为准。
- Claude可从以上代码检查点或包含本记录的最新交接提交创建自己的分支；应用代码与155项通过测试的版本相同。
- Claude先核对远程分支和SHA，再从该提交创建自己的 `feat/claude-v2-followup`，避免两个开发者写同一分支。不要合并main，除非负责人批准。

## 来源保护与实际架构

main `adb4d02306af7c0be4d5491f996279877354e308`；安全分支 `755fdae70c776730efddd323e954fc111bb9f143`；OpenAI立项分支 `0f833dfa36d54b6fcac9adc2e6a239039dd6f43e`。通过git merge保留两份分支历史，不以旧文件覆盖。没有对main推送或合并。

Node24、零生产依赖。`server.js`保留认证/模型/SSE/兼容API；`lib/v2-api.js`接V2工作台；`project-engine.js`执行有限多岗位流程；`project-store.js`以SQLite schema v1持久化项目/运行/步骤/消息/事件/成果bytes/账本。模型/团队/认证旧JSON仍保留。详细架构、表结构和约束在ARCHITECTURE与CLAUDE。

## 已完成并保留

1. 单管理员安全登录、服务端会话、只读大屏、上报凭证分离；修复首次设置/改密并发覆盖。
2. 模型注册、试连、替换、团队/岗位模板和声明能力推荐；代理/TLS及SSRF保护；远程试连需明确批准。
3. OpenAI六步立项指导、23类模板、自定义岗位/标准；服务端重算并保存草案进入新工作台。
4. 可编辑项目岗位/边界/量化标准/步骤；真实模型适配器的多岗位调用、实际前序输出消息交接。
5. 工具精确授权，MCP stdio客户端，版本化Skills前后执行、文本/JSON质检、人工审核/有界返工及取消。
6. SQLite事务、乐观版本更新、唯一实例锁、重启中断不重放、成果字节及下载持久化。
7. 每次远程执行/返工明确审批、USD价表与Token/费用上限、保守预留、失败/部分/未知用量账本；旧远程任务不能绕过V2。
8. 真实DOCX/XLSX/PPTX/CSV/文本/JSON/代码ZIP；文档生成工具和同运行文本file_read；代码ZIP缺少files会明确失败。
9. 工作台实际步骤/消息/事件/费用/成果显示；原大屏保留真实/外部/模拟来源区分。
10. Docker/Compose/Caddy/Render部署配置及CI定义，在线SQLite备份工具，完整开发文档。

## WIP、风险与未完成

- 不是全部V2需求最终验收通过。企业多用户/SSO/多租户、完整DAG/并行队列、模型自主工具选择、通用上传/PDF/Office输入解析、网页搜索、安全任意代码执行及专业行业工具未完整实现。
- 专业能力标签主要用户声明；试连成功只证明连通。向导缺工具或专业实测时保守阻止自动执行，不得修改verified字段掩盖缺口。
- MCP只有stdio；共享服务器进程取消可能使同服务器并发调用失败。受信MCP具有服务账户OS权限，需要容器/运行隔离；不是沙箱。
- 费用取用户USD价表估算，不是厂商账单。取消不能撤销已经发生费用；未知用量保守保留。真实厂商能力/免费资格尚未核验。
- 单实例DATA锁在容器PID复用/异常recovery锁情况下需停机检查，不能盲删活锁。完整灾备演练尚未做。
- 旧内存MessageBus/ArtifactStore历史未迁移到新项目数据库。V2团队备用模型配置尚未完整自动故障切换。
- 代理委托DNS是显式可选信任模式；代理负责DNS/私网阻断，应用无法证明代理真实IP。默认严格模式不静默降级。

- 已知功能问题：Anthropic模型列表发现追加`?limit=100`，当前出站URL语法校验拒绝query，可能导致发现接口失败；应分离Base URL校验与请求路径/query校验，保留SSRF/TLS门禁后补回归。
- 远程32-token连接试连虽有单独明确同意及事件用量记录，但未计入V2项目预算ledger；接力时统一核算。

## 测试与实际运行证据

`npm test` 最终实际执行 **155项，155通过，0失败，0跳过**（2026-11-05，Node v24.22.1）。已验证的两个浏览器流程均通过；真实SQLite、文件下载、MCP协议子进程、内置工具及办公文档生成有测试证据。开发全程未调用收费API。

明确区分：真实厂商API未测试；模型为本地HTTP/适配器Mock；MCP使用实际JSON-RPC但对端是fixture；DOCX/XLSX/PPTX是真实文件，并经独立解析器和LibreOffice导出PDF；代码ZIP是实际文件打包，不代表生成代码已运行。Docker较早快照真实构建/容器重启通过；最终另有成功构建镜像`sha256:de2fa70ee019fe1efff6957abc27ad9cdaedc0bb76835df33cdd34f314436d63`，但未再启动，且早于最后连接试连并发修复，不能声称最终SHA容器运行已验。公网TLS/Render未部署，远程Actions状态未确认。

## 部署、迁移与回滚

Node24 `npm start`，默认本机8787；先通过服务器一次性设置码设置管理员密码。`/workspace.html`为新工作台，`/admin.html`为模型管理，`/project-intake.html`为立项向导。生产使用Compose+Caddy，应用端口不能公网暴露；Render方案会收费，必须由负责人手动批准。

SQLite首次事务创建schema v1，后续变更必须新增迁移版本并拒绝旧程序读新库。`npm run db:info`；`npm run db:backup -- /secure/new.sqlite`为在线一致备份。完整备份还需全部私有DATA/JSON/凭据；回滚先停止应用、保留现有完整数据，再用匹配SHA代码和完整备份恢复至新卷。不要复制活跃主数据库而遗漏WAL，也不要自动降级。详见DEPLOYMENT。

## Claude开始后的下一步

1. 核对分支/SHA/工作区，创建独立接力分支，先读AGENTS、CLAUDE、PRODUCT、FEATURE-STATUS和TESTING。
2. `npm test`与两个浏览器命令重跑；检查真实子测试数量及预期402，保留所有原测试。
3. 对新API、预算/取消、MCP权限、文件与备份做综合代码审核；远程CI结果据实核对。
4. 优先完善通用项目向导与工具缺口、专业输入文件读取、审批可用性及项目端到端交付；不以某行业重写产品。
5. 待负责人批准额度/凭据后验证真实供应商和第三方MCP；明确记录费用与失败，不能拿Mock替代。
6. 补企业账户/队列/保留策略/性能等后续架构，持续更新实况；最终交OpenAI审核，不未经批准合main。
