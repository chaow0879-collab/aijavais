# R53 通用多岗位工作后端与联合产品候选

基线为R51 `3d6937348d94e585e44d567de05f14ecd0eb3636`，本分支`integrate/codex-r53-universal-workflow`。真实官方身份、供应商单次金额/Token硬限额及owner GO缺失，自动化与真实模型仍NO_GO。R51原安全文件不改；产品是通用/陌生行业虚拟AI公司，不将测试样例当行业支持白名单。

## 现有资产与新增接缝

原`ProjectEngine`负责顺序角色执行、共享预算、前序输出、工具/Skill、质量检查、人工返工和取消；`ProjectStore`负责SQLite v4及PID排他锁、重启不重派、消息/事件/文件BLOB、费用。原模型草案使用已有持久请求和取消202协议。本包没有新的CLI Runner、定时器或调度队列。

精确选择性引入R44单个产品提交`4c198c430806836bb289cd5da57b7fad44c7b0dc`，不引入其其他旧父链。其通用规则按工作类型/成果形式/风险生成建议，不按行业名if/switch；R53后端复用其协议，计划明确`PLAN_SIMULATED/E2_RULES_NOT_AI`，没有模型时不能宣称理解完成。岗位职责、步骤、验收、连接与工具建议均可编辑；建议不是授权，也不代表专业能力已验证。

`lib/universal-workflow.js`是现有Engine的产品适配器；`lib/product-events.js`只投影服务端持久事件，不接受浏览器伪造状态。必要接缝位于`lib/project-engine.js`、`lib/project-store.js`、`lib/v2-api.js`和`server.js`的首次输出回调；新增按岗位权限与预算、审核事件及通用验收要求，旧API认证/同源/预算/取消/幂等仍保留。R52独占前端文件由Claude维护，最终只按准确READY增量引入。

## 后端JSON契约（R52可复用）

所有接口继承原管理员会话与同源JSON门禁，无未登录后门。保存计划不会运行；运行需要明确批准。基础地址`/api/v2`。

| 接口 | 输入/返回与副作用 |
|---|---|
| POST `/universal/plan` | `{goal,domain,audience,outputs,acceptance,constraints,risks}` → `{schema,status:PLAN_SIMULATED,project,intake,clarifications,modelRecommendations,toolRequirements,permissions,budget,acceptance}`；不保存、不外呼 |
| POST `/universal/projects` | `{project}` → `{project}`；用户编辑后保存，使用原项目Schema |
| PUT `/projects/:projectId` | 原项目编辑，携带`expectedVersion`；409版本冲突；保留通用工作流标记 |
| POST `/universal/projects/:projectId/runs` | `{requestId,approved:true,rolePermissions,maxTokens,maxOutputTokens,maxCost,allowedTools}` → `{run}`；唯一请求ID持久占位后调用原Engine |
| GET `/universal/runs/:runId` | `{run}`；状态/步骤/文件/事件/费用真实读取SQLite；成本`usd:null`不假称厂商零账单 |
| GET `/universal/runs/:runId/events?after=0&limit=1000` | `{schema,events,cursor,readOnly:true}`；稳定顺序分页重放，无写入事件API |
| POST `/universal/runs/:runId/cancel` | 原Engine取消；保留在途计费事实，不声明撤销已发费用 |
| POST `/universal/runs/:runId/rework` | 新`requestId`、反馈与完整新授权；同run新round，原产出保留 |
| POST `/universal/runs/:runId/deliver` | `{requestId,format:docx\|xlsx\|pptx\|md\|csv\|json}` → `{artifact}`含downloadUrl/hash/round/sourceArtifactId；只从已完成实际输出生成文件 |
| GET `/runs/:runId/artifacts/:artifactId/download` | 原认证下载接口，实际持久化字节 |
| POST `/universal/runs/:runId/accept` | `{artifactId,sha256,confirmCriteria:true,acknowledgeSimulation:true,expertReviewNote?,acknowledgeUnknownCost?}` → `{run}`；绑定当前round/hash/实际可解析文件，人工确认不是专业认证 |

角色授权是以roleId为键的`rolePermissions`：`{approved:true,connectionId,allowedTools:[],maxTokens,maxCost}`。每角色必须批准准确连接、调用的工具和上限，不能用其他岗位权限替代。复用原共享预算，实际工具与Skill拿到该岗位缩减后的allowedTools。新通用入口仅允许策略白名单内已注册/当前可用的本地连接；远端费用硬上限未证明时返回`BLOCKED_UNENFORCEABLE_COST_CAP`。旧产品远端API策略没有因此被放宽，本轮测试仅Mock。

