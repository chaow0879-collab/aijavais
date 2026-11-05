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
9. 文档：`docs/USER-GUIDE.md`（普通用户）、`docs/DEPLOYMENT-PARALLEL.md`（与第一代并行部署）、FEATURE-STATUS / ARCHITECTURE / TESTING 更新。

## 测试

`npm test` 182/182（本地 0 跳过）；`test:ui`、`test:workspace` 通过。全部为本地 Mock 模型、本地 MCP fixture、真实文件与系统程序；真实厂商 API 与第三方生产 MCP 未测。

## 尚未完成（按建议顺序）

1. 受控代码执行（需隔离运行环境，默认关闭、每次授权）——尚未实现。
2. 多步交接：后续岗位可选择接收全部前序成果；团队备用模型自动切换（需纳入批准与价表）；32-token 试连费用入账。
3. 图表嵌入 Word/PPT；流程图/结构图；已上传 Office 文件的编辑（替换文字后重新生成）。
4. 由模型提出团队/流程草案（需走同一预算批准）以支持模板外的全新项目类型。
5. 负责人提供服务器后，按 `docs/DEPLOYMENT-PARALLEL.md` 只读检查 → 备份 → 并行部署 → 12 项测试 → 报告；未经批准不切换生产流量。
6. 真实厂商 API / 第三方 MCP 端到端验收（需负责人批准额度）。

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
