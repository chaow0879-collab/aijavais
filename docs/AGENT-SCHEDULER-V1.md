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
