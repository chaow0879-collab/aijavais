# AIJAVAIS V2 R51 独立集中产品差异验收

role: Codex-ProductQA / AIJAVAIS-ProductQA
reviewed_sha: 3d6937348d94e585e44d567de05f14ecd0eb3636
reviewed_tree: 510d2fa20055d67aacc64c42d1cdf8a3473f12fd
base_sha: fcf52ed855dfccacb16cef632d0e3eb202510718
test_branch: test/codex-productqa-r51
idempotency_key: R51:3d6937348d94e585e44d567de05f14ecd0eb3636:ProductQA:FULL_FINAL
status: LOCAL_COMPLETE_CI_PENDING（本文件冻结本地检查点；最终准确test_sha/CI/工件及READY_FOR_REVIEW由Issue #4最终AGENT_REPORT_V1绑定）

## 授权与结论边界

[本轮#4正式任务#6704912040](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6704912040)、[#10#6704952388](https://github.com/chaow0879-collab/aijavais/issues/10#issuecomment-6704952388)、[本人CLAIMED#6705003604](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6705003604)。已读取最新#20/#26、作者#34#6703653218及原R49独立结果。本轮专职产品QA，不参与开发、不代签CodeAudit。远端精确SHA建立新独占测试checkout/branch；只增加测试/夹具/报告/专用CI，所有被测业务源码只读，原分支/main未写。

本地 **41独立PASS / 0 FAIL**；另**5组开发者原编Chromium脚本独立重跑PASS**，后者单列辅助，不混充独立设计。41=34个新入口/身份/只读修复/故障差异场景+2个API/SQLite+3个Chromium+2个实际交付/独立解析。未搬入旧R49的73项、旧R47的26项、作者865/276/77项；不重复大量无影响历史场景。

建议产品结论PASS_WITH_FOLLOWUP，仅限本轮固定SHA E2/E3；最终以本测试SHA的独立CI和#4正式报告为准。真实官方模型启动0、E4/E5及真实GitHub受保护CAS/正式cron未做，真实接力NO_GO。三行业只是样例，不以本轮旧UI回归声称已验证普遍陌生行业产品。

## 自编方法及独立性

- automation.cjs是本轮34个独立场景/断言；support.cjs自行构造R50 owner批准、RSA OIDC、HMAC事件及broker上下文；git-service.cjs是本人新建的loopback HTTP+真实SQLite Git对象/ref单父FF CAS fixture，不是真GitHub写。worker.cjs是真实独立Node执行器，fake-cli.cjs是明确marked的独立Node程序。
- flow-fixture.cjs继承本人R49合成数据构造器，新增自行构造的R51 admission与operator manifest摘要签入；只复用开发者scheduler positive fixture作为输入数据，不导入开发者测试断言。所有审批、公钥/私钥、IdP和事件都是合成；测试私钥不提交，不读取或配置任何真实Secret。多进程需要的TestSigner合成seed只放0700/0600临时目录，结束删除，不进入证据/工件。
- 用户路径继承本人R49独立资产，只改准确被测SHA；来源哈希见inherited-assets.json。原五组浏览器脚本是开发者编写，本人重跑只作辅助。资产的QA43/QA49 sentinel是合成输入标识，不代表沿用旧输出或旧SHA结论。

## 本轮逐项结果

| 场景ID | 状态 | 证据组 |
|---|---|---|
| A00-source-and-real-NO_GO | PASS | automation |
| A01-new-entry-Git-protocol-HTTP-SQLite-success | PASS | automation |
| A02-loopback-receiver-event-and-fresh-OIDC-tick | PASS | automation |
| A03-two-R50-event-OIDC-processes | PASS | automation |
| A04-four-R51-processes-one-work | PASS | automation |
| A05-AUD-R49-01-actual-process-ignored | PASS | automation |
| A05-AUD-R49-01-actual-process-metadata | PASS | automation |
| A05-AUD-R49-01-actual-process-transient | PASS | automation |
| A06-full-filesystem-scope-ignored-audit | PASS | automation |
| A06-full-filesystem-scope-ignored-qa | PASS | automation |
| A06-full-filesystem-scope-metadata | PASS | automation |
| A06-full-filesystem-scope-allowed-qa | PASS | automation |
| A07-HALT-at-final-spawn-boundary | PASS | automation |
| A08-R50-revoke-before-spawn | PASS | automation |
| A09-R50-withdraw-running-process | PASS | automation |
| A10-source-veto-while-running | PASS | automation |
| A11-lease-expired-after-clone-before-spawn | PASS | automation |
| A12-Git-PATCH-commit-ACK-lost | PASS | automation |
| A13-Git-authority-SIGKILL-after-commit | PASS | automation |
| A14-runner-SIGKILL-after-claim-no-replay | PASS | automation |
| A15-real-HTTP-403 | PASS | automation |
| A15-real-HTTP-429 | PASS | automation |
| A16-cancel-after-process-start | PASS | automation |
| A17-parent-known-false | PASS | automation |
| A17-parent-known-true | PASS | automation |
| A18-admission-refusal-cross-sha | PASS | automation |
| A18-admission-refusal-money | PASS | automation |
| A18-admission-refusal-token | PASS | automation |
| A18-admission-refusal-signature | PASS | automation |
| A19-R50-identity-refusal-hmac | PASS | automation |
| A19-R50-identity-refusal-jwks | PASS | automation |
| A19-R50-identity-refusal-workflow | PASS | automation |
| A19-R50-identity-refusal-approval | PASS | automation |
| A19-R50-identity-refusal-identity-lookalike | PASS | automation |
| T2-10-API | PASS | api |
| T2-13-after-http | PASS | api |
| T2-09-cancel | PASS | browser |
| T2-11-UI | PASS | browser |
| T2-12-GAP | PASS | browser |
| org | PASS | delivery |
| independent-file-parsing | PASS | delivery |

辅助5组：admin/workspace/intake-draft/industry/claude-delivery，全部PASS，来源标注developer-authored independently reexecuted。

## 关键实证

A00：直接Git对象比较R49→R51恰48改动，server/lib/public/catalog/package零变化；R50准确4ea740ee5638882e44f697a6a47cee60c8a8457d新增17路径全部blob/mode一致，R44不是R51祖先。真实入口返回LIVE_BUILD_DISABLED并同时列BLOCKED_UNENFORCEABLE_COST_CAP、BLOCKED_OFFICIAL_CREDENTIAL；credential/backend getter读取0，ProtectedAppState在读取tokenProvider前拒绝，productionSigner未配置拒绝。CLI旗标、预付、caller boolean不能证明供应商硬限额。

A01–A04：真实R51 entry→R49/R46→FixtureGitHubState生产协议→loopback HTTP/SQLite Git对象/ref CAS→严格R45签名→实际marked Node→结构化outcome/日志回执。成功Fake meter为0.02（不是厂商账单）。本地真实R50 HTTP receiver接HMAC事件，重复delivery409；合成RSA OIDC推进10分钟后同work不重派。两个不同Node分别event/OIDC tick共用broker store与Git ref，至多1次CLI；另4个不同Node/独立journal竞争也只有1次，额外新runner不重派。临时SQLite quick_check均ok，记录请求method/route/FF提交、PID、exit及回执SHA。

A05：同UID marked程序实际先chmod再写gitignored data、改.git/config、写后删除，虽输出成功JSON及known合成费用，三个结果都为FAILED/outcome FAILED、原R45 receipt原因READONLY_VIOLATION；没有误报SUCCEEDED，旧任务重试不再启动。**本结论是修改检测/拒绝成功，不是同UID强沙箱保证写入从未发生。**

A06：真实临时Git源+V2 workspace，audit初始树无写位；恶意owner chmod后创建ignored文件，Git status仍clean但verifyChanges拒绝；QA ignored越界、.git/info/exclude修改也拒绝，合法tests内QA commit仍通过。只触碰一次性测试仓库，不改本业务checkout。

A07/A08/A11：DISPATCHING后最后检查处持久HALT、R50撤销批准、clone/权限准备期间租约耗尽，实际CLI启动均0，不能因旧授权或已claim继续spawn。对应R45回执BLOCKED/PRE_LAUNCH_GATE_REVOKED，unknown费用上界和reservation不清零。

A09/A10/A16：实际marked进程已启动后撤回批准、audit veto改变源快照、主动取消，自己的进程被停止，费用未知保持null，0.1合成预留保留，旧工作不重启。停止不能撤销已发生厂商费用，本轮没有真实账单。

A12–A15：真实Git API PATCH先提交再掉ACK、权威SQLite服务COMMIT后SIGKILL、runner PATCH后SIGKILL，均不自动重派；过期恢复UNKNOWN/null outcome和reservation，真实HTTP403/429使停止状态无法确认而fail-closed，未写新任务。只证明本地E3故障/耐久，不证明真实GitHub保护、跨host强一致或exactly-once。

A17/A18/A19：未知费用父WAIT_PARENT且子0启动，known成功父可进入新的独立授权QA阶段；新admission跨SHA/改钱/改Token/operator坏签名拒绝且空jobs；R50 HMAC错误、无JWKS、错workflow、owner批准错SHA、JSON伪造minted身份均0进程/空jobs。真实Identity Provider与KMS不在此范围。

## 用户关键路径最小回归

- 8并发同ID只有1次真实loopback Mock HTTP、1账本、7个409；异参冲突与重启不重派。真实模型HTTP收到后SIGKILL保守恢复interrupted_unknown/cost=null/预留，旧ID409且模型调用不增加。
- Chromium实际取消与明确再次批准恢复；临时settle故障产生真实HTTP202 usage_unsettled、未知费用/人工核对/不要补记账重生成提示；重启仍unknown。永久3在途、第4个429无派发/新账本，当前请求未发送/费用0与上一请求未知费用分属不同ID；隔离只读诊断、停唯一临时实例、完整临时DATA副本校验和未知保留恢复通过。未操作生产或确认供应商停费。
- 两岗位合成组织图实际HTTP前序交接→人工审核→SVG/DOCX/XLSX/PPTX文件；未登录401、delivery-check不增模型/账本、不代批。SVG元数据哈希匹配，原字节在无CSP的loopback由真实Chromium打开，3节点/无img或script执行；ZIP CRC/XML及python-docx/openpyxl/python-pptx独立读取并断言真实段落sentinel、质量组单元格、幻灯片标题。只证明合成流程和实际文件，不代表管理专业质量。

## 证据、环境与CI

每个automation案例保存evidence.json：SQLite/HTTP协议状态、PID/实际调用数、trigger审计、原R45 outcome与脱敏日志，并核对日志SHA256；原始DB和私钥不提交Git。产品场景保存HTTP/模型计数/只读SQLite状态、截图和脱敏trace。local-evidence-index.json列本地文件大小/哈希，local-results.json列本轮精确状态。

本地Node24.22.1、Chromium155.0.8059.79、Playwright1.62.1；CI固定Playwright1.56.1与配套Chromium，Office解析器docx1.2.0/openpyxl3.1.5/pptx1.0.2。默认沙箱不能连接代理，按支持流程审批后Git读取成功；所有localhost测试通过受支持审批运行，无网络策略绕过。一次工具编排在API已exit0后误存undefined session_id，改编排guard并读取实际日志，未重复运行/重复计数API。所有产品用例首次运行通过，未删除测试/放松skip，无业务修复。

专用workflow .github/workflows/productqa-r51.yml：automation/api/browser/delivery/browser-groups五job，contents只读、persist-credentials=false，无Secrets、无schedule/持续事件。每job先验证固定业务SHA祖先及仅QA路径差异，准确GITHUB_SHA；打印R51_HASHES并上传productqa-r51-<mode>，含SHA256SUMS.json。最终run/attempt/真实job日志、test_sha及artifact digest由Issue #4最终AGENT_REPORT_V1绑定，不能用作者CI替代。

```sh
QA_GAPS_OUT=/tmp/qa51-automation node tests/productqa-r51/automation.cjs
QA_GAPS_OUT=/tmp/qa51-api node tests/productqa-r51/run.cjs --api
QA_GAPS_OUT=/tmp/qa51-browser PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium QA_GAPS_CHROMIUM_NO_SANDBOX=1 node tests/productqa-r51/run.cjs --browser
QA_GAPS_OUT=/tmp/qa51-delivery PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/productqa-r51/delivery.cjs
QA_GAPS_OUT=/tmp/qa51-groups PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/productqa-r51/browser-groups.cjs
```

## 缺口、风险、发布门禁

| 项目 | 状态 | 边界与最小下一步 |
|---|---|---|
| 原受控software smoke | BLOCKED（原环境限制，本轮NOT_RUN） | 旧环境unshare不可用、ran=false/not_run；实现未变，不重复、不降隔离或称软件可运行。 |
| 真实官方CLI/身份、provider费用硬边界 | BLOCKED | 返回LIVE_BUILD_DISABLED、BLOCKED_OFFICIAL_CREDENTIAL、BLOCKED_UNENFORCEABLE_COST_CAP；需Owner另批合法官方身份、可信签名、供应商可强制USD+Token限额与单次非生产只读窗口，不能用CLI flag/Fake证明替代。 |
| 强OS/网络只读隔离 | BLOCKED/NOT_VERIFIED for live | 同UID可chmod，文件snapshot只能拒绝不合规回执，不能保证瞬时写/外部I/O无发生。真实host/短命Runner/停止机制须独立实证；所有live入口继续OFF。 |
| 真实模型/E4、实际账单 | NOT_RUN / NOT_VERIFIED | real_agent_launches=0，所有meter、批准和审核是合成，无收费/真实模型API。 |
| 真用户/专家/E5 | NOT_RUN | 无联系人员；自动浏览器和Office解析不代替用户理解、专业质量验收。 |
| 真GitHub App保护CAS/实际回执发布 | NOT_RUN | 仅本地HTTP/SQLite假Git对象协议，真实token/remote transport未开。 |
| 默认分支真实event/10min cron/持续接力 | NOT_RUN / NOT_ENABLED | 仅合成事件/OIDC与虚拟10分钟tick，未注册正式触发。 |
| R44陌生行业真实产品 | NOT_RUN on R51 | R44不是候选祖先，产品源码未变化；旧三行业/模板不能证明普遍行业能力。 |
| #2 R51安全结论 | 未由ProductQA执行 | 本轮只提交独立产品证据；AUD-R49-01安全关闭及其他审计裁决归原#2，不冒签ACCEPT。 |

未发现新产品P0/P1/P2。产品侧建议PASS_WITH_FOLLOWUP、可继续现有授权非live R52/R53工作；其最终新SHA不继承本QA结论。真实接力仍NO_GO，不配置Secrets、不合main、不部署或改生产。规划AGENT结合本测试CI与#2同SHA安全结果裁决，Owner未满足外部门禁前不能启动真实模型。本轮完成后停止自有测试分支写入，不关闭Issue或自行发布。
