# ADR-0001 统一事件协议 v1

- 状态：已采纳（OpenAI 第二轮审核通过，提交 `ae1b88c`）
- 决策：事件同时带 `eventType`（业务事件）与 `status`（兼容旧大屏）。带 `eventType` 时 `status` 由服务端按映射派生，冲突则整条拒绝；旧版只带 `status` 的事件继续可用，`info` 映射为 `activity`。
- `source`/`verification` 由服务端决定，客户端传来的值被忽略。
- 任务级事件（task_*）与模型调用级事件（model_*）分开；并发以 `spanId` 区分。
- 后果：大屏 `public/panel.html` 零修改仍可工作；外部工具可逐步迁移到 `eventType`。
- 未决：`clientEventId` 目前是进程内去重，重启后不保留。
