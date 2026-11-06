> 第42轮集成状态：本文件原始作者分支保持冻结；#22在feat/codex-v2-autoexec-v2-stub合入独立认可的d54b29e11716a01f0812b3e8576982b9f5b9b234，并仅追加Independent-CodeAudit精确机器角色别名，保留CodeAudit/Codex-CodeAudit及所有可信身份/最新状态/SHA/授权门禁。完整来源、40项新回归、Planner文书迁移与NOT_RUN见 [第42轮说明](AGENT-EXECUTOR-V2-R42.md)。V1当前260项通过；实际派工仍关闭，新集成候选尚待独立审计。

# 自动调度器V1：只读门禁模拟

唯一分支feat/codex-v2-scheduler-v1，base 58c52f0084997f669eea763edc7b58e11d3ef4f4。#15已在另一checkout冻结于c088076425256f52a26aab4e5272a5b1f72402a4；本分支不包含其改动，不修改业务/数据库/计费/通用测试或package。

## 默认关闭及权限边界

config.json enabled=false，poll_interval_minutes=10。无定时器/cron/常驻进程，无schedule/push/workflow_run触发器，不恢复已取消夜间任务。`node tools/agent-scheduler/cli.js`只输出DISABLED，完全不联网。V2 dispatchAgent接口始终抛错；没有Claude/Codex/SSH/模型/邮件/通知调用，没有GitHub写接口。所有报告actual_dispatch=false。

显式手动一次：`node tools/agent-scheduler/cli.js --once --live`。仅调用gh api --method GET固定仓库；可由操作者提供最小read token（contents/issues/actions/pull_requests:read），不要放入命令参数、repo或日志。默认trustedActors为空，无法确认来源时BLOCKED。单请求10秒、每列表最多20页、总计最多200请求；403/429/超时/页数上限/total_count矛盾/字段缺失全部UNKNOWN，不推断READY。未读取完整历史不称成功快照。GitHub读取不等于已验证真实AI执行或供应商账单。

离线模拟：`node tools/agent-scheduler/cli.js --once --fixture tests/agent-scheduler/round24.json`。此fixture明确MOCK/as-of轮24，含#4 QA head c1db3590a3b91a7651d6c276b079b0aea53376c6、run42146837614 HTTP成功/Chromium失败及#2仅PRE_AUDIT_PREPARED；#15/#17远端当时仍58c52f0。不是当前实时任务结论，过期一律BLOCKED。

## 来源合同与状态机

所有任务必须有可信身份映射：--config提供trustedActors的planner/codex/claude/integrator/audit/qa账号白名单。要求OWNER/MEMBER/COLLABORATOR association，审计账号不得与开发/集成人重叠。GitHub账号只能证明发布身份，不能独立证明操作者确为某种AI；角色映射须负责人确认。不能仅从role自称、CLOSED或PASS单词获得权限。

只接受闭合[AGENT_REPORT_V1]块（结束[/AGENT_REPORT_V1]），行`key: value`，数组/布尔使用JSON，拒绝重复键。旧自由格式/无结束标签的评论不会猜测解析，需负责人认可的结构化报告；本程序不回写补字段。必需字段：role/status/branch/head_sha/base_sha/completed_milestones（#15 M1-M3，#17 M1-M4）。Planner闭合[PLANNER_DECISION_V1]须提供approved:true、authorized_role（codex/claude/integrator/audit/qa）、issue、branch及base_sha或candidate_sha；正式审计/QA授权须candidate_sha匹配reviewed_sha。集成报告另需parent_shas同时绑定两个冻结开发SHA，唯一非审计集成人获Planner授权；CI必须精确SHA和required_jobs tests/browser/container全部completed/success，步骤不得空缺/失败/跳过。

状态顺序为READY/CLAIMED/RUNNING → READY_FOR_REVIEW →（每包证据CI_VERIFIED）→ INTEGRATION_READY → AUDITING →（证据AUDIT_ACCEPTED）→ PRODUCT_QA → READY_FOR_HUMAN_GATE。后两项要求正式FINAL审计verdict ACCEPT/ACCEPT_WITH_FOLLOWUP与精确集成SHA；QA reviewed_sha同集成SHA、t2_complete:true；QA还须提供自身test_head_sha及其远端branch/ref一致，ci_sha同test_head_sha，qa_required_jobs默认HTTP/Chromium都成功；E4/E5均PASS且有Planner human_trials_approved:true及candidate_sha。PLAN_ONLY不能通过。字段可解析不代表事实可信，独立审计/QA仍由人授权的角色提供。P0/P1或unknown_cost报告立即HUMAN_REVIEW_REQUIRED。永远不自动批准生产发布。

## 模拟lease和重启

