> **WIP / 依赖BLOCKED。** 第三十轮授权继续现有CLI/GitHub-hosted源码、版本元数据探测及Stub验证；V1仍因AUD-26-SCH-01/02/03三项P1被独立REJECT，#25尚无独立审计通过的新SHA。本分支不修V1，不引入未审计修复，整条真实接力保持阻断。所有实际Agent执行、凭据配置、定时部署、生产操作均OFF。

# 自动执行器V2：离线Fake/Stub开发包（#22）

## ADR-22-01：不接入真实执行器

基线为V1精确SHA 6363e8d10595a566a1ba266cb70017711cc806be，独立分支feat/codex-v2-autoexec-v2-stub、独立checkout；V1尚无独立CodeAudit ACCEPT。本包不修改tools/agent-scheduler或业务代码，不把V1作者测试当独立审计。当前业务Claude #17=1bf1aef3fb02f5a4fa40507435dd5b05b023207e、Codex #15=c088076425256f52a26aab4e5272a5b1f72402a4；业务#23集成候选尚未核验，不凭两支CI绿推断集成通过。

选择：当前只用不可替换的内存Fake适配器；包含受编译期OFF保护的CLI监管实现，实际启动路径在本构建永远封锁；不加载真实SDK或云任务。cli/sdk/cloud_approved只是预留后端枚举，都会返回真实接入BLOCKED_CREDENTIALS，不能因二进制存在推断登录、套餐、费用、条款或可执行资格。默认清单只查PATH文件元数据；显式runner-entry.js --probe可执行固定--version（8秒/16KiB上限），只保留数字版本和安全状态，不执行登录/认证命令，不读cookie/凭据文件或输出token。

候选托管A：GitHub-hosted短生命周期门禁+独立runner，需GitHub App只读/写入两种独立短期身份与额外服务账单批准。候选B：隔离非生产开发runner上的官方受支持登录CLI，需持续运行、安全守护、资源/网络和额度控制。当前均NOT_CONFIGURED/NOT_RUN；不能把网页会话当后台可唤醒API。Codex/Claude本身也可能收费，不能仅批准产品被测API而默认批准开发Agent服务费用。

配置所有*_ENABLED=false、dry_run=true、stage=DRY_RUN，cron/webhook也false。events.example.json仅禁用的数据样例，不注册任何事件/cron；专属CI仅manual/PR（无secrets）；GH-hosted事件/schedule配置只保存在非工作流目录的.disabled模板，未注册。修改配置或环境变量试图打开真实开关会被代码拒绝；本构建永远actual_dispatch=false。不存在自动启用或真实dispatch实现。

## 实现与运行清单

policy.js严格校验所有OFF开关（配置和环境变量）、签名/身份/仓库/Issue/分支/角色/phase/SHA/approval_version/最小上下文与完整来源摘要、预算和到期。Ed25519签名仅是模拟授权完整性协议；demo生成内存临时Fake密钥，没有用户真实授权、模型凭据或登录。默认身份及公钥白名单为空。允许后端cli/sdk/cloud_approved，但均只能构造不可替换、冻结的FakeAdapter；任意自定义adapter被拒绝，realDispatch永远抛错。

engine.js复用原V1纯门禁evaluate（原文件未改），核对observed_ref与snapshot refs，绑定source_digest防Issue/评论强改；CLAIMED/RUNNING/IN_PROGRESS不重复启动，新SHA的QA关键FAIL停人工。只有INTEGRATION_READY/AUDITING/PRODUCT_QA可模拟对应已签角色。P0/P1、未知来源、CI失败、非fast-forward、脏工作区、旧SHA等全部阻断。E4/E5、main、生产角色没有自动执行入口。

store.js仅允许当前UID拥有的0700临时目录，文件0600；wx独占事务锁、fsync临时快照+原子rename、校验和/版本、哈希串联审计。键为repo/issue/role/phase/sha/approval_version；持久CLAIMED后才标RUNNING，之后才调用Fake；单角色最大1。事件与CI rerun重复、重启均不重放。heartbeat/TTL与死PID恢复为HUMAN_REVIEW_REQUIRED，actual_cost=null并保留假设预留；不自动删除僵尸锁或释放未知作业。超过4MiB、腐坏文件、权限或持久写入失败均停止；当前不是生产分布式锁、未声称断电/恶意同UID/跨主机安全。所有数据/日志写入本地模拟目录，不写业务SQLite/GitHub。

