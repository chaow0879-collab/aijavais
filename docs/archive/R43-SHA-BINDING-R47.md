# R47：AUD-R43-01 候选SHA绑定定向修复

唯一修复分支 `fix/codex-r47-r43-sha-binding-p1`，精确基线为原R43冻结 **ab3e07979f67924e795426737e26c5c4d84b8501**。原R43及R46/R45作者分支保持冻结，不覆盖其文件或重写历史。任务[#22 #6690655576](https://github.com/chaow0879-collab/aijavais/issues/22#issuecomment-6690655576)，准备分支说明[#6699009123](https://github.com/chaow0879-collab/aijavais/issues/22#issuecomment-6699009123)，独立REJECT报告[#2 #6689538804](https://github.com/chaow0879-collab/aijavais/issues/2#issuecomment-6689538804)。

先前独立R46整包已恢复核验并正式交付/冻结：a1a258a41c2041ab8d6cebc622cfed0c690c3387，CI42253344324 attempt1双job成功，本地101控制/383自动化/276业务通过；完整[#30报告](https://github.com/chaow0879-collab/aijavais/issues/30#issuecomment-6699403152)。本R47基于ab3e，不偷合R46/R45/R44，R46 READY不抵消本P1，也不代表其源ab3e已获安全接受。

## 问题、真实复现与结果

旧V2分别校验操作员签名绑定的request SHA、请求分支ref、source_digest及gate_digest，但未验证这些证据是否属于**同一候选**。

按独立审计原方法，对audit及qa各保留V1候选A=`3`重复40位及其CI/审核证据，仅把request.sha、observed_ref、允许工作分支ref、payload.sha改B=`9`重复40位，重算source/gate摘要并使用有效Fake私钥重签。B没有对应CI。相同脚本在修复前/后执行：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| audit/qa同候选A | SUCCESS、1个Fake job | SUCCESS、1个Fake job |
| audit/qa完全重签B，V1候选仍A，B无CI | 错误SUCCESS、1 job、1 would_launch | BLOCKED/CANDIDATE_SHA_MISMATCH、0 job、0 would_launch |
| B额外有自己的绿色CI，审核门禁仍属于A | 新增负例 | 仍BLOCKED；B的CI不能替代B缺失的阶段/独立审核证据 |

全部为合成审批密钥及FakeAdapter，真实Agent启动始终0、actual_dispatch=false、model_spend=null；复现成功不计安全PASS。没有调用真实厂商API或GitHub状态写入。

## 最小实现及阶段语义

`tools/agent-executor/policy.js`在`verify()`中、任何`Store.claim()`之前增加中央候选绑定：

- 请求SHA必须是严格40位小写十六进制字符串，拒绝类型强制转换。
- audit/qa必须有V1 `observed_shas`自身字段`integration`，是严格合法SHA且**精确等于request.sha**。缺失/null/空/错误类型/继承原型值拒绝；有效操作员重签、ref变化、额外CI不能覆盖该条件。
- 原角色/phase映射、签名、source_digest、gate_digest、权限、费用/Token/到期和ref检查保持；同一候选缺V1对应CI或阶段不符仍拒绝。
- 若已提供integration候选，integrator也不能指向另一SHA。
- **集成准备的必要特例**：INTEGRATION_READY时尚无最终integration候选，不能凭空绑定一个不存在的独立审核结论。此阶段明确要求request及签名payload的`parent_shas`精确等于V1已验证#15/#17双输入（固定角色顺序）；`base_sha`为严格SHA并等于请求SHA/已批准目标基线，payload同值。仍由engine核目标分支ref及完整来源摘要。它仅允许已批准的集成准备，不是审计/QA跨SHA执行通道；不能换role/phase绕过阶段映射。

`demo.js`只在显式Fake integration fixture中增加上述输入/基线字段并签入payload；没有为真实操作者代签或迁移历史授权。旧缺字段集成请求将拒绝，需要真实授权者按新合同明确批准，不自动补字段。

执行引擎流程未改：verify→source_digest→活动角色/QA失败/ref/adapter→claim→RUNNING→Fake。新拒绝发生在claim前，既无新job/reservation，也无would_launch。原本相同候选已完成job的幂等键与费用字段不变；重启、改B重签后仍不可产生B任务或重放A。

## 测试与保全

新增 `tests/agent-executor/r47-sha-binding.test.js` **53项**，包括两种模型×audit/qa同SHA正例、无CI/有CI的完整重签B负例、同SHA缺CI、空/类型错/缺失/继承候选、错误phase、集成输入/目标基线缺失或矛盾、合法集成准备、已给候选不一致、跨重启旧墓碑/未知费用及权限不扩大。

本地目标测试53/53、组合自动化**436/436**（原383+53；其中V1仍260，V2为176），0失败/取消/跳过。业务276等最终准确SHA与CI结果见#22最终报告；不把本地数量当远端日志计数。原所有安全测试保留，不删或放松旧断言。

原源码保全工具不删除：仍检查业务18+自动化35=53条来源路径及Git blob/mode。历史SVG测试例外不变，新增仅两个**精确旧/新blob**例外（policy.js与demo.js），标记`AUTHOR_PROPOSED_PENDING_INDEPENDENT_REVIEW`，不使用目录/路径通配；其余50条来源文件保持原样。新的`reviewed_security_fixes`只是作者声明的可定位差异，不是独立审计通过。确切blob见工具本身及CI来源JSON。

复用原联合workflow，仅增加本R47分支push触发；四job在同一准确SHA检查来源、自动化、全量业务/P2/严格Office、五组Chromium及隔离容器，不新增自动派工workflow。作者只交一次最终候选，不逐commit申请审计。

```sh
node --test tests/agent-executor/r47-sha-binding.test.js
node --test tests/agent-executor/*.test.js tests/agent-scheduler/*.test.js
npm test
node tools/integration/verify-r43-sources.js
node tools/agent-executor/cli.js
node tools/agent-executor/cli.js --fake-demo
```

原R43对照复现四项观察中两个跨SHA错误接受已本地确认；修复后两个正例保留、两个反例拒绝。新增测试及原383均首次通过，无失败用例被删或改成skip。历史R43浏览器/umask问题仍见原文档，不把旧CI/旧QA签字移给本SHA。

## 明确延期、实际执行与下一步

独立审计三个P2 **未在本包修复**：AUD-R43-02远端JSON重复jobs键；AUD-R43-03 readiness期限类型；AUD-R43-04 workspace已提交越界差异。这些相关源文件未变，仍须未来统一硬化/真实接入前复核，不将它们说成已通过。P1修复不依赖真实CLI、GitHub写或放宽任何安全开关。

真实CLI、远端写transport仍编译期OFF；5个ENABLED=false、dry_run=true、cron/webhook=false。真实模型/付费API、GitHub状态写、后台自动接力、10分钟云端轮询、生产/服务器/Secrets/main/PR合并均未做；E4/E5与真实账单NOT_RUN/NOT_VERIFIED。业务schema仍v4，无迁移。

最终新SHA交原独立CodeAudit定向重放两跨SHA反例及53项/关键回归，并由ProductQA按同一SHA作差异复验。保留原R43 REJECT与旧QA29PASS/1环境BLOCKED事实，不继承其签字。后续R44/R45/R46合流需对齐新的精确修复源与绑定合同，再对统一增量候选集中审核；不得把旧R46源ab3e自动当已修复。

回滚保留Git父链、原所有墓碑/未知reservation，普通追加回退，不force/reset/删除状态/将未知费用清零或重放收费请求。若回退到ab3e，AUD-R43-01亦重新存在，必须保持实际执行OFF并标REJECT，不能把回退当安全恢复。
