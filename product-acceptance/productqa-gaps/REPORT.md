# AIJAVAIS V2 第二十三轮独立产品补测报告

负责角色：**AIJAVAIS-ProductQA / Codex-ProductQA**。报告交付状态：**READY_FOR_REVIEW，等待GPT裁决**，不是产品ACCEPT或生产发布许可。

- 固定业务SHA：`58c52f0084997f669eea763edc7b58e11d3ef4f4`。
- 测试资产起点：`099b9c3e99a5708bd582109d3d05e8fdff4a148c`。
- 唯一测试分支：`test/codex-v2-productqa-gaps`。旧ProductTest分支未写入。
- 正式授权：[第二十三轮任务](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6674202389)；[CLAIMED](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6674319628)；[P2缺陷提前归档](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6674663583)。
- 首次脚本提交：`8d5c32e13bdc38dc41045e71a09c6093d9da96ee`；本文和CI哈希输出是后续报告提交。**报告所在最终提交的完整SHA、匹配CI及工件由Issue #4最终AGENT_REPORT_V1登记**；每份工件的`provenance.json.testHeadSha`与源码哈希也提供精确绑定，不把较早CI冒充最终提交CI。

## 1. 结论及实测计数

本轮五项：**T2-09 PASS、T2-10 PASS、T2-11 PASS、T2-13 PASS；T2-12存在P2界面FAIL，专用管理员恢复SOP另为BLOCKED**。通过仅限下面明确写出的E2/E3子范围。

