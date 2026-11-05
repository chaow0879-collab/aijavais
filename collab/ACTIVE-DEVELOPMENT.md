# 当前授权：第十轮 #6 + #8 联合P1整改

唯一开发/集成：Codex；Claude授权已撤销且待命。分支 `feat/codex-v2-p1-ledger-recovery`，起始SHA `b71faaa65bb66e04ea2a015c9238a3a129bdb68e`。开工确认新分支精确HEAD、工作区干净；原Codex旧分支未写入。授权来源：Issue #10最新第十轮与#6评论6660869089。

先提交[设计、迁移与回滚](../docs/LEDGER-RECOVERY.md)，再实施schema v4、持久幂等/事务预留/恢复、管理员只读异常查询与Mock/SQLite/浏览器/CI验证。范围：lib/project-store.js、lib/intake-draft.js、lib/v2-api.js、必要的能力中心警示、对应测试、CI新分支触发及文档。其他核心预算/认证/模型文件优先不改。内部辅助仅分配隔离文件或只读检查；不代表独立审计。

#7/#9仍未授权。禁止真实收费API、main合并、生产迁移/部署、服务器/Caddy/S-UI改动、人工改余额接口。最终双Issue统一完整SHA READY_FOR_REVIEW后停写，等待#2独立审核；不得自行关闭Issue。
