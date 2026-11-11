# 开发指南

## 本地工作

使用 Node 24+，仓库无生产依赖：

```sh
node --version
npm start
```

默认监听本机 8787。首次运行自动建立私有 DATA、一次性设置码和 SQLite schema v1。使用设置码在登录页设密码；不要重置已有管理员。`AIJ_DATA_DIR=/secure/path` 可隔离开发实例。`GET /healthz` 检查进程；项目 API 需要会话，401 不表示服务未就绪。

工作台 `/workspace.html` 支持岗位/步骤、模型选择、工具、Skills、预算及审核。模型和团队管理仍在 `/admin.html`；六步立项向导保存草案后进入工作台。原向导的保守能力和工具门槛保留，不通过伪造 verified 字段宣称专业能力。

## 分支与集成

这次在 `feat/codex-v2-integration` 合并：

- main: `adb4d02306af7c0be4d5491f996279877354e308`
- event/security: `755fdae70c776730efddd323e954fc111bb9f143`
- intake/OpenAI: `0f833dfa36d54b6fcac9adc2e6a239039dd6f43e`

使用真实 git merge 保留历史，没有用旧文件覆盖新功能，没有合并 main。接力从核对过的交付提交新建独立分支，禁止两名开发者同时写同一分支。修改前检查状态和来源分支是否又有新增提交。

## 添加能力

- **模型服务商**：`catalog/providers.v1.json` 定义兼容协议/地址；新增协议必须改适配器并测试。不要把网页会员当 API 额度。注册和试连不能证明专业能力。
- **岗位/团队**：数据方式添加岗位；项目角色独立于品牌。`requiredCapabilities` 目前比对用户声明标签，文档和 UI 必须说明未专业实测。
- **Skill**：POST `/api/v2/skills`，使用 `{skillId,name,version,steps}`。steps 只能 prompt、tool、check；修改已有内容必须增加语义版本。持久化失败不能改变内存状态。
- **工具**：内置注册在 `lib/tools-v2.js`，输入/输出有限制，实际调用需 `allowedTools` 精确授权。新工具必须有成功/失败/未授权/取消测试。不要把 shell 命令放进项目 JSON。
- **MCP**：通过本地受信 `AIJ_MCP_SERVERS_FILE` 配置；示例见 DEPLOYMENT。发现和调用是显式操作，模型不能注册程序。
- **交付格式**：`createDeliverable(format, options)` 返回 `{buffer,mime,extension,filename}`；生成后应独立解析 ZIP/XML，必要时 LibreOffice 渲染。格式正确不代表内容审核通过。
- **API**：V2 路由保持管理员门禁后；POST/PUT 对象经过规范化，乐观版本更新返回409。不要从客户端接收 owner、执行状态或历史账单作为可信状态。

## 费用与真实执行

开发测试用本地模型 fixture 和隔离临时数据，不会调用真实供应商。真实调用需要负责人明确批准。远程连接试连也可能收费：单独确认，一次最多32输出token；旧任务接口只保留显式本地目标，远程任务使用 V2 的价格/预算/Token 预留。模型输出、实际工具结果、生成文件和人工质量结论分别记录。

返工会重新执行整个有限流程，不是从任意中间断点恢复。重启不自动重试，避免重复收费和副作用。更新目标后，旧审批快照不再允许下一步调用。

## 数据与代码规范

CommonJS、Node 标准库，生产不引入不必要依赖。保持原事件/消息协议和许可证。用户输入在 UI 使用 textContent 或显式转义；文件名/ZIP路径须校验。上限超出应明确失败，不截断关键信息后继续。

数据库结构变更先备份、新增迁移版本，再测旧版本升级及恢复。SQLite 后续版本不能由旧代码静默打开。全部私有 DATA 和临时截图不提交；提交前 `git diff --check`、`git status --short`。不要删除原断言让新代码“通过”。
