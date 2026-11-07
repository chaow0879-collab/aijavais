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

执行过程中仅运行短命安全watch（非持续调度器），读同一R46权威状态；HALT、状态读不确定、有效期结束会取消自己的进程组。输入克隆后保持签名来源；每次backend read/CAS有界，无自动重试。**新增的两处共享接缝**：R46 SignedFakeR45Runner传递beforeLaunchCheck，R45在clone完成、真正spawn前执行此权限缩减复核并检查abort/KILL。既有HMAC/审批/HALT域分离、source/gate强绑定、NUL文件名保护均保留。

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

当前R50最终增量与R49双门禁状态、准确最终SHA/CI/计数将在#34唯一最终报告更新。本包尚在开发，不以中间检查点申请审计或真实GO。
