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

## 当前检查点结果

集成基线80项通过；随后完整149项通过。追加工具扩展和最后连接试连并发回归后，最终 `npm test` **155项全部通过，0失败，0跳过**。中途一个防伪工具断言误选了默认流程不要求的slide_render，已改成该流程实际要求的chart_generation，没有关闭断言或放宽能力门禁。

管理员浏览器测试最终通过：0 JS/额外资源错误、无移动端横向溢出、模型替换有效；预期付费门槛HTTP402被实际触发。V2浏览器最终通过：项目创建、校验、两次Mock模型调用、文本XSS安全、人工审核、真实DOCX下载/持久化、向导草案保存；未执行收费API。

当前云本地日志位于 `/workspace/scratch/v2-*-tests.log`，办公证据位于 `/workspace/scratch/v2-office-evidence/`。这些是当前机器临时证据，不保证GitHub或新任务恢复；可重复的测试脚本已提交。数据库/凭据/运行截图不提交。

下一开发者应在自己的接力分支重新运行完整测试及两个浏览器测试，再申请有预算授权的真实API/MCP端到端验收。GitHub Actions是否通过须查远程结果，不能因工作流文件存在便声称通过。
