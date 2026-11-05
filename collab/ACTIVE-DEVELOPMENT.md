# 当前授权：第十三/十四轮 AUD-68-SEC-01 最小返工

唯一写入者Codex；分支`feat/codex-v2-p1-ledger-recovery`；精确返工基线`c4d0a8c53a54453535125b3ade5cef91a4801a11`。开工本地/远端HEAD一致且干净。

原候选独立审计REJECT，唯一P1是迁移备份初始0644权限窗口。本轮仅修改lib/project-store.js的备份创建/发布流程、必要回归与说明；不重构持久幂等/账本状态机，不改ProjectEngine或#7/#9。

安全边界：写入前0700私有临时目录，0600文件校验后hardlink原子无覆盖发布，失败保留受保护证据；不改变全局umask。原Schema版本仍v4。无真实收费API、main/生产DB/服务器/Caddy/S-UI操作。

本地验证已完成：安全新增10/10，原相关40/40，全量248/248，草案Chromium通过；CI及新完整SHA以双Issue最终报告为准。交付同一新40位SHA到#6/#8 READY_FOR_REVIEW后停写。只有负责人明确“开始审计”后GPT才复审；不自动触发审计/移交Claude。详细设计与失败处置见docs/LEDGER-RECOVERY.md。

---

以下是原联合整改的历史记录，本轮范围以上述最小返工为准。

# 当前授权：第十轮 #6 + #8 联合P1整改

唯一开发/集成：Codex；Claude授权已撤销且待命。分支 `feat/codex-v2-p1-ledger-recovery`，起始SHA `b71faaa65bb66e04ea2a015c9238a3a129bdb68e`。开工确认新分支精确HEAD、工作区干净；原Codex旧分支未写入。授权来源：Issue #10最新第十轮与#6评论6660869089。

先提交[设计、迁移与回滚](../docs/LEDGER-RECOVERY.md)，再实施schema v4、持久幂等/事务预留/恢复、管理员只读异常查询与Mock/SQLite/浏览器/CI验证。范围：lib/project-store.js、lib/intake-draft.js、lib/v2-api.js、必要的能力中心警示、对应测试、CI新分支触发及文档。其他核心预算/认证/模型文件优先不改。内部辅助仅分配隔离文件或只读检查；不代表独立审计。

#7/#9仍未授权。禁止真实收费API、main合并、生产迁移/部署、服务器/Caddy/S-UI改动、人工改余额接口。最终双Issue统一完整SHA READY_FOR_REVIEW后停写，等待#2独立审核；不得自行关闭Issue。


实施检查点：设计36e2c7a96cd107e9b88ed74eae1abaee758a75f1；事务实现84dfd8ddd8cf06aaeb4bcf78857b79bf1e946191。schema v4与只读API/能力中心警示已实现，最终代码本地238/238，0失败/跳过，三个Chromium脚本通过。CI最终状态/最终40位候选SHA以#6/#8交付评论为准；当前正收尾CI与报告，交付后停写等待独立审计，不启动#7/#9。
