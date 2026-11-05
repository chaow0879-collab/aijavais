# 部署到 Render（免费版）

1. 打开 https://dashboard.render.com ，用 GitHub 登录。
2. New → Blueprint → 选仓库 `aijavais` → Apply。（`render.yaml` 已写好启动命令和环境变量。）
3. 在服务的 Environment 里填写：

| 变量 | 说明 |
|---|---|
| `ADMIN_TOKEN` | 自动生成，在 Environment 里查看，登录管理界面用 |
| `ANTHROPIC_API_KEY` + `CLAUDE_MODEL` | 要接 Claude 时填（模型名以官网为准） |
| `OPENAI_API_KEY` + `CHATGPT_MODEL` | 要接 ChatGPT 时填 |
| `MOONSHOT_API_KEY` + `KIMI_MODEL`、`DEEPSEEK_API_KEY` + `DEEPSEEK_MODEL` | 可选，自己在 Environment 里添加 |

4. 部署完成后：大屏是 `https://服务名.onrender.com/`，管理界面是 `/admin.html`，弹出令牌输入框时填 `ADMIN_TOKEN`。
5. 外部 AI 发信号：向 `https://服务名.onrender.com/api/event` 发 JSON，请求头带 `x-admin-token`。

注意：免费版约 15 分钟无访问会休眠，再打开要等十几秒；休眠或重启后在管理界面里改的配置会丢失，所以 Key 和模型名请放环境变量。大屏页面和事件流任何人知道网址都能看，但看不到 Key。
