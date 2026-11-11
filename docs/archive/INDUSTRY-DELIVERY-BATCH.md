# 三行业真实交付能力与验收真实性（#17 M0–M4，含 #19）

开发者：Claude Code｜分支 `feat/claude-v2-industry-delivery-batch`｜基线 `58c52f0084997f669eea763edc7b58e11d3ef4f4`。
本文是开发者实现与自测说明，**不是**独立代码审计或 #4 产品验收；Mock/合成数据只证明流程与检查逻辑，不证明模型智能或行业成果质量。

## M0 事实核对与缺口矩阵（基线 58c52f0）

| 领域 | 基线已具备（代码证据） | #4 裁决中的缺口 | 本包处理 |
|---|---|---|---|
| 文件生成 | `lib/deliverables.js` 真实 DOCX/XLSX/PPTX/ZIP/CSV/MD/JSON，路径安全、公式注入防护 | 生成≠可用；ZIP 是 MOCK 占位（T2-14） | 不重复实现；新增四级状态区分 |
| 软件可运行性 | `lib/code-exec.js` 受控 JS 执行器（默认关闭、无网络、fs 限临时目录、禁子进程） | 无“可运行”判定，无交付清单 | M1：软件清单、编译级语法检查、占位识别、危险指令告警、显式请求的沙盒冒烟测试 |
| 组织设计 | 只有文本/表格成果 | 无组织结构数据校验与图示（T2-15） | M2：组织结构校验 + 安全静态 SVG + DOCX/PPTX/XLSX 关联 |
| 研究证据 | 只有文本 | 无来源/数据/假设映射与核验状态（T2-16） | M3：证据链、synthetic/unverified、缺证提醒、引用标注 |
| 状态真实性 | 运行审核=用户人工确认 | 未区分“生成/可解析/可用/专家评审” | M4：四级状态 + API + 工作台 |
| 费用提示归属 | 草案费用以单一“本次用量”显示 | #19 QA-GAPS-UX-01：429 沿用上一笔费用 | M4：按 requestId 归属 |

## 四级交付状态（`lib/delivery-check.js`）

| 层级 | 取值 | 含义 |
|---|---|---|
| 文件已生成 `generated` | true | 字节或结构化输出存在 |
| 结构可解析 `structure` | valid / invalid / not_checked | OOXML 必要部件、ZIP 目录与路径、静态 SVG、JSON、JS 编译检查 |
| 可实际使用 `usable` | `runnable_verified` | **仅**在隔离沙盒中测试文件真实运行、退出码 0（且输出含期望文本） |
| | `graph_validated` | 组织结构唯一ID/上下级/无环/无孤点已校验（专业合理性未评审） |
| | `evidence_mapped_unverified` / `evidence_gaps` | 每个主张均有证据映射但来源未核实 / 存在缺证主张 |
| | `mock_placeholder` | 检测到 MOCK/PLACEHOLDER/占位内容，永不运行、永不升级 |
| | `structure_only` | Office/文本文件只能证明结构；是否满足需求需人工判断 |
| | `not_run` / `failed` | 未运行（附原因）/ 检查失败 |
| 领域专家评审 `expertReview` | 恒为 `not_run` | 平台无专家；运行“审核通过”是用户人工确认，单独显示，不冒充专家评审 |

## M1 软件交付

- 输入：运行最终输出 JSON 的 `files[]` 与可选 `software{entry,test,install,run,testCommand,expectOutput}`。
- 检查：路径（穿越/绝对/盘符/保留名/重复/非文本/超大→拒绝并列明原因）；文件分类（source/test/doc/config）；`.js/.cjs` 仅 `vm.Script` 编译不执行、`.json` 解析；一致性（README、入口与测试存在、运行说明提到入口、无语法错误、无占位）；安装/运行指令中的 `curl|sh`、`rm -rf /`、`sudo`、`chmod 777`、`mkfs/dd`、fork 炸弹等**只告警、从不执行**。
- 冒烟测试：`POST /api/v2/runs/:id/delivery-check {"smokeTest":true}`，且管理员已设置 `AIJ_ENABLE_CODE_EXECUTION=1`、主机支持网络命名空间隔离时，才用既有执行器 `require` 声明的测试文件。子进程、网络被权限模型/命名空间阻止（单元测试实证：`child_process` → 失败，`fetch` → 退出码3）。否则 `not_run` 并写明原因。
- 合成示例 `tests/claude-delivery-fixtures.cjs` 中的记账模块是**真实可运行的最小软件**；本地实测 `runnable_verified`（退出码0，输出 `LEDGER SMOKE OK`）。CI Runner 不支持非特权网络命名空间时据实为 NOT_RUN。

## M2 组织结构