Fake限额按事件消费前计量：max_job_runtime（模拟毫秒）、max_tokens、max_model_spend与UTC每日桶，先事务预留假设金额；超限不接受下一Fake事件。输入最多256事件，不能无限循环，不使用真实计时器。它不证明真实厂商费用被限额：真实model_spend/actual_cost均null；将来真实接入必须有可审计的任务/每日硬额度、取消与未知收费恢复保护并单独验收。只读检查Fake重试最多1次；代码Fake失败/停止/未完成保留证据，原key不再跑；修复重跑要新签署approval_version，不能自动换ID避锁。

显式离线命令：

```sh
node tools/agent-executor/cli.js
node tools/agent-executor/cli.js --fake-demo
node --test tests/agent-executor/*.test.js tests/agent-scheduler/*.test.js
```

默认仅DISABLED与脱敏清单。当前开发环境Node v24.22.1/Linux：第三十轮显式--version探测确认Codex CLI 0.166.0；Claude未找到。仅执行版本及公开help，未执行模型任务、未验证账号/额度/条款/登录，两者实际接入仍BLOCKED_CREDENTIALS，runner NOT_CONFIGURED，V1 audit NOT_VERIFIED。--fake-demo创建隔离临时模拟目录、假许可及Fake SUCCESS，明确fake_only/actual_dispatch=false/actual_launches=0；不是实际任务完成。

## 管理员一屏未来启用指南（本轮只说明，不操作）

1. 负责人先选择A短生命周期GitHub-hosted+独立执行runner，或B非生产隔离开发runner；不得用生产AIJAVAIS/Caddy/S-UI主机。确认Linux/ACL、CPU/内存、默认无网/网络白名单、隔离工作区/分支、日志加密保留与删除政策。当前不安装runner/service/daemon/webhook。
2. 在未来另获批准后，GitHub Settings → Developer settings创建仓库专属App；只读身份issues/contents/actions/pull_requests:read；另一个短期执行身份才可对指定Issue/开发分支写入，main与保护设置禁止。App通常不能仅靠token scope限制单Issue/分支，必须结合服务端白名单、环境审批与分支保护，不能宣称仅App权限已完成隔离。
3. GitHub Settings → Secrets and variables → Actions / Environments：未来为已批准环境配置短期凭据及required reviewers；本轮不写Secrets、不复制网页登录Cookie/生产SSH，不创建默认分支schedule。账号计划、计费方式、条款与任务/每日Token和金额上限由负责人逐项确认，不能假定订阅免费。
4. 运行身份/allowed_issues/allowed_branches/permitted_roles/approved_scope/approval_version/精确SHA与上下文摘要/期限/任务和每日限额须完整签署并绑定可信公钥。审计只读、QA只写测试资产、开发仅独占分支；未来还需真实沙箱文件/网络权限验证，本Fake实现不模拟为真实OS强制隔离证据。
5. DRY_RUN→ARMED_READ_ONLY→AUTHORIZED_DISPATCH→AUDITED_RUNNING只允许相邻步骤；先分别完成精确V1独立ACCEPT、V2独立安全验收、负责人对地点/凭据/费用并发/角色及窗口的另批。previewEnablement只返回假设，实际阶段始终DRY_RUN。本构建即使三项许可字段为true仍不能启动真实Agent，必须另行开发/审计真实接入，不能通过改开关绕过。
6. 未来停止/回退：负责人停用独立环境与App短期授权，停止独立runner，保存失效lease/任务状态/脱敏审计与未知费用证据，核对供应商账单；不重放未知作业、不删除幂等键、不恢复历史夜间automation。代码回退到匹配快照版本并保留本地执行幂等记录；生产/main/付费/外部MCP始终另走人工门禁。

## 验证口径

初始Fake阶段V2 58项+原V1 37项=95/95通过；包括完整Fake集成→独立审计→QA轨道、两种执行器及3种Stub后端、真实4子进程争锁、SIGKILL Fake worker后保守恢复、预算/签名/凭据/分支/修订/CI故障、状态持久写入失败、运行中防重复及停止开关。测试曾发现夹具重签许可未真正传入，已修正闭包并复核，未删断言。实际模型/Claude/Codex/云任务启动0；计时/用量/服务费用均模拟，不是供应商或生产验证。独立专属CI及最终40位SHA见Issue #22。


