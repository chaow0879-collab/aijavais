# R49：首次受控接力的统一集成候选（默认关闭）

唯一作者Codex，任务[#32](https://github.com/chaow0879-collab/aijavais/issues/32)，分支`integrate/codex-r49-first-real-handoff`，起点`3c37035befab9e411724686ff22e44333174e217`。这是通用跨行业虚拟AI公司的阶段性自动化工作包；一次真实接力实证后应回归普通用户的动态团队、真实交付及HALOFLUX，不继续扩张内部Runner。

## 当前状态与来源

**当前为M0–M6可独立部分的工程检查点，WAIT_R48，不能作为完整冻结候选或真实执行GO。**准确最新SHA、CI及计数见#32作者报告。R47已获同SHA[独立CodeAudit ACCEPT_WITH_FOLLOWUP](https://github.com/chaow0879-collab/aijavais/issues/2#issuecomment-6699993622)及[独立ProductQA 26PASS/0FAIL](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6699977676)，其结论仅覆盖3c37035，不转移给R49新增代码或真实执行。

| 来源 | 固定SHA | 引入方式 |
| --- | --- | --- |
| R47 | 3c37035befab9e411724686ff22e44333174e217 | 已存在分支精确起点；候选绑定policy/demo及53项反例完整保留 |
| R46 | a1a258a41c2041ab8d6cebc622cfed0c690c3387 | 仅ab3e→363ed485→a1a258两个提交cherry-pick；原顺序保持 |
| R45 | 0b95251133d47fd7c0b9280d3ddb5287c2628307 | 只cherry-pick此独立提交；未merge其R44父4c198c43 |
| R48 | 尚未交付 | 不写其独占路径、不假造源码或符合性结果，M7待固定READY SHA |

两个来源新增路径完全不重叠。精确原父链、文件scope、旧/新blob例外在`tools/first-handoff-r49/sources.json`；只读`sources.js`检查R47全树保全、R45/R46各自新增路径、R44不在候选祖先及本地已提交字节一致。保全工具的例外是**作者提出、待独立复审**，不等于安全认可。原53路径R43保全也保留，仅对三个P2新增精确blob例外，不豁免目录。

## 单一执行链和真实差异

`first-handoff-r49/control.prepare`核候选、目标ref和来源SHA一致，调用R46已有Gate（包括V1/V2/操作员三身份签名、独立审计/QA、精确CI和来源摘要）→R46的`pilot-contract.prepare`生成**未签名**R45 v1 frame→外部受信dispatcher签署→R45原authorize→R46原Ledger/CAS/lease/DISPATCHING/read-back→R45原runOnce和Journal→原Supervisor短命子进程→R46 normalize→原Ledger结算。没有新调度器、持久库或另外一套锁。

生产代码不生成dispatcher私钥、不代签GitHub评论。`execute()`只有显式simulate才能进入**SignedFakeR45Runner**；该adapter拒绝live policy，必须是与未签frame逐字段相同且验签通过的输入，仅调用R45的marked Fake模式。默认CLI及非模拟调用始终BLOCKED，即便有人将规划用readiness布尔值全部设true，也仍有LIVE_BUILD_DISABLED。规划摘要从不当执行授权。

R46原先把所有候选限制为旧R43 ab3e，无法验证新R47/统一SHA。这里改为严格验证已批准config.source_sha并与envelope匹配，仍由完整签名、快照门禁和候选ref绑定约束；旧config不改、更不让旧ab3e获得真实执行许可。R46 normalize原来只认E3_FAKE与process.exit，实际R45输出E3_FAKE_CLI与process.exit_code：新增准确映射，保留旧协议测试。任何real_agent_launch=true、摘要/候选/费用不一致结果仍拒绝。

Fake流程中的密钥、CI、审计和预算是合成夹具，**不代表真实审计批准或真实费用**。Fake的0.0123仅为测试CLI输出的费用字段，不是供应商账单。实际模型调用及收费均未发生。

## 三个原P2在激活前的最小修复

- **AUD-R43-02**：V2 GitHub blob通过strict-json逐对象检查重复键（包括转义同名键、嵌套对象），保留合法空白与字段顺序。损坏或含糊状态读失败，不产生CAS或删除墓碑；体积4MiB、深度64封顶。R46自己的canonical/checksum状态检查保留。
- **AUD-R43-03**：三个readiness证明的expires_at都必须是未来安全整数；有效签名不能为缺失、null、字符串、NaN等补授权。
- **AUD-R43-04**：workspace以最初批准SHA检查工作区及全部新增commit的路径，保留commit后又revert的越界证据，禁用rename折叠，并要求原SHA是当前HEAD祖先。audit不能编辑，QA仅获批tests路径可改。没有把HEAD移动后的clean误当作没有越界。

这些边界在实际激活前若仍能越权或重费，即为阻断风险；本作者补丁与负例等待最终独立整包审计，不能仅因历史标签P2放行。

## 证据分层、测试与失败历史

```sh
node --test tests/first-handoff-r49/*.test.js
node --test tests/agent-pilot-r45/*.test.js tests/auto-handoff-r46/*.test.js
node --test tests/agent-executor/*.test.js tests/agent-scheduler/*.test.js
npm test
node tools/integration/verify-r43-sources.js
node tools/first-handoff-r49/sources.js
node tools/first-handoff-r49/cli.js
```

专属`codex-r49-integration.yml`在**同一github.sha**保留业务/P2/严格Office、五组Chromium、隔离容器、V1/V2及来源核对，增加R45/R46/R49的跨模块回归。公开官方CLI的安装、--version/--help只核元数据，无模型调用或认证。没有schedule、webhook或模型Secrets；R48未交付时明确记录WAIT_R48/符合性NOT_RUN，工程CI绿不能冒称完整M7通过。

E2是Fake模型/合成评论及签名；E3是真实Node进程、临时HTTP/SQLite CAS、SIGKILL恢复与真实文件/解析。四独立Node Runner和独立本地journal对同权威CAS至多启动一次Fake CLI，event/tick重复、ACK丢失、403/429/崩溃、超时/取消/kill、未知费用都不自动重发。已验证已知成功父可接下一份独立签名阶段，费用未知父不能自动推进。不保证分布式exactly-once：允许0次，UNKNOWN保留费用上界，人工调查后才另行批准新工作。

失败历史保留：首轮R49脚手架把快照对象替换后，原fixture签名闭包仍绑定旧对象，引发SIGNED_SOURCE_BINDING；改为原对象内更新，未改生产签名规则。次轮四进程复测中把返回历史SUCCEEDED当重执行，断言不符：保留实际语义，检查DUPLICATE_NO_REPLAY、runner_calls=0、总进程计数不增；不放松最多一次断言。首次已提交来源检查因新增strict-json没有显式列入scope而BLOCKED，随后精确钉住该新增文件blob，未宽泛豁免目录。恢复测试曾在把模拟时钟退回旧时刻后得到CLOCK_SKEW阻断；现将事件、后续tick及恢复时刻分别更新快照并重新签署有效合成frame，明确断言DUPLICATE_NO_REPLAY或UNKNOWN来自持久状态，而非复用旧签名失败。准确最终测试结果另见#32，不把试跑exit0或旧SHA结果拼接。

## 首次真实试点GO/NO_GO与部署准备

目前**NO_GO**。本地官方Claude CLI未安装；Codex仅版本/帮助可读（不等于认证），两者官方凭据均NOT_CONFIGURED，当前非GitHub-hosted。R47双独立差异复验已有上述结果；R48最终增量、最终统一SHA独立审计及QA、真实身份和可强制费用/Token上限、GitHub远端状态写、可信签署broker、实际event/schedule尚未满足。E4/E5=NOT_RUN；实际模型启动0；真实账单NOT_VERIFIED。

后续须由负责人额外批准以下**一个有界试点窗口**，不是本包自动启用：

1. R48固定交付选择性合入后，冻结唯一统一SHA，跑同SHA CI并集中独立CodeAudit/ProductQA；R47先行门禁也必须有实际结论。R44产品包不暗中引入。
2. 受信dispatcher在可信GitHub API重新采集快照、核真实login/最新否决/固定SHA/CI/独立角色，使用外部受管Ed25519签署R45 frame。模型输出或Issue自由文本不能签署或授权。
3. 官方Claude认证仅从负责人批准的短命Runner身份传入，不读取聊天Cookie/开发会话令牌；默认凭据白名单仅R45所列官方变量，临时HOME、日志脱敏、凭据不进入仓库/成果。Codex没有已验证原生金额上限时继续拒绝。Claude CLI金额flag仍需供应商可强制上限的实证，Token硬上限不能靠输出自报。
4. 单次受限只读任务、固定SHA、批准金额与Token/运行时间、只读工具、无MCP外部写；R45 PID/退出码/官方JSON回执/未知账单和证据哈希必须留存。短命clone与CLI权限属于边界的一部分，不能宣称OS级隔离已获独立认可。
5. 最小GitHub App权限：任务采集issues/actions只读；状态writer仅必要contents写并绑定专用state-ref、禁force/delete、受保护fast-forward及CAS冲突。GitHub本身的token通常不具单ref权限，需受信broker与保护策略独立核验，未能强制时BLOCKED；不把contents:write当作天然受限。
6. 经负责人批准的main变更才把审阅过的事件/10分钟工作流注册到**default branch**。`templates/activation.yml.disabled`只是NOT_INSTALLED方案，job常false、权限只读、没有Secrets。真实启用时可信事件仅作重新采集提示，fork/PR/任意评论不能成为指令；push/workflow_dispatch开发CI不代表cron已启用。
7. 停止必须先持久HALT并禁止新派发；活跃进程由批准的受信取消通道/超时结束。撤销App或模型授权、关闭workflow是应急措施，不能保证已发生费用撤销。读回失败、签名/费用/门禁/lease不确定立即NO_GO；保留墓碑及reservation，不重放。

生产服务器、main合并、Secrets配置、真实GitHub状态写、真实官方模型、持续自动执行均未实施。Schema仍v4，无生产数据库迁移。回退通过追加提交，保留所有持久状态、未知费用与历史SHA；不能回滚墓碑来重试可能已收费的工作。

## 完成长包的剩余步骤

Claude在#31实际READY后核其完整40位SHA、source父链与CI，只在R49选其专属新增目录/文档/workflow增量，R48作者分支保持冻结。未收到时记录WAIT_R48；不虚构符合性通过。R47独立结论只解除非live代码基线阻断，R49自身双门禁未结前仍NO_GO。以上依赖完成才冻结一个最终整包SHA，提交最终READY_FOR_REVIEW，由总指挥安排一次集中独立审计和QA。当前工程检查点不替代此最终交付。