加--simulate-plan仅生成would_dispatch假设建议；--state-dir必须是/tmp下权限0700且本UID拥有的独立模拟目录。幂等键(issue,role,phase,sha)，集成阶段phase还绑定另一开发SHA，避免只看一方更新。wx独占本地锁与原子快照记录计划；重复comment/workflow、并发、重启不会扩大建议。TTL默认10分钟，过期lease或僵尸锁仅告警、禁止自动重发，不删除历史键；腐坏快照失败关闭。一次无状态模拟若不指定state-dir会创建新临时目录，跨次去重必须复用同一安全目录。本地写入仅模拟账本，无GitHub锁，也不是业务SQLite队列。

## 轮询及未来启用

10分钟仅为配置/设计，当前没有部署任何进程。未来需另批运行机器、read凭证、日志保留、窗口/费用、停止开关，代码验收后再实现受控read-only polling；不得使用生产AIJAVAIS服务器。未来webhook需验签、重放保护和同一门禁；V2 Agent实际派工另需独立授权、费用/锁/安全审计。改enabled为true本身也不会创建定时任务或启用Agent。

## 测试与CI

`node --test tests/agent-scheduler/*.test.js`：覆盖T01-T18和额外正例/身份冲突/分页完整性/真实多进程竞争。实际模型/Agent调用0；测试Github响应为注入Mock，手动live采集另行记录。专属workflow仅PR/manual，permissions contents:read，测试不用secret不联网。新workflow不在默认分支时GitHub可能不允许直接dispatch；可建立仅用于CI的draft PR到同一已审计base分支，不合并不改target。CI及最终SHA以Issue #18报告为准。租约不是安全的跨主机分布式锁；特殊ACL/其他OS未验证。没有真实供应商/生产操作。

本地最终测试37/37、0失败/跳过，含T01–T18门禁/故障/正例、唯一集成人、歧义块拒绝及正式审计精确授权约束。另已显式执行一次真实GitHub只读采集：来源完整后因trustedActors默认为空而BLOCKED(NO_AUTHENTICATED_REPORT_15)，actual_dispatch=false/would_dispatch=[]；没有将采集成功当作任务已授权。CI Draft PR #21仅供验证，不合并。手动workflow dispatch首次404（新workflow未在默认分支注册），改用本Issue允许的PR验证路径。最终精确SHA与CI结果见#18交付报告。

最终复跑发现并修复EEXIST后锁被移除、lstat返回ENOENT的竞争窗口：竞争者仅返回LOCK_CHANGED_RETRY_READONLY和would_dispatch=false。新增确定性负例，四进程竞争重复5次均只有一个模拟计划。中间失败记录未计入最终通过；最终完整37/37。

## 第三十轮门禁整改（#25，AUD-26-SCH-01…05）

修复分支 `fix/claude-v1-gate-p1-26`，base `6363e8d10595a566a1ba266cb70017711cc806be`（被 #2 独立审计 REJECT）。只改 `tools/agent-scheduler/state.js`、`lease.js`、本节、新增回归 `tests/agent-scheduler/audit-r26-regression.test.js` 与专属 workflow `agent-scheduler-fix-26.yml`；原 37 项测试未改。仍默认关闭、GET-only、`actual_dispatch` 恒 false。