首次独立CI：[run 42146188858](https://github.com/chaow0879-collab/aijavais/actions/runs/42146188858)，head准确匹配`8d5c32e13bdc38dc41045e71a09c6093d9da96ee`：

| Job | 实际结果 | 日志与工件 |
|---|---|---|
| HTTP并发、SQLite与SIGKILL | **4 PASS / 0 FAIL / 0 SKIP**，Job success | job `127658122254`；[API工件13469483639](https://github.com/chaow0879-collab/aijavais/actions/runs/42146188858/artifacts/13469483639) |
| Chromium错误、费用与容量 | **7 PASS / 1 FAIL**，Job failure；失败是已复现的`QA-GAPS-UX-01 P2`，不是脚本崩溃 | job `127658122545`；[浏览器工件13470311739](https://github.com/chaow0879-collab/aijavais/actions/runs/42146188858/artifacts/13470311739) |

不能宣称“本轮CI全绿”。**失败保留为exit 1，没有修改业务代码或吞掉失败来获取绿色。** 十二个执行场景全部运行；另有明确的SOP BLOCKED子项，不能由顶层FAIL计数隐去。

本地先跑API四项及浏览器八项。初版浏览器记录为7 PASS/1 BLOCKED；随后独立查看截图发现429后的费用归属矛盾，增加对应FAIL判定，仅定向复跑T2-12并复现，之后CI完整补测再次复现。原本地记录与定向失败记录均保留，未覆写。没有重跑首轮三行业Office、普通编辑保存或开发者单元套件。

## 2. 逐项补测与证据

| 用例 | 状态 | 实际行为及证据文件（相对对应CI工件） |
|---|---|---|
| T2-09 供应商401 | **PASS E3操作/信息呈现** | 本地供应商真实HTTP401被应用包装为502；页面保留`HTTP 401`及手工/模板回退。费用null，不自动重试；另一次人工估算、批准后恢复200。模型草案HTTP总数2。`T2-09-401/evidence.json`、`error.png`、`browser-http.json` |
| T2-09 供应商429 | **PASS E3操作/信息呈现** | 供应商限流HTTP429→应用502，页面保留`HTTP 429`；unknown费用和人工恢复同上。此场景不同于本地容量`draft_busy`。`T2-09-429/` |
| T2-09 供应商500 | **PASS E3操作/信息呈现** | 供应商HTTP500→应用502，页面保留`HTTP 500`；unknown费用、无自动重试、另行批准后恢复。`T2-09-500/` |
| T2-09 超时 | **PASS E3** | 使用原有、未缩短的60秒草案期限。首次CI等待`60118ms`后504/code=timeout、费用null；人工再次批准后成功。`T2-09-timeout/` |
| T2-09 取消 | **PASS E3** | Chromium实际点击取消，最终409/code=cancelled；页面明确“已发送的模型请求仍可能产生费用”，费用null。再次生成要新估算/批准和新requestId。`T2-09-cancel/` |
| T2-10 同ID并发/异参/重启 | **PASS E2/E3** | barrier同时放行8个真实POST：1个200、7个409 duplicate_request；模型HTTP仅1次、SQLite请求/草案账本各1行。在途改变description及重启后改变输出上限均409 idempotency_key_reused；重启同参数409且模型调用数仍1。`T2-10-concurrent/evidence.json` |
| T2-10 浏览器连点 | **PASS E3** | 原生`mouse.dblclick`、间隔80ms，真实HTTP保持未完成时双击；浏览器POST=1、模型HTTP=1、账本=1。`T2-10-browser-double-click/` |
| T2-11 结算失败202 | **PASS E3** | 本地模型通过真实HTTP返回100 Token后，测试夹具使settle抛合成磁盘错误；实际API为202/ok=false/usage_unsettled/financiallyComplete=false/cost=null。页面显示“费用账本未完成”“费用未知”“人工核对”“不要为补记账重新生成”；草案可编辑但保存须人工确认。重启后interrupted_unknown、同ID409、模型仍仅1次；能力中心真实截图显示只读异常账本。`T2-11-settlement-ui/202-unknown.png`、`restarted-accounting.png`、`evidence.json` |
| T2-13 claim后、派发标记前SIGKILL | **PASS E2** | 已提交真实SQLite预留，模型收到0次。进程以SIGKILL退出；恢复为not_dispatched、cost=0、requestSent=false、预留释放，同ID不重发。零费用有发送前证据。`T2-13-claimed/evidence.json` |
| T2-13 派发标记后、网络前SIGKILL | **PASS E2** | dispatching已提交但模型实际收到0次。恢复仍保守interrupted_unknown/cost=null、保留原reservedCost和预算上界；不凭网络计数倒推已知零费用，同ID不重发。`T2-13-dispatch-marker/evidence.json` |
| T2-13 模型HTTP收到后SIGKILL | **PASS E2** | 模型实际收到1次、SQLite仍reserved/dispatching；SIGKILL后恢复interrupted_unknown/cost=null、原预留保留，同ID409，模型仍1次。三个窗口都独立`PRAGMA quick_check=ok`、每请求只有1条账本。`T2-13-after-http/evidence.json` |
| T2-12 容量/诊断/安全重启 | **PASS E2/E3子范围** | 三个真实HTTP流不结束，逐次取消仅结束用户等待；activeSlots/underlyingInFlight/outstandingAfterResponse均3，第四次429，无第四次claim/账本/模型HTTP。两次只读诊断前后SQLite快照完全相同。隔离SIGTERM约2秒后退出，持有流随进程退出关闭；重启保留三条unknown和预留，旧ID均409不重派；明确批准的新ID恢复200。`T2-12-permanent-capacity/evidence.json` |
| T2-12 当前请求费用归属 | **FAIL / P2** | 第四次未派发，却沿用第三次取消请求的“本次用量”，详见下一节。`T2-12-permanent-capacity/429-full.png`、`429-full-text.json`、`browser-http.json` |
| T2-12 已交付管理员恢复SOP | **BLOCKED** | 冻结候选有技术文档及原始计数API，但#15永久挂起专用诊断/安全恢复SOP没有本候选上的交付证据。本测试的受控重启不能代替产品已交付的管理员工作流。未合入#15或#17新代码。 |

所有HTTP与浏览器过程都是本AGENT新编写的补测脚本实际运行。错误后300ms的观测窗内没有自动重试，最终调用数也与失败一次、明确再授权一次一致；不能将这个有界观测外推为任何第三方供应商永不重试的证明。

## 3. 已复现P2：QA-GAPS-UX-01

**触发**：按T2-12夹具启动隔离服务，连续生成三次并取消等待，底层调用仍未结束。再次人工估算、批准第四次请求，服务器返回`429 draft_busy`。

**实际界面相邻显示**：

> 已有3个草案模型调用仍在进行（含已取消但供应商尚未结束的调用），本次未发送请求、未产生费用；请稍后再试。
>
> 本次用量：未知 Token（unknown）；费用：未知，不能视为零（已发送且供应商调用尚未结束：费用未知（null），可能仍在计费）……

第二段与第三次取消结果的用量文字完全一致。第四次HTTP响应本身没有usage，独立SQLite与Mock计数证明它没有派发或建账。本页将此前调用的状态标为“本次”，使新请求费用归属矛盾。

**预期**：未派发的本次请求应明确标识；之前仍在途的用量要注明对应历史请求/ID，或隐藏陈旧的“本次用量”栏。这里只提出验收要求，不修改实现。

**严重性P2**：可复现的费用状态/可理解性问题，尚未造成本测试中的第四次派发、重复账本或未知费用归零，不升级成没有证据的P0/P1。建议GPT安排唯一开发者修复后，对这个场景做差异回归。

**复现命令**（项目根目录、Node24+、Playwright/真实Chromium可用）：

```bash
QA_GAPS_OUT=/tmp/productqa-capacity-evidence \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium \
node tests/productqa-gaps/run.cjs --browser --case=T2-12-GAP
```

冻结版本下预期是保留P2 `FAIL`并退出1；不能将这个退出码误报为测试脚手架失败。真实普通用户是否理解所有费用提示仍需E5人员测试，本轮未模拟人类作答。

## 4. 证据、哈希与CI绑定

首个脚本提交CI工件归档SHA256（来自GitHub元数据，**不是内部单个文件的SHA**）：

- API工件：`c5a0bcc12298454c7dd8056bd694ecac8849e5db5044205869becf66d4d7e85e`。
- 浏览器工件：`ba3f9061cf5b6040fd78b88593c9f58fbd5cabe679afef0ebe7f2dd90a05adfd`。

可在本地独立复核的样本SHA256（这些是本地attempt01/02，**不冒称CI截图哈希**）：

| 文件 | SHA256 |
|---|---|
| `T2-12-permanent-capacity/429-full.png` | `4a1fb545be60918a8ace8a105673ca70df47def64912af91a7d6216cb59552fe` |
| `T2-11-settlement-ui/202-unknown.png` | `45627c2c21f7a001d3a026d68dace08bd97e00d3798f161e67872c305c68140a` |
| `T2-10-concurrent/evidence.json` | `a4ef3fe5022d826bdabf9ad3169c0b16a9210aca34baaf3cc02d6f39887e3967` |
| `T2-13-after-http/evidence.json` | `b7953631b786e39a9841b5312230374a309600b454781d99a27aa40d6c6ad84a` |

每个新工件含`provenance.json`、`summary.json`、`SHA256SUMS.json`，以及逐场景真实HTTP结果、模型请求时间/数量及prompt哈希、独立SQL快照、进程终止信号、日志、截图和trace。最终workflow在runner.log关闭后再生成哈希，并将`QA_GAPS_ARTIFACT_HASHES`写入日志，可从GitHub日志交叉核对单文件哈希。源脚本也在provenance中逐文件SHA256绑定。

临时DATA、密码、setup-code、Cookie、密钥及原始数据库未提交Git。服务器日志隐藏设置码；trace中的Cookie/Set-Cookie/Authorization等凭据值在上传前通过独立ZIP/JSON处理去除，截图未改动。脱敏后trace通过ZIP CRC检查；它是脱敏后的过程证据，不宣称是逐字节未处理的原始网络抓包。

初始环境：Node24.22.1、Chromium155.0.8059.79、Playwright1.62.1。本支线CI使用Node24及固定Playwright1.56.1/其Chromium，版本差异如实留在工件中，不混用本地与CI计时、哈希或浏览器版本。

既有首轮报告、三个独立测试源码、10次Actions及失败/成功原始日志已读取，旧工件存在性、摘要与SHA已核对。GitHub下载工具能生成旧工件下载引用，但执行环境访问File Service下载主机被HTTP代理403拒绝，**旧工件二进制亲自解包检查BLOCKED**；没有绕过网络策略，也没有重跑旧已充分取证的验收。本轮新补测的实际执行和CI工件不依赖该下载路径；可由获准访问GitHub工件的审阅者复核二进制。

## 5. 故障注入的边界及独立性

- 启动真实、未修改的`server.js`，只监听127.0.0.1。每场景有新临时DATA、合成管理员及本地HTTP/SSE模型。`paid_api`只是本地模拟收费语义，不接真实收费供应商。
- 结算失败通过测试专用preload替换临时进程的settle方法；claim与实际模型HTTP不被伪造。崩溃barrier位于真实SQLite事务提交后，控制器实际发送SIGKILL；并非正常关闭后冒充崩溃。
- 非合作模型通过测试专用适配器移除caller AbortSignal，仍使用原生产HTTP/SSE实现连接本地持有流；**不声称正常生产适配器忽略取消**，也不声称有限观察证明第三方永不结束。夹具持有至测试进程退出。
- 保留SSRF、认证、审批、预算、TLS规则；只配置本地模型的精确`LOCAL_MODEL_TARGETS`。子进程不继承厂商API Key；没有MCP生产或外部写入。
- 新增/修改仅本分支`tests/productqa-gaps/**`、`.github/workflows/productqa-gaps.yml`和本报告。CI验证业务SHA/test-base祖先与文件白名单；业务`lib/public/server/package/catalog/tools`差异为零。
- 独立于Claude/Codex开发分支与其单元测试；本AGENT不把自己写的测试当成测试代码已通过独立安全审计，仍需外部复核。

运行完整本包（仅隔离本地测试）：

```bash
QA_GAPS_OUT=/tmp/productqa-api node tests/productqa-gaps/run.cjs --api
QA_GAPS_OUT=/tmp/productqa-browser \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium \
node tests/productqa-gaps/run.cjs --browser
```

## 6. 保留的历史矩阵及当前边界

首轮原报告状态**10项限定E2/E3 PASS、5项BLOCKED、2项NOT_RUN**保持历史事实，没有被本轮重写。下表“当前”仅合并旧证据与本轮新增范围，旧通过项没有冒称本轮重跑。

| T2 | 首轮 | 当前及限定 |
|---|---|---|
| 01 | NOT_RUN | **NOT_RUN**：真实语义理解 |
| 02 | PASS子范围 | **PASS原E2/E3结构**；真实专业合理性NOT_RUN |
| 03 | PASS | **PASS原E3编辑保存**，本轮未重跑 |
| 04 | PASS子范围 | **PASS原Mock授权门禁**；真实账单NOT_RUN |
| 05 | PASS子范围 | **PASS原Mock工具隔离**；生产工具NOT_RUN |
| 06 | PASS | **PASS原E2格式回退**，本轮未重跑 |
| 07 | PASS子范围 | **PASS原HTTP字节交接**；真实语义消费NOT_RUN |
| 08 | PASS子范围 | **PASS原Mock人工审核/返工流程**，本轮未重跑 |
| 09 | BLOCKED | **PASS本轮E3错误/取消/人工恢复**；真实人类理解度NOT_RUN |
| 10 | PASS部分 | **PASS补齐并发/异参/双击/重启子项** |
| 11 | PASS部分 | **PASS补齐真实202及异常账本UI子项** |
| 12 | PASS部分 | **FAIL P2费用归属UI**；容量/只读诊断/隔离重启PASS，已交付管理员SOP BLOCKED |
| 13 | BLOCKED | **PASS三个真实SIGKILL恢复窗口**，不含生产事故演练 |
| 14 | BLOCKED | **BLOCKED**：Mock占位ZIP不是可运行的软件成果 |
| 15 | BLOCKED | **BLOCKED**：Office可解析不是专业组织方案/组织图验收 |
| 16 | BLOCKED | **BLOCKED**：无真实市场/法规来源、正式财务及专家复核 |
| 17 | NOT_RUN | **NOT_RUN**：≥5名真实独立普通用户未组织 |

按主项当前为11项限定范围PASS、1项FAIL、3项BLOCKED、2项NOT_RUN；另有T2-12 SOP BLOCKED子项。E4真实供应商、真实第三方MCP/账单与E5行业专家、真实用户全部NOT_RUN。不能将Mock、可解析Office或自动浏览器操作上升为真实行业成果质量合格。

## 7. 风险与交接

本轮已实测新增P0/P1：**未观察到**，仅限上述Mock覆盖，不能据此宣称全系统风险清零。新增已复现P2：**QA-GAPS-UX-01**。已知P2-01永久挂起的安全取舍及#15其它跟进未被本报告关闭。

建议GPT登记费用归属P2，安排唯一开发者做最小修复，保留真实在途上限、unknown费用与不重发；新SHA经所需审计后仅回归受影响项。管理员SOP待实际交付再验收。真实付费试验和E5人员仍走单独门禁。

本AGENT完成本包后在#4提交最终AGENT_REPORT_V1/READY_FOR_REVIEW并停工，不关闭#4，不自行ACCEPT，不合main、不部署、不操作生产数据库或生产MCP。
