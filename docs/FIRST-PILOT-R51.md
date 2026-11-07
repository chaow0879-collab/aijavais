# R51 一次性官方CLI试点准备（默认OFF）

Codex唯一开发/集成人，任务#34，分支`integrate/codex-r51-first-pilot-readiness`，准确基线R49 `fcf52ed855dfccacb16cef632d0e3eb202510718`。R49冻结分支保持不写；其独立CodeAudit/ProductQA只对该SHA有效，当前没有继承为R51签字。产品仍是普通人普遍/陌生行业的通用虚拟AI公司，首次真实接力后停止增加内部Runner。

## 目前的真实结论

**NO_GO / BLOCKED_UNENFORCEABLE_COST_CAP / BLOCKED_OFFICIAL_CREDENTIAL**。只形成可审代码及E3证据，不发模型请求，不读真实认证，不配置Secrets，不合main，不写真实state-ref，不注册event/cron或部署。

官方公开npm固定`@anthropic-ai/claude-code@2.1.318`已安装到临时目录。禁用安装脚本使`.bin/claude`仍为占位入口，首轮元数据探针诚实BLOCKED；选择同版本官方`claude-code-linux-x64/claude`后，在全新HOME和无凭据环境，仅`--version/--help`核对`2.1.318 (Claude Code)`及R45所需只读参数成功。没有模型/auth请求。公开发行integrity、帮助hash及官方README Git blob存于本包公开证据JSON。

`--max-budget-usd`的公开帮助说明API花费限制，但**不是本项目已验证的供应商端单次账单上界证明**。没有实际供应商allowance/不可超支预付机制、官方撤销/额度接口或独立账单实证。客户端flag、超时、输出Token、使用者boolean、测试签名/假预付均不能填补；costFeasibility始终BLOCKED。暂不实现虚构的费用服务或第四套Runner。官方合法凭据与受信provider机制需要负责人后续明确授权与证据，不能读取聊天Cookie或开发会话令牌来补齐。

## 复用与最小接缝

R51 `entry.runPilot`→现有R49 prepare/execute→原R46 Ledger/FF-only CAS/lease/tombstone→原R45 Journal/runOnce/Supervisor。没有新调度器、队列或费用库。

新增admission仅是附加执行约束，**不是新的批准系统**。它的digest进入既有operator manifest，再由原V1/V2/operator签名与R49核验。严格绑定task/ref/SHA/work key/dispatch、USD cap/Token/runtime、短有效期、Read/Glob/Grep和非生产只读隔离；目前唯一可执行scope为显式E3_FAKE，合成身份/费用不会变成E4授权。

`official-port.runOfficialOneShot`编译常量为false，任何env/runtime config不能开启。关闭时不读取传入凭据getter、不预检认证、不请求远端、不启动CLI。即使未来源码显式打开build，未配置可验证的provider费用机制仍阻断；复用R45官方一次性端口，不复制进程监督。该E4路径未运行，也不是可直接上线的生产执行器。

`app-state.ProtectedAppState`复用原R46 Git对象协议（固定repo/ref、单父、force:false、无自动写重试）。App transport编译期OFF，先拒绝再读credential context。候选包含限时App上下文、固定HTTPS API/禁止redirect、响应上限及请求超时的最薄实现；不安装App、不获取token、不调用真实写API。未来verified身份和受保护ref必须来自经审计的可信实现，不能凭caller boolean认定。

执行过程中仅运行短命安全watch（非持续调度器），读同一R46权威状态；HALT、状态读不确定、有效期结束会取消自己的进程组。输入克隆后保持签名来源；每次backend read/CAS有界，无自动重试。**共享接缝**：R46 SignedFakeR45Runner传递beforeLaunchCheck，R45在clone完成、真正spawn前执行此权限缩减复核并检查abort/KILL；随后R46核心再读取同一owner/lease/envelope/HALT及有效期，防止clone或较慢的复核耗尽租约后仍启动。精确文件及blob在sources.json，均需最终独立复审。既有HMAC/审批/HALT域分离、source/gate强绑定、NUL文件名保护均保留。

