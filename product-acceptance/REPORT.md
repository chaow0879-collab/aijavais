# AIJAVAIS V2 第一轮独立产品验收报告（E2/E3，本地 MOCK）

报告状态：**READY_FOR_REVIEW（仅独立验收证据送审）**；**不建议直接生产发布**。  
负责 AGENT：ProductTest（独立于 Claude/Codex 开发与 CodeAudit）  
业务代码固定候选：`58c52f0084997f669eea763edc7b58e11d3ef4f4`  
隔离测试分支：`test/v2-product-acceptance`；所有新增/更新文件仅限 `tests/product-acceptance-*.test.js`、`tests/ui/product-acceptance-independent.e2e.js`、`.github/workflows/product-acceptance.yml`、本报告。  
环境：GitHub Actions Ubuntu Runner、Node v24.22.2、真实 Chromium（Playwright 1.56.1）、本地 HTTP/SSE MOCK、临时SQLite、真实ZIP/OOXML、python-docx 1.2.0、openpyxl 3.1.5、python-pptx 1.0.2。没有调用任何真实收费模型/真实第三方MCP/生产服务。

## 1. 实际验证结果（证据独立于开发者既有测试）

| 验证 | 独立实际结果 | 权威运行证据 |
|---|---|---|
| 隔离分支起始 HEAD = 固定 SHA | PASS；GitHub分支API最初返回完全相等；后续测试提交不是更换业务候选 | 本次 #4 CLAIMED 和专用 CI `git merge-base` + `git diff` 仅测试文件 |
| 合成远程付费模型：未批准/超 Token、价表不合规 | PASS：适配器调用数0、费用账本行0 | run 42132587485 / job 127612617755 / F01 |
| 结算持久化失败，结果与账单分离 | PASS：返回202、`usage_unsettled`、`cost:null`、已派发调用次数1；重启后同ID拒绝二次派发 | 同上 / F02 |
| 模型忽略AbortSignal | PASS：底层在途峰值3，第四请求429；已发出但未确认费用null；底层结束后释放容量 | 同上 / F03 |
| A软件行业流程（合成） | PASS E2/E3流程：草案→权限过滤→非法JSON退回手工→用户编辑→保存→重启→分岗交接→人工审核→真实文件导出与独立解包 | 同上 / industry A |
| B企业管理流程（合成） | PASS E2/E3流程；审核要求补充裁决机制，人工发起返工一次后回到人工审核；真实Office文件独立解析 | 同上 / industry B |
| C跨行业研究流程（合成） | PASS E2/E3流程；后续角色捕获先前输出的合成标记；真实Office文件独立解析 | 同上 / industry C |
| Chromium陌生需求表单/估算/编辑/保存 | PASS E3：未勾收费同意不可调用；估算不派发；同意后一次Mock调用，推荐工具不授予权限；人工修改岗位/步骤并确认保存，项目无运行，页面JS异常0 | run 42132518562 / browser job 127612380795 / `PRODUCT_INDEPENDENT_BROWSER_PASS` |

独立 Node 结果：**6 PASS / 0 FAIL / 0 SKIP**（run 42132587485，job 127612617755）。另一条独立浏览器任务已 **success**（run 42132518562，job 127612380795）。这两项通过来自**不同 Actions run 的各自成功 Job**，不把它们虚称同一次完整绿色运行。run 42132587485 的浏览器Job在形成此报告时仍显示 in_progress；不能预先宣布该 run 全绿。早期独立脚本/CI脚手架失败是测试侧计数、语法、API JSON层级与浅克隆配置问题，均有日志且已在仅测试文件修正；不冒称产品缺陷，不隐瞒失败历史。

## 2. T2-01～T2-17 独立验收覆盖矩阵

以下 `PASS` 只针对**括号内明确写出的E2/E3子范围**，不能解释为该编号全部E4/E5通过：

