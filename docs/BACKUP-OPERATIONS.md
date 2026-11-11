# SQLite 备份运维与只读盘点（#14 包四 / #2 AUD-68-FU-01/02/03）

本页只描述**开发者自测过的行为与人工运维步骤**。没有任何自动删除、自动回滚或自动“认定可恢复”。真实生产操作（清理、恢复、迁移）需负责人另行批准。

## 1. 已修复：操作员备份的权限窗口与覆盖竞态（AUD-68-FU-03 扩展）

- **可达性（代码级证据）**：`ProjectStore.backup(target)` 在 `server.js`/`lib/v2-api.js` 中无调用者，但运维命令 `npm run db:backup -- <新文件>`（`tools/database.js`，README/DEPLOYMENT/USER-GUIDE 与就绪检查都推荐使用）使用**同一模式**：先 `sqlite.backup()` 写目标、再 `chmod 0600`。备份是整个 `projects.sqlite`（项目说明、上传资料原文与提取文字、运行输出、系统用量账本），属于敏感数据。
- **复现**：`tests/backup-operations-security.test.js` 第一项：umask 022、已存在 0755 目录时，旧模式写出的文件在 chmod 前为 **0644**（同机其他用户可读）。另有 `existsSync()`→写入之间若他人创建同名文件，SQLite backup 会覆盖它。
- **整改**：`lib/private-backup.js publishPrivateBackup()`（两处共用；**迁移备份 `migrationBackup()` 未改动**）：同目录 `mkdtemp(.private-backup-*)`（创建即 0700，并校验属主/模式）→ 在其中写备份 → `chmod 0600` + `lstat` 复核（chmod“假成功”失败关闭）→ `immutable=1` 只读 `PRAGMA quick_check` → `link()` 原子发布（EEXIST 绝不覆盖；同目录无 EXDEV）→ 移除自身暂存名。失败时目标不出现；因源库未被修改，自身暂存副本可安全移除。
- **故障矩阵（均为临时目录 + 真实 SQLite）**：已存在文件/符号链接/活动库路径、写入期间目标被并发创建、chmod EPERM、chmod 假成功、暂存目录非 0700（写入前拒绝）、EXDEV、ENOSPC、损坏副本（quick_check 失败不发布）、CLI 在 umask 022 + 0755 目录下发布 0600 且二次执行不覆盖。
- **信任边界（未改变，AUD-68-FU-02）**：目标父目录不得可被不可信用户写；同 UID 恶意进程、可被敌手写的父目录、ACL/非 POSIX 文件系统不在保证范围内。备份继承 WAL 模式：用普通连接打开会生成 `-wal/-shm`，请在私有目录内操作或用 `file:...?immutable=1` 只读打开。

## 2. 只读盘点 `.migration-backup-*` 等遗留物（AUD-68-FU-01）

```
npm run db:backup-inventory              # 默认 AIJ_DATA_DIR 或 ./data
node tools/backup-inventory.js /path/to/DATA --json
```

- 盘点对象：`.migration-backup-*`（迁移中断的私有暂存）、`.private-backup-*`（操作员备份中断的暂存）、`projects.sqlite.pre-vN-<毫秒>.bak`（已发布迁移备份）。
- 每项输出：类型、模式/属主（是否当前用户）、大小、时间、是否符号链接、SQLite 头（`user_version`）、`quick_check`、暂存副本是否与某个已发布 `.bak` 为同一 inode（`published`）、目录剩余字节与磁盘可用空间。
- **只读保证（有测试）**：不跟随符号链接（`lstat`，`O_NOFOLLOW`）；只对属于当前用户的普通文件用 `immutable=1` 只读连接做 `quick_check`，不产生 `-wal/-shm`；测试前后对目录做递归快照（名称/模式/大小/mtime/inode/sha256）完全一致；没有 `--delete/--restore` 等选项，未知选项直接拒绝。
- **退出码（失败关闭）**：0 = 已扫描且无需关注；2 = 已扫描，有需关注项；1 = 无法扫描（DATA 不存在/不是目录/读取错误）——不会给出部分“全部正常”。
- **解读**：`recoveryUse` 恒为 `manual_review_required`。`quick_check ok` 不证明副本完整或可用于恢复；`published:false` 的暂存副本可能来自 VACUUM 中途崩溃，绝不能未经人工核对就用于恢复。ACL 不检查（`aclChecked:false`）。

## 3. 人工处置建议（需另批，工具不执行）

1. 停止服务或确认无迁移进行中；对整个 DATA 目录做私有完整备份。
2. 运行盘点 `--json` 并保存输出；核对每个遗留物的 `user_version`、时间、`published` 与 `quick_check`。
3. 若某暂存副本 `published` 指向已发布 `.bak`：两者同一 inode，删除暂存名不影响已发布备份。
4. 若 `published:false`：与当前库/已发布备份比对后，由负责人决定保留或在私有位置归档；不要直接恢复。
5. 磁盘空间：关注 `leftoverBytes` 与 `disk.freeBytes`；反复启动失败会累积遗留物。

## 4. 测试入口

`node --test tests/backup-operations-security.test.js`（已纳入 `npm test`），并与原有 `tests/migration-backup-security.test.js`（#6/#8 已审计）共同运行。
