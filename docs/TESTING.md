# 测试方法与证据

> **C1（2026-11-11）统一入口**：`npm test` = `npm run test:product`，包含全部产品测试（含原先只在单独 CI 步骤里跑的交付检查、通用工作流 R53、通用立项、R52/R54 工作台 Node 套件和 P2 守卫）。浏览器套件统一用 `npm run test:product:ui`（`tests/ui/run-all.cjs`，逐个子进程运行并汇总）；严格 Office 解析门禁用 `npm run test:release`。产品 CI 是 `.github/workflows/product.yml`。relay（`tools/relay/`）测试用 `npm run test:relay`，只在手动触发的 relay 工作流里跑。

需要 Node 24+。生产无第三方 npm 依赖。统一入口 `npm test` 引入全部旧测试及立项、代理、SQLite执行、工具、Skills、文件、V2 HTTP和认证并发测试。不得用零子测试的 exit 0 冒充验证；受限云环境可能需要支持的执行权限才能真实开启本地socket/子进程。

```sh
npm test
npm run test:ui
npm run test:workspace
```

浏览器测试额外需要 Playwright 和 Chromium。当前云环境已有 Playwright、`/usr/bin/chromium`；也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定。CI在临时目录安装固定版本，不增加生产依赖。测试隔离临时 DATA，不读取真实业务数据库或调用收费模型。

## 验证类别必须分开

- **真实厂商 API：未执行**。无授权收费调用，不编造免费额度或专业能力。
- **模型 Mock：实际本地 HTTP/SSE fixture 与内存适配器**。验证多岗位调度、真实输入交接、计数/费用状态机、取消、失败与恢复，不证明厂商可用。
- **MCP：真实 stdio 子进程 JSON-RPC，对端为本地协议 fixture**。不是第三方生产MCP验收。内置工具及文档工具是真实代码执行。
- **持久化：真实 SQLite/WAL/备份/重启/锁/文件BLOB与SHA256**，不是存储Mock。
- **文件：真实DOCX/XLSX/PPTX/代码ZIP**，ZIP CRC/XML/关系独立验证；当前环境还用python-docx/openpyxl/python-pptx读取及LibreOfficeDev26.8导出PDF。未人工逐页审稿。
- **浏览器：真实Chromium、登录会话、模型/团队管理及V2保存/运行/审核/DOCX下载/XSS检查**；模型仍是本地Mock。
- **部署：真实Docker构建/非root/健康/持久卷重启**，Caddy配置校验；未执行公网ACME、Render部署或完整故障灾备恢复。

## 第十七轮 #14 五包新增套件（Claude Code，2026-11-05）

| 套件 | 包 | 类型 |
|---|---|---|
| `tests/intake-draft-cancel-lifecycle.test.js` | #7 M1 | 服务级Mock真值计数器 + 本地真实HTTP断连 + SQLite重启 |
| `tests/intake-draft-api.test.js`（新增#7用例） | #7 M1 | 真实server.js生产适配器套接字关闭 |
| `tests/capability-truth.test.js` | #9 M2 | 真实ModelRegistry/v2处理器/SQLite/HTTP |
| `tests/cost-facts-matrix.test.js` | #9 M3 | 真实server.js端到端费用事实矩阵 |
| `tests/backup-operations-security.test.js` | M4 | 临时SQLite、注入fs故障、子进程umask/SIGKILL遗留物 |
| `tests/industry-mock-e2e.test.js` | M5 | 三行业真实server.js + 文件导出 + python独立解析 |
| `tests/fault-regression.test.js` | M5 | 固定种子故障注入（20×70） |
| `tests/regression-guard.test.js` | M5 | 旧P1测试存在性/断言数、生产代码环境钩子白名单 |
| `npm run test:industry`（`tests/ui/industry.e2e.js`） | M5 | Chromium三行业人工审批流程 |

重跑说明与产物见 [INDUSTRY-MOCK-RUNBOOK.md](TESTING.md)；备份运维见 [BACKUP-OPERATIONS.md](DEPLOYMENT.md)。全部为本地Mock，真实厂商/生产 NOT_RUN。

## 第十轮 #6 + #8 本地验证（Codex，2026-11-05）

分支`feat/codex-v2-p1-ledger-recovery`，起点`b71faaa65bb66e04ea2a015c9238a3a129bdb68e`。最终代码本地`npm test` **238/238通过，0失败，0跳过**（Node v24.22.1，实际子测试计数）；`test:ui`、`test:workspace`、`test:intake`均通过。GitHub Actions结果见Issue #6/#8最终同SHA报告，不能用本地结果代替CI。

