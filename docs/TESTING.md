# 测试方法与证据

需要 Node 24+。生产无第三方 npm 依赖。统一入口 `npm test` 引入全部旧测试及立项、代理、SQLite执行、工具、Skills、文件、V2 HTTP和认证并发测试。不得用零子测试的 exit 0 冒充验证；受限云环境可能需要支持的执行权限才能真实开启本地socket/子进程。

```sh
npm test
npm run test:ui
npm run test:workspace
```

浏览器测试额外需要 Playwright 和 Chromium。当前云环境已有 Playwright、`/usr/bin/chromium`；也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定。CI在临时目录安装固定版本，不增加生产依赖。测试隔离临时 DATA，不读取真实业务数据库或调用收费模型。

## 验证类别必须分开

- **真实厂商 API：未执行**。无授权收费调用，不编造免费额度或专业能力。
- **模型 Mock：实际本地 HTTP/SSE fixture 与内存适配器**。验证多岗位调度、真实输入交接、计数/费用状态机、取消、失败与恢复，不证明厂商可用。
- **MCP：真实 stdio 子进程 JSON-RPC，对端为本地协议 fixture**。不是第三方生产MCP验收。内置工具及文档工具是真实代码执行。
- **持久化：真实 SQLite/WAL/备份/重启/锁/文件BLOB与SHA256**，不是存储Mock。
- **文件：真实DOCX/XLSX/PPTX/代码ZIP**，ZIP CRC/XML/关系独立验证；当前环境还用python-docx/openpyxl/python-pptx读取及LibreOfficeDev26.8导出PDF。未人工逐页审稿。
- **浏览器：真实Chromium、登录会话、模型/团队管理及V2保存/运行/审核/DOCX下载/XSS检查**；模型仍是本地Mock。
- **部署：真实Docker构建/非root/健康/持久卷重启**，Caddy配置校验；未执行公网ACME、Render部署或完整故障灾备恢复。

## 当前检查点结果（2026-11-05，Claude Code 接力）

本地（Node v24.22.1，含 poppler 24.02、LibreOffice 24.2、python-docx/openpyxl/python-pptx）：`npm test` **182 项全部通过，0 失败，0 跳过**；`npm run test:ui` 与 `npm run test:workspace` 通过（修复收尾竞态后连跑多次稳定）。GitHub Actions：`tests`、`browser`、`container` 三个任务以远程实际结果为准；CI 已安装 poppler、LibreOffice 与固定版本的 Python 解析器，使相关测试真实运行而不是跳过。缺少可选程序的环境中，渲染相关测试会显示为 **skipped** 并注明原因，不计为通过。

新增验证类别：

- **真实外部生成文件**：`tests/fixtures/files/` 中的 DOCX/XLSX/PPTX 由 python-docx、openpyxl、python-pptx 生成，PDF 由 LibreOffice 生成（生成脚本 `tests/fixtures/make-office-fixtures.py`），不是用本项目自己的写入器生成。
- **恶意/异常输入**：扩展名与内容不符、加密 ZIP、CRC 错误、DTD、压缩炸弹、截断文件、非 UTF-8、超限。
- **MCP HTTP**：本地 Streamable HTTP 协议 fixture（令牌、会话 ID、SSE 响应），不是第三方生产服务。
- **数据分析**：样本标准差与 Python `statistics.stdev` 交叉核对。
- **浏览器**：上传真实 DOCX→预览→进入模型 prompt；能力中心三个标签页；网页添加远程 MCP、测试、调用、日志；立项向导服务端工具检查。

仍未执行：真实收费厂商 API、第三方生产 MCP、公网部署与灾备恢复演练。
