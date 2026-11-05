# AIJAVAIS V2.0 独立部署

本项目当前是**单管理员、单应用进程**部署：Node.js 24 内置 SQLite，账号/模型/团队等既有配置仍保存为 JSON。应用没有第三方运行时依赖，不需要 `npm install`。SQLite 文件与 JSON 必须一起持久保存，不能只保存代码或只备份数据库。

## 本地开发

在仓库根目录使用 Node.js 24 或更高版本：

```sh
node --version
npm start
```

默认监听本机 `127.0.0.1:8787`。首次运行会生成一次性设置码，仅在服务器可信终端查看；不要把设置码、API Key、Cookie 或数据目录内容贴入聊天/工单。打开登录页，使用设置码设置管理员密码。`ADMIN_TOKEN` 已废弃，不能用旧版管理令牌替代密码登录。

独立数据目录可通过 `AIJ_DATA_DIR=/absolute/private/path npm start` 指定。不要在不同进程中共享同一个数据目录运行多个实例；这不是多节点集群。

## Docker Compose + Caddy HTTPS

仓库提供 `Dockerfile`、`compose.yaml` 和 `Caddyfile`：

- 应用使用 Node 24、UID 1000、只读根文件系统；可写数据放在 `/data` 持久卷，临时文件放在 `/tmp`。
- 应用不发布任何主机端口；只有 Caddy 监听 80/443。`TRUST_PROXY=1` 只能用于可信反向代理之后，禁止把应用的 8787 端口直接暴露到公网。
- Caddy 覆盖转发来源与协议头，自动申请和续期 HTTPS 证书，支持 SSE。
- `/healthz` 是只返回 `{ "ok": true }` 的公开存活检查，不授予登录态、模型调用权限或数据访问。其他生产请求仍需 HTTPS。
- 模型调用默认需要明确的执行/预算授权；部署不会自动调用收费 API。

先准备自己的域名和服务器，将域名的 DNS 指向服务器并允许 80/443 入站。以下命令会开始实际部署和证书申请，应由部署负责人在获准的服务器上运行；本次开发未执行公网部署。

```sh
export AIJAVAIS_DOMAIN=aijavais.your-domain.example
docker compose config --quiet
docker compose build app
docker compose up -d
docker compose ps
```

将实际域名保存在部署目录的私有 `.env` 或服务管理器配置中，确保重启后仍存在。不要直接使用文档中的示例域名申请证书。Caddy 证书状态保存在 `caddy_data` 卷。

首次设置码只在可信服务器终端中查看：

```sh
docker compose exec app cat /data/setup-code.txt
```

设置管理员密码后，该一次性设置码不再可用。登录、Cookie、模型配置、SSE、大屏和成果下载均通过自己的 HTTPS 域名访问。健康检查可用：

```sh
curl --fail --silent --show-error https://YOUR_ACTUAL_DOMAIN/healthz
docker compose exec app npm run db:info
```

应用健康为 `healthy` 只说明应用响应 `/healthz`；它不能证明某个外部模型/工具、DNS、证书续期或收费额度可用。

### 反向代理和凭据

生产模式必须配置 `AIJ_ENV=production`，并使用直接 TLS 或 `TRUST_PROXY=1` 的可信 HTTPS 反向代理。Compose 已配置后者。Caddy、Render 等入口必须覆盖客户端伪造的 `X-Forwarded-Proto` / `X-Forwarded-For`。不要把“信任代理”当成可以公开 HTTP 后台的理由。

可通过登录后的模型注册中心配置连接。模型 Key 与公开模型注册信息分开保存，Key 所在的 `/data/credentials.json` 权限为 0600。也可按服务器环境变量绑定凭据，但不要把密钥写进 Dockerfile、Compose、镜像层、Git 或说明文件。网络代理与 CA 信任配置必须通过部署环境注入，不能关闭 TLS 验证。

本地模型必须通过 `LOCAL_MODEL_TARGETS` 显式授权目标。容器中的 `localhost` 指的是应用容器，不是宿主机；不要为方便调用本地模型而使用 host 网络或关闭 SSRF 检查。外部 MCP 服务器也只能通过运维人员控制的服务器白名单文件注册；本镜像不附带任意第三方 MCP 服务二进制，需要额外运行时的工具应使用经过审核的扩展镜像。

## 数据库、迁移、备份与回滚

SQLite 数据库为 `/data/projects.sqlite`，使用版本化迁移。首次启动/升级由应用迁移新库；原有模型、团队、登录 JSON 不被静默导入或丢弃。迁移细节与表结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

### 在线一致性 SQLite 备份

本地开发可在正确的 `AIJ_DATA_DIR` 环境下执行：

```sh
npm run db:info
npm run db:backup -- /secure/new-backup.sqlite
```

`db:backup` 通过只读连接与 SQLite 原生 backup API 创建一致性备份，并验证 `quick_check`。目标必须是不存在的新文件；它不会覆盖旧备份，也不会创建执行引擎或把运行中的任务误判为中断。示例目录需换成有权限的私有目录。

容器中可将 SQLite 备份先写入卷内，再复制到独立的私有备份位置：

