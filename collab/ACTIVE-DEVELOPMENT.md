# R47 AUD-R43-01 定向修复候选（当前状态）

- 唯一作者原Codex；分支fix/codex-r47-r43-sha-binding-p1，基线ab3e07979f67924e795426737e26c5c4d84b8501，原R43冻结分支不改。
- R46已正式READY并冻结a1a258a41c2041ab8d6cebc622cfed0c690c3387，#30#6699403152；R47未合入R46/R45/R44。
- 中央V2 verify在claim前强制audit/qa SHA匹配V1 integration候选；集成准备明确签双输入和目标base。仅policy.js、Fake demo、53项新测试、精确blob保全、现有联合CI和交接文档有必要变更。完整范围与阶段语义见docs/R43-SHA-BINDING-R47.md。
- 本地53目标/436组合通过，最终准确40位SHA/CI及业务结果见#22 R47报告；仅作者READY，等待原CodeAudit和ProductQA定向差异复验。原R43 REJECT不撤回，三个P2保持延期未修复。
- 真实执行/远端写仍编译期OFF，无收费模型、云端自动接力、生产/main/Secrets操作。后续完整自动化合流必须重绑新的修复源与真实权限，不移用旧SHA审计结论。

---

# R43 唯一联合候选（覆盖以下历史分叉状态）

- 唯一写入者Codex-Integrator；分支 `integrate/r43-unified-product-autoexec`，复用现有隔离checkout。业务b377d427e6a018dc03fbf01c6ec1db40be156b4c与自动化e891978b46490bccf2c2282df24c8e7b2f4ced42已真实no-ff无冲突合流，merge 64b3df5c75548b0fda3e44d8f1a35a6a8ed25200保留双父链。
- 两线运行逻辑/安全/费用/交付与原测试保留；仅现有联合CI、源码保全工具和一项SVG浏览器夹具兼容修复。53条来源改动路径按Git blob+mode核验，除显式钉死旧/新blob的SVG测试外其余52条不变。
- 完整来源、260 V1/383组合/276业务/9 P2/3严格行业/9严格交付、五组浏览器、容器证据及先前失败见docs/UNIFIED-R43.md；最终唯一40位SHA/tree/CI run及job结果见Issue #22 R43 AGENT_REPORT_V1，#23仅索引。
- 原冻结来源分支不改；Claude R44在feat/claude-v2-universal-intake-r44独立开发，不等待或合入未完成WIP。R43冻结后只在同一SHA做一次并行独立CodeAudit+QA。
- 产品仍为通用跨行业虚拟AI公司，三行业只是样例。真实Agent启动0、费用NOT_VERIFIED；实际CLI/远端写、10分钟轮询/daemon/webhook和5个ENABLED仍OFF。无生产/服务器/Secrets/main/PR合并；Git协调分支/报告不自动授予模型执行权。
- 下一步由GPT核统一SHA/CI，独立联合审计/QA后另批真实认证/费用/窗口的有界接力；不把CI/Fake/文件结构通过当真实模型或E4/E5。

---

# 第42轮 #22 当前集成交付（覆盖以下历史状态）

- 唯一写入者Codex，原隔离checkout `/workspace/aijavais-autoexec`，分支 `feat/codex-v2-autoexec-v2-stub`。原WIP `4b8bc6929833a06d1186df1d62a95300398daa45`完整保留，未重写历史。
- 正式#22#6686129504及独立#2#6685927910解除V1代码依赖；merge `adbe5598b7497e43e31fb2c69b5a0a2e6d2012f6`父链为4b8bc692… + 获认可的精确V1 `d54b29e11716a01f0812b3e8576982b9f5b9b234`。无冲突，未修改Claude冻结分支或main。
- AUD-41-COMPAT-01只增加Independent-CodeAudit精确别名，旧别名/可信身份/最新否决/SHA/branch/授权检查保留；新增40项V1及8项V2回归，两条旧V2夹具只补时间戳而不改断言。
- 本地V1 260/260、V1+V2 383/383、业务276/276（umask022）及四组Chromium通过；初次集成夹具失败、历史umask077失败均如实保留在docs/AGENT-EXECUTOR-V2-R42.md。容器/准确CI与最终40位SHA见Issue #22第42轮AGENT_REPORT_V1。
- 产品仍为通用跨行业虚拟AI公司；当前工程优先为自动接力。仅代码候选READY_FOR_REVIEW，不代表新V2独立审计/产品QA通过；实际Agent启动0、成本NOT_VERIFIED。真实入口/远端写入编译期OFF，开关全部false、dry_run=true、cron/webhook关闭，无Secrets/付费API/生产改动。
- 下一步由GPT核候选SHA/CI，再独立CodeAudit和必要#4 QA。真实Planner自由格式决议需负责人按精确SHA和独立账号重新发布结构化协议，开发者未代签/伪造。真实认证/费用/窗口及实际接力须另获负责人明确授权，勿因解除V1代码依赖自动启用。