- 输入 `orgChart{title,nodes[{id,name,title,parentId,duties[],authority[],boundary}]}`；校验：节点 1–200、ID 规则与原型名、重复ID、缺名称、上级不存在（孤点）、自指/环、无根、多根（提醒）、层级≤12、不可达；缺职责/边界提醒。
- 图示：校验通过才生成 `org-chart.svg`（子树布局，父节点居中于自身下级），所有文本 XML 转义，无脚本/事件/外链/foreignObject；作为运行成果保存并可下载，Chromium 实际渲染 8 个节点。
- 关联：导出 DOCX/MD 追加“组织结构（已校验）”章节（层级文本、职责/边界、SVG 文件名+artifactId+SHA-256、“领域专家评审未进行”）；PPTX 在原幻灯片后追加“组织结构”页；XLSX 在模型未给表格时输出节点表。

## M3 研究证据链

- 输入 `claims[{id,text,evidenceIds,assumptionIds,confidence}]`、`evidence[{id,kind,citation,url,verification}]`、`assumptions[]`。
- 规则：`kind:'synthetic'` → `synthetic`；其余一律 `unverified`；模型声称 `verified` 被记录但忽略（并提醒）；只接受 http(s) 链接且**从不访问**；不存在的证据/假设引用、重复ID → 错误；无证据主张 → `unsupported`（缺证提醒）；含数字/金额/法规的主张提醒人工核实原始来源；平台产生的 `verified` 计数恒为 0。
- 导出：DOCX/MD 追加“证据清单与核验状态”（主张带 `[E1]` 引用标注、来源与核验状态、“平台未访问任何链接”）；XLSX 在模型未给表格时输出主张-证据-状态-假设-提醒表；PPTX 追加证据链摘要页。

## M4 接口、界面与 #19

- `POST /api/v2/runs/:id/delivery-check`（运行进行中 409；`smokeTest` 必须是布尔）；结果另存为运行成果 `delivery-manifest.json` 并记 `delivery_checked` 事件与审计；`GET` 返回最近一次清单（无则 404）。不改账本、费用或运行状态（测试断言 usage/usageLedger 前后相同）。
- 工作台“交付检查（四级状态）”卡：每项成果一行四列状态+说明，生成的 SVG 下载链接；沙盒冒烟测试需勾选。
- **#19 QA-GAPS-UX-01**：`public/project-intake/ai-draft.js` 每次生成记录当前 requestId；用量只归属于返回它的请求。新请求无用量时不显示“本次用量”；较早请求的用量显示为“上一请求（ID xxxxxxxx，与本次请求无关）”，保留其“费用未知/可能仍计费”事实；当前请求单独一行显示“未发送请求，本次费用为0”（仅对服务器在 claim 前拒绝的代码，如 `draft_busy`/402/`model_not_ready`）或发送状态未知（不视为0）。未改 `lib/intake-draft.js`、账本或费用事实。

## 自测证据与未测矩阵

| 项 | 结果 | 证据 |
|---|---|---|
| M1 清单/路径/语法/占位/危险指令 | PASS | `tests/claude-delivery-checks.test.js` |
| M1 沙盒真实运行 | 本地 PASS（runnable_verified）；不支持隔离的主机 NOT_RUN | 同上 + `tests/claude-delivery-http.test.js` |
| M2 校验负例/SVG 安全/布局 | PASS | 单元 + Chromium 渲染与 XSS 断言 |
| M3 证据链负例/降级/缺证 | PASS | 单元 + 真实 server 导出 |
| 导出关联与独立解析 | PASS（python-docx/openpyxl/python-pptx/zipfile/xml.etree）；依赖缺失时 NOT_RUN | HTTP 套件 |
| M4 API 门禁（401/403/404/400/409）与账本不变 | PASS | HTTP 套件 |
| 工作台 A/B/C 四级状态与持久化 | PASS | `tests/ui/claude-delivery.e2e.js` |
| #19 三个非合作在途 + 第4次429；正例 409 未知、202 未知 | PASS | 同上（测试专用预加载去掉 AbortSignal，仅限临时测试进程） |
| 真实厂商模型、真实软件仓库/部署、真实组织/研究数据、领域专家评审、真实用户（E4/E5） | NOT_RUN | 不在授权范围 |

运行：`node --test tests/claude-delivery-checks.test.js tests/claude-delivery-http.test.js`；`node tests/ui/claude-delivery.e2e.js`（需 playwright+Chromium）；CI：`.github/workflows/claude-industry-delivery.yml`（另跑完整 `npm test` 与全部浏览器套件）。

## 文件所有权与合流注意

本包新增/修改：`lib/delivery-check.js`(新)、`lib/v2-api.js`（仅交付检查路由、`finalTextOf`/`latestDeliveryArtifact` 辅助与导出章节增强）、`public/workspace.js|html`、`public/project-intake/ai-draft.js`、`tests/claude-delivery-*`、`tests/ui/claude-delivery.e2e.js`、本文、专属 workflow。未改：`lib/intake-draft.js`、`lib/project-store.js`、`lib/private-backup.js`、认证/工具授权核心、`tests/all.test.js`、`ci.yml`、`package.json`、#15/#4 专有文件。合流提示：`lib/v2-api.js` 可能与 #15 同时改动；新测试未加入 `tests/all.test.js`（共享文件），集成时由集成人员决定是否纳入。
