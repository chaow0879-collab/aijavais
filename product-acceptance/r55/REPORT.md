# R55 独立产品验收本地证据记录

`role=Independent-ProductQA`，`agent_name=AIJAVAIS-ProductQA`。
`reviewed_sha=8e9584149cccac02fa0b5c39a68c1983ec60170e`，tree `d0ebc0b559aca1e51922692db4e3888786153514`。
任务：[正式任务](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6716234046)、[总决议](https://github.com/chaow0879-collab/aijavais/issues/10#issuecomment-6716262870)、[CLAIMED](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6716315809)。

**本地结论：PASS_WITH_FOLLOWUP，仅 E2/E3、非 live。35 项：34 PASS / 1 FAIL / 0 BLOCKED。** QA55-01 为 P2 实际产品失败，已[登记 #4](https://github.com/chaow0879-collab/aijavais/issues/4#issuecomment-6716435282)。没有通过删除断言、跳过或修业务源码掩盖。CI 在该断言仍失败时应保留 browser job failure。此文件记录本地结果；**准确测试提交、远端 CI 的真实结果与工件 digest，以 #4 最终 AGENT_REPORT_V1 为准**，不把尚未运行的 CI 写成通过。

独立分支 `test/codex-productqa-r55` 只新增 `tests/productqa-r55/**`、本目录和专属测试 workflow。业务服务在另一个临时、干净、detached 的冻结 SHA checkout 中运行，避免 QA commit 冒充被测业务 SHA。R53 `397b46c18e25aaddc3e92886693da4ef3f2528d3` 祖先关系、R54 `3fbd6ff5db2f1a9032a02f9b48a965abc461d500` 相对 R52 的 13 路径 blob/mode 保真均实测；server 事件 source_sha 明确断言为冻结 SHA。作者 CI 42438404898 的成功仅为来源证据，不计本次独立 PASS。旧 R51/更早结果不移签。

| 自有用例 | 本地结果 | 实际证据与边界 |
| --- | --- | --- |
| M0 | PASS | 精确业务 SHA/tree、干净运行 checkout、来源与 13 个文件、8 个新行业词不在预制规则/目录中 |
| M1 × 8 | PASS | 每条自然目标：规划 0 模型调用；岗位可编辑且保存；无批准/错版本/过期拒绝；真实 loopback 模型消息交接和 peer review；文件 SHA/round；criteria 保存、准确文件验收；重复交付不派发；append-only 事件分页无重复、seq 连续 |
| M2 | PASS | 8 个下载文件 ZIP CRC + python-docx/openpyxl/python-pptx 读取实际 Mock 内容标记，覆盖 DOCX/XLSX/PPTX；非只验扩展名 |
| M3 | PASS | 真实 Node 重启后 SQLite quick_check=ok、账本不变、8 个 run 的服务器 criteria 与 approved 持久保存，无模型重发 |
| B1–B6 | 6 PASS | 真实 Chromium R54→R55：自然目标、编辑令授权失效、逐岗同意、保存不调用、运行/刷新、断网不假工作、unknown 费用提示、真实下载、失败 criteria 阻断且刷新/本地便签不能改服务器、重新授权与从第3步返工（仅4个追加调用）、旧轮次拒收、当前文件验收、手机390px/reduced motion；旧 V2 发现404仅为明确注入的 fixture 分支 |
| B7 / QA55-01 | **FAIL / P2** | 有效离线 event/artifact bundle 导入后 REPLAY 可见，但 qa55-offline.svg 文件名与下载不显示；无额外调用/服务器假验收。截图、trace、known-defect JSON 保存 |
| F1–F10 | 10 PASS | 同ID并发仅1派发；取消后重启永久墓碑不重发；改参数409；首步期间过期阻止下一步；取消后重复409；3活跃第4请求HTTP429；上游真实Mock HTTP429不自动重试；UNKNOWN必须确认且验收/重启不清账本；逐岗Token不足0派发；撤回岗位拒绝；SIGKILL恢复 interrupted/failed 且不自动重发；loopback模拟paid策略402拒绝，非真实收费 |
| S1–S7 | 7 PASS | 独立小型临时Git/SQLite：QA越界瞬时创建删除被检测；tests外链拒绝；伪造隔离对象不启动；嵌套namespace不可用失败关闭；真实OS允许tests写与父进程受限提交；OS拒绝瞬时越界/运行期链接/邻居写，外部SQLite哈希未变；真实agent路径编译关闭 |

8 个自拟自然输入：苔藓孢子标本×声学走廊、霓虹招牌修复×手语导览、陨石拓印×社区夜跑、蒸汽玩具×嗅觉展览、漂流木图书馆×潮汐日历、冰川花粉档案×声音邮局、竹编机器人外壳×剧场服装、行星植物纹样×触摸票券。原文见 common.cjs 的 GOALS 和每项 evidence；未传开发者预制行业或显式输出类型替代自然目标。

本地 API 8旅程合计49个岗位 Mock HTTP，连接试连1次另计；浏览器完整第一轮6步+第三步起返工4步，共10个岗位 Mock HTTP，另1试连。每个故障独立数据目录、调用数逐案保存。真实供应商模型调用=0，真实费用=0。局部 free/local 账本的0不是供应商账单；view.cost.usd 仍 null、vendorInvoiceReconciled=false、professionalQuality=NOT_VERIFIED。

QA55-01 精确复现：在主工作台生成 R53 团队后，导入两条有效事件 queued/delivered 和一个 `aijavais.workbench.artifact/v1`、`origin=fixture`、`evidence=E2_FAKE` 的 SVG data URL。REPLAY 后成果区却显示“还没有交付文件”。只读定位 `renderOutputsR53` 按服务器 run metadata 过滤，离线 bundle 没有 run。建议由文件所有者为离线工件提供明确的 fixture 展示；不能伪装成服务器真实交付。当前影响离线回放浏览，正常服务器下载/验收主链通过，定 P2 跟进。

作者另外两项披露独立分类：旧R52 V2回退的404是测试注入，B6只证明该分支，不能称正常R53不可用；accept/cancel重复返回409是状态拦截，不具requestId级重放结果语义，本次核实没有额外模型调用或清费。作为协议限制记录，不将其误判为重复收费或伪称严格requestId幂等。新 start/deliver/criteria 使用独立持久收据测试。

本地环境 Node24.22.1、Chromium155、Playwright1.62.1、真实SQLite和Bubblewrap；Office解析 python-docx1.2.0/openpyxl3.1.5/python-pptx1.0.2。浏览器录屏取真实CDP帧时间戳，ffmpeg输出webm；原图未编辑，trace移除临时Cookie/Authorization。共享工件含请求日志、模型消息/次数、SQLite只读投影、哈希、下载字节、独立解析、截图、视频与trace；不将数据库、截图或凭据放入Git。`local-results.json` 为逐项结果；`local-delivery-hashes.json` 为本地实际文件与录屏哈希，CI独立生成不同run/时间戳的文件哈希，不能混用。

真实外部门禁：**NO_GO / LIVE_BUILD_DISABLED**。E4官方收费模型、E5五名真实普通用户、专业领域专家质量、厂商账单核对均 **NOT_RUN / NOT_VERIFIED**；官方身份、可信OIDC/KMS签名、供应商可强制单次和总额USD+Token硬上限、受保护真实GitHub state-ref/CAS、默认分支event/10分钟正式cron、Owner明确收费/真实运行授权、生产环境隔离证明未满足均 **BLOCKED**。旧软件unshare/真实运行未验证项不升级。安全审计由 #2 独立签署，ProductQA 不代签。

本轮未修改业务代码，未调用真实模型/生产MCP，未配置/提取Secrets，未合main/部署/生产数据库/启用正式持续调度。下一步由总指挥处理P2与独立双门禁，R57新完整候选冻结后再按其新SHA集中验收，不能复用本报告签字。
