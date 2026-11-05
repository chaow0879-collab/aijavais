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
| 更新时间 | 2026-11-05 |

## 正在做什么

**接手核查阶段（不改功能代码）。** 已完成：远端分支/SHA 核对、文档与核心模块阅读、快照分支对照、测试复跑。本轮唯一提交即本文件。

等待负责人发送 GPT《开发总协议》后开始第一个开发单元；`docs/ACCEPTANCE.md` 将按该协议的验收口径创建。

## 接手时实测（Node v24.22.1，本容器）

- `npm test`：155 项，155 通过，0 失败，0 跳过，0 取消。
- `npm run test:ui`：走查断言全部通过，但退出码不稳定（3 次中 2 次因测试收尾 `rmSync` 与服务端退出写盘竞争报 `ENOTEMPTY` 而返回 1）。GitHub Actions 同一原因失败（run 42009783428）。
- `npm run test:workspace`：`LANG=C.UTF-8` 下通过；容器默认未设置 `LANG` 时，Chromium 把中文下载文件名退化为 `download`，导致断言失败（环境问题，已用独立脚本复现）。远端 CI 因上一条命令失败未执行此测试。
- 均为本地 Mock 模型 / 本地 MCP fixture；未调用任何收费 API。

## 规则提醒

- 不强推、不改写他人提交、不合并 `main`；未经负责人批准不调用收费 API、不公开部署。
- 每个可验证单元单独提交、推送，并更新本文件与 `collab/HANDOFF.md`。
- Mock / 协议 fixture / 真实文件 / 真实 API 分开报告；未验证不称完成。
