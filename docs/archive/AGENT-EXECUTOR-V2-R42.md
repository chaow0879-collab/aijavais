# #22 第42轮：已审计V1集成与角色协议兼容

产品仍为通用跨行业虚拟AI公司；本包为受控自动接力的代码集成候选。**不授权实际Agent启动、付费模型、定时器、生产操作或main合并。** 当前实际派工0，所有真实入口仍编译期OFF。

## 准入与来源

- 正式任务：[#22 第42轮](https://github.com/chaow0879-collab/aijavais/issues/22#issuecomment-6686129504)。
- 独立审计：[#2 第41轮](https://github.com/chaow0879-collab/aijavais/issues/2#issuecomment-6685927910)，准确V1 `d54b29e11716a01f0812b3e8576982b9f5b9b234`，`ACCEPT_WITH_FOLLOWUP`、无P0/P1阻断，**仅准入代码集成**。
- 已核审计来源：run [42222114921](https://github.com/chaow0879-collab/aijavais/actions/runs/42222114921)；被审V1 tree `cae2776c5252b74905a62ca984bb5cf2d6f3184a`。不把审计工作流自己的commit当被审源码。
- #22原WIP基点：`4b8bc6929833a06d1186df1d62a95300398daa45`，分支 `feat/codex-v2-autoexec-v2-stub`、原独立checkout。原有22文件及后续环境/提案代码全部保留。
- 合入commit：`adbe5598b7497e43e31fb2c69b5a0a2e6d2012f6`，父提交依次为原WIP `4b8bc6929833a06d1186df1d62a95300398daa45` 和认可V1 `d54b29e11716a01f0812b3e8576982b9f5b9b234`。无冲突、无reset/force push、未改Claude冻结分支。
- V1被引入的两提交为 `1e7b09294e55210f04089bb6c1ac93782d2ae462` → `d54b29e11716a01f0812b3e8576982b9f5b9b234`。旧1e7自身被REJECT；认可的是包含后续安全修复的**d54最终树**。

最终候选40位SHA、父链/差异及匹配Actions结果以本轮Issue #22 AGENT_REPORT_V1为准，不在提交正文中制造自引用SHA。

## AUD-41-COMPAT-01最小改动

`tools/agent-scheduler/state.js`仅向audit角色表增加大小写精确匹配的 `Independent-CodeAudit`；保留 `CodeAudit`、`Codex-CodeAudit`，不做模糊前缀/忽略大小写匹配，不变更角色权限或身份白名单。

仍要求可信GitHub author及OWNER/MEMBER/COLLABORATOR association；审计身份独立于开发和集成人；闭合且无重复字段的报告；最新有效时间顺序；最终status、verdict、FINAL phase、精确reviewed SHA/可选head一致、branch及Planner精确候选授权。别名不是身份认证，未知/矛盾角色仍保守阻断。新BLOCKED/REJECT不会被旧ACCEPT覆盖，伪造GitHub身份不能靠role文本获取权限。

新增 `tests/agent-scheduler/audit-r42-role-compat.test.js` 40项：三别名与两个合法verdict正例、未知/矛盾角色、伪造账号/association、最新BLOCKED/REJECT及来源乱序、错误SHA/分支/phase/verdict/status、缺失或错误Planner授权、身份独立、P1全局门禁；另含ASCII/Unicode岗位的旧写入器JSON格式账本正例，过期旧键不重放，追加保留历史。

新增 `tests/agent-executor/gate-integration.test.js` 8项：三别名进入Fake QA流程、最新否决不创建Fake作业、缺评论时间阻断、跨候选授权与同名CI skipped负例。每例断言actual_dispatch=false、actual_launches=0、model_spend=null。

旧V2两条测试只补 `created_at` 元数据，保留原断言不变：新版V1要求所有源评论有可排序时间，原无日期夹具先被该新门禁阻断，未到达其原本测试的source digest/活动角色检查。新增缺日期反例确认此门禁没有被绕过。

## 本地验证与保留的失败证据

环境：Node v24.22.1/Linux，数据及Fake状态均在私有临时目录，没有生产DB操作。

| 验证 | 实际结果 |
| --- | --- |
| 精确merge后原V1、尚未修改别名 | 220/220通过，0失败/跳过 |
| P2修复前新角色回归 | 38 total /20通过 /18预期失败 /0跳过；合法新别名及相应门禁原因未识别，复现旧行为；后加2项旧账本正例不在此前计数内 |
| 初次merge后原V1+V2 | 335 total /333通过 /2失败：上述两条无时间戳旧V2夹具；未删断言，补齐元数据后通过 |
| 最终V1串行文件执行 | 260/260通过，0失败/取消/跳过，含原220及新增40；原3项真实四Node进程争锁测试保留 |
| 最终V1+V2 | 383/383通过，0失败/取消/跳过：V1 260 + V2 123 |
| `umask 022; npm test` | 276/276通过，0失败/取消/跳过；未改业务/lib/public/数据库schema |
| Chromium管理/工作台/立项/行业 | 四组全部通过；本地Mock模型，真实HTTP/SQLite、文件导出/解析与浏览器；使用现有系统Chromium |

第30轮首次全量在继承umask077时275通过/1失败，既有backup-operations-security“chmod fake success”注入假定初始0644，但环境直接生成0600。保持测试/备份实现不变，以022重跑276通过；本轮按已知环境约束使用022。此可移植性问题仍存在，未隐藏首次失败，未在本包越权改备份代码。

本地Docker镜像sha256:6087c2ff0ca32171437d381136539ab92bfad95e935c05012afc121943b66ed8构建成功；仅该测试容器network=none、不发布host端口，health=healthy，随后删除容器及临时卷。镜像包含最终运行源码；后续仅补测试/文档/工作流证据。最终CI结果/限制见Issue #22准确SHA交付报告。远端计数只在取得对应原始日志/工件时报告，不能把本地数量写成远端实际读取数量。

复验命令：

```sh
node --test --test-concurrency=1 tests/agent-scheduler/*.test.js
node --test tests/agent-executor/*.test.js tests/agent-scheduler/*.test.js
(umask 022; npm test)
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:ui
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:workspace
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:intake
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:industry
node tools/agent-scheduler/cli.js
node tools/agent-executor/cli.js
node tools/agent-executor/cli.js --fake-demo
node tools/agent-executor/runner-entry.js --stub
```

后两条显式Fake/固定Node Stub命令不是Codex/Claude模型执行。专属CI使用精确PR head SHA checkout并断言HEAD，contents:read、persist-credentials:false；分别执行串行V1与组合回归，保存TAP及安全版本探测JSON。通用CI的PR merge源码树须另核与候选tree一致，run元数据head_sha不能替代实际checkout核验。不会为测试设置Secrets或启用schedule/daemon。

## 实际Planner文书迁移方案（NOT_RUN）

现有自由格式规划评论、只有开始无结束标签的文书不会自动转换成模型执行授权；最新模糊决议可能按既有规则阻断。这是安全协议要求，**不通过放宽解析或伪造Planner/审计报告来过门禁**。

未来由负责人认可的独立账号在明确候选SHA后，发布闭合、字段唯一的 `[PLANNER_DECISION_V1]` / `[/PLANNER_DECISION_V1]` 文书，并复核采集后的来源、时间、仓库、Issue、SHA和branch。结构化授权字段：

| 场景 | 必须绑定 |
| --- | --- |
| 开发/集成代码授权 | `authorized_role` 为codex/claude/integrator、issue、branch、approved:true；优先candidate_sha。若只有base_sha仅限该工作包范围；两字段并存必须一致 |
| 最终独立审计/QA | `authorized_role` 仍为audit/qa（不是文书显示别名）；issue、branch、approved:true、精确candidate_sha=reviewed_sha；base-only不能授权 |
| 撤回 | 同scope的更新决议明确approved:false或负状态；不得依赖旧绿报复活权限 |
| E4/E5真人/模型试验 | 另有精确candidate_sha及human_trials_approved:true和真实证据；本轮未授权、未生成真实批准 |

审计机器报告同样必须闭合，`role`精确三别名之一、status:READY_FOR_REVIEW、review_phase:FINAL、verdict:ACCEPT或ACCEPT_WITH_FOLLOWUP、reviewed_sha与分支绑定；若带head_sha必须一致。可信账号和独立性映射需要负责人核实，不能仅因为GitHub桥接评论都由一个账号发布就声明独立身份已认证。默认trustedActors仍空，不自动配置。

迁移正确次序：负责人核准独立身份/分工 → 真实Planner发布新精确结构化决议 → 独立审计/QA各自发布真实证据 → 离线只读快照验证 → 另获实际认证/费用/窗口授权后才考虑一次受控运行。开发者只提供协议说明和合成夹具，没有回写或重签任何真实授权，没有配置CLI认证或运行工作流定时器。

## 审核、NOT_RUN与回退

新候选仍需独立CodeAudit重验全部合入差异、角色正负例、原AUD-26/AUD-33负例、合法matrix/旧账本、V2签名/幂等/跨进程/kill恢复/限额/默认OFF及CI source绑定。#4 QA按新SHA验证必要业务/浏览器/文件回归；两者不能互相代替。

真实Codex/Claude任务、登录/凭据/原生Token及费用硬限制、真实GitHub CAS写入、跨主机/断电耐久、真实Planner账号授权迁移、E4/E5、自动轮询、生产和部署均NOT_RUN。代码READY_FOR_REVIEW不代表这些通过。

本轮业务schema仍v4，无迁移或生产数据改动。回退保留原4b8 WIP及d54来源历史，按匹配代码/状态快照审阅后进行普通追加回退；不force push、不删除幂等墓碑、不将未知费用改0或重发未知作业。不能为了回退重新启用旧REJECT Gate；所有实际入口继续OFF。