事件schema `aijavais.work-event/v1`：`event_id/source_event_id/sequence/task_id/work_id/project_id/parent_id/type/raw_type/role_id/actor/source_sha/timestamp/round/step_id/artifact_id/message_id/evidence/cost`。事件id、parent和时间由服务端append生成；source SHA来自运行源码Git元数据，发布镜像无.git时null。`agent_started`代表适配器派发尝试；`work_started`仅由服务器实际收到首个输出片段的回调生成，hang/预检失败没有该事件，step准备不冒称模型已工作；`handoff`有实际消息ID，`peer_review`有审查角色产出ID；`accepted`仅人工确认。

HALOFLUX可按事件ID去重、sequence分页，乱序/断线重新GET补齐，不能靠前端动画决定后台状态。旧事件无新增字段时投影稳定`run:seq`，标UNVERIFIED_LEGACY_EVENT。所有事件费用保持未知供应商账单，假provider的成功不升级E4/E5。

## 状态与持久性

请求→离线草案→用户编辑保存→逐岗批准→原run.running→准备/工具/模型派发→真实消息交接→独立审核角色→review_required→生成文件→明确验收approved；返工需反馈和新授权、最多原5轮；取消/失败/重启中断禁止自动重派。

请求幂等复用SQLite settings事务：owner+action+requestId的SHA256键、规范参数摘要与永久占位。同ID同参数只读返回已有run/artifact或claimed不重放；不同参数409。启动前占位已提交，进程若在调用后/回填前崩溃会留下保守claimed，不盲目再发。DATA仍单进程独占；这是持久防重/可能零次，不声称分布式exactly-once。交付BLOB与事件在原事务中保存；请求回执失败不能删除墓碑。

Schema仍v4，无DDL迁移；新增JSON字段和settings前缀与旧库兼容。回滚前停唯一实例、保留完整DATA/WAL/请求墓碑/费用/文件。旧代码不识别R53协议时禁止继续这些新工作流，不能删settings后重派。无生产数据操作。

## 自测与证据

```sh
node --test tests/universal-workflow-r53/*.test.js
npm test
node tools/universal-workflow-r53/sources.js
```

8个未在实现中枚举的中文/英文陌生与跨域目标，至少3个交叉任务；真实Node HTTP/SQLite/Mock provider，角色交接、独立复核、授权反例、费用未知、Token不足、取消/重启、重复请求、版本化返工与验收。实际DOCX/XLSX/PPTX从运行输出下载，用Python标准zipfile CRC及python-docx/openpyxl/python-pptx独立解析。产物保存在`R53_EVIDENCE_DIR`（或打印的临时目录），它们是Mock内容的真实文件，不是专业成果质量PASS。

初次测试错误：模型注册API实际200而新fixture误期望201；修正契约断言。第二次发现低风险默认lean计划未选独立复核，R53改用至少normal建议并在原Engine对通用工作流检查独立审查角色；没有删审核事件断言。最终计数、SHA、CI与R52合流状态以#36唯一最终报告为准。

## 用户旅程与诚实边界

普通用户描述一个新目标→拿到带模拟标记的可编辑岗位/成果/缺失工具清单→选择自己的已登记本地模型与逐岗权限→明确批准→真实HTTP执行多岗和交接→查看因果事件/审查意见→输入反馈并重新批准返工→下载带来源hash与模拟标记的可打开文件→人工确认当前版本。没有连接只保存草案，缺专业工具/资格不能宣称已达专业质量。真实厂商E4、领域专家E5、正式无人值守开发接力均NOT_RUN，HALOFLUX上游商业授权/NOTICE边界不变。

### 补充验证边界

未知usage不仅是完全缺失，还包括估算/部分/重启未知用量；DTO供应商费用一直为null，验收此类账目需额外`acknowledgeUnknownCost:true`，确认不会清零预留。Office表格和演示文稿也嵌入E3未专业验收标记。英语只按通用output form词组产生离线建议；领域/标准不明确仍要求澄清，不宣称语言模型推理。

逐岗授权映射使用无原型字典并验证自有键，角色ID如`__proto__`不能使权限在JSON持久化时丢失后回退到全局工具集合；有专门持久化负例。现有非通用项目事件保留MODEL_ADAPTER_UNVERIFIED，不因存在planning.goal就伪标为本地Mock。

本地浏览器首轮因Playwright默认浏览器缓存缺失未执行；无需安装，改用已安装`/usr/bin/chromium`后原R44真实浏览器流程通过。源码不改变浏览器断言或生产权限。后续R52合流及真实后端联调另行记录，不能拿独立fixture浏览器PASS冒充最终整合用户旅程。