- `model-request-recovery.test.js` 15项：真实SQLite/事务触发器故障、跨进程唯一性和独占锁、SIGKILL、两次恢复、v3历史迁移/备份0600/失败回滚/损坏及未来库拒绝、只读脱敏。
- `intake-draft-idempotency.test.js` 8项：服务底层Mock计数、同参并发/异参、目标和预算摘要、成功失败未结算重启、跨主体、预留/派发/读取故障、1001条后续历史。
- `intake-draft-api.test.js` 6项：真实本地HTTP管理员/CSRF门禁、200/202既有语义、409防重、503预留失败、真正服务强杀后未知账本、不重发与只读异常查询。202服务级断言在intake-draft.test.js，真实HTTP+Chromium断言在test:intake。
- 原ProjectEngine17项预算/中断恢复回归全部通过，未修改其代码。未删旧测试；旧v1迁移fixture仅增加删除v4表后重建真实v1结构、动态版本断言。

关键派发证据：同ID并发总数1；服务成功/失败/未结算各重启后仍1；1001个后续请求后总数1002、重试增量0；SIGKILL claimed/dispatching标记后尚未调用/实际调用三个窗口分别0/0/1，恢复增量0；真实服务器已发送Mock HTTP后强杀，恢复后总数1；草案E2E共4次Mock派发，409重试和只读查询增量0。跨owner同ID为两个独立授权请求，总数2。

真实厂商API/收费账单/生产迁移/生产重启/部署均NOT_RUN；MCP、Office、隔离执行仅既有fixture与临时进程回归，未启用生产代码执行。本轮不是#7或全部P1验收。迁移与回滚门禁见[LEDGER-RECOVERY](DEPLOYMENT.md)。

## 当前检查点结果（2026-11-05，Claude Code 接力）

本地（Node v24.22.1，含 poppler 24.02、LibreOffice 24.2、python-docx/openpyxl/python-pptx）：`npm test` **187 项全部通过，0 失败，0 跳过**（提交 de11c14）；`npm run test:ui` 与 `npm run test:workspace` 通过（修复收尾竞态后连跑多次稳定）。GitHub Actions：`tests`、`browser`、`container` 三个任务以远程实际结果为准；CI 已安装 poppler、LibreOffice 与固定版本的 Python 解析器，使相关测试真实运行而不是跳过。缺少可选程序的环境中，渲染相关测试会显示为 **skipped** 并注明原因，不计为通过。

新增验证类别：

- **真实外部生成文件**：`tests/fixtures/files/` 中的 DOCX/XLSX/PPTX 由 python-docx、openpyxl、python-pptx 生成，PDF 由 LibreOffice 生成（生成脚本 `tests/fixtures/make-office-fixtures.py`），不是用本项目自己的写入器生成。
- **恶意/异常输入**：扩展名与内容不符、加密 ZIP、CRC 错误、DTD、压缩炸弹、截断文件、非 UTF-8、超限。
- **MCP HTTP**：本地 Streamable HTTP 协议 fixture（令牌、会话 ID、SSE 响应），不是第三方生产服务。
- **数据分析**：样本标准差与 Python `statistics.stdev` 交叉核对。
- **浏览器**：上传真实 DOCX→预览→进入模型 prompt；能力中心三个标签页；网页添加远程 MCP、测试、调用、日志；立项向导服务端工具检查。

GitHub Actions 在 4f863b6 上：185 项中 184 通过、1 跳过（代码执行隔离测试：Runner 禁止非特权命名空间，工具在该环境按设计拒绝运行）。

仍未执行：真实收费厂商 API、第三方生产 MCP、公网部署与灾备恢复演练。

## Codex工作单元2（基于4560c8a，独立分支）

共同基线在本实例189/189；共享预算A后193/193；集成Claude e74adee修复与动态草案后最终207/207，0失败/0跳过。三个浏览器命令`test:ui`、`test:workspace`、`test:intake`通过，均使用本地Mock模型。12类覆盖、一次请求的费用/取消及不自动执行证据见[AI-DRAFT.md](ARCHITECTURE.md)。

指定CI已通过GitHub网页独立核实：06b540f的run42023627459三个job均cancelled；4560c8a的run42023677352三个job均success。API读取403、公开步骤日志404，因此远程子测试计数/跳过原因未独立读取，不能用前开发者报告代替；本地207/207为实际输出。