## 第二十八轮 CLI / GitHub-hosted源码交付（仍未启用）

cli-runner.js实现Codex/Claude候选命令构造与stdin上下文、无shell argv、退出码、有限输出、跨chunk脱敏、流式用量检查、超时watchdog与显式stop、子进程回收。实际模型CLI版本/参数兼容/账号/条款/凭据/原生Token与USD硬限额未验证，不能宣称接力实测；Codex没有已证实原生USD预算能力时必须BLOCKED，而不是假定subscription免费。真实输出默认不返回正文；已知secret/Bearer/sk-脱敏只是额外保护，不是通用DLP。Node Stub用固定本地脚本，进程环境不继承模型密钥；watchdog仅是该显式测试进程的安全超时，不是自动轮询/定时派工。

runLive源码当前首行受LIVE_BUILD_ENABLED=false封锁，任何配置、环境变量或伪造审批都不能启动真实Agent；本轮没有调用真实codex/claude模型任务；第三十轮仅对Codex执行--version和exec --help元数据探测。未来源码接入前，三个不同签名身份的v1_audit/v2_audit/operator须绑定同一manifest、有效期、已修Gate SHA、准确仓库/Issue/分支、原生硬限额与角色隔离验证。旧6363e8d Gate永远不接受。三签名仅校验声明真实性，不替代供应商与隔离实测，真实执行实现仍需新源码验收、可信签名注册表和许可。当前全部凭据状态BLOCKED_CREDENTIALS。

workspace.js实现仅受信本地Git源、clean/精确SHA校验、0700临时私有clone、无hardlink、禁Git hooks/global config、独立feat/fix/test分支、健康/差异范围检查与品牌实例清理。audit只读、QA只允许tests/，开发需显式allowed_paths；结果后置校验不等于OS级权限沙箱。真实CLI环境仍须独立GitHub-hosted实例/原生限制保证任务执行中不可越权，当前NOT_VERIFIED。不会删除任意调用者路径，不写源工作树或main。

真实调用源码只允许显式的OPENAI_API_KEY/ANTHROPIC_API_KEY/CODEX_HOME/CLAUDE_CONFIG_DIR凭据字段，不能覆盖PATH/NODE_OPTIONS等执行环境；当前Stub忽略这些字段，未配置任何真实值。真实credentials必须由未来审计后的broker/受保护环境提供，模型工具不能继承公开PR注入的密钥；当前没有Secrets设置或外部令牌申请。

GH-hosted完整示例在tools/agent-executor/templates/hosted-runner.yml.disabled，不位于.github/workflows，复制/默认分支启用均需额外授权。仅允许内部可信事件；workflow_run拒绝fork/PR来源；执行器checkout必须固定AUDITED_EXECUTOR_SHA而不是事件提供的ref，persist-credentials=false。公开PR只跑无secret Stub CI。用户不需购买新服务器或私有控制repo；跨host持久CAS后端的受保护GitHub App写入方案仍需独立审计与实际许可，本地模拟锁不冒充GitHub-hosted跨job持久锁，任何只靠workflow concurrency的方案不得启用。

下一步依赖：Claude #25修完所有独立P1、出准确SHA和独立ACCEPT后，GPT明确准入的固定修复版本；再由授权唯一集成人精确引入本分支，补独立反例并执行端到端Fake/Stub及全量CI。未经该步骤，源码模块可以独立审阅，整包/真实接力不能签READY或上线。

第二十八轮无耦合模块最终本地：V2 85项（Fake/CLI监管Stub/隔离Git/远端CAS协议Fake）+原V1常规37项，共122/122、0失败/跳过。远端CAS协议只在FakeAtomicRemote测试共享状态竞争、重启去重、丢提交ACK不重试；LiveGithubRefTransport禁止构造，真实跨job后端的REST源码已补齐，但运行仍OFF且未实测，不把本地或Fake远端锁当真实GitHub原子锁。V1常规37项仍未覆盖独立审计的3个P1；这些绿不能解除依赖。当前#25远端仍旧6363e8d，无可引入的审计通过SHA。


