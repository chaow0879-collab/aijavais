# #15 P2运行与验证边界

FU-01（FIXED_WITH_SOP）：既有GET /api/v2/intake/ai-draft/status为管理员只读诊断。使用已登录会话读取，不在命令行打印Cookie。tools/p2/preflight.js的diagnose可将该JSON转成只读容量警示。3槽永久挂起表示供应商可能仍计费；429是拒绝第四次派发，不应通过释放槽位、删账或重发恢复服务。

人工恢复SOP：暂停新提交；记录只读status及异常账本ledgerId/requestId/UTC/保守上界（不要提示词/密钥）；负责人另行批准停机窗口、完整备份与恢复路径；由授权运维停止唯一实例（close有界，但不证明供应商停止），确认旧进程已退出；归档完整DATA及WAL。授权启动后核对dispatching恢复interrupted_unknown、cost=null与上界保留；同ID拒绝、不重发。对照供应商账单人工核对，未经另批不修改账单或余额。生产演练NOT_RUN。Mock演练运行tests/intake-draft-cancel-lifecycle.test.js TC7-01/02/05，包含3槽、close有界和恢复；仅模拟永不settle，不能保证厂商停止。

FU-02（FIXED_TOOL / ENVIRONMENT_NOT_VERIFIED）：node tools/p2/preflight.js /explicit/isolated/path 默认只读；逐级lstat检查父链、owner、可写位、符号链接及getfacl。缺ACL工具/扩展ACL/非Linux/非受信owner/可写父链一律BLOCKED，不修改chmod、不跟随符号链接、不读取秘密。/tmp的sticky位不能替代受信父链。仅零问题输出READY_FOR_HUMAN_REVIEW，不代表生产可部署。同UID攻击者、特定生产OS/挂载/ACL实际核查仍须独立运维授权，本轮NOT_RUN。

FU-03（FIXED）：npm run test:p2在临时worker内注入5类真实生产模块语义回退（擅自批准、工具权限放大、重复请求、崩溃当未派发、提前释放容量），要求现有负面fixture确实失败；不修改磁盘生产源码、不增加生产后门。历史标题/断言计数护栏保留为辅助，npm test仍必跑。变异仅证明所选错误能被捕获，不是所有变异的完整证明。

FU-04（FIXED）：npm run test:release-industry要求独立Office解析PARSED，缺依赖/解析失败报BLOCKED并失败；普通开发模式可NOT_RUN，但summary为INCOMPLETE_NOT_RUN，不再写完整PASS。CI安装python-docx/openpyxl/python-pptx，严格模式实际导出和独立读取三行业文件，记录SHA256。缺依赖负例由tools/p2/office-gate与P2测试验证。

FU-05（DOC_ONLY）：AI-DRAFT明确#7基线缺陷已修；剩余永久不合作供应商可用性和未知费用边界仍保留。本轮无lib/public/schema改动，不修改Claude #17或QA #4文件。真实厂商、专业质量、E4/E5、生产均未验证。
