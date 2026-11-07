# AIJAVAIS V2 R47 独立产品差异验收

[AGENT_REPORT_V1]
role: Codex-ProductQA / AIJAVAIS-ProductQA
status: READY_FOR_REVIEW（本文件记录本地完成状态；最终测试SHA和CI绑定以Issue #4最终报告为准）
reviewed_sha: 3c37035befab9e411724686ff22e44333174e217
base_business_sha: ab3e07979f67924e795426737e26c5c4d84b8501
test_branch: test/codex-productqa-r47
idempotency_key: R47:3c37035befab9e411724686ff22e44333174e217:ProductQA:P1_DIFF

授权：[#4 R47任务](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6699577654)、[#10 R49总调度](https://github.com/chaow0879-collab/aijavais/issues/10#issuecomment-6699770457)。独立CLAIMED：[6699862229](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6699862229)。只有ProductQA身份，不代签CodeAudit，不自行决定发布。

## 结论与证据范围

本轮本地执行 **26 PASS / 0 FAIL**：19个自编差异场景、2个HTTP/SQLite回归、3个Chromium回归、1个合成管理交付链路及1个独立解析场景。重试和子断言不重复计数。没有新的P0/P1/P2产品缺陷。仅认可固定SHA的本轮E2/E3证据，不是生产GO或真实无人值守接力成功。

初跑两处测试脚本错误（默认关闭入口exit2处理、嵌入Python转义）已修正；原始错误、原因、日志SHA保存在local-attempts.json，不归为产品FAIL。浏览器定位不存在的旧usage字段改为先查存在性，补充本次/上次requestId精确归属正断言；修改后3项全部重跑，最终CI执行同版测试。

## 差异范围及避免重复

精确git diff只有8文件：policy.js、demo.js、作者新增测试、来源校验器、原CI分支触发、R47说明及两份交接。D01对server.js、lib、public、catalog、package.json、tools/p2、tools/database.js的树/文件blob作前后核对，全部未变；scheduler/executor配置也未变、5开关false、cron/webhook关闭。自编脚本观察真实Store.claim调用次数，不能以BLOCKED字符串代替未占位证明。

不重跑历史29项整包，不将[旧R43 QA29PASS/1BLOCKED](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6689677456)移作新SHA全功能PASS。原[测试资产SHA10c6d9a](https://github.com/chaow0879-collab/aijavais/tree/10c6d9a9d8e160c2f11b10472bb5f6647983a582/tests/productqa-r43)由本人编写，继承来源及哈希见inherited-assets.json；本轮收窄至费用/取消/容量/未知恢复及一个文件交付工作流。开发者53项/436项测试和CI只作背景，不充当本人独立验收结论。

## 本轮逐项结果

| 测试 | 状态 | 本地详细结果（CI同名JSON） |
|---|---|---|
| D01-exact-source-difference | PASS | delta-retry/delta-results.json |
| D02-audit-same-candidate-and-reopen | PASS | delta-retry/delta-results.json |
| D03-audit-fully-resigned-B-ci-false | PASS | delta-retry/delta-results.json |
| D03-audit-fully-resigned-B-ci-true | PASS | delta-retry/delta-results.json |
| D04-audit-same-SHA-missing-CI | PASS | delta-retry/delta-results.json |
| D05-audit-resigned-wrong-role | PASS | delta-retry/delta-results.json |
| D06-audit-restart-unknown-reservation | PASS | delta-retry/delta-results.json |
| D02-qa-same-candidate-and-reopen | PASS | delta-retry/delta-results.json |
| D03-qa-fully-resigned-B-ci-false | PASS | delta-retry/delta-results.json |
| D03-qa-fully-resigned-B-ci-true | PASS | delta-retry/delta-results.json |
| D04-qa-same-SHA-missing-CI | PASS | delta-retry/delta-results.json |
| D05-qa-resigned-wrong-role | PASS | delta-retry/delta-results.json |
| D06-qa-restart-unknown-reservation | PASS | delta-retry/delta-results.json |
| D07-integration-explicit-dual-input-base | PASS | delta-retry/delta-results.json |
| D08-integration-wrong-base | PASS | delta-retry/delta-results.json |
| D08-integration-missing-base | PASS | delta-retry/delta-results.json |
| D08-integration-swapped-parents | PASS | delta-retry/delta-results.json |
| D08-integration-unsigned-parent-change | PASS | delta-retry/delta-results.json |
| D09-old-vs-new-original-cross-SHA-reproduction | PASS | delta-retry/delta-results.json |
| T2-10-API | PASS | api/api-results.json |
| T2-13-after-http | PASS | api/api-results.json |
| T2-09-cancel | PASS | browser-final/browser-results.json |
| T2-11-UI | PASS | browser-final/browser-results.json |
| T2-12-GAP | PASS | browser-final/browser-results.json |
| org | PASS | delivery-retry/delivery-results.json |
| independent-file-parsing | PASS | delivery-retry/delivery-results.json |

## 关键观察

- D02/D07：合法同SHA audit/qa及明确双输入/base的integration Fake成功；重新创建Store/Executor同请求DUPLICATE_JOB，原job不变。
- D03：门禁A仍为3×40，请求/ref/工作分支/签名payload改B=9×40并完整重签、重新计算source/gate摘要。audit和qa各测B无CI及有自身绿色CI，全部CANDIDATE_SHA_MISMATCH，Store.claim调用0、jobs0、CLAIMED0、would_launch空。
- D04/D05/D08：同SHA缺CI、完整重签错角色、错/缺base、调换双输入、只改变未绑定payload的输入，都在claim前拒绝。D09仅把旧两个simulation模块目录物化到私有临时目录，以同方法复现旧R43 audit/qa错误SUCCESS，与新D03对照；全部实际Agent启动0。
- D06：真实子进程留下CLAIMED后退出，新Store恢复HUMAN_REVIEW_REQUIRED/actual_cost=null、保留合成0.05预留；同ID不重派。再重签B仍在claim前拒绝，旧jobs和daily预算完全不变。此0.05只是Fake状态，不是费用支出。
- API：8请求并发同ID只有1个真实loopback模型请求、1账本，7个409；异参冲突及重启仍无新增派发。真实HTTP模型收到后SIGKILL，SQLite quick_check=ok，恢复interrupted_unknown/cost=null/保留预留，旧ID不重放。
- 浏览器取消：真实底层HTTP请求、409与可能收费提示，只有明确再次批准才新requestId恢复；202注入真实settle失败，界面未知费用/人工核对/不为补记账重生成，重启仍unknown。
- 浏览器429：隔离测试preload仅使临时模型适配器忽略取消，3条HTTP继续在途；第4请求429，实际模型仍3、无新账本；本次requestId明确未发送/费用0，上一requestId明确与本次无关/费用未知，旧#19不回退。只读诊断/停唯一临时实例/完整临时DATA副本校验/重启保留3笔unknown及预留/旧ID不重派/新批准ID恢复，均通过。未操作生产。
- 交付：自编合成3节点组织图，两岗位2次真实loopback HTTP及前序交接；delivery-check不调用新模型、不改变费用、不代替人工批准；401管理员门禁有效。SVG下载哈希与服务端元数据相符，将相同字节在无CSP的loopback源交给真实Chromium，3节点、0 img/script、无注入执行。下载DOCX/XLSX/PPTX，ZIP CRC + python-docx/openpyxl/python-pptx/XML独立读取，核对实际段落sentinel、质量组单元格、指定幻灯片标题。**只证明合成流程和文件结构/内容存在，不是管理专业质量通过。**

## 证据及复跑

CI定义：.github/workflows/productqa-r47.yml，4个隔离job（delta/api/browser/delivery），不调用开发者套件。每个job先核对固定候选祖先、仅测试/报告/本专用workflow差异、准确GITHUB_SHA；contents只读、无Secrets输入、无定时器。每个job输出R47_HASHES并上传productqa-r47-<mode>。最终CI run/head/job/artifact链接及哈希由Issue #4最终报告绑定，未完成前不能以旧CI替代。

本地Node24.22.1、Chromium155.0.8059.79、Playwright1.62.1；CI固定Playwright1.56.1及其Chromium。独立解析器docx1.2.0/openpyxl3.1.5/pptx1.0.2。临时合成DATA已关闭并清理，不入Git；截图、脱敏trace/HTTP日志和生成文件仅入CI artifact。local-evidence-index.json列出本地证据SHA256；真实请求日志、模型计数、只读SQLite状态以各case/evidence.json保存。

```sh
QA_GAPS_OUT=/tmp/qa47-delta node tests/productqa-r47/delta.cjs
QA_GAPS_OUT=/tmp/qa47-api node tests/productqa-r47/run.cjs --api
QA_GAPS_OUT=/tmp/qa47-browser PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium QA_GAPS_CHROMIUM_NO_SANDBOX=1 node tests/productqa-r47/run.cjs --browser
QA_GAPS_OUT=/tmp/qa47-delivery PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/productqa-r47/delivery.cjs
```

## BLOCKED / NOT_RUN 与发布门禁

| 项目 | 状态 | 边界 |
|---|---|---|
| 原受控软件smoke | BLOCKED（沿用已记录环境限制，本轮NOT_RUN） | 原R43本地/CI unshare失败，工具ran=false/not_run。执行隔离实现未变；本轮不启用代码执行、不重跑，不升级为可运行软件PASS。 |
| AUD-R43-02/03/04 | NOT_RUN（仍开放P2） | JSON重复jobs键、readiness期限类型、workspace已提交越界差异未由作者修复。本轮无真实执行，需最终真实激活前由独立安全门禁复核；ProductQA不替代审计。 |
| 真实模型/CLI、E4、供应商账单 | NOT_RUN / NOT_VERIFIED | real_agent_launches=0；所有自签只用于本地Fake合成密钥，不是GitHub授权或真人审核。 |
| 真实用户/专家/E5 | NOT_RUN | 无人员联系；自动浏览器不能充当普通用户体验研究。 |
| 实际事件/10分钟调度/持续自动接力 | NOT_RUN / NOT_ENABLED | 默认OFF，无远端状态写、Secrets、main、生产、部署。 |
| 未重跑的原R43场景 | NOT_RUN on R47 | 保留旧报告及同源树证据，不声称新候选全部E2/E3通过。 |

P1 AUD-R43-01在本轮独立产品反例中未复现，具备提交规划者评审的产品差异证据；**仍须#2对同SHA独立安全结论，R49最终冻结候选另做其授权的新SHA集中门禁**。R47结果不提前认可未冻结的R49。三项P2保留，未获真实模型/预算/身份/受限Runner授权前真实自动接力继续阻断。

下一步：规划AGENT核对本报告准确SHA/独立CI及#2门禁；根据最终R49冻结SHA再集中审核。作者停写，不合main、不关闭Issue、不自行上线。
[/AGENT_REPORT_V1]
