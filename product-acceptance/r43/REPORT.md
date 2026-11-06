# R43 独立产品集中验收

身份：AIJAVAIS-ProductQA / Codex-ProductQA。任务：#4 R43 #6687938207；上位决议：#10 R46 #6688764976。交付状态：READY_FOR_REVIEW，等待GPT核验证据，不自行关闭任务或作代码安全签署。

## 固定对象与执行范围

- 被测业务SHA：`ab3e07979f67924e795426737e26c5c4d84b8501`。
- 独立测试分支：`test/codex-productqa-r43`，从该精确SHA开始；没有写入冻结集成分支、旧测试分支或main。
- 历史独立测试来源：`c1db3590a3b91a7651d6c276b079b0aea53376c6/tests/productqa-gaps`。原始4份资产的SHA256登记在`tests/productqa-r43/inherited-assets.json`。继承断言未弱化；仅更新新候选绑定、#19已修复的实际结果以及本候选已交付SOP的验收。
- 新增自编输入/断言：delivery.cjs、automation.cjs；五组既有浏览器脚本只由browser-groups.cjs调用，单独标记为开发者编写的回归，不把它们当本AGENT独立编写的验收。
- 只新增tests/productqa-r43、product-acceptance/r43及专用workflow。所有运行业务与自动化源码保持冻结版本。没有合入R44/R45/R46的新代码。
- 所有模型为本地HTTP/SSE Mock；自动化为临时签名授权Fixture、FakeAdapter及固定Node Stub。无真实付费模型、生产MCP、Secrets、生产数据或服务器操作。

本报告记录本地执行结果；专属workflow将同一测试提交的准确SHA、执行结果和工件绑定。**最终测试head_sha、匹配CI、实际CI失败/跳过及工件URL/digest以#4本轮最终AGENT_REPORT_V1为准，不把开发者run42236815155或本地计数冒充本支线CI。**

## 本地逐项结果

| 分组 | 结果 | 可复核实际行为 |
|---|---|---|
| 独立API/恢复4场景 | PASS 4 / FAIL 0 | 8请求barrier仅派1个模型HTTP、1条账本；同ID异参409；重启不重派。实际SIGKILL在claimed、dispatching标记后/网络前、模型HTTP已收到后三个窗口，模型收到分别0/0/1；前者有未发证据恢复0费用，后两者保持null/预留上界；quick_check=ok。 |
| 独立Chromium8场景 | PASS 8 / FAIL 0 | 401/429/500上游错误呈现、真实未缩短60秒超时、取消可能费用unknown、人工新授权恢复；原生双击仅1个请求；实际结算失败202/未知费用/人工确认；三槽永久持有/第四429不派发；#19当前用量不再沿用上一取消结果。 |
| #15 SOP子项 | PASS（隔离环境） | 文件docs/P2-OPERATIONS.md确已交付；tools/p2/preflight.diagnose实际输出CAPACITY_BLOCKED/readOnly。只读诊断不改账、受控停唯一实例、停止后完整临时DATA副本quick_check及三条账本一致、重启保留unknown/预留且旧ID不重派，新授权ID可生成。生产停机/灾备恢复NOT_RUN，不外推供应商停止计费。 |
| 独立交付7项 | PASS 7 / FAIL 0 | 双岗真实HTTP交接后进入review_required；交付检查不得代替人工批准/改费用。软件结构与占位分别识别；组织SVG真实下载/哈希/独立Chromium安全呈现；研究模型声称verified不升级为核实；循环图拒绝产图；路径穿越文件拒绝为有效结构；8份实物独立解析。 |
| 软件受控smoke正例 | BLOCKED（环境） | 本地已显式批准临时执行器与smoke请求，但unshare隔离命名空间不可用，接口如实not_run/ran=false/expertReview=not_run，没有虚标runnable_verified。若CI环境支持隔离则另以实际结果判定，并要求QA43_CLOCK_OK输出；CI不支持时仍BLOCKED。 |
| 独立自动化10项 | PASS 10 / FAIL 0（受支持权限重跑） | 默认scheduler/executor关闭、live入口LIVE_BUILD_DISABLED；Fake三阶段各持久成功、重开Store后3次重复均拒绝；签名/SHA/CI变化不启动Fake任务；fail/incomplete/超token/stop不重放；固定Node Stub子进程成功。全部actual_agent_launches=0、actual_dispatch=false、实际模型费用null。 |
| 五组既有Chromium | PASS 5组 / FAIL 0 | admin/workspace/intake-draft/industry/claude-delivery逐组独立子进程实际运行，保留原断言、退出码、耗时、合成实例截图。其源码由开发者编写，本轮仅独立重跑作辅助证据，不与自编29项混称新的独立测试总数。 |

本地独立项目计数为**29 PASS / 0 FAIL / 1 BLOCKED**，另有5组既有浏览器回归通过。SOP与#19为八场景内部子检查，不重复加计数。此计数不包含开发者276/383/Office自测或历史测试，未重跑全量历史单元套件。

### #19费用归属复核

三个临时非合作适配器维持实际HTTP流，用户逐次取消等待；第四次请求返回429/draft_busy，实际模型调用数仍3、草案账本仍3。新页面的当前“本次用量”不再等于上一条取消请求用量，也不再将旧供应商在途费用冒充第四次已发送。截图、DOM文本、HTTP响应、SQLite快照均保留。关闭旧#19只能由GPT依据本轮独立证据裁决，本AGENT不自行关闭。