```sh
backup_name="projects-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
docker compose exec -T app node tools/database.js backup "/data/backups/$backup_name"
docker compose cp "app:/data/backups/$backup_name" "/secure/offsite/$backup_name"
```

**SQLite 备份不包含登录、会话、模型凭据与团队 JSON。** 生产恢复点必须另做完整 `/data` 备份并记录对应完整 Git SHA。备份包含敏感数据，必须限制访问并使用自己组织的加密/离线存储流程。

### 完整恢复点

为获得 JSON 与 SQLite 同一停机时刻的完整快照，先停止应用写入，再复制数据卷：

```sh
docker compose stop app
backup_root="/secure/aijavais-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup_root"
docker compose cp --archive app:/data "$backup_root/data"
git rev-parse HEAD > "$backup_root/commit.txt"
docker compose start app
```

这些命令应在有 Docker 权限和备份目录权限的服务器账户下运行。保留 UID/GID，防止恢复后非 root 应用无法读取 0600 文件。可以压缩加密完整快照，但不要单独复制运行中的主 `.sqlite` 文件而遗漏 WAL。不要运行 `docker compose down -v`，该命令会删除持久卷。

### 回滚到完整恢复点

没有未经验证的“自动降级数据库”操作。回滚应使用恢复点对应的代码版本和**新卷**，保留当前卷用于回退审计；不要将旧数据库与新版本 WAL/JSON 混合覆盖。

1. 停止应用：`docker compose stop app`；为当前状态另做完整备份。
2. 校验备份的 `commit.txt`、文件完整性和访问权限，在部署副本中准备该代码版本并构建 `aijavais:local` 镜像。开发分支上的未提交文件不能被部署回滚覆盖。
3. 创建一个新的恢复卷并将完整备份复制进去。下面的 `RESTORE_VOLUME` 和 `BACKUP_ROOT` 必须替换为实际目标：

   ```sh
   docker volume create RESTORE_VOLUME
   docker create --name aij-restore-helper --volume RESTORE_VOLUME:/data aijavais:local
   docker cp --archive BACKUP_ROOT/data/. aij-restore-helper:/data
   docker rm aij-restore-helper
   ```

4. 在部署配置中持久设置 `AIJAVAIS_DATA_VOLUME=RESTORE_VOLUME`，切换到恢复卷。默认卷名为 `aijavais_data`，修改该变量不会删除原卷。
5. 执行 `docker compose up -d --no-deps --force-recreate app`，再检查 `/healthz`、`npm run db:info`、登录和成果下载。更换到旧代码前必须先停止新代码写入。
6. 保留原卷和失败版本镜像，直到负责人确认恢复完成。首次升级前的旧版备份如没有 SQLite，则由旧版代码读取其 JSON；不要声称新库可无损导出回任意旧版本。

## 可选 Render 部署

`render.yaml` 已改为 Docker + `starter` 服务 + 1GB 持久磁盘 `/data` + `/healthz` 健康检查，关闭自动部署。它取代不兼容安全登录/持久化的旧免费版方案。

**此方案涉及服务与磁盘费用，必须由负责人确认后在 Render 控制台手动 Apply。** 本次未创建服务、未产生 Render 付费资源，也没有验证 Render 的实际入口、磁盘 UID 或证书。首次部署时检查 `/data` 对 UID1000 可写，若托管磁盘为 root-owned，先通过该平台受支持的权限初始化流程赋予应用 UID1000 目录所有权，不能将生产应用改成 root 运行来掩盖问题。确认平台 HTTPS 入口、转发头覆盖、健康检查和持久化重启，再配置真实凭据。

## 自动化验证与发布边界

`.github/workflows/ci.yml` 定义三类验证：

- Node24 `npm test`，使用本地协议 fixture，不访问收费模型。
- 在临时目录安装固定版本 `playwright@1.56.1` 和对应 Chromium，执行管理员及项目工作台浏览器测试；截图作为 CI artifact 保存。
- 构建 Docker 镜像并启动不发布端口的测试容器，等待健康状态后移除该测试容器和测试卷。

CI 没有镜像推送、生产部署、SSH、MCP外部服务或收费模型调用步骤。GitHub Actions 是否成功以远程实际运行结果为准，提交工作流本身不是 CI 已通过的证明。模型流式协议和 MCP fixture 测试也不等于真实服务商 API 或第三方生产 MCP 服务已验证。

## 当前实际验证范围

在本次云开发环境中已验证：Compose 配置解析、Docker 镜像构建、隔离容器非 root 运行、只读根文件系统、`/data` 写入、Node 内置 SQLite、GET/HEAD `/healthz` 的无数据健康响应、生产普通 HTTP 受保护接口拒绝、无主机端口映射、应用重启与数据卷保留。Caddy 2.10 镜像执行 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 返回 `Valid configuration`；这不等于已申请证书或已完成公网 HTTPS 部署。

未执行公网 DNS/ACME/TLS 部署、Render 部署、真实外部模型收费调用、真实第三方 MCP 服务或故障服务器灾难恢复演练。完整卷回滚步骤须由部署负责人在其环境进行恢复演练；不要把文档存在视为恢复演练成功。
