> **WIP / BLOCKED：停止开发，未交付READY_FOR_REVIEW。** 独立CodeAudit已在#18冻结基线6363e8d复现P1 AUD-26-SCH-01（#2评论6675651482）：最终审计/QA的BLOCKED/REJECTED/缺失status仍可能被残留ACCEPT/PASS放行。本V2依赖该门禁，按#22授权立即停止受影响开发；未修改V1、未启动CI/真实Agent/定时器。Fake实现及95项本地开发测试仅作保留检查点，不是安全验收。等待GPT决定经修正的准确baseSHA及恢复授权。

# 自动执行器V2：离线Fake/Stub开发包（#22）

## ADR-22-01：不接入真实执行器

基线为V1精确SHA 6363e8d10595a566a1ba266cb70017711cc806be，独立分支feat/codex-v2-autoexec-v2-stub、独立checkout；V1尚无独立CodeAudit ACCEPT。本包不修改tools/agent-scheduler或业务代码，不把V1作者测试当独立审计。当前业务Claude #17=1bf1aef3fb02f5a4fa40507435dd5b05b023207e、Codex #15=c088076425256f52a26aab4e5272a5b1f72402a4；业务#23集成候选尚未核验，不凭两支CI绿推断集成通过。

选择：当前只用不可替换的内存Fake适配器；不存在执行真实CLI/SDK/云任务的代码路径。cli/sdk/cloud_approved只是预留后端枚举，都会返回真实接入BLOCKED_CREDENTIALS，不能因二进制存在推断登录、套餐、费用、条款或可执行资格。环境清单仅查找PATH中可执行文件是否存在，不执行--version/登录检查、不读cookie/凭据文件或输出token。

候选托管A：GitHub-hosted短生命周期门禁+独立runner，需GitHub App只读/写入两种独立短期身份与额外服务账单批准。候选B：隔离非生产开发runner上的官方受支持登录CLI，需持续运行、安全守护、资源/网络和额度控制。当前均NOT_CONFIGURED/NOT_RUN；不能把网页会话当后台可唤醒API。Codex/Claude本身也可能收费，不能仅批准产品被测API而默认批准开发Agent服务费用。

配置所有*_ENABLED=false、dry_run=true、stage=DRY_RUN，cron/webhook也false。events.example.json仅禁用的数据样例，不注册任何事件/cron；专属CI仅manual/PR。修改配置或环境变量试图打开真实开关会被代码拒绝；本构建永远actual_dispatch=false。不存在自动启用或真实dispatch实现。

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

默认仅DISABLED与脱敏清单。当前开发环境Node v24.22.1/Linux：Codex可执行文件在PATH中、Claude未找到；这仅是fs元数据，未执行CLI、未验证账号/额度/条款/登录，两者实际接入均BLOCKED_CREDENTIALS，runner NOT_CONFIGURED，V1 audit NOT_VERIFIED。--fake-demo创建隔离临时模拟目录、假许可及Fake SUCCESS，明确fake_only/actual_dispatch=false/actual_launches=0；不是实际任务完成。

## 管理员一屏未来启用指南（本轮只说明，不操作）

1. 负责人先选择A短生命周期GitHub-hosted+独立执行runner，或B非生产隔离开发runner；不得用生产AIJAVAIS/Caddy/S-UI主机。确认Linux/ACL、CPU/内存、默认无网/网络白名单、隔离工作区/分支、日志加密保留与删除政策。当前不安装runner/service/daemon/webhook。
2. 在未来另获批准后，GitHub Settings → Developer settings创建仓库专属App；只读身份issues/contents/actions/pull_requests:read；另一个短期执行身份才可对指定Issue/开发分支写入，main与保护设置禁止。App通常不能仅靠token scope限制单Issue/分支，必须结合服务端白名单、环境审批与分支保护，不能宣称仅App权限已完成隔离。
3. GitHub Settings → Secrets and variables → Actions / Environments：未来为已批准环境配置短期凭据及required reviewers；本轮不写Secrets、不复制网页登录Cookie/生产SSH，不创建默认分支schedule。账号计划、计费方式、条款与任务/每日Token和金额上限由负责人逐项确认，不能假定订阅免费。
4. 运行身份/allowed_issues/allowed_branches/permitted_roles/approved_scope/approval_version/精确SHA与上下文摘要/期限/任务和每日限额须完整签署并绑定可信公钥。审计只读、QA只写测试资产、开发仅独占分支；未来还需真实沙箱文件/网络权限验证，本Fake实现不模拟为真实OS强制隔离证据。
5. DRY_RUN→ARMED_READ_ONLY→AUTHORIZED_DISPATCH→AUDITED_RUNNING只允许相邻步骤；先分别完成精确V1独立ACCEPT、V2独立安全验收、负责人对地点/凭据/费用并发/角色及窗口的另批。previewEnablement只返回假设，实际阶段始终DRY_RUN。本构建即使三项许可字段为true仍不能启动真实Agent，必须另行开发/审计真实接入，不能通过改开关绕过。
6. 未来停止/回退：负责人停用独立环境与App短期授权，停止独立runner，保存失效lease/任务状态/脱敏审计与未知费用证据，核对供应商账单；不重放未知作业、不删除幂等键、不恢复历史夜间automation。代码回退到匹配快照版本并保留本地执行幂等记录；生产/main/付费/外部MCP始终另走人工门禁。

## 验证口径

本地V2 58项+原V1 37项=95/95通过；包括完整Fake集成→独立审计→QA轨道、两种执行器及3种Stub后端、真实4子进程争锁、SIGKILL Fake worker后保守恢复、预算/签名/凭据/分支/修订/CI故障、状态持久写入失败、运行中防重复及停止开关。测试曾发现夹具重签许可未真正传入，已修正闭包并复核，未删断言。实际模型/Claude/Codex/云任务启动0；计时/用量/服务费用均模拟，不是供应商或生产验证。独立专属CI及最终40位SHA见Issue #22。
