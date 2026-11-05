# AIJAVAIS V2.0 开发计划与进度（Claude 执行用，随开发更新）

基准：`51dc5fc`（第三阶段）。授权：一次性完整集成开发，开发期间不等待逐段审核；整体集成测试完成前不合并 main。

## 技术决策
| 层 | 选择 | 理由 |
|---|---|---|
| 后端 | Node.js（CommonJS，模块化 lib/）| 现有代码已测试，迁移 TS 无功能收益且有风险；Node 22.18+ 原生支持类型剥离，后续可逐模块迁移 |
| 数据库 | SQLite（Node 内置 `node:sqlite`，WAL）| 零原生依赖、单文件、适合个人部署；数据层用“键列 + JSON 文档列”，保留 MySQL 适配可能 |
| 凭证 | AES-256-GCM 加密（密钥：`AIJ_MASTER_KEY` 或 data/master.key 0600）| 数据库或备份单独泄露时不暴露 API Key |
| 文件 | 磁盘 Artifact Store（data/artifacts/<task>/<artifact>/v<n>）+ 数据库索引 | 重启不丢、版本、SHA-256、审核状态 |
| Office | docx / exceljs / pptxgenjs（纯 JS，生成真实可编辑文件）；读取 mammoth / jszip / exceljs；渲染检查 LibreOffice + pdftoppm（有则用，无则明确不可用）| |
| MCP | 官方 `@modelcontextprotocol/sdk` 客户端（stdio / Streamable HTTP）| |
| 前端 | Vue 3 + TypeScript + Vite（web/ → 构建到 public/app/）| 工作台复杂度需要组件化；HALOFLUX panel.html 不改 |
| 执行引擎 | 进程内异步调度器 + 工具在子进程中执行（超时、资源限制、工作目录隔离）| 模型调用是 I/O 密集；CPU / 危险操作隔离到子进程 |

## 模块清单与状态
- [x] 登录安全（lib/auth.js，755fdae）
- [ ] 数据库与迁移（lib/db.js、lib/vault.js、旧 JSON → SQLite，迁移前自动备份）
- [ ] 持久化 Artifact Store（版本、哈希、审核状态、差异、下载鉴权）
- [ ] 模型适配器：工具调用（Anthropic / OpenAI 兼容），缓存 Token 统计
- [ ] Tool Registry + 内置工具 + 权限审批 + 调用日志；MCP 客户端
- [ ] Skills Registry / Runner / Validator + 内置 Skills
- [ ] 岗位体系（9 个内置岗位）+ 团队导入导出复制 + 旗舰团队
- [ ] 执行引擎：计划 → 步骤图 → 岗位实例 → 工具循环 → 消息 → 审核返工 → 质量门 → 交付；并行、重试、超时、暂停、取消、故障切换、人工确认、恢复、预算
- [ ] Cost & Token Ledger + 预算执行 + 付费审批（服务端）
- [ ] 免费模型接入中心（官方链接核实、更新机制）+ 推荐模式
- [ ] Vue 3 工作台（首页 / 团队 / 模型 / Skills / 任务工作台 / 成果中心 / 设置）+ 工作流可视化
- [ ] 部署：Dockerfile、docker-compose（Caddy HTTPS）、.env.example、备份恢复、健康检查、升级
- [ ] 测试：单元、集成、E2E、迁移、安全、工具、文件交接、通信、预算、恢复、并行隔离、真实文件、视觉兼容
- [ ] 验收 A–H 记录（模拟模型驱动 + 真实工具 / 真实文件；真实厂商 API 需用户密钥联调）
- [ ] 完成报告

## 原则（每次提交前自查）
1. 不用模拟事件冒充执行；模拟模型只用于测试并明确标注。
2. 模型说“完成”不算完成：步骤以客观验收检查（文件存在且可打开、测试通过、审核通过、证据齐全）为准。
3. 未批准不调用付费 / 费用未知模型；检查在服务端。
4. 第三方 MCP / Skills 默认无全盘文件与任意命令权限。
5. 不删除失败测试；HALOFLUX panel.html 不改。
