# R53 通用多岗位工作后端与联合产品候选

基线为R51 `3d6937348d94e585e44d567de05f14ecd0eb3636`，本分支`integrate/codex-r53-universal-workflow`。真实官方身份、供应商单次金额/Token硬限额及owner GO缺失，自动化与真实模型仍NO_GO。R51原安全文件不改；产品是通用/陌生行业虚拟AI公司，不将测试样例当行业支持白名单。

## 现有资产与新增接缝

原`ProjectEngine`负责顺序角色执行、共享预算、前序输出、工具/Skill、质量检查、人工返工和取消；`ProjectStore`负责SQLite v4及PID排他锁、重启不重派、消息/事件/文件BLOB、费用。原模型草案使用已有持久请求和取消202协议。本包没有新的CLI Runner、定时器或调度队列。

精确选择性引入R44单个产品提交`4c198c430806836bb289cd5da57b7fad44c7b0dc`，不引入其其他旧父链。其通用规则按工作类型/成果形式/风险生成建议，不按行业名if/switch；R53后端复用其协议，计划明确`PLAN_SIMULATED/E2_RULES_NOT_AI`，没有模型时不能宣称理解完成。岗位职责、步骤、验收、连接与工具建议均可编辑；建议不是授权，也不代表专业能力已验证。

`lib/universal-workflow.js`是现有Engine的产品适配器；`lib/product-events.js`只投影服务端持久事件，不接受浏览器伪造状态。必要接缝仅在`lib/project-engine.js`、`lib/project-store.js`、`lib/v2-api.js`；新增按岗位权限与预算、审核事件及通用验收要求，旧API认证/同源/预算/取消/幂等仍保留。R52独占前端文件由Claude维护，最终只按准确READY增量引入。

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
| POST `/universal/runs/:runId/accept` | `{artifactId,sha256,confirmCriteria:true,acknowledgeSimulation:true,expertReviewNote?}` → `{run}`；绑定当前round/hash/实际可解析文件，人工确认不是专业认证 |

角色授权是以roleId为键的`rolePermissions`：`{approved:true,connectionId,allowedTools:[],maxTokens,maxCost}`。每角色必须批准准确连接、调用的工具和上限，不能用其他岗位权限替代。复用原共享预算，实际工具与Skill拿到该岗位缩减后的allowedTools。新通用入口仅允许策略白名单内已注册/当前可用的本地连接；远端费用硬上限未证明时返回`BLOCKED_UNENFORCEABLE_COST_CAP`。旧产品远端API策略没有因此被放宽，本轮测试仅Mock。

事件schema `aijavais.work-event/v1`：`event_id/source_event_id/sequence/task_id/work_id/project_id/parent_id/type/raw_type/role_id/actor/source_sha/timestamp/round/step_id/artifact_id/message_id/evidence/cost`。事件id、parent和时间由服务端append生成；source SHA来自运行源码Git元数据，发布镜像无.git时null。`agent_started`只由调用适配器前的持久model_dispatched事实产生，step准备不冒称模型已工作；`handoff`有实际消息ID，`peer_review`有审查角色产出ID；`accepted`仅人工确认。

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
