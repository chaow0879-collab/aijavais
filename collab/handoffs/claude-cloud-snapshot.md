# Claude 云端会话快照（WIP，仅供参考与选择性移植）

- 分支：`claude/v2-cloud-snapshot`（独立快照，**不是**集成分支；不要直接合并）
- 基于：`755fdae`（登录安全，Codex 分支 `feat/codex-v2-integration` 也基于它）
- 生成时间：2026-11-05。Codex 接力开发期间，这批代码一直只在 Claude 的云端会话里，未进入 Codex 分支。

## 包含内容（相对 755fdae）
| 提交 / 文件 | 内容 | 状态 |
|---|---|---|
| `a42a0a2` lib/db.js、lib/vault.js、lib/legacy-import.js | SQLite（node:sqlite）通用文档表、迁移、嵌套事务、在线备份；API Key AES-256-GCM 加密；旧 JSON 一次性导入并备份 | 测试通过（当时全量 83 项） |
| `0e7a916` lib/artifact-store.js、lib/extract.js、lib/diff.js | 磁盘成果库 + 版本 + SHA-256 校验 + 审核状态 + 回退；DOCX / XLSX / PPTX / PDF 按页按段提取；Myers 行级差异 | 测试通过 |
| WIP 提交 lib/llm.js | Anthropic / OpenAI 兼容两种协议的流式对话 + 工具调用 + 缓存 Token 用量 + 错误分类 | 测试通过 |
| WIP 提交 lib/tools/registry.js | 工具注册：ajv 参数校验、auto/ask/deny 策略、岗位授权、审批、硬超时 / 取消、结果裁剪、调用日志 | 测试通过 |
| WIP 提交 lib/tools/builtin.js、office.js、sandbox.js | 27 个内置工具：Word / Excel / PPT（原生图表、组织结构图、溢出检测）、PDF、LibreOffice 渲染检查、数据分析、网页读取（快照作为引用证据）与检索（Brave / Tavily / SearXNG）、代码执行、测试运行（解析通过数）、受限 Git（禁用钩子）、工作区文件 | 测试通过 |
| WIP 提交 lib/tools/mcp.js | 官方 `@modelcontextprotocol/sdk` 客户端（stdio + Streamable HTTP），默认停用、加密环境变量、不继承机密 | 测试通过（本地 fixture 服务器） |
| lib/security.js | 完整请求地址允许查询参数（修复 Anthropic 模型发现 `?limit=100` 被拒——Codex 交接中记录的已知缺陷）；可选 returnRedirects 逐跳校验 | 测试通过 |

测试：`tests/db.test.js`、`artifacts.test.js`、`llm.test.js`、`tools.test.js` 合计 15 项全部通过（最终状态下单独复跑）。**加入这些模块后未在最终状态重跑全量 `npm test`。**

## 与 Codex 集成分支的关系（接手者必读）
- 技术路线不同：本快照引入了 npm 依赖（MCP SDK、docx、exceljs、pptxgenjs、jszip、mammoth、papaparse、pdf-lib、unpdf、ajv），要求 Node ≥ 22.13；Codex 分支采用“零生产依赖、Node 24+”，并已有自己的 `project-store.js`、`project-engine.js`、`tools-v2.js`、`skills-v2.js`、`deliverables.js`。
- 两边的数据库、工具、成果实现**不能整体合并**，会出现两套并行系统。应以 Codex 集成分支为主线，按需移植本快照中 Codex 尚未实现的能力：上传文件解析（lib/extract.js）、网页读取 / 检索、代码执行与测试运行（含沙箱）、LibreOffice 渲染检查、PPT 高级版式、Anthropic 发现缺陷修复思路、官方 SDK 版 MCP（HTTP 传输）。
- 是否放弃“零依赖”原则属于架构决策：如需引入依赖，请在 docs/ARCHITECTURE.md 记录理由，并视情况提交 GPT 审核。
