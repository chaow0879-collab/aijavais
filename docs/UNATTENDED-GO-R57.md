# R57：一次有界调用连接既有自动接力链

基线 R55 `8e9584149cccac02fa0b5c39a68c1983ec60170e` / tree `d0ebc0b559aca1e51922692db4e3888786153514` / CI42438404898五job成功。唯一分支`integrate/codex-r57-unattended-go-gate`。R55独立CodeAudit与ProductQA正在另行取证，作者不代签。R56并行且只精确集成其正式READY后相对R55新增提交，不修改其专属文件。全行业产品、R53/R54和R55原安全实现保留。

## 真实入口与范围

`control.runOnce`/`runChain`是**一次有界的组合调用**，不是新Runner、服务、定时器、数据库或签名协议。最多4包；不会自行唤醒停止的聊天会话。实际调用关系：

```
可信event或OIDC tick
  -> 原R50 verifyDelivery/verifyOidc + Broker
  -> 原R51 r50-bridge.handleTrusted / entry.runPilot
  -> 原R46 reconcile + Ledger/CAS/永久工作键
  -> 原R45 runOnce/Journal/只读workspace/supervisor
  -> GET固定Git ref/commit/CI/结构化report
  -> 原manifest/proofs格式 + verifyReadiness独立密钥校验
  -> 下一个已经授权的after任务
```

默认/live请求在任何凭据getter、网络、回调或spawn前调用原official-port的BLOCKED。没有env开启、HTTP live入口或新官方执行循环。唯一当前可执行路径是显式Fake + TestSigner + 原R51 SYNTHETIC_FAKE_ONLY admission，不能将其转换为真实批准。原R51 official-port与原R46 live GitHub transport编译关闭均未修改。

两类官方CLI命令仍来自R45 `runner.command`：Claude print/json/plan/只读工具及Codex exec/read-only。R50批准协议目前只接受Claude只读，Codex的USD账单解析仍unknown；本包不谎称已启用真实Codex。官方Claude版本/帮助/标志由原R51 metadata工具在CI空HOME重放；仅公开元数据，不认证、不产生模型请求。CLI的max-budget/超时/客户端计数**不是**供应商单次和总额USD/Token硬限额。供应商allowance验证器缺失时原costFeasibility始终BLOCKED。

## 执行授权与结果回收

调用者是受信控制器，不是Issue自由文本。`packet`沿用R51原形状，`collectionPolicy`须以`r57_collection_policy_digest`纳入**原R46的已签manifest**。回收密钥必须与该执行配置的trusted_keys相同；repo/issue/branch/workflow/developer/reviewer白名单包含在该digest内。进程前及运行中重新比较policy，并检查父任务独立回执，不能事后替换审核公钥/工作流。

`receipts.collect`只调用注入的受信GET transport（固定repo、固定ref/SHA、固定run/comment），每次最多1秒/1MiB，未知/429/5xx/超时均失败关闭，不读任意URL或执行报告文本。检查：

- branch仍指向原SHA；commit和tree真实存在。当前只读任务work_sha==source_sha，**没有生成开发代码提交**。
- CI的id/attempt/head_sha/branch/repo/head repo/fork/event/workflow path/结论与回执一致；PR、其他SHA和其他workflow不能代替。
- 报告必须是原R45 outcome JSON，出自批准的developer identity，run/dispatch/source/gate/known cost/实际Fake进程/log hash匹配持久R46结果。自由文本“READY”不算证据。CI和报告被绑定到完整receipt digest。原R45的evidence.ci_ref是执行生产者workflow，可能不同于后续验证CI；单独保存在producer_ci_ref并绑定签名，不能替代对目标验证CI的固定SHA/workflow检查。检查点CI42440725126暴露了此前将两者等同的契约错误，已用带公开CI环境变量的本地负/正对照复现并修正，不删SHA断言。
- 回收签名继续使用原`{manifest,proofs}`，`control_operation=COLLECT`和`r57_receipt_digest`隔离执行授权域；不是第三套签名格式。原verifyReadiness验证三把不同密钥；审核/QA的reviewed_sha及各自login白名单、QA PASS、expiry均需成立，developer不能自审。

没有完整独立身份/签名时`REVIEW_PENDING / WAIT_AUTHORIZED_REVIEWER`，已签但QA尚PENDING时`QA_PENDING`。负面/过期/错误/同身份签名不推进。Receipt和签名均为E3 synthetic测试时，输出明确SYNTHETIC_ONLY_NOT_REAL_ACCEPT。

`runChain`只顺序消费已批准的任务票；直接调用后继runOnce也须重新回收并验父任务，不能绕过链。唯一上游例外是`first-pilot-r51/r50-bridge.js`添加一个**AND型、仅减权**authorityCheck，交给原entry现有beforeProcess与限时watch重查，未改旧批准、源码、预算、停止逻辑。`sources.json`逐blob/mode列此例外及R56原件；不拿作者manifest当独立审计签字。

## 状态与恢复

`READY -> CLAIMED -> RUNNING`来自原R46审计链，运行成功且known cost后才到`CI_PENDING -> REVIEW_PENDING -> QA_PENDING -> REWORK_OR_NEXT -> DONE`。后半是对重新读取的不可替代证据的**投影**，不另建第二状态账本；重启后重新校验。CI失败的REWORK_OR_NEXT带next_allowed=false，不能自己重写任务或自动返工计费。

