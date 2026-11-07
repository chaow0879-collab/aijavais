# AIJAVAIS V2 R49 独立集中产品验收

role: Codex-ProductQA / AIJAVAIS-ProductQA
reviewed_sha: fcf52ed855dfccacb16cef632d0e3eb202510718
test_branch: test/codex-productqa-r49
idempotency_key: R49:fcf52ed855dfccacb16cef632d0e3eb202510718:ProductQA:FULL_FINAL
status: LOCAL_COMPLETE_CI_PENDING（本文件冻结本地证据；最终准确test_sha/CI及READY_FOR_REVIEW由Issue #4最终AGENT_REPORT_V1绑定）

## 授权、身份与本轮范围

[正式任务#4#6700575626](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6700575626)、[#10#6700603604](https://github.com/chaow0879-collab/aijavais/issues/10#issuecomment-6700603604)、[本人CLAIMED#6700741919](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6700741919)。已读#20/#26及作者完整报告#32#6700338502，独立checkout从精确R49建立，自有新分支无其他产品QA占用。只写tests/productqa-r49、product-acceptance/r49和本专用CI，不编辑业务源码，不签CodeAudit，不配置或读取Secrets、不真实模型/生产/生产MCP/main/部署/持续调度。

本地 **71独立PASS / 0产品FAIL**，另**5组开发者编写的Chromium脚本独立重跑PASS**，后者是辅助回归，不当成独立设计验收。自编2项R48 broker/current R49装配检查本地NOT_RUN，必须由独立GitHub CI真实执行后才计PASS；若CI全部通过，完整独立集为73项（36流程+28边界+2互操作+2 API+3 browser+2 delivery），五组辅助不混加。

本轮不重复旧R43整包29项；R47旧26项、作者689/276及R48历史49项不计为本轮独立验收。产品结论建议PASS_WITH_FOLLOWUP仅限本轮E2/E3，最终以同一冻结测试SHA的CI/Issue报告为准；没有真实自动接力、E4/E5或发布GO。

## 来源与集成核验

Q00直接读Git对象，比对固定R47→R49共70改动；server/lib/public/catalog/package零差异。R47 policy/demo及53项原测试的blob不变。R48相对R45的12文件逐路径/blob/mode与1f3fd9744cbeb7d07b2e9b3b48463301050af49d精确相同。R45的19路径和R46的21路径均保留，只有明确的policy/helper/runner-test及contract/pilot-contract/adapter六处新增整包修订，与声明清单完全相符；R44 SHA不是R49祖先，没有产品父链暗合入。此为产品来源证据，不自动ACCEPT作者安全例外。

独立Node/HTTP/SQLite夹具、签名与断言见flows.cjs、flow-fixture.cjs、cas-service.cjs、fake-cli.cjs、flow-worker.cjs；P1/P2负例及Git文件范围见boundaries.cjs。使用既有scheduler positive fixture作为合成输入数据，**不导入或执行开发者测试断言**；自己构造R46/R45 frame、三独立Ed25519证明、候选绑定、临时marked CLI、HTTP/CAS故障与预期断言。所有测试密钥只在进程内产生，子进程输入只含合成签名和公钥，无私钥导出、无真实授权。

## 逐项本地独立结果

| 场景ID | 状态 | 证据组 |
|---|---|---|
| F00-default-off-even-optimistic-facts | PASS | flows |
| F01-signed-event-success-repeat-and-ten-minute-tick | PASS | flows |
| F02-event-tick-race-one-process | PASS | flows |
| F03-four-real-processes-independent-journals | PASS | flows |
| F04-new-task-id-same-work-key | PASS | flows |
| F05-commit-before-ack-loss-no-process | PASS | flows |
| F06-authority-sigkill-after-sqlite-commit | PASS | flows |
| F07-runner-sigkill-after-durable-dispatch-marker | PASS | flows |
| F08-cancel-after-process-launch | PASS | flows |
| F09-unknown-fee-no-replay-or-zero | PASS | flows |
| F10-preexisting-local-receipt-not-remote-success | PASS | flows |
| F11-parent-handoff-known-true | PASS | flows |
| F11-parent-handoff-known-false | PASS | flows |
| F12-daily-reservation-budget | PASS | flows |
| F13-envelope-runtime-over-limit | PASS | flows |
| F13-envelope-tokens-over-limit | PASS | flows |
| F13-envelope-cost-over-limit | PASS | flows |
| F14-pre-dispatch-cancel | PASS | flows |
| F15-signed-persistent-halt | PASS | flows |
| F16-untrusted-sender-and-forged-tick | PASS | flows |
| F17-no-broker | PASS | flows |
| F17-bad-signature | PASS | flows |
| F17-cross-sha | PASS | flows |
| F17-missing-ci | PASS | flows |
| F17-audit-veto | PASS | flows |
| F17-qa-veto | PASS | flows |
| F17-expired | PASS | flows |
| F17-expiry-string | PASS | flows |
| F18-real-http-403 | PASS | flows |
| F18-real-http-429 | PASS | flows |
| F18-real-http-500 | PASS | flows |
| F19-real-process-403 | PASS | flows |
| F19-real-process-429 | PASS | flows |
| F19-real-process-fail | PASS | flows |
| F19-real-process-hang | PASS | flows |
| F19-real-process-overcost | PASS | flows |
| Q00-exact-sources-product-and-r48-preservation | PASS | boundaries |
| Q01-R47-fully-resigned-cross-SHA-audit | PASS | boundaries |
| Q01-R47-fully-resigned-cross-SHA-qa | PASS | boundaries |
| Q02-R48-S01-resigned-source-B-gate-A | PASS | boundaries |
| Q03-duplicate-json-0 | PASS | boundaries |
| Q03-duplicate-json-1 | PASS | boundaries |
| Q03-duplicate-json-2 | PASS | boundaries |
| Q04-unambiguous-json-positive | PASS | boundaries |
| Q05-expiry-v1_audit-missing | PASS | boundaries |
| Q05-expiry-v1_audit-null | PASS | boundaries |
| Q05-expiry-v1_audit-string | PASS | boundaries |
| Q05-expiry-v1_audit-expired | PASS | boundaries |
| Q05-expiry-v2_audit-missing | PASS | boundaries |
| Q05-expiry-v2_audit-null | PASS | boundaries |
| Q05-expiry-v2_audit-string | PASS | boundaries |
| Q05-expiry-v2_audit-expired | PASS | boundaries |
| Q05-expiry-operator-missing | PASS | boundaries |
| Q05-expiry-operator-null | PASS | boundaries |
| Q05-expiry-operator-string | PASS | boundaries |
| Q05-expiry-operator-expired | PASS | boundaries |
| Q06-valid-three-distinct-expiry-signatures | PASS | boundaries |
| Q07-scope-allowed-test | PASS | boundaries |
| Q07-scope-audit-test-write | PASS | boundaries |
| Q07-scope-committed-outside | PASS | boundaries |
| Q07-scope-committed-reverted | PASS | boundaries |
| Q07-scope-newline-untracked | PASS | boundaries |
| Q07-scope-newline-staged | PASS | boundaries |
| Q07-scope-newline-committed | PASS | boundaries |
| T2-10-API | PASS | api |
| T2-13-after-http | PASS | api |
| T2-09-cancel | PASS | browser |
| T2-11-UI | PASS | browser |
| T2-12-GAP | PASS | browser |
| org | PASS | delivery |
| independent-file-parsing | PASS | delivery |
| I01-r48-broker-current-r49-audit | NOT_RUN（本地审批服务阻断；待CI） | interop |
| I01-r48-broker-current-r49-qa | NOT_RUN（本地审批服务阻断；待CI） | interop |

辅助五组：admin/workspace/intake-draft/industry/claude-delivery，本地5/5 PASS。脚本原作者是开发者，本人仅按任务重跑并独立核对计数、退出码及截图。

## 流程及阻断实证

- F01/F02/F03：合法HMAC合成GitHub event→operator/V1/V2独立证明、同SHA CI/审核→R46 SQLite CAS→严格R45签名→真实marked Node程序→normalized outcome，成功只启动1测试进程。重复event、新签10分钟tick、event/tick竞争与4个不同Node runner/不同journal竞争均最多一次。第五个新Node进程重试不再启动CLI；保留PID、调用参数、HTTP请求、SQLite快照与outcome。仅loopback权威服务，不是真GitHub state-ref或真实timer。
- F04/F05/F06/F07：不同ID同work key拒绝；SQL COMMIT后断ACK、权威服务COMMIT后SIGKILL、执行器读到持久DISPATCHING后SIGKILL，均不重派。恢复过期租约为UNKNOWN/null outcome且保留0.1合成费用预留；全部临时SQLite quick_check=ok。允许0次执行及UNKNOWN，不声称分布式exactly-once。
- F08/F09/F10/F11：真实测试进程启动后取消→STOPPED且cost=null，重复不重启；未知费用不转0；已有本地成功receipt不冒充远端成功，保留原run_id、UNKNOWN及预留；只有成功且费用已知的父阶段能进入新独立签名阶段，未知父保持WAIT_PARENT。
- F12/F13/F14/F15：日预留金额、单次金额、Token及runtime上限拒绝；调用前取消无进程；签名HALT持久阻断。F19超额费用由测试进程输出0.2，cap0.1时不报告SUCCEEDED并保留证据；这只是检测合成超额输出，**不证明厂商费用可强制硬封顶**。
- F16/F17：不可信sender、伪造tick对象、未配broker、签名篡改、跨SHA完整重签、缺CI、独立audit/qa否决、过期和字符串期限全部无执行。拒绝前不创建任务的场景实际检查空SQLite jobs；取消后的合法拒绝墓碑保留，不误作无claim。
- F18：真实loopback HTTP返回403/429/500时无任务/无进程，报告AUTHORIZATION_DENIED/READ_RATE_LIMITED/READ_TRANSIENT；读退避不是自动重新派发。F19实际测试程序返回403/429/非零/超时/超额，均不冒充成功且不会自动再启。
- Q01/Q02：R47 audit/qa跨SHA重签且B有CI仍在Store.claim前拒绝；R48-S01/R45-S01来源B与门禁A虽有效重签，实际R45入口SOURCE_GATE_SHA_MISMATCH，0进程、无claim/dispatch文件。
- Q03/Q04：V2 GitHubRefProtocol注入含重复/转义同名/嵌套重复键的原始blob→RemoteJobs.claim，全部BLOCKED、0写/CAS，不清墓碑。合法空白和键顺序正例保留。
- Q05/Q06：三个独立角色各自缺失/null/字符串/已过期期限，完整重签仍拒绝；三枚不同公钥、未来整数期限正例通过。
- Q07：实际临时Git仓库中已提交越界、提交后revert、字面前导换行路径在untracked/staged/committed三状态均拒绝；合法tests内QA提交通过、audit写同路径仍拒绝。使用NUL分隔路径并核对原始字节哈希，不将换行路径裁剪成tests/。
- I01（CI专项）：不改原R48 bridge，原TestBroker签current R49 frame，audit/qa各一次真实marked Node进程；核对R48映射exit_code/exit与Fake层级，并拒绝把real_agent_launch=true outcome转换为Fake。无broker仍BLOCKED。此处本地未执行，CI结果必须单独读取。

## 普通用户关键路径回归

本人R47独立资产仅改业务绑定SHA并收窄保留2个HTTP/SQLite、3个Chromium、1交付+1解析场景；来源与哈希见inherited-assets.json。

- 8并发同ID：实际loopback模型1次/账本1行/7个409，异参冲突和重启不重放；模型实际收HTTP后SIGKILL保留unknown/null/预留，旧ID409。
- 真Chromium取消和明确再次批准恢复、临时settle故障202/人工核对提示/重启未知费用、永久3在途/第4次429无派发/区分本次0与上一请求未知费用；只读诊断与隔离停机备份/恢复均通过。没有生产恢复或供应商停止收费结论。
- 两岗位前序结果交接→人工审核→合成组织图SVG和实际DOCX/XLSX/PPTX。401门禁、delivery-check不新增模型或费用、不代批；同SVG字节在无CSP loopback由真实Chromium打开，3节点且无脚本/img执行；ZIP CRC/XML及python-docx/openpyxl/python-pptx独立解析实际sentinel、质量组单元格和幻灯片标题。
- 三行业仅为既有回归样例；产品的自定义角色和工作流源码未变，未新增行业硬编码。**没有真实模型陌生行业盲测，也没有证明专业质量、真实用户理解或通用智能能力。**

## 失败记录与环境边界

F06初跑读取child.signalCode早于退出事件，测试自身报null≠SIGKILL；实际进程启动0、SQLite已commit且完整。只将断言改为等真实退出事件，再完整重跑36项全通过，原日志/哈希保存在execution-notes.json，无产品错误被删或改skip。

最后一次额外本地权限命令被Automatic approval review拒绝执行：审批服务账户用量上限，无法完成review；明确说明不是认定命令不安全。该命令无编辑/执行发生，没有绕过审批。保留本地额外互操作NOT_RUN；通过正常文件操作写入独立脚本，由本轮原已授权的GitHub CI提供额外证据。执行说明见execution-notes.json。

Node24.22.1、Chromium155.0.8059.79、Playwright1.62.1；CI pinned Playwright1.56.1及配套Chromium。Office解析器docx1.2.0/openpyxl3.1.5/pptx1.0.2。临时DATA、SQLite原库、私钥不提交Git；截图/脱敏trace/HTTP日志/实际文件/receipt/进程证据只入CI artifact。local-evidence-index.json只保留本地证据路径/大小/SHA256。

## CI绑定与可复跑

专用workflow：.github/workflows/productqa-r49.yml，7job modes flows/boundaries/interop/api/browser/delivery/browser-groups，contents只读、无Secrets/定时/事件持续执行，fetch-depth0。每job先断言固定业务SHA祖先及仅独立测试/报告/workflow变更，GITHUB_SHA准确对应测试提交。每job打印R49_HASHES，artifact productqa-r49-<mode>含原始日志及SHA256SUMS.json。最终CI run/attempt/7job实际结果、准确test_sha、artifact digest与关键文件哈希由#4最终报告绑定；未完成前不以作者CI替代。

```sh
QA_GAPS_OUT=/tmp/qa49-flows node tests/productqa-r49/flows.cjs
QA_GAPS_OUT=/tmp/qa49-boundaries node tests/productqa-r49/boundaries.cjs
QA_GAPS_OUT=/tmp/qa49-interop node tests/productqa-r49/interop.cjs
QA_GAPS_OUT=/tmp/qa49-api node tests/productqa-r49/run.cjs --api
QA_GAPS_OUT=/tmp/qa49-browser PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium QA_GAPS_CHROMIUM_NO_SANDBOX=1 node tests/productqa-r49/run.cjs --browser
QA_GAPS_OUT=/tmp/qa49-delivery PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/productqa-r49/delivery.cjs
QA_GAPS_OUT=/tmp/qa49-groups PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/productqa-r49/browser-groups.cjs
```

## 未完成、风险与发布门禁

| 项目 | 状态 | 说明 |
|---|---|---|
| 原受控软件smoke | BLOCKED（历史环境限制；本轮NOT_RUN） | 原隔离unshare不可用，ran=false/not_run；产品实现未变，未重跑或降隔离，不称软件可运行。 |
| 真实官方CLI/收费模型/E4/厂商账单 | NOT_RUN / NOT_VERIFIED | real_agent_launches=0。所有Node程序Fake，所有签名和审批为合成；金额是合成meter/预留，绝非账单。 |
| 真实用户/五人及专家/E5 | NOT_RUN | 无人员联系，自动浏览器/Office能解析不代表专业成果或普通用户验收。 |
| 真实GitHub受保护state-ref CAS | NOT_RUN | 仅loopback HTTP+SQLite及注入REST协议；真实transport关闭，无远端写测试。 |
| 默认分支event/10min cron/持续接力 | NOT_RUN / NOT_ENABLED | event与tick为明确合成调用，虚拟时钟推进10分钟不是真等10分钟或真scheduler。 |
| 官方身份、真实broker、供应商强制费用上限 | BLOCKED | 未获配置/验证和单次owner GO，不用env或Fake密钥补授权。 |
| R49独立CodeAudit最终裁决 | NOT_RUN by ProductQA | 原P1/3P2本轮产品负例拒绝只属产品证据，仍须#2独立安全签字。 |

无新增产品P0/P1，建议在同SHA独立安全门禁无阻断后继续既有R50/R51 **非live**整包开发/集成；本报告不提前认可其新SHA。真实接力仍NO_GO，须官方身份/可信签名/可强制预算/受限Runner/停止机制/真实CAS及单次明确批准齐备。最后以#4正式AGENT_REPORT_V1为准，不自行发布或关闭Issue。
