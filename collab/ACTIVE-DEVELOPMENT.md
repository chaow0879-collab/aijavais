# 当前活跃开发（单写入者登记）

> 同一时间只有一位开发者写同一分支。开始写入前更新本文件并推送；交接或暂停时同步更新本文件与 `collab/HANDOFF.md`。

| 项目 | 内容 |
|---|---|
| 当前开发者 | Claude Code（云端会话） |
| 开发分支 | `feat/claude-v2-followup` |
| 基线提交 | `29630a28bad51e6adabec83abdef46821e4ebe79`（Codex 最终交接文档提交；完整代码检查点 `3623247266c29284ce86828c9da8b586ac7b22ae`） |
| 已停止写入 | `feat/codex-v2-integration`（Codex，2026-11-05 核实最新提交仍为 `29630a2`） |
| 只读参考 | `claude/v2-cloud-snapshot` @ `2bcc726`（npm 依赖路线的 WIP 快照，禁止整体合并，只做选择性零依赖移植） |
| 不触碰 | `main`（`adb4d02`）、`feat/event-protocol-security`（`755fdae`）、`feat/project-intake-guidance-openai`（`0f833df`） |
| 更新时间 | 2026-11-05（持续更新） |

## 正在做什么

负责人已正式授权 Claude Code 为唯一主开发（兼部署）工程师，持续开发。已完成单元（均已推送，CI 绿色以 GitHub Actions 实际结果为准）：

| 提交 | 单元 | 验证 |
|---|---|---|
| `ea98edf` | 浏览器测试收尾竞态 + UTF-8 下载文件名；CI 拆分步骤 | 本地连跑 3/3；远端 CI 绿 |
| `b5aaa46` | Anthropic 模型发现 `?limit=100` 被 URL 策略拒绝的缺陷 | 本地协议 fixture + 单元矩阵；CI 绿 |
| `14defcf` | 去职业偏向（大屏品牌、示例、占位符、模板排序）+ 5 个通用团队模板 | 防回归测试 |
| `9144298` | 项目资料：上传/解析（DOCX/XLSX/PPTX/文本/PDF）/持久化/交给岗位；SQLite v2 迁移 | 外部工具生成的真实文件；CI 含 pdftotext、容器镜像 |
| `8164618` | 工作台「项目资料」卡片 | 浏览器上传真实 DOCX→预览→进入模型 prompt |
| `b162ef6` / `97d121b` | 能力中心 + 系统就绪检查（API + 页面 /capabilities.html） | 单元 + HTTP + 浏览器 |
| `ffe4240` `88e2757` | 数据分析、SVG 图表、Office→PDF 与渲染检查 | 单元 + HTTP；CI 含 LibreOffice |
| `0ec6b0c` `6bea920` | MCP 管理中心（远程 HTTP、启停、测试、日志）| HTTP fixture + 浏览器 |
| `364275b` `a3829f4` | 立项实时工具检查；用户指南、并行部署手册、文档更新 | 浏览器 |

下一步：见 `collab/HANDOFF.md`「尚未完成」。

部署：负责人尚未提供服务器访问。**在确认现有环境前不触碰第一代服务、代码、数据库、反向代理。**

## 规则提醒

- 不强推、不改写他人提交、不合并 `main`；未经负责人批准不调用收费 API、不公开部署。
- 每个可验证单元单独提交、推送，并更新本文件与 `collab/HANDOFF.md`。
- Mock / 协议 fixture / 真实文件 / 真实 API 分开报告；未验证不称完成。