执行UNKNOWN/失败/取消/撤回/失ACK不会在当前调用推进。下一tick可以只读重查已持久的SUCCEEDED，但不会再派发旧工作。R46原工作键/任务参数摘要/租约/墓碑和R45 journal保持权威；费用null与reservation保留，不把未知改0。SIGKILL后原R46 recover将过期DISPATCHING标UNKNOWN；无自动重发。新控制器不能用新task_id绕过原work_hash。

本包无Schema迁移：业务SQLite仍v4；R46 document schema1与R50 trigger SQLite原样复用。回滚先HALT/停止唯一实例，保存DATA/WAL/refs/journals/墓碑/账单；只撤代码，不删除claim或unknown预留重跑。

## E3与真实GO

测试使用真实Node、loopback HTTP、原SQLite CAS服务、临时Git bare对象库、原marked Fake CLI。三阶段为**只读摘要/审核/QA测试任务**，输出SHA是确实存在的原提交；Fake的CI网关来自本地Node校验exit和Git对象/Journal事实，不是真实GitHub运行/真实独立审计。每阶段不用用户粘贴prompt=0只在E3成立，绝不是已经真实无人值守模型开发。真实GitHub工作流仍只在开发分支push/manual运行测试。

```sh
node --test tests/unattended-go-r57/*.test.js
node tools/unattended-go-r57/sources.js
node tools/unattended-go-r57/cli.js
node tools/unattended-go-r57/cli.js --matrix <准确40位最终SHA>
npm test
```

证据`R57_EVIDENCE_DIR`归档三阶段、真实进程和SHA/日志、并发CAS、OWNER_GO_MATRIX。完整旧自动化/安全/业务/浏览器/Office回归由专属R57 CI运行；旧R52 V2回退与默认R54分别测试，R55已披露离线fixture展示限制未越权改动。

跟踪`OWNER_GO_MATRIX.json`明确NO_GO，candidate_sha=null不能作为批准；CLI/CI使用准确最终SHA生成可机读绑定副本。真实官方身份、费用单笔/总额和Token硬上限、供应商账单及停止、App/OIDC/KMS、同SHA双独立门禁、受保护FF-only state-ref、正式host OS/网络、默认分支event/10min tick和Owner GO均不得从测试boolean推导。

唯一未来安装计划在`templates/*.disabled`，非生效workflow。事件与延迟的10min兜底须共用原CAS；GitHub不保证准点。Owner一次配置/授权清单见matrix：保护Environment及最小App/OIDC/KMS权限、独立reviewer身份、真实费用硬界限、HALT、固定候选审验、单次只读试点、单独批准的activation commit及main/secret/ref/trigger安装。**当前模板即使被复制也exit78，不能通过一个env变量启动模型**。尚缺真实账户与供应商能力，不能承诺配置后无需任何经审计激活代码；若供应商根本无强限额，明确STOP而不是继续堆Runner。

截至本检查点真实Agent=0、E4/E5 NOT_RUN、真实GitHub state-ref写NOT_RUN、正式cron/webhook NOT_ENABLED。R56与最终同SHA CI/独立审验状态以#40最终报告为准。


## R56 精确合流与最终回收

R56已正式READY并冻结于`2b53e350d3b147b9216f8241a3e63350ceaf6b67`，专属CI42441148770同SHA成功。仅将相对R55的`be385790480f495551ffea12608ef800583b983c`和`2b53e350d3b147b9216f8241a3e63350ceaf6b67`精确cherry-pick成`f010cfee8fb0a249b175b237caba7e9c9b4bcda9`与`80eac00807b95b5cd6b558e045dccd73b318e205`；全部13个R56新增文件blob/mode保持原件。自身source guard逐项检查，未改Claude分支或其任何源码/测试/工作流。

`r56-adapter.step`把R56的可信trigger→机器ticket→provision接到本R57的runOnce；provision必须给出已经签好的原R51 packet和collectionPolicy，R56 pipeline/item摘要还须通过`r56_pipeline_digest`纳入该批准策略。adapter不签名、不改工单、不降级权限。它把实时R56候选/CI/撤回/负面审验复查作为AND型authorityCheck交给现有R51监视器，避免只在接力起点检查。直接默认/live调用仍在任何getter前BLOCKED。

原R56的HANDOFF_COMPLETE只表示原R46各job执行成功；本adapter仍重新回收所有完成记录（lookupCompleted须给出原已批准packet），全部SHA/CI/独立签名回执都成立才能对外报告HANDOFF_COMPLETE。末阶段缺审核时保留REVIEW_PENDING，不把execution SUCCEEDED冒充最终验收。补齐签名后的只读重查不会再启动Fake进程。

新增联合E3实际连接R56的HTTP/SQLite GitHub模拟器/原事实读取/签名评审/机器ticket，与R57的临时Git bare、HTTP/SQLite CAS、R50/R51/R45和回收器，完成3个原Fake只读阶段，产生3条机器报告，event+tick重复不重派；另验证末阶段缺审核、晚到signed REJECT运行中停下、假trigger与live getter拒绝。它仍是E3，GitHub模拟器的CI状态不是外部真实GH流水线，KMS与官方模型未运行。

原R56 `scope:`断言检验作者独占分支，不能在联合树声称成立；**完整9项含scope原断言**在`run-r56.cjs`精确冻结clone运行；其余**8项行为原断言**在联合HEAD再跑。没有编辑/删除原断言。联合fixture首次失败来自误用了stats.reports（原emulator字段是post_report）以及重复插入旧评审主键；已改为读取真实计数并append新REJECT，R56原件不动。最终本地/CI计数和明确限制以#40最终报告为准。
