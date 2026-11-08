# R57 独立 ProductQA 本地记录

被测业务 SHA `049a3376a2d08042fcac1833b324bc87b0137ba1`，tree `fcd7c05a9a55a1b0906a5b7d661982f379e7e4f5`。
角色 AIJAVAIS-ProductQA / Independent-ProductQA；[任务](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6719108253)、[总决议](https://github.com/chaow0879-collab/aijavais/issues/10#issuecomment-6719420239)、[CLAIMED](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6719522402)。

**本地 30 项：29 PASS / 1 FAIL / 0 BLOCKED。非 live 产品结论 PASS_WITH_FOLLOWUP。** 唯一产品失败是重现的 QA55-01/P2：离线fixture工件导入后事件可REPLAY，但成果文件不显示。正常HTTP/SQLite/Mock用户路径通过。浏览器断言保留FAIL，工作流不能因此宣称全绿。准确独立测试提交与远端CI、工件digest将在#4最终AGENT_REPORT_V1填写，不能预写成通过。

自有分支 `test/codex-productqa-r57`，不改冻结业务源码。服务及自动化模块实际从临时干净detached业务SHA运行，而非QA提交。R55祖先及R56 `2b53e350d3b147b9216f8241a3e63350ceaf6b67` 相对R55的13路径blob/mode独立匹配；R55→R57的lib/server/public无差异。作者CI42459094848的5个原始job日志均取得并核对实际checkout：handoff128664327419、container128664327633、browser128664327663、tests128664327667、automation128664327705均success。新R57作者45/45是作者证据；作者R55隔离专项23项中6PASS/17SKIP必须记BLOCKED/NOT_RUN，不能洗绿。详见author-ci-observation.json；不累计为本次独立PASS。

| 独立案例 | 本地结果 | 证据 |
| --- | --- | --- |
| P0–P3 | 4 PASS | 来源/工作区/集成；新自然目标浮标边缘计算×城市声景地图；真实HTTP、逐岗许可、消息交接与peer review；实际DOCX/XLSX/PPTX下载字节/SHA/CRC与独立内容解析；criteria准确轮次/hash验收；真实服务重启后账本和approved状态持久，无重派 |
| B1–B5 | 5 PASS | 实际Chromium主工作台编辑→旧授权失效→逐岗许可→运行/刷新/断网→unknown费用提示→Word下载→失败criteria服务器阻断且本地便签不能伪造→需新许可的定向返工→第二轮文件验收；手机390px/reduced motion；截图/原始时间戳CDP录屏/脱敏trace |
| B7 | **FAIL/P2** | QA55-01在此准确R57仍可复现，known-defect-QA55-01.json和08截图，保留exit1 |
| A01 | PASS | 默认/live入口在读取输入getter前阻断，official模型0 |
| A02 | PASS | R56 minted event、tick→原CAS领取→3个真实标记Fake Node→Git对象/CI/report回收；末阶段缺QA回执不能完成，补齐只读回收后HANDOFF_COMPLETE；重复不新增Fake/报告 |
| A03–A06 | 4 PASS | HTTP429后只读重查不重派；错ref/SHA/workflow/PR/作者/自由文本/报告SHA具体拒绝码；CI pending/failure、缺审核/QA pending不推进；自审/同审/错SHA/过期/坏签名不能放行 |
| A07–A09 | 3 PASS | 无用量保持cost=null/预留0.1且阻断后继；Fake失败不自动重试；真实CAS提交ACK丢失保留claim且不执行 |
| A10 | PASS | 3个真实控制器OS进程竞争，1个持久工作键、1个实际Fake进程 |
| A11–A15 | 5 PASS | 持久HALT及晚到R56 signed REJECT停止活动Fake、未知费用不清；子任务不能绕父QA；最终回收期间策略交换阻断；日预算耗尽或修改已批collection policy不启动后继 |
| A16 | PASS | CLI输出绑定本冻结SHA的OWNER_GO_MATRIX，NO_GO/authoritative_go不为true，provider硬额度未验证 |
| A17–A18 | 2 PASS | HTTP/SQLite CAS服务真实停止重启后墓碑/账本不变、仍1次Fake；自有controller SIGKILL后以持久lease_until前后验证DISPATCHING→UNKNOWN、预留0.1/不重发，清理仅限测试自建PID/工作区 |
| I1–I2 | 2 PASS | 本地实际Bubblewrap能力探测；固定Stub可写临时tests但不能写server.js；非生产隔离证明。CI若namespace不可用必须BLOCKED，禁止改内核规则迫使通过 |

测试独立性披露：automation场景、断言、Fake程序/次数/PID记录、controller worker与回执review bundle为本QA编写；借用了开发者**协议bootstrap/合成packet与临时key工厂、本地GitHub/SQLite模拟器**，没有执行或计入开发者test断言。不是完全独立密码学实现，也不代签CodeAudit。用户路径复用了本QA的R55工具及必要断言并重新绑定本SHA；未重复旧8行业大扫或显式404旧V2整包。

全部自动化模型/审阅/CI身份为明确合成资料；本地HTTP返回中的CI IDs101等不是GitHub真实CI。实际Node/Fake进程、Git对象、SQLite持久记录和Office字节为真实测试证据。三阶段现有work_sha==source_sha，不称真实AI生成新软件提交。E4官方模型、五真人E5、专业质量及厂商账单均NOT_RUN/NOT_VERIFIED；local免费账本0不是供应商账单，vendorUsd保持null。合成签名不替代受信KMS/独立合法署名。

已核真实执行外部门禁仍NO_GO：官方身份、供应商可强制单次及总额USD/Token硬上限、可信App/OIDC/KMS、同SHA独立安全裁决、受保护远端state-ref/CAS、目标宿主OS/网络隔离、default-branch event/10分钟正式cron和Owner单次真实执行批准未全部实证。#24真实运行环境预检由Infra负责，ProductQA不冒称完成。默认/live编译阻断，不因更多CI解除。

QA55-01复现：主工作台生成R53团队，导入有效event/v1的queued/delivered与artifact/v1的qa57-offline.svg，origin=fixture/evidence=E2_FAKE/data URL。REPLAY正常但文件区“还没有交付文件”。仅服务器run工件过滤导致离线工件缺失，真实run交付主链通过，故P2跟进、不阻断当前非live研发；由UI所有者修，本QA不改业务。

首轮自有automation夹具出现2个失败，保留原始本地输出：末阶段缺review的注入错误地同时拒了父回执，事件重复又误用了已消费nonce。修正为只拒该末阶段、重复走tick，并对每类错误断言具体拒绝码；业务源码不改。最终18/18。该夹具修复不影响QA55-01真实产品FAIL，不删除其断言。

所有私有worker合成key文件仅临时0600且清理，不上传。实际证据、文件与录屏SHA见local-hashes.json；远端CI会另生成manifest。未配置/提取Secret、调用收费或生产MCP、部署、main、生产数据库、真实protected state-ref写或正式持续调度。最终结论只针对本SHA，不移用R55签字，也不替安全审计或Infra签字。
