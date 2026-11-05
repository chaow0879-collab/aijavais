# 三行业 Mock 验收准备与故障回归手册（#14 包五）

> **性质**：开发者自测资产（Claude Code）。它证明**应用流程**（人工审批、权限、费用事实、取消/重启、文件生成与可打开性），**不**证明模型智能或真实行业成果质量，**不是** #4 独立产品验收，也不替产品测试 AGENT 签字。所有模型均为本地 Mock，未调用任何收费厂商，未执行任何外部工具。

## 1. 固定夹具（`tests/fixtures/industry/*.json`）

| 文件 | 行业 | 岗位/步骤 | AI 建议工具（期望核验状态） | 人工编辑 | 导出与独立检查 |
|---|---|---|---|---|---|
| `software-development.json` | 软件开发 | pm/dev/qa；requirements→design→testplan(all) | builtin:text-stats=已注册可用；code_execution=取决于服务器；repository_access=未验证 | 改项目名、qa→质量保障工程师、加人工决策、只保留 text-stats | docx/xlsx/pptx/md：测试清单、T2 按月汇总、迭代概览 |
| `enterprise-organization.json` | 企业管理/组织优化 | analyst/hrbp/comms/reviewer；4步 | xlsx_generation、builtin:json-validate=已注册；web_search=未验证 | 改名、reviewer→合规与风险审核、保留 json-validate | 审核意见、缩短审批链/运营总监、组织优化摘要 |
| `cross-domain-research.json` | 跨领域研究 | lead/data/ethics；scope→analysis→ethics→report(all) | file_read、calculation=取决于服务器；web_search、image_generation=未验证 | 改名、ethics→研究伦理顾问、无必需工具 | 研究报告框架、分析计划/数据分析员、研究框架 |

每个夹具还含：`draftReply`（Mock 模型的固定 JSON 回复）、`expect`（岗位/步骤ID、最后一步交接来源、工具核验状态）、`stepOutputs`（运行时按 `[[STEP:id]]` 标记返回的确定性输出）、`malicious`（预算/权限/连接/密钥/工具调用注入）、`abnormal`（非JSON、无效引用、空岗位、超限、非法handoff、重复ID、超长目标等，期望 422）、`seed`。

## 2. 重跑命令（Node ≥ 24；无需网络与收费 API）

```sh
npm test                                   # 全部单元/HTTP/SQLite，含下列新套件
node --test tests/industry-mock-e2e.test.js          # 三行业真实 server.js + HTTP + SQLite + 文件导出
INDUSTRY_E2E_OUT=/私有目录/industry node --test tests/industry-mock-e2e.test.js   # 指定保留产物目录
node --test tests/fault-regression.test.js           # 20 个固定种子 × 70 步故障注入
FAULT_SEEDS=1234,99 FAULT_OPS=300 node --test tests/fault-regression.test.js   # 复现/加压指定种子
node --test tests/regression-guard.test.js           # 旧 P1 测试存在性/断言数 + 无测试后门
npm run test:industry                      # Chromium 三行业人工审批流程（需 playwright + chromium）
npm run test:intake && npm run test:ui && npm run test:workspace
```

独立文件解析需要 `python3` 与 `python-docx==1.2.0 openpyxl==3.1.5 python-pptx==1.0.2`（CI 已安装）。缺失时该部分记录为 **NOT_RUN**（`summary.json` 中 `parse.status`），不会伪造为通过；解析失败则测试失败。

## 3. 产物（每个行业一个目录）

`$INDUSTRY_E2E_OUT/<行业id>/`（未设置时为打印出的临时目录，不自动删除）：

- `draft.json`：生成的草案完整响应（含 `toolRecommendations`、`toolPermissions.granted=[]`、用量与 `billingFact`）
- `saved-project.json`：人工编辑并确认保存、重启后读回的项目
- `deliverable.docx|xlsx|pptx|md`：真实导出的文件字节
- `hashes.json`：每个文件的 SHA-256、字节数、artifactId（并已验证重新下载字节一致）
- `summary.json`：逐步证据（每步 Mock 草案/步骤调用计数、状态码、取消计费状态、解析状态）