- **SCH-01 最终审计/QA状态契约**：最新一条可信报告决定；先判显式状态：`REJECTED` 或审计 `verdict: REJECT` → REJECTED；`BLOCKED` → BLOCKED；缺 `status` → BLOCKED；其它非 `READY_FOR_REVIEW`（CLAIMED、PRE_AUDIT_PREPARED、小写、未知）→ 不前进。之后才要求审计 `verdict` ∈ ACCEPT/ACCEPT_WITH_FOLLOWUP、`review_phase: FINAL`、`reviewed_sha` 精确（若给 `head_sha` 必须相同），QA `verdict: PASS`。可信账号较新的报告块若无法解析（重复字段、多块、坏 JSON）或缺/未知 `role`，按**歧义**阻断，绝不回退到较旧的 ACCEPT/PASS。评论按 `created_at`（再按评论 id、原顺序）排序；时间戳不可解析 → UNKNOWN。
- **SCH-02 授权撤回**：Planner 决议按范围 `(authorized_role, issue[, branch][, candidate_sha|base_sha])` 取**最新适用**一条；`approved:false`、`status` 为 BLOCKED/REJECTED/REVOKED/WITHDRAWN/CANCELLED/FAILED 或 approved:true 但带否定状态都不是批准；无 SHA/无 branch 的决议是该角色+Issue 的整体撤回（不能作为批准）。撤回后需新的精确授权才能恢复。较新的可信 Planner 块不可解析 → 人工复核。E4/E5 同理：`human_trials_approved` 的最新适用决议（同候选或不带候选的整体撤回）决定。注意：自由格式（无闭合标签）的 `[PLANNER_DECISION_V1]` 评论也会被视为歧义而阻断其后的所有授权判断，需负责人发布闭合结构化块。
- **SCH-03 CI 选择**：同一 SHA 的运行按 workflow（`workflow_id`→`path`→`name`）分组；凡含必需 job 名的 workflow，只看其**最新 run/attempt**（`id` 再 `run_attempt`），必须 completed/success 且其中必需 job 与步骤全部成功；最新为失败、取消、超时、进行中即阻断，旧绿不能遮盖。同组多条无法排序或同 id/attempt 内容冲突 → 阻断。完全不含必需 job 的可选 workflow 不影响判定。重复的同一 run 记录去重。
- **SCH-04 lease 账本**：只接受精确 `{version:1, plans:{"[issue,role,phase,sha]":{created_at,expires_at}}}` 的普通对象；数组、null、原始值、多余字段、畸形 key/entry、非有限时间、`__proto__` 键、截断/空文件、符号链接一律 `CORRUPT_SIMULATION_SNAPSHOT` 失败关闭，**不改写、不删除**原文件（留待人工）；锁照常释放。写入后回读确认键已落盘才报告 `would_dispatch`。
- **SCH-05 QA 独立与不可降级门槛**：`trustedActors.qa` 不得与 codex/claude/integrator 重叠（QA_AUTHOR_CONFLICT），且 QA/审计报告的发布账号不得是本轮任一开发/集成报告的发布账号。`qa_required_jobs` 可省略（默认 HTTP+Chromium），若给出必须是去重非空字符串数组且包含 HTTP 与 Chromium；`required_jobs` 必须包含 tests/browser/container；`trustedActors` 每项必须是非空字符串数组。job 改名需改代码并重新审计，不能用配置删掉必测。

验证：`node --test tests/agent-scheduler/*.test.js`（原 37 + 新回归）。新回归在原 6363e8d 代码上运行时，审计者的 12 个最小反例全部失败（即确实复现原缺陷），在修复后全部通过。仍未验证：真实 `--live` 采集、跨主机锁、其它 OS/ACL、真实 Agent 派工（V1 不可开启）。

## 第三十四轮定向返工（#25 R34，AUD-33-SCH-01…03）

基于被 #2 #6677345745 REJECT 的 `1e7b09294e55210f04089bb6c1ac93782d2ae462` 追加提交；第三十轮全部修复保留，原 37 + R26 103 项测试未改。

- **SCH-01（P1）candidate/base 绑定**：决议里写了 `candidate_sha` 就以它为准——指向别的候选的决议对本候选**既不授权也不撤回**，不再因 `base_sha` 相同而套用；两字段同时存在时必须都与报告一致，否则不是批准。只有 `base_sha` 的决议是包级授权/撤回（审计/QA 不适用）；无 SHA 的决议仍只能撤回。范围选择和最终批准共用同一绑定规则。E4/E5 的 `human_trials_approved` 同样要求精确 candidate，若附 base 也须与集成报告一致。
- **SCH-02（P1）同名必测 job**：不再用“任意同名 job 成功”判断。最新 run 中每个必需名称至少一个 job，且**全部**同名 job（及其全部步骤）都必须 completed/success；同一 run 内重复 job id 视为矛盾记录直接阻断。合法 matrix（不同 id、全部成功）仍通过；不含必需 job 名的可选 workflow 不受影响。
- **SCH-03（P2）账本重复键**：`JSON.parse` 会静默保留重复键的最后一个值，所以只校验解析后的形状不够。本工具只写一种规范编码 `{"version":1,"plans":{<key>:{"created_at","expires_at"}}}`；读入字节必须与该规范编码逐字节相同，否则（重复/转义等价键、字段重排、缩进、尾随换行、BOM）一律 `CORRUPT_SIMULATION_SNAPSHOT`，保留原字节、不改写、不删除，锁照常释放，不产生新计划。
- **自由格式 Planner 决议迁移**：行为不变，没有为兼容而放宽。较新的、无法解析的可信 `[PLANNER_DECISION_V1]` 仍会阻断其后的授权判断；需由规划方为 5 个角色及 E4/E5 重新发布完整、精确范围的闭合结构化块（合成正例见 R33 回归最后一项）。本分支不签发、不代替 Planner 授权。

回归：`tests/agent-scheduler/audit-r33-regression.test.js`（审计 3 个最小复现原样 + 相邻负例与合法正例）。在 1e7b092 旧代码上运行该文件：80 项中 49 项失败，3 个审计复现全部失败；修复后全部通过。