### 文件与高风险负面输入

独立合成软件为时长转换模块，不复用开发者记账示例：src/clock.js、test/clock.test.js、README、package.json。软件有文件结构不等于已实际运行；占位MOCK文件从不执行，独立专家仍not_run。

组织图自编三节点，其中恶意节点名包含img/onerror样式文字。真实下载SVG与manifest SHA一致；由127.0.0.1直接提供相同字节给真实Chromium，没有额外CSP掩盖XSS。断言实际svg g=3、img/script=0、window.__qa43未执行并截图。循环父节点产生failed且generatedArtifacts=0。

研究自编三主张：合成样本、模型自称已verified的外部来源、无来源主张；实际分别synthetic_only/unverified/unsupported，summary.verified=0，避免假核查。不访问例示URL。

软件中额外../../QA43_ESCAPE.js被列入rejected，结构invalid；不执行该文件。每个case独立核对未认证调用401，交付检查前后系统费用快照相同；运行保持review_required直到本测试明确提交合成流程的人工批准，不冒称专业人审。

独立Python使用zipfile、python-docx、openpyxl、python-pptx、XML核验ZIP CRC、代码入口/测试清单、Office非空结构及SVG根节点，共8文件：软件ZIP/DOCX，组织SVG/DOCX/XLSX/PPTX，研究DOCX/XLSX。文件字节、SHA256、解析报告保存于delivery工件。它们均是合成模型输入的实际文件，不是经过E4/E5验收的行业成果。

## 自动化模拟的准确边界

模拟阶段使用生产代码冻结树上的engine/store/CLI，输入授权由临时Ed25519密钥签名并标注FAKE，仅作用于临时Store，未发送GitHub授权评论或写真实远端状态。三阶段各用合成来源快照，不冒充真实CodeAudit/QA签署或真实跨会话唤醒。固定Node Stub是实际Node进程，不是实际Codex/Claude CLI。

已验证有限范围的门禁、持久去重、失败/未知状态、限额/stop以及默认OFF。真实GitHub事件→真实10分钟云端兜底→真正启动模型CLI→回收真实提交/CI/报告这一整链**NOT_RUN**；不能以本轮模拟链宣布自动化第一阶段已完成。未启动daemon、cron或webhook。

## 失败与环境限制保留

首次自动化自编脚本在默认执行沙箱下2项FAIL：默认子进程输出没有形成JSON，以及固定Node Stub返回FAILED。原始automation/runner.log和automation-results.json保留。未改代码，在平台支持的执行权限下重跑同脚本得到10 PASS；不将此过程声称业务修复。初次未捕获明确系统错误码，因此不伪称已精确证实某个EPERM错误。

软件smoke由于本地命名空间限制BLOCKED保留，没有关闭隔离/预算/权限门禁以获得通过。记录此前文件能解析和这次未能受控运行的区别。CI可能存在相同限制，须按工件实读，不能将job成功解释成所有子项PASS。

## 证据与复现

各执行单元有独立目录，保留runner.log、JSON结果、真实HTTP/模型调用计数或prompt SHA、SQLite状态/终止信号、交付文件、截图和脱敏trace。inherited run输出provenance绑定businessSha/testHeadSha与源脚本hash；所有单元上传SHA256SUMS，日志结束后重新生成，避免runner.log末尾变动导致哈希不一致。

本地平台Node24.22.1/Chromium155、Playwright1.62.1；专用CI固定Node24与Playwright1.56.1对应Chromium。版本差异不混用计时/文件hash。日志隐藏设置码/Cookie，独立trace上传前剔除Cookie/认证头；只上传合成实例材料，不将私有DATA/原始数据库/凭据提交Git。

```sh
QA_GAPS_OUT=/tmp/qa43-api node tests/productqa-r43/run.cjs --api
QA_GAPS_OUT=/tmp/qa43-browser PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node tests/productqa-r43/run.cjs --browser
QA_GAPS_OUT=/tmp/qa43-delivery PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node tests/productqa-r43/delivery.cjs
QA_GAPS_OUT=/tmp/qa43-automation node tests/productqa-r43/automation.cjs
QA_GAPS_OUT=/tmp/qa43-groups PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node tests/productqa-r43/browser-groups.cjs
```

全部使用新临时DATA，不碰生产。低权限沙箱若不能建本地HTTP或子进程，用支持的执行权限运行并保留初次失败，不绕过网络策略。CI专用workflow仅验证并上传证据，不启动真实Agent或调度服务。

## 风险、未执行与交接

本地当前没有已复现的新业务FAIL/P0/P1；不等于代码安全审计通过。软件受控可运行性正例仍存在环境BLOCKED，专家质量/真实语义/真实账单/五名非开发者理解与操作E4/E5均NOT_RUN。三行业仅是结构回归样例，不作为通用未知行业能力上限或已全面验证的证据。

HALOFLUX与真实产品事件的长期用户体验、真正无人值守接力、真实云端周期、跨主机/断电恢复、生产部署不在本轮已测结论中。现有五组浏览器可视化操作是辅助证据，不冒充真人体验或新增事件桥。

完整结果及最终CI回写#4，接受裁决由GPT负责。#2独立CodeAudit对同一ab3e业务SHA的结论仍为独立门禁；本AGENT不代签、不合main、不部署、不改Secrets、不启用收费模型或将R44/R45/R46补丁混进本冻结对象。
