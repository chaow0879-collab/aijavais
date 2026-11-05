# NOTICE · 修改声明

本工程的大屏（`public/panel.html`）**修改自 HALOFLUX 的 `lab.html`**，管理界面（`public/admin.html`）沿用其配色风格。

> Original work: **HALOFLUX by Ryder191 (RYDER CODE / Ms MAIKEBAIs CAT)**
> Source: https://github.com/Ryder191/haloflux
> License: PolyForm Noncommercial License 1.0.0（见本目录 `LICENSE`）

这是**修改版**，不是原版。使用、分享本工程须继续遵守原作品的 `LICENSE`，并保留本声明、各文件头部的版权说明，以及大屏左下角的署名文字。

## 相对原版做了什么

| 项 | 修改 |
|---|---|
| 联动 | 新增“外部 AI 活动”状态：待机时圆环静止、画面压暗、光束与节拍减弱；外部 AI 开工后圆环转动、光束增强、节拍加快 |
| 数据 | 原版的假数据（论文 / 方法 / 参考场景等）换成真实信号：事件流、智能体、KPI、调用路由、当前动作 |
| 事件 | 新增 SSE 客户端；开工、输出、交接、完成分别触发不同的光束与闪光 |
| 演示 | 新增 `?demo=1` 模拟模式（界面会明确标注 DEMO） |
| 文案 | 标题、面板名称、说明文字改为本项目内容；氛围性画布标注为 AMBIENT / illustrative |
| 新增文件 | `server.js`、`tools/signal.js`、`public/admin.html`、启动脚本与说明 |

背景音乐 `public/audio/sw421k.mp3` 为 The Cynic Project 的 “Synthwave 421k”，CC0 协议，不受上述许可证约束。