第二十八轮末补齐github-ref-backend.js：同一业务repo的专用refs/heads/feat/agent-executor-state-v2，GET当前ref/commit/tree/blob，严格白名单jobs元数据，POST状态blob/tree/单父commit，再PATCH force:false发布。FF sibling竞争只允许一个成功；不自动初始化404，不重试丢ACK写入。RemoteJobs保留key墓碑、owner_hash与单角色互斥、UTC当日假设成本上界；成功也保守计入当日上界，不把未知账单改0。state-ref必须由可信App独占写入、禁止force/delete并独立审核；管理员强制回滚不在安全保证内。LiveGithubRefTransport编译期永久OFF，当前没有调用任何GitHub写API、没有创建state分支；CAS协议仅注入Fake REST验证。未来control-plane token只供后端，不进入Agent子进程环境。

最终无耦合模块本地：V2 91项+冻结V1常规37项=128/128，通过/失败/跳过为128/0/0。专属CI和统一WIP SHA见#22最终报告。V1真实P1仍未修复/验收，不能把这些模拟通过或CI绿当作整包READY_FOR_REVIEW；仍等待#25精确新SHA和独立审计准入。


## 第三十轮：版本探测与单任务演练准备（仍为WIP）

继续保留a999e9bffec1a64e7aba5c6563df49792d95a1ea全部代码；不改V1/业务文件。
`environment.js`执行固定`--version`，无shell，进程只传PATH/LANG，限制8秒和16KiB输出；不运行login/status/config/task，不读取认证文件、不保留原始stdout/stderr，只返回数字版本、安装/失败状态。版本成功不能作为登录、费用资格或实际派工许可。`readiness()`只提供缺口清单，即使调用者声称所有检查通过也不能启用执行器；签名准入仍由cli-runner独立校验且真实入口编译期关闭。

```sh
node tools/agent-executor/runner-entry.js --probe
node tools/agent-executor/runner-entry.js --plan /tmp/bounded-rehearsal-input.json
```

`--plan`输入字段为`kind`（codex/claude）、独立`branch`、40位`sha`、非空`context`及可选`timeout_ms`/`max_tokens`/`max_model_spend`。生成1任务1执行、只读、不重试、不后台、不注册定时器的**提案**，默认30秒、128 Token、金额上限0；校验硬上界30秒/512 Token/1 USD。金额非零的提案仍不授权消费。只保存上下文摘要，不保存提示正文。输出`NOT_GRANTED_BY_PLAN`和`actual_dispatch:false`；不会运行CLI、自动创建工作区或修改GitHub。错误JSON/过大输入/无效分支及混合CLI模式拒绝，安全原因码与Gate错误分开。

第三十轮实际环境证据：Codex `--version`=0.166.0，`exec --help`支持json/sandbox/ephemeral/output-last-message参数；不等于原生Token/USD硬上限已证实。Claude CLI未安装，两种账号认证均NOT_VERIFIED，实际模型启动0、实际费用未知而非账单0。缺口为#25准确修复SHA+独立ACCEPT、最终V2独立审核、合法CLI认证、原生费用/Token硬限制及受控窗口证据。未具备这些条件时不能把Fake/Stub或版本命令当实际Codex→Claude接力。

新增探测/提案24项；本地V2 115 +冻结V1常规37=152/152、0失败/跳过。V1的37项仍不能抵销独立REJECT。专属CI仅PR/manual、contents:read，增加GitHub-hosted固定版本探测及公开安全工件（TAP和脱敏环境JSON）；无模型Secrets、真实请求或定时器。最终CI/全量业务回归和完整SHA以#22同轮报告为准。

回退：将本#22独立分支代码回到匹配检查点（保留持久幂等证据），不删除任务墓碑、不重发未知模型请求；本轮无业务schema或生产数据迁移。#25必须精确SHA经独立审计通过后才引入，不能自行接受旧Gate或改作者分支。


第三十轮业务回归证据：`npm test`在本环境继承umask=077时首轮275通过/1失败，失败是既有backup-operations-security的“chmod fake success”故障注入预期（原文件已0600，因此没有权限异常可拒绝）。保留测试和实现不变，以`umask 022; npm test`重跑276通过/0失败/跳过。该测试的umask可移植性问题未在本#22范围修复，不把首次失败隐去。admin/workspace/intake/industry四组Chromium最终均通过；industry首轮因Playwright下载浏览器不存在而未启动，指定已安装的`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`后通过。都是本地Mock模型/真实HTTP、SQLite与文件，未使用厂商模型。