远端失ACK/崩溃保留claim、UNKNOWN费用null与上界；无法证明跨host/断电耐久则NOT_VERIFIED。不保证exactly-once，允许零次且禁止盲目重发。已有成功receipt不等于已核对供应商账单。

## 自测与证据范围

```sh
node --test tests/first-pilot-r51/*.test.js
node --test tests/agent-pilot-r45/*.test.js tests/auto-handoff-r46/*.test.js tests/first-handoff-r49/*.test.js
node tools/first-pilot-r51/metadata.js /path/to/pinned/public/claude
node tools/first-pilot-r51/cli.js
node tools/first-pilot-r51/sources.js
npm test
```

新负例实际调用R51入口：缺/错签名或SHA/CI/审核、改预算/Token/工具/隔离、过期、假硬上限、真实身份缺失、默认OFF、clone后HALT、运行时取消/状态不明。临时真实Node HTTP/SQLite服务模拟GitHub Git objects/ref API，PATCH以单父FF CAS事务提交；四个独立Node Runner/独立本地journal仅一次Fake CLI，lost ACK、服务/worker SIGKILL、403/429/5xx及恢复不重派。该服务仅测试fixture，不是新增生产状态机，也不代表真实GitHub强一致或实际App授权。

Fake meter只用于schema测试，不是供应商账单；真实模型启动0，E4/E5 NOT_RUN。原Office/业务、五组Chromium与容器在同一最终CI核验，不能把旧SHA计数拼为新结果。精确旧/新blob例外在sources.json，来源核验不是独立安全认可。

## 最小Owner动作与停止线

1. 对唯一R51最终SHA完成集中独立CodeAudit与ProductQA，核真实源码、保留R49独立结论边界。
2. 供应商明确支持并经独立验证的单次金额/Token硬边界；无法满足则保持BLOCKED，而非继续添加Runner。
3. 负责人批准一次小额非生产只读窗口、合法官方凭据、可信签名/身份与受保护App/ref权限；在受信短命环境提供，禁止聊天中交付Secrets。
4. 另行批准必要源码开关与main/default-branch工作流变更，再启用一次受控event/10min兜底；本包只提交.disabled样例。
5. 停止先持久HALT、禁止新派发，再取消活跃进程/撤销授权；已发生费用无法靠kill撤销。异常回滚保留journal/state-ref/墓碑和unknown上界，不清零、不重claim。

