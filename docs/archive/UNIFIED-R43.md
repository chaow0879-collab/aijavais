# R43 联合产品与自动化候选

本包把已完成的业务系统及V1/V2开发自动化保存在**同一Git源码树**，不重新开发已交付功能，不把它们描述成已完成真实Codex→Claude接力。产品仍是普遍/未知行业通用AI工作平台/虚拟公司，HALOFLUX展示真实工作事实；三个行业仅为回归样例。

## 唯一分支及来源

- 正式授权：[#22 R43](https://github.com/chaow0879-collab/aijavais/issues/22#issuecomment-6686840206)；R44不阻塞通知 [#6687128094](https://github.com/chaow0879-collab/aijavais/issues/22#issuecomment-6687128094)。唯一集成人Codex，唯一写入分支 `integrate/r43-unified-product-autoexec`。
- 冻结业务来源：`b377d427e6a018dc03fbf01c6ec1db40be156b4c`，保留#17/#15/#19产品、请求费用归属、交付检查、严格Office门禁和相关UI/HTTP/测试。
- 冻结自动化来源：`e891978b46490bccf2c2282df24c8e7b2f4ced42`，包括被独立接受用于代码集成的V1 `d54b29e11716a01f0812b3e8576982b9f5b9b234`及R42角色兼容、全部V2 Fake/Stub/CAS/锁/恢复/限额/环境探测。旧REJECT核心没有重新成为基线。
- 共同祖先：`58c52f0084997f669eea763edc7b58e11d3ef4f4`；两来源相对此base的改动路径无交集。
- 真实no-ff merge：`64b3df5c75548b0fda3e44d8f1a35a6a8ed25200`；第一父b377业务，第二父e891自动化；合流无冲突。原来源分支/历史不改，不force push、不reset。
- 最终候选完整SHA/tree、准确CI run/attempt/job结果以Issue #22本轮AGENT_REPORT_V1为准；#23只有同一报告索引，不另交第二候选。
- Claude R44在 `feat/claude-v2-universal-intake-r44` 独立开发。本包不等待、不合入其未完成WIP，不修改其分支，不将未来成果静默写入冻结候选。

## 必要集成胶水与保全

不新增产品API、复杂Runner或事件调度服务，不改业务/执行器运行逻辑。两条来源的运行模块直接共存：

| 部分 | 路径及事实 |
| --- | --- |
| 业务系统 | server.js、lib/**、public/**、catalog/**、package.json保留；真实HTTP/SQLite、审批/取消/预算、交付检查及文件下载继续走原API |
| 开发自动化 | tools/agent-scheduler/**、tools/agent-executor/**及原测试完整保留，所有真实入口继续OFF |
| 联合CI | 复用现有.github/workflows/integrated-acceptance-26.yml，新增本联合分支push触发及automation job；四job在同一准确SHA运行，均断言checkout HEAD、只读权限、persist-credentials:false |
| 源码保全检查 | tools/integration/verify-r43-sources.js仅执行只读Git命令；核两冻结来源为当前祖先、共同base、53条非文档/工作流改动路径的Git blob+mode及工作树一致性 |

保全检查的53条为业务18+自动化35。唯一受控差异是 `tests/ui/claude-delivery.e2e.js` 的SVG展示夹具，旧/新Git blob分别钉死为 `9f532302c13c45a28bcf5a29153360edac10037f` / `cd143f86f5fd8df7a74257f4c9e3e1e4da831138`，不使用整路径豁免。其余52条与来源逐字/模式一致，业务运行代码、自动化运行代码和原安全断言不变。

该检查仅用于本冻结R43工作包，依赖Git完整父链（CI automation checkout fetch-depth=0）。未来产品整包发生合法源码变化时由其负责人更新该包自己的来源策略，不能为了绕过检查删除原来源或保护记录。

### SVG测试兼容修复及首次失败

首轮五组浏览器中前四组通过；第五组费用归属/429/未知费用检查先通过，随后云环境Chromium将 `data:image/svg+xml;base64,...` 导航拒绝为 `ERR_BLOCKED_BY_ADMINISTRATOR`。

最小修复：仍通过真实登录会话下载原附件SVG并检查HTTP200、MIME及attachment头，再由只绑定127.0.0.1的临时HTTP夹具呈现**相同下载字节**。保留全部8节点、`window.__xss`未执行、无img元素和截图断言；不改浏览器策略/TLS/网络规则，不加会掩盖XSS问题的CSP，不修改产品下载接口或生成器。退出清理该测试page/server。修复后完整第五组通过，首次失败保留在报告。

## 同树验证

| 命令/流程 | 本地结果（Node24.22.1/Linux） |
| --- | --- |
| V1串行 `node --test --test-concurrency=1 tests/agent-scheduler/*.test.js` | 260/260通过，0失败/跳过，原AUD-26/AUD-33负例、3组真实多进程争锁和R42角色正负例保留 |
| V1+V2 `node --test tests/agent-executor/*.test.js tests/agent-scheduler/*.test.js` | 383/383通过，0失败/跳过；包括模拟多Agent、签名/权限/stop/超时/CAS/跨进程/kill恢复/未知费用/安全env |
| `npm test` | 276/276通过，0失败/跳过，包含业务HTTP/SQLite/幂等/取消/账本/文件/Office；继承umask077也通过 |
| `npm run test:p2` | 9/9通过，含预算/权限/幂等/恢复/容量语义变异被旧测试击杀及缺Python解析拒绝 |
| `npm run test:release-industry` | 3/3通过，严格独立Office解析为PARSED，不将缺依赖当通过 |
| `npm run test:release-delivery` | 9/9通过，四级交付状态、SVG、权限/活动运行拒绝、账单不变、严格解析及本地隔离代码smoke |
| 五组Chromium | test:ui / workspace / intake / industry / delivery-ui最终全部通过；真实浏览器+本地Mock模型，含429不派第4次、未知费用归属、HTTP202及交付卡片/SVG/XSS |
| 容器 | 镜像sha256:7aeb8e003c427a4657dc22b44e2fb2acc867fdbe2f478636024d715b328992b9构建，临时无网络/无host端口容器health=healthy，测试容器及临时卷已清理 |

最终准确SHA上的本地/CI详细计数见#22冻结交付。表中串行V1与组合V1存在重复，不能相加宣称唯一测试总数。真实厂商API未调用。

历史umask问题：R30/R42自动化分叉的旧备份测试在077下发生275通过/1失败、022重跑276通过；本次**业务冻结来源已经修复该测试夹具的错误假设**，故完整保留该修复且本轮077下276通过。没有删断言或修改备份业务实现来掩盖失败。

本地代码smoke是临时隔离环境中运行生成的示例代码，不是启动真实Codex/Claude。hosted runner如不支持网络namespace，代码执行按设计拒绝/记NOT_RUN或skip；CI内部skip须据日志/证据单独报告，不把job绿当每个子项全通过。严格Office门禁则要求实际PARSED。

## 联合CI、复验及证据

现有联合工作流复用后有tests、browser、container、automation四job，同一push精确SHA而非分叉版本或PR测试merge。保留所有既有工作流；本包不再新增工作流或创建/合并PR。tests运行原npm/P2/两严格Office门禁，browser保留全部五组，container构建/健康检查，automation保全两来源后跑串行V1及组合V1+V2、默认OFF、Fake/固定Node Stub和无认证版本元数据探测。安全TAP、来源JSON及既有业务/Office/浏览器工件保留。

```sh
node tools/integration/verify-r43-sources.js
node --test --test-concurrency=1 tests/agent-scheduler/*.test.js
node --test tests/agent-executor/*.test.js tests/agent-scheduler/*.test.js
npm test
npm run test:p2
npm run test:release-industry
npm run test:release-delivery
# Playwright已装时，云环境可显式指定现有系统Chromium
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:delivery-ui
```

本地全量和浏览器命令使用临时SQLite/本地Mock；日志/截图/测试私有目录不提交到Git。源码保全工具无GitHub写或模型请求。

## 产品事件与后续真实接力边界

现有 `lib/events.js`事实事件协议、`ProjectEngine._event()`持久事件及`project_run`发射路径、原HALOFLUX素材均保留；V2开发执行器现有持久审计事件及哈希链保留。两者没有在本包被混写：Fake SUCCESS不能被桥接成产品真实任务完成。未来经负责人授权的事件适配可复用这些已发生事实，必须绑定原任务/运行、来源真实或模拟、角色/SHA与权限并脱敏；本包未冒称新事件桥或可视化已上线。

R43 Git集成分支和协调报告`Codex-Integrator`不是自动模型执行授权；不因此扩张执行器allowed_branches/permitted_roles/可信账号。实际Planner自由格式文书仍需按R42协议由合法独立身份重新发布结构化精确SHA授权；本包未代签、回写或伪造批准。

**NOT_RUN**：真实Codex/Claude任务及认证/套餐/原生费用Token硬限额、真实远端CAS写、跨主机/断电耐久、实际10分钟轮询/daemon/webhook、生产或测试服务器部署、main/PR合并、真实第三方模型/MCP和E4/E5。默认开关与编译期OFF不变，actual_agent_launches=0、real_dispatch=false、cost=NOT_VERIFIED。本地Mock或Node Stub不是实际自动接力。

最终仅冻结**一个联合SHA**交GPT，由独立CodeAudit+ProductQA并行在同一SHA集中复核。后续有界真实演练仍需负责人明确批准合法凭据、预算和窗口；通过首轮稳定真实闭环后按#26封顶Runner投入、回归普通用户通用产品与HALOFLUX主线，不等待R44就提交本包。

本轮业务schema仍v4，无迁移/生产数据改动。回滚须保留两个父链和持久状态证据，以普通追加提交回退，不force push/reset或删幂等墓碑，不重发未知收费请求、不把未知费用清零；不得因回退启用旧REJECT安全核心。
