# 当前交接（第二批完成，等待 OpenAI 复核）

分支：`feat/event-protocol-security`（未合并 main）。`public/panel.html`、`public/admin.html`、`docs/*` 与 main 零差异。

## 提交
- 51ff939 test: cover message and event integration
- 9f397dc fix: harden streaming and timeout handling
- 79cb152 feat: route A->B->A pipeline through the message bus
- adb3fff fix: isolate runtime counters and persistence
- 0fcdf8b feat: add task message envelopes
- ae1b88c feat: finalize event protocol v1
- （本提交）docs: add collaboration protocol

## 已完成
事件协议 v1 定稿；最小消息总线；A→B→A 流水线走消息总线；运行时计数按 spanId 隔离；外部/演示事件不进真实统计；token 真实值与估算分开；任务状态及时落盘并在停止时标记 interrupted；SSE 规范解析与大小/超时上限；不再打印管理令牌。

## 已知缺口
1. SSE 三级权限、INGEST_TOKEN 未做（第三批）；`/api/events` 目前对所有连接按完整级别输出，勿公网暴露。
2. AuthThrottle / RateLimiter 已写未接入。
3. 任务取消 / 重试 / 并行 / 预算未做（第四批）；因此“取消路径”测试暂无对象。
4. 真实厂商 API 未经验证（无密钥），仅用本地模拟供应商测试。
5. 消息正文超过 20000 字符会被截断（metadata.truncated）。
6. `panel.html` / `docs/index.html` 仍含旧品牌名“龙创 · 任职资格管理系统”，需在视觉阶段改为可配置（现在不能改）。

## 下一步
等待 OpenAI 复核；通过后才开始第三批。