D代码检查点`3463c9ebcadd43d1cfdf3244d73e199983613274`：[GitHub Actions run42030235161](https://github.com/chaow0879-collab/aijavais/actions/runs/42030235161)的tests/browser/container三项均实际success。远程job成功已核查，子测试计数/跳过细节仍未从公开日志读取；不要将本地207/207等同远程计数。

## 三行业 Mock 验收与故障回归手册（原 INDUSTRY-MOCK-RUNBOOK.md）

> **性质**：开发者自测资产（Claude Code）。它证明**应用流程**（人工审批、权限、费用事实、取消/重启、文件生成与可打开性），**不**证明模型智能或真实行业成果质量，**不是** #4 独立产品验收，也不替产品测试 AGENT 签字。所有模型均为本地 Mock，未调用任何收费厂商，未执行任何外部工具。

### 1. 固定夹具（`tests/fixtures/industry/*.json`）

| 文件 | 行业 | 岗位/步骤 | AI 建议工具（期望核验状态） | 人工编辑 | 导出与独立检查 |
|---|---|---|---|---|---|
| `software-development.json` | 软件开发 | pm/dev/qa；requirements→design→testplan(all) | builtin:text-stats=已注册可用；code_execution=取决于服务器；repository_access=未验证 | 改项目名、qa→质量保障工程师、加人工决策、只保留 text-stats | docx/xlsx/pptx/md：测试清单、T2 按月汇总、迭代概览 |
| `enterprise-organization.json` | 企业管理/组织优化 | analyst/hrbp/comms/reviewer；4步 | xlsx_generation、builtin:json-validate=已注册；web_search=未验证 | 改名、reviewer→合规与风险审核、保留 json-validate | 审核意见、缩短审批链/运营总监、组织优化摘要 |
| `cross-domain-research.json` | 跨领域研究 | lead/data/ethics；scope→analysis→ethics→report(all) | file_read、calculation=取决于服务器；web_search、image_generation=未验证 | 改名、ethics→研究伦理顾问、无必需工具 | 研究报告框架、分析计划/数据分析员、研究框架 |

每个夹具还含：`draftReply`（Mock 模型的固定 JSON 回复）、`expect`（岗位/步骤ID、最后一步交接来源、工具核验状态）、`stepOutputs`（运行时按 `[[STEP:id]]` 标记返回的确定性输出）、`malicious`（预算/权限/连接/密钥/工具调用注入）、`abnormal`（非JSON、无效引用、空岗位、超限、非法handoff、重复ID、超长目标等，期望 422）、`seed`。

### 2. 重跑命令（Node ≥ 24；无需网络与收费 API）

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

### 3. 产物（每个行业一个目录）

`$INDUSTRY_E2E_OUT/<行业id>/`（未设置时为打印出的临时目录，不自动删除）：

- `draft.json`：生成的草案完整响应（含 `toolRecommendations`、`toolPermissions.granted=[]`、用量与 `billingFact`）
- `saved-project.json`：人工编辑并确认保存、重启后读回的项目
- `deliverable.docx|xlsx|pptx|md`：真实导出的文件字节
- `hashes.json`：每个文件的 SHA-256、字节数、artifactId（并已验证重新下载字节一致）
- `summary.json`：逐步证据（每步 Mock 草案/步骤调用计数、状态码、取消计费状态、解析状态）

CI 中 tests 作业把该目录上传为 artifact `industry-mock-e2e-evidence`；Chromium 截图在 `browser-screenshots`（`industry-*.png`）。

### 4. 每个行业断言的流程（HTTP 套件）

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

### 5. 故障回归（`tests/fault-regression.test.js`）

种子 PRNG（mulberry32）生成操作序列：新请求/同 ID 二次点击/取消/供应商完成（完整、部分、未知、带用量失败）/注入结算失败/空闲；每次调用随机为合作式或非合作式。**每一步后**检查：底层在途 ≤3；容量槽 ≥ 底层在途；服务视图=真实计数；每次派发恰有一行持久记录；每个 ledgerId 至多结算一次；已派发收费行无静默 0；未派发行恒为 0。结束时：排空后无槽泄漏；只有注入失败的行可保持 reserved；有界 close 后重启恢复无 claimed/dispatching，中断行费用 null，零重放。时间相关的分支（宽限内结束或 outstanding）可能因调度不同而分类不同，但不变量与顺序无关。

### 6. 覆盖矩阵（与 #4 T2 系列对照，供独立验收选取）

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

