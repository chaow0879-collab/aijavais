# 第三十轮 #22 当前接力（覆盖以下历史状态）

- 产品：通用跨行业虚拟AI公司；当前工程第一优先为受控自动接力（#26），不是将产品改成开发者Runner。
- 唯一写入者Codex；checkout `/workspace/aijavais-autoexec`，分支 `feat/codex-v2-autoexec-v2-stub`；保留原WIP `a999e9bffec1a64e7aba5c6563df49792d95a1ea`，新增版本探测、只读单任务提案和24项测试。最新完整SHA/CI见Issue #22第三十轮交付，不使用本文内嵌SHA自引用。
- V2 115 + 冻结V1常规37 = 本地152通过；完整业务276通过（umask022），4组Chromium通过；首次环境失败及重跑详见docs/AGENT-EXECUTOR-V2.md。Fake/Stub不代表真实模型执行。
- Codex CLI --version=0.166.0，Claude CLI未安装，认证/原生费用硬限额未验证；实际Agent模型启动0。所有开关OFF，禁用模板仍不在.github/workflows中。专属PR/manual CI增加TAP和安全环境探测工件，无Secrets/定时器。
- Claude独占#25修复；不得修改其scheduler文件。新修复只有在提供准确最终SHA并经#2独立审计通过后才精确引入本分支；当前整包WAIT_GATE，不能标最终READY或启用真实派工。#22后续V2集中审计和合法认证/受控只读窗口仍需实证。不操作生产/main，不调用付费API。
- 下一步：核对#25最终报告+#2精确SHA结论→复核diff/精确集成→V1+V2+独立负例/全量/CI→统一候选SHA；如冲突停止自动处理。通过独立验收后准备先Codex再Claude的一次受控实测；缺认证则BLOCKED_CREDENTIALS，不以网页版会话代替CLI。

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
