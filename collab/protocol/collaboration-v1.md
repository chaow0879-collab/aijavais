# 协作协议 v1

## 三个概念（不要混用）
| 概念 | 含义 | 谁产生 | 例子 |
|---|---|---|---|
| **Task** | 用户交给平台的一件事 | 用户 / 调度器 | “设计一个协作调度方案” |
| **Message** | 智能体之间交换的结构化通信 | 智能体 / 用户 / 调度器（服务端校验） | A 给 B 的提案、B 给 A 的审核意见 |
| **Event** | 已经发生的工作事实，用于审计与可视化 | 平台观察 / 外部上报 / 演示 | model_start、handoff、task_done |

“消息创建成功”**不等于**“对方已处理”。投递由 `handoff` 事件体现；消费（`consumed`）才代表接收方开始处理。

## 消息信封（v1）
必有：`v, messageId, threadId, taskId, runId, from, to, type, round, createdAt, content, status`
可选：`spanId, replyTo, artifactRefs, metadata`

- `messageId / createdAt / status / runId` 一律由服务端生成或从任务注册信息得到，**不信任**调用方传入的值。
- `type`：`request` `question` `answer` `proposal` `review` `revision` `decision` `artifact` `system_notice`
- `status`：`created → queued → delivered → consumed`；任一未完成状态可到 `failed` / `cancelled`；终态不可再变。
- `content`：`{ format: text|markdown|json, text }`，`text ≤ 20000` 字符。
- `artifactRefs`：只能是成果 ID（`[\w.-]{1,64}`），**不得是路径**。
- 保留身份：`user` 只能发 `request`，只接收成果类消息；`scheduler` 只能发 `system_notice` / `decision`。模型不能冒充二者。

## 约束
- 默认上限：`maxRounds 3`、`maxMessages 20`、`maxQuestionsPerRound 3`；配置不能突破硬上限（10 / 100 / 10）。
- 回复只能针对**发给自己且已投递**的消息，收件方必须是原发送方；`question` 只能用 `answer` 回复；同一消息不得被同发送方同类型重复回复。
- 相同发收方、类型、线程、轮次、内容的消息视为重复，拒绝。
- 所有查询与投递以 `taskId` 为边界，跨任务不可见；任务结束后拒绝新消息与投递，未处理消息转为 `cancelled`。
- 消息只保存在内存；任务落盘只保存统计，不保存消息正文。

## 事件与消息的对应（A→B→A 流水线）
`user→A request` → A 起草 → `A→B proposal`（投递时发 `handoff`） → B 审核 → `B→A review`（回复 proposal，投递时发 `handoff`） → A 修订 → `A→user revision`。
运行时接口：`GET /api/runs/:id/messages`（仅管理员，仅内存）。

## 事件信封要点（详见 `lib/events.js`）
`eventType` 与 `status` 同时存在；带 `eventType` 的事件 `status` 由服务端派生，不一致则拒绝；旧版只带 `status` 的事件继续兼容。
`source`（server/external/demo）→ `verification`（observed/reported/simulated）由服务端决定；`tokenUsage.source`（provider/estimated/external/unknown）区分真实用量与估算。

## 第三阶段补充（兼容 v1，只增不改）

### 身份三层解耦
| 字段 | 含义 | 例子 |
|---|---|---|
| `connectionId` | 用户配置的模型连接（服务商 + 模型 + 凭证）。事件 `agentId` = connectionId，大屏按它显示 | `mc_9b553e`、迁移来的 `claude` |
| `roleId` | 岗位（来自团队或默认的 drafter / reviewer） | `writer`、`reviewer` |
| `agentInstanceId` | 本次任务里承担某岗位的实例；消息的 `from` / `to` 用它 | `ai_1a2b3c4d_writer` |

同一个连接承担多个岗位时，各岗位是不同实例，照常经过消息总线。事件新增可选字段 `agentInstanceId`、`roleId`；handoff 事件的 `metadata` 带 `toAgentInstanceId`、`toRoleId`。

### 长内容
超过 20000 字符的消息正文完整存为任务内成果（`artifactRefs` + `metadata.fullTextArtifact/chars/sha256`），消息只带预览；接收方读取成果全文，成果缺失或长度不符则任务失败。不截断。任务输入上限 200000 字符，超出直接拒绝。

### 外部上报归属
外部事件的 `owner` = 上报主体（local / admin / ingest:<名称>）。内部任务拒绝写入（403）；外部任务属于首次创建它的主体；agentId 绑定来源 + 主体。

### 可见级别
事件流按 2 / 1 / 0 级输出，字段允许列表见 `lib/access.js`。