R50已核[真实READY报告](https://github.com/chaow0879-collab/aijavais/issues/33#issuecomment-6700976155)、准确4ea740ee5638882e44f697a6a47cee60c8a8457d及CI42328460103；只引入1b5a837c→4ea740ee两提交、17个新增文件，源码/mode保持与原SHA一致，不修改Claude冻结分支。R49双门禁状态及准确最终SHA/CI/计数由#34唯一最终报告更新，不能把作者或旧SHA结论代签。


## R50到R51的最终接入

`r50-bridge.handleTrusted`默认真实路径先返回LIVE_BUILD_DISABLED，连broker/approval/IdP凭据getter都不读取。仅显式E3_FAKE：R50原verifyDelivery或verifyOidc（显式synthetic JWKS）→精确task/issue/source/role→R49 prepare→R50原Broker→R51 runPilot。R50 TestSigner必须显式且原样，收据的SHA/work key/digest再次绑定；真实/KMS未配置时仍BLOCKED，不伪造信任。

只在R51独占适配层补强：approval必须有exact task_id；broker与operator/V1/V2/owner身份按DER比较，不能靠PEM换行不同绕过；额外admission digest由原operator批准。R50 v1 owner token没有原生Token硬上限/供应商账单证明，R51的synthetic Token约束不能被当作实际provider执行证明。

授权撤回、R50 KILL、批准/策略/来源快照变化在CAS前、clone后spawn前及运行中重复核验，短命watch至多一个在途查询。源变化只减权停止，不自动重签或提升权限。真实GitHub最新否决采集/IdP/JWKS可信来源尚需后续经审计部署，内存fixture的改变不冒充真实GitHub事件。无效getter/循环/非JSON约束拒绝，Fake执行只复制公开协议字段，不枚举官方credential context。

失败历史：首个联合撤回测试少传TriggerStore.revoke的reason参数，SQLite拒绝第三参数绑定（63/64）；修正**测试调用**为(id, reason, at)后通过，未改R50实现或撤回断言。官方CLI占位入口失败与原生二进制元数据成功分开保留；不把初次失败或历史来源计数删掉。

默认分支只使用本R51的`templates/r50-trusted-trigger.yml.disabled`作为后续唯一启用候选；R50原样例是保全的上游资料，不同时注册第二个dispatcher。R51模板job常false、固定运行时SHA占位、无模型Secrets，需另一次owner审批的default-branch activation commit对准冻结runtime SHA，与R50 trusted_workflow_ref精确一致。这里不存在“复制就自动启动”。

## R49独立门禁反馈与R51增量修复

R49固定SHA `fcf52ed855dfccacb16cef632d0e3eb202510718`：独立[CodeAudit ACCEPT_WITH_FOLLOWUP](https://github.com/chaow0879-collab/aijavais/issues/2#issuecomment-6703392470)，0 P0/0 P1/1 P2；独立[ProductQA PASS_WITH_FOLLOWUP](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6703334140)，73 PASS/0 FAIL，另有原5组Chromium通过。它们只对R49生效，不是R51认可，也不准许E4/E5。

AUD-R49-01：忽略文件可绕过原Git状态核对，激活前必须修复。本R51在原V2及R45工作区加入完整文件系统清单（忽略文件、权限、内容hash、ctime及Git元数据），在调用任何验收Git命令**之前**拒绝敏感元数据篡改。保留原提交历史/NUL路径检查；QA仍可按原范围正常提交，只有index/当前分支ref和日志/objects/COMMIT_EDITMSG允许配合Git提交变化，不能改HEAD/config/hooks/exclude。R45只读工作区及V2 audit启动路径预先移除全部文件/目录写权限；HOME/TMP留在仓库外。清理只恢复本实例临时目录权限，不跟随符号链接。扫描有限额，异常一律失败关闭。

**限制**：POSIX权限不是同UID强沙箱；同UID可chmod，清单用于拒绝篡改后的成功回执，不证明从未发生瞬时写入或外部I/O。V2 QA/developer的实际OS写范围、主机隔离、真实网络封锁尚未实证，真实执行继续NO_GO。未做生产部署或内核沙箱启用。

新增17项AUD-R49-01测试涵盖原复现忽略目录data/ignored、审核和QA/开发角色、合法QA提交、Git配置/HEAD/exclude、权限模式、先写后删、符号链接清理及真实R51入口下同UID恶意Fake；三个恶意Fake的成功JSON均不能产生SUCCEEDED，且不可重派。首轮85/86失败原因是测试文件mode受环境umask收窄，显式设置fixture模式后通过，未放宽清理断言。原R50实现和测试逐blob保留。

R51新入口的真实进程PID/exit/命令类别、脱敏日志及SHA256由测试在R51_EVIDENCE_DIR归档；标注E3_FAKE、供应商费用null与真实Agent启动0，不上传私钥/原始数据库。最终准确测试数量、SHA、同SHA五job CI见#34最终报告；原R48 49项作为历史冻结来源单列，不重复累计。

### 数据及回滚

本包不改变业务Schema v4、R46 ledger schema1或R50 TriggerStore表结构，无迁移。回滚仅切回已冻结的源码/禁用模板，先HALT、禁止新派发并停止自己的进程。保留原state/journal/永久墓碑及UNKNOWN费用和reservation；禁止删除状态后重新派工。没有模型费用或生产数据操作可回滚。