## R52 精确合流与最终契约适配

R52真正[READY报告](https://github.com/chaow0879-collab/aijavais/issues/35#issuecomment-6705287149)源`0532f606258d06bf5215907b1566dc419a86cab5`、父R44、CI42361149501 completed/success；17个增量路径只做单提交cherry-pick，不带其旧父链。所有Claude独占文件与原源blob/mode一致。

新增认证GET `/api/v2/universal/runs/:id/workbench?after=0&limit=1000`由`lib/workbench-r53.js`输出原样R52 `aijavais.workbench.event/v1`及artifact/v1。每work内seq从1连续，持久event_id/parent/source SHA稳定，分页重放不重新编号旧记录；R52原projector可直接消费，倒序/重复输入有实际联调测试。费用事件绑定真实usage ledger ID且供应商账单null，不把本地价表零当真实厂商账单。非R53旧运行只标SERVER_RECORDED，不冒称E3或E4。

补上原Engine平滑关停缺少run_cancelled事件的缺口。`rework`新增`fromStepId`：先验证前缀实际角色产出和hash，重用这些持久证据，从所选步骤到末尾执行依赖后缀；不选仍整轮重做，每轮都需全新授权，不自动重试。原R52 UI把重点步骤放进反馈文字，仍按整轮返工；精确步骤ID路径由新API提供，未私改Claude前端行为。

新增POST `/api/v2/universal/runs/:id/criteria`：`{requestId,expectedRound,checks:{"criterion-1":{status:"passed|failed|unverified",note}}}`；标准文字来自运行快照，按当前round存不可变JSON证据文件与事件，不修改模型/账本。存在已保存检查时，任何未通过项都会阻断accept；没逐项保存时confirmCriteria是明确的批量用户声明，逐项结论进入review.acceptance，不是平台专业认证。原R52 UI本地检查仍是本地便签，服务器不会假称已同步这些本地值。

### 原R52测试适用范围与失败记录

冻结R52原12项整体在准确源SHA隔离普通clone执行，不创建worktree。其scope测试专门断言R44之后只有Claude路径，因此对联合R53树不适用；原E3测试还明确断言SIGTERM**没有**取消事件，这是一条上游缺口观察，本包已经修复，不能保留这个错误行为去迎合历史断言。直接在联合树运行原套件出现这两项失败，已完整保留日志；不删除、不篡改上游断言。

统一CI分别执行：冻结R52完整12项、联合树纯模块10项（另2项按上述上下文仅在冻结整套中执行；Node过滤选择不计入skipped计数）、R53真实HTTP/事件/授权/定向返工/验收正负例、R52原完整11项真实Chromium。联合树作者scope由R53全树来源核验与17文件逐blob对照替代；修复后的关停行为在R53服务重启负例核对真实run_cancelled事件。不把原Frozen12算作联合源码12个运行时通过，也不把旧缺陷复现当当前安全成功。

原R52页面继续使用已认证V2 API；R53增加的是同一Engine的更严格逐岗授权/幂等/版本验收API和直接事件DTO。R52原页面尚未消费新逐条服务器检查API和fromStepId字段，仍按原文案说明其本地检查/整轮返工限制。原页面的前端角色状态由保全的旧V2 snapshot适配器重建；新增量端点与原projector的真正联调单列，不冒称前端已全面改接新协议。

## 已收到的R51最终独立结论（仅旧SHA）

R51安全[#2#6706878270](https://github.com/chaow0879-collab/aijavais/issues/2#issuecomment-6706878270) ACCEPT_WITH_FOLLOWUP仅非live，0P0/0P1/2P2；审计CI42360045723 **completed/failure**，保留158 PASS/1 FAIL及额外symlink反例，不能说全绿。AUD-R51-01为V2 QA越界临时文件写后删除时忽略目录ctime；AUD-R51-02为允许目录链接绕出工作区。它们不由本产品分支修改：当前任务禁止改R51安全源码，真实路径仍编译期OFF。请规划AGENT另行聚合授予精确安全差异修复及复审，激活前两项都必须关闭。

R51独立QA[#4#6705133661](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6705133661) PASS_WITH_FOLLOWUP，41 PASS/0FAIL；[补充说明#6706891475](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6706891475)明确这两项安全反例不在其41项PASS内。两份结论仅对R51准确SHA生效，不是本R53独立认可。真实官方身份/可信签署、金额+Token硬边界、OS隔离、保护ref与Owner GO继续缺失，E4/E5、生产/main/Secrets/真实持续调度全部NOT_RUN/NOT_ENABLED。