| 用例 | 状态 | 实测边界、证据或阻塞 |
|---|---|---|
| T2-01 陌生任务理解 | **NOT_RUN**（真实语义质量）；Mock提交陌生办公点任务且成功生成可编辑草案的结构流程是E3 PASS；Mock响应预先固定，不能证明AI主动识别缺失信息 | Chromium截图与日志 |
| T2-02 团队合理性 | **PASS（E2/E3结构与显示）**；三行业均有职责/审核岗位；真正动态合理性与行业覆盖 **NOT_RUN（E4/E5）** | A/B/C project.json、draft/Mock呼叫 |
| T2-03 用户编辑保存审批 | **PASS（E3）**；岗位命名、额外步骤、人工确认、刷新后服务端持久，保存不会启动 | Chromium记录、截图、runs=0 |
| T2-04 零未经授权收费 | **PASS（E2/E3）**；远端定价模拟适配器未授权/超额度调用数0，估算无外呼；真实供应商账单 **NOT_RUN** | F01 + Chromium |
| T2-05 恶意JSON/工具隔离 | **PASS（E2）**；恶意预算/连接ID/execute/allowedTools字段被过滤，推荐工具不代表授权；真实第三方有副作用工具 **NOT_RUN** | 三行业断言与浏览器无勾选 |
| T2-06 非法JSON手工回退 | **PASS（E2）**；HTTP422、fallback=manual，没有自动创建 | 三行业 |
| T2-07 多AI真实交接 | **PASS（E2）**；Mock HTTP捕获后续岗位prompt含上游合成事实标记；messages持久化；是否真实理解上游语义 **NOT_RUN** | A/B/C hashes+接口断言 |
| T2-08 人工审核/返工 | **PASS（E2）**；review_required、无反馈返工拒绝；B有反馈返工一次、旧轮次保留，再次等待人审 | B stepCalls=8，review反馈 |
| T2-09 错误/取消/429用户提示 | **BLOCKED（完整UX）**；已实测取消后底层容量、费用unknown，**未完成**401/429/500全类别真实浏览器错误提示/恢复 | F03；专项UX仍需测试 |
| T2-10 幂等/重复请求 | **PASS（E2的完成态及重启同ID）**；再次同ID返回409且零重复调用；不同参数冲突、浏览器连点和实际并发突发 **NOT_RUN（独立）** | A/B/C + F02 |
| T2-11 结算失败 | **PASS（E2）**；202、cost null、非完整财务成功、不得复派；页面状态完整视觉核对 **NOT_RUN** | F02 |
| T2-12 忽略取消在途上限 | **PASS（E2）**；峰值3，第四被429拒绝，pending费用未知；永久挂起后的管理员恢复SOP **NOT_RUN，#15 P2-01** | F03 |
| T2-13 崩溃/重启恢复 | **BLOCKED（完整故障演练）**；同ID+unknown财务的“正常关闭重启”已通过，但没有独立SIGKILL崩溃/恢复事故注入 | F02部分证据 |
| T2-14 软件A真实应用 | **BLOCKED（业务成果质量）**；文件ZIP真实有效可解析，内容是`MOCK PLACEHOLDER`，**不是可运行任务管理应用**，绝不能判APP可用 | ZIP SHA及README/index.html |
| T2-15 企业B专业Office | **BLOCKED（专业成果质量）**；DOCX/PPTX/XLSX实际生成且第三方解析PASS，但没有两套严谨组织图及专家审稿 | Office SHA/解析证据 |
| T2-16 研究C专业Excel/来源 | **BLOCKED（专业成果质量）**；DOCX/XLSX/PPTX解析PASS，但没有真实市场来源、法规核验、可复算正式财务模型 | Office SHA/解析证据 |
| T2-17 非开发者普通用户 | **NOT_RUN**；没有组织不少于5名真实独立测试者，不能拿浏览器自动脚本冒充用户研究 | 需后续人工组织 |

**额外测试边界**：该矩阵严格记录本AGENT独立实测。固定候选原有开发CI/独立安全审计是额外参考，**不计入上述PASS**。不把模拟供应商（虽然标为paid_api但实际回调是本地函数/loopback）算成真实计费。**没有已证实新P0/P1**，不代表全系统风险为零。

## 3. 文件证据、SHA256与可复核解析

工件来源：
- Node 独立验收 run 42132587485：`https://github.com/chaow0879-collab/aijavais/actions/runs/42132587485/artifacts/13464356278`
- Chromium 成功验收 run 42132518562：`https://github.com/chaow0879-collab/aijavais/actions/runs/42132518562/artifacts/13463138674`
- 浏览器before-save截图 SHA256：`fc4287d059cea11f2703c7f66dd53cd340b56aad874bfa131bb0b2f0393ac467`
- 浏览器workspace截图 SHA256：`ead9ef5c2316a7eb9f236f7d5967555d70976ad626ccb5bfc9b87e3702e77ea7`