---


# 当前：第十七轮 #14 五包（Claude Code）— 已完成，等待一次集中独立审计

唯一写入者Claude Code；分支`feat/claude-v2-p1-cancel-lifecycle`；基线`17ec74c1f43afd1f19e3695568a24adf5cad40d3`（#6/#8已审计ACCEPT）。最终40位SHA、CI链接与五包证据以#14/#7/#9同一份`[AGENT_REPORT_V1] READY_FOR_REVIEW`为准；交付后停写，不自行关闭Issue、不合main、不部署。

里程碑：M1 #7取消生命周期`3d51841978a2ba35f9babecaa2508b0e97c208c8`；M2 #9能力/工具权限`644288aeffeb032780d0cee23aa8921e2d022a78`；CI触发`2d587e95b09c1d9df97c174eb0f104cc58167e6c`；M3费用事实`804e0745cc7e807d5407822454daa2b44bccf0c9`；M4备份运维`a1d4272d046f6255083a04184957ddfb83937229`；M5三行业/故障回归`52f146c0ee1be250cd3341068559e78db6818bd0`。

未触碰：schema v4/MIGRATIONS/事务/恢复状态机、`migrationBackup()`、ProjectEngine执行、认证、工具真实执行授权接口；无真实收费API/生产数据/服务器操作。范围外文件（已在#14说明）：`.github/workflows/ci.yml`（新增本分支push触发与行业测试步骤）、`package.json`（新增`test:industry`/`db:backup-inventory`脚本）、`tools/database.js`（复用私有备份发布）、`public/workspace.js|html`（费用/模型状态文案）。

---

# 当前授权：第十三/十四轮 AUD-68-SEC-01 最小返工

唯一写入者Codex；分支`feat/codex-v2-p1-ledger-recovery`；精确返工基线`c4d0a8c53a54453535125b3ade5cef91a4801a11`。开工本地/远端HEAD一致且干净。

原候选独立审计REJECT，唯一P1是迁移备份初始0644权限窗口。本轮仅修改lib/project-store.js的备份创建/发布流程、必要回归与说明；不重构持久幂等/账本状态机，不改ProjectEngine或#7/#9。

安全边界：写入前0700私有临时目录，0600文件校验后hardlink原子无覆盖发布，失败保留受保护证据；不改变全局umask。原Schema版本仍v4。无真实收费API、main/生产DB/服务器/Caddy/S-UI操作。

本地验证已完成：安全新增10/10，原相关40/40，全量248/248，草案Chromium通过；CI及新完整SHA以双Issue最终报告为准。交付同一新40位SHA到#6/#8 READY_FOR_REVIEW后停写。只有负责人明确“开始审计”后GPT才复审；不自动触发审计/移交Claude。详细设计与失败处置见docs/LEDGER-RECOVERY.md。

---

以下是原联合整改的历史记录，本轮范围以上述最小返工为准。

# 当前授权：第十轮 #6 + #8 联合P1整改

唯一开发/集成：Codex；Claude授权已撤销且待命。分支 `feat/codex-v2-p1-ledger-recovery`，起始SHA `b71faaa65bb66e04ea2a015c9238a3a129bdb68e`。开工确认新分支精确HEAD、工作区干净；原Codex旧分支未写入。授权来源：Issue #10最新第十轮与#6评论6660869089。

先提交[设计、迁移与回滚](../docs/LEDGER-RECOVERY.md)，再实施schema v4、持久幂等/事务预留/恢复、管理员只读异常查询与Mock/SQLite/浏览器/CI验证。范围：lib/project-store.js、lib/intake-draft.js、lib/v2-api.js、必要的能力中心警示、对应测试、CI新分支触发及文档。其他核心预算/认证/模型文件优先不改。内部辅助仅分配隔离文件或只读检查；不代表独立审计。

#7/#9仍未授权。禁止真实收费API、main合并、生产迁移/部署、服务器/Caddy/S-UI改动、人工改余额接口。最终双Issue统一完整SHA READY_FOR_REVIEW后停写，等待#2独立审核；不得自行关闭Issue。


实施检查点：设计36e2c7a96cd107e9b88ed74eae1abaee758a75f1；事务实现84dfd8ddd8cf06aaeb4bcf78857b79bf1e946191。schema v4与只读API/能力中心警示已实现，最终代码本地238/238，0失败/跳过，三个Chromium脚本通过。CI最终状态/最终40位候选SHA以#6/#8交付评论为准；当前正收尾CI与报告，交付后停写等待独立审计，不启动#7/#9。
