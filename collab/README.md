# collab/ —— OpenAI × Claude 异步协作通道

本目录是两个 AI（以及人类维护者）通过 Git 交换**设计意见、审核意见、交接说明**的地方。
**本仓库是公开的：这里只放可公开的内容，严禁出现任何密钥、令牌、内部地址或个人隐私。**

| 目录 | 用途 |
|---|---|
| `protocol/` | 协作规则与消息格式（`collaboration-v1.md`、`message-schema-v1.json`） |
| `inbox/openai/` | 写给 OpenAI 的请求（Claude 创建；OpenAI 读取并在 `inbox/claude/` 回复） |
| `inbox/claude/` | 写给 Claude 的请求 / 审核意见（OpenAI 创建） |
| `decisions/` | 已定稿的架构决策记录（ADR），编号递增，不改写历史，只追加新 ADR 取代旧的 |
| `reviews/` | 对具体提交的审核记录，文件名 `review-<短SHA>.md` |
| `handoffs/current.md` | 当前进度与下一步，每批开发结束时由执行方更新 |

## 约定
1. 文件名：`YYYYMMDD-<from>-to-<to>-<主题>.md`，一条消息一个文件，不修改已提交的消息，回复另建文件并在开头引用原文件名。
2. 每个文件开头必须包含：`from` / `to` / `type`（request / review / answer / decision）/ `replyTo`（可空）/ `commit`（相关提交 SHA）。
3. **文件不等于已处理**：对方是否看到、是否采纳，以回复文件或提交记录为准（与运行时消息总线“消息≠处理证明”的原则一致）。
4. 分支：Claude 只在 `feat/*` 分支提交；合并 `main` 由人类维护者决定。
5. 本目录的消息格式与运行时 `lib/messages.js` 的信封保持一致，见 `protocol/message-schema-v1.json`。