CI 中 tests 作业把该目录上传为 artifact `industry-mock-e2e-evidence`；Chromium 截图在 `browser-screenshots`（`industry-*.png`）。

## 4. 每个行业断言的流程（HTTP 套件）

1. 估算：`requestSent:false`、本地目标 `local:true`、零模型调用。
2. 异常回复：全部 422 + `fallback:manual` + 手工草案；本地计费 0 且 `billingFact=local_free_zero`；不保存。
3. 恶意回复：草案中不出现 attacker/sk-/process.exit/`"*"`/approvePaid/allowedTools；`toolCalls=[]`、`skillId=''`、`connectionId=''`。
4. 取消：真实生产适配器收到取消后停止；409；不保存；不重发。
5. 正式草案：岗位/步骤/交接与夹具一致；工具建议均 `not_granted`/`needs_approval_per_run`；同 ID 二次点击 409 且零新增调用。
6. 人工编辑 + 显式保存（附带伪造 `allowedTools/approval` 也不会持久化）。
7. 进程重启：编辑持久；`runs=[]`（绝不自动启动）；无任何模型调用重放；草案容量槽 0。
8. 校验通过；未授权工具时运行 403 `tool_permission` 且零步骤调用；显式授权后运行。
9. 审核通过后导出 4 种文件：PK 头、哈希、重新下载一致、python 独立解析内容。
10. 账本：异常 + 恶意 + 取消 + 正式 = 行数一致，全部结算，无重复。

Chromium 套件对三个行业重复：估算→批准→恰好一次调用→岗位/步骤数→“未授予任何权限”→费用文案→人工编辑→保存确认才可保存→工作台工具复选框全部未勾选→`runs=[]`。

## 5. 故障回归（`tests/fault-regression.test.js`）

种子 PRNG（mulberry32）生成操作序列：新请求/同 ID 二次点击/取消/供应商完成（完整、部分、未知、带用量失败）/注入结算失败/空闲；每次调用随机为合作式或非合作式。**每一步后**检查：底层在途 ≤3；容量槽 ≥ 底层在途；服务视图=真实计数；每次派发恰有一行持久记录；每个 ledgerId 至多结算一次；已派发收费行无静默 0；未派发行恒为 0。结束时：排空后无槽泄漏；只有注入失败的行可保持 reserved；有界 close 后重启恢复无 claimed/dispatching，中断行费用 null，零重放。时间相关的分支（宽限内结束或 outstanding）可能因调度不同而分类不同，但不变量与顺序无关。

## 6. 覆盖矩阵（与 #4 T2 系列对照，供独立验收选取）

| 维度 | 自测覆盖 | 证据 |
|---|---|---|
| 人工审批前不调用模型 | ✔ | industry HTTP 1、Chromium、cost-facts 402×3 |
| 草案可编辑且需确认保存 | ✔ | industry HTTP 6、Chromium |
| 绝不自动启动/授权工具 | ✔ | HTTP 7–8、Chromium 工作台复选框、capability-truth |
| 恶意模型输出 | ✔ | HTTP 3、capability-truth、intake-draft |
| 取消/断连/超时/容量 | ✔ | HTTP 4、intake-draft-cancel-lifecycle、fault-regression |
| 重启/崩溃恢复 | ✔ | HTTP 7、model-request-recovery、TC7-05 |
| 费用事实一致性 | ✔ | cost-facts-matrix |
| 文件真实生成/可打开 | ✔（docx/xlsx/pptx/md） | HTTP 9 + python 独立解析；PDF/图片渲染：本手册 NOT_RUN |
| 真实厂商/收费/生产数据 | ✘ NOT_RUN（禁止） | — |
| 行业成果专业质量 | ✘ 不在范围 | 需人工/领域专家在 #4 判断 |