| 行业 | DOCX SHA256 | XLSX SHA256 | PPTX SHA256 |
|---|---|---|---|
| A 软件 | `575ecd046dbd938323522dc0efa5cb08cd44518c483e9cc21025b26b9295f217` | `bcf7dadc3305455b399d6e6c7481eee38029d949d71bba45be00e8b9073980ba` | `10159815bd9667bbc4b0058c2af99e34914b2fd9e6045177cb32f5b559d8a3cf` |
| B 企业 | `c7c3eca7aed79d7afbca21826115f8e3bec22c36961ef173e9494f7a1d6c5b15` | `7e6d17370701e48ae002cd5707a560e41ffe948f04af3b2d6470e6a05f79045d` | `4f1fa1a9415ad4bd7e8540095b152deaa1b4ae66eb7d681a164be8bbe93cbfe3` |
| C 研究 | `a7a349fb70a03a6b8230a34e9ff8faf97f7e8c026b44b0f56316a2843219a8da` | `45115a21f06917d6988055e4fd14bffc41421e1c4ee3a9507ca33eb9a0246e3a` | `3d486fe64bcbbbb7a281d1d07687ec24eed91c592cdbfa0acd72ce112533fd22` |

软件A附加ZIP SHA256：`28010abdae8ca020f4bcc44ed51f036901cc6b0a2798d6b9d5d1779b1ca8d238`（含`README.md`及`index.html`，其中明确写`MOCK PLACEHOLDER`，非已开发完成App）。每个导出文件通过独立Python工具解析/ZIP CRC与内容校验；并非仅凭文件后缀。文件视觉排版、真实编辑可用性及专业内容不在本次自动测试通过结论中。

**#15 P2-04特别说明**：本AGENT独立解析为硬性断言：解析器缺失/报错则测试失败，不会静默PASS。但这不等于已修改候选旧自测脚本中的软门槛；#15后续仍需处理。#15 P2-01永久挂起容量与安全恢复、P2-02真实备份ACL、P2-03静态防回归护栏、P2-05文档过时均不擅自判已解决。

## 4. 风险与建议

- **P0（本轮独立已实际发现）：0**。没有在当前Mock覆盖范围发现未授权远程计费请求、越权工具执行、同ID重复派发，**但真实厂商/生产工具未经测试**。
- **P1（本轮独立已证实的业务缺陷）：0**。测试基础设施早期失败均属于新增测试侧问题，已修复；不把产品安全审计的`ACCEPT_WITH_FOLLOWUP`误写为产品正式验收。
- **P2及未覆盖**：沿用#15未关闭5项；额外的用户体验测试缺口包括异常全矩阵(401/429/500)/真实崩溃模拟/并发双击/运营恢复/行业专业质量。
- **发布结论**：**Mock E2/E3 受控功能范围有条件通过；AIJAVAIS作为全行业真正完成业务成果的发布验收仍BLOCKED/NOT_RUN，不批准生产上线。**
- **下一步建议（需要GPT决策）**：(1) 如需下一轮独立补测，明确只测专项429 UX、真实SIGKILL恢复、同ID并发与UI账单异常；(2) 另外安排真实5人试用及专家审核；(3) 对真实厂商收费模型/MCP先提交预算/工具风险方案供负责人**另行批准**，不得自动调用；(4) #15 P2跟踪并保留安全容量不放松；(5) 由GPT规划AGENT决定缺陷单/下一READY任务及是否继续E4，不由ProductTest自行开工。

## 5. 实施完整性

- 没有修改Codex/Claude开发分支、业务实现文件、main、服务器/生产DB、生产MCP或收费模型。
- 仓库中的独立测试分支HEAD因新增测试脚本/报告会前移；**固定被测业务候选SHA始终不变**。
- 本轮报告属于AGENT交付，须在#4以`AGENT_REPORT_V1 / READY_FOR_REVIEW`登记；**不能自行ACCEPTED**。
