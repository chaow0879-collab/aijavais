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

`db:backup` 通过只读连接与 SQLite 原生 backup API 创建一致性备份，并验证 `quick_check`。目标必须是不存在的新文件；它不会覆盖旧备份，也不会创建执行引擎或把运行中的任务误判为中断。示例目录需换成有权限的私有目录。备份先在同目录的0700私有暂存目录内写入，校验0600与quick_check后以原子硬链接无覆盖发布（见 [BACKUP-OPERATIONS.md](DEPLOYMENT.md)）。遗留的 `.migration-backup-*` 等可用只读的 `npm run db:backup-inventory` 盘点，工具不会删除或恢复任何文件。

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

`deploy/render.yaml`（**不在仓库根目录**）已改为 Docker + `starter` 服务 + 1GB 持久磁盘 `/data` + `/healthz` 健康检查，关闭自动部署。B2-prep 起把它移出根目录：Render 默认读取根目录的 `render.yaml`，若早期按 main 旧版免费蓝图（默认自动部署）建过服务，main 快进后可能被同步成付费方案。负责人批准费用后，执行 `git mv deploy/render.yaml render.yaml` 或在 Render 中把蓝图路径指向 `deploy/render.yaml`，再手动 Apply。它取代不兼容安全登录/持久化的旧免费版方案。

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


## Schema v4 迁移与回滚安全门禁（#6 + #8）

新代码启动会在现有DATA独占锁下将v3迁移至v4，自动VACUUM INTO生成0600一致备份，再事务建model_requests和恢复历史草案费用。**本轮仅对临时DB验证，未操作或批准生产迁移。** 生产操作必须由负责人另行授权目标SHA、备份、窗口及回滚方案。

不得删幂等墓碑、盲删活锁或重发中断请求。旧v3程序拒绝v4库；停止唯一实例并归档完整DATA后，才能在隔离目录恢复匹配备份/代码。若迁移后已有模型调用，恢复旧备份会丢失请求键并引入重复收费风险，不能直接回退后开放；须保全v4全部账本与墓碑并申请审计后的前向修复/保留幂等数据恢复方案。详见[LEDGER-RECOVERY](DEPLOYMENT.md)。管理员可在能力中心只读查看异常账单；没有实际改账接口。

## 与第一代并行部署（原 DEPLOYMENT-PARALLEL.md）

适用情况：负责人已在自己的服务器上运行第一代 AIJAVAIS 并通过 HTTPS 使用。V2 **与第一代并行部署**，复用现有 HTTPS 入口，不需要新购服务器。**本文件是执行手册，尚未在负责人服务器上执行**；执行前需要负责人提供服务器访问并逐步确认。

### 负责人服务器实况与本方案的适配（2026-11-05，经 GPT 审核确认）

已知环境：Debian 13，内存 2 GB；**S-UI 正在运行**；Caddy 提供 HTTPS；系统原有 Node.js 20 之外已单独安装 Node.js 24.22.2；已安装 LibreOffice 与 Poppler；第一代位于 `/opt/ai-ring`，服务名 `ai-ring.service`；V2 开发版已下载到 `/opt/aijavais-v2/app`，负责人在服务器上测试过的是提交 `88e2757`（180 项中 179 通过、1 跳过），临时启动与登录保护检查通过。**服务器上的 `88e2757` 不是最新批准版本**，尚无最新代码常驻运行的证据。

因此本方案在该服务器上：**不安装 Docker**（第 3 节 B 方式：独立 Node 24 + 独立 systemd 服务）；复用已安装的 Node 24、LibreOffice、Poppler；**不修改 S-UI 的配置、端口和服务，不重启 S-UI**；不重装 Caddy、不做不必要的 Caddy 重启（只在批准后新增站点块并 `caddy validate` + reload）；不覆盖或卸载 Node 20；V2 使用独立系统用户、独立数据目录、仅 `127.0.0.1` 的独立端口；生产经 Caddy 代理时必须设置 `AIJ_ENV=production` 与 `TRUST_PROXY=1`；部署**最新批准的提交**并在服务器上重新运行测试，而不是沿用 `88e2757`。

**域名**：不强制新增子域名。测试阶段只在本机端口隔离测试；如需公网 HTTPS 并行验收，经负责人确认后再加临时测试子域名。V2 通过全部验收后，经负责人批准再把现有域名 `javis.ailp.fun` 切换到 V2，之后才处理第一代。

**2 GB 内存的资源限制**：用 systemd 限制 V2（示例：`MemoryMax=900M`、`CPUQuota=150%`、`TasksMax=256`）；代码执行保持关闭（`AIJ_ENABLE_CODE_EXECUTION` 不设置）；Office 转换/渲染按需使用，避免同时运行多个；平台本身最多 3 个并发运行。

systemd 单元示例（路径按实际 Node 24 位置填写，先 `systemd-analyze verify` 再启用；**新增**文件，不改动 `ai-ring.service`）：

```ini
# /etc/systemd/system/aijavais-v2.service
[Unit]
Description=AIJAVAIS V2 (parallel to ai-ring)
After=network-online.target

[Service]
User=aijavais-v2
WorkingDirectory=/opt/aijavais-v2/app
Environment=HOST=127.0.0.1 PORT=18787 AIJ_DATA_DIR=/opt/aijavais-v2/data AIJ_ENV=production TRUST_PROXY=1
ExecStart=/实际/node24/bin/node server.js
Restart=on-failure
MemoryMax=900M
CPUQuota=150%
TasksMax=256
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/aijavais-v2/data
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

升级 V2 代码（只影响 V2）：先 `npm run db:backup` 与完整数据目录备份 → `git -C /opt/aijavais-v2/app fetch origin && git -C /opt/aijavais-v2/app checkout <批准的 SHA>` → 在服务器上运行 `npm test` 并核对数量 → `systemctl restart aijavais-v2` → `/healthz` 与登录检查。所有命令执行前先确认当前目录、服务名和 SHA，避免误操作第一代或 S-UI。

下文第 3 节 A（Docker）仅适用于其他已有 Docker 的服务器。

### 0. 红线（确认现有环境前一律不做）

不停止第一代服务；不覆盖第一代代码；不修改、迁移或打开写入第一代数据库与数据目录；**不修改或重启 S-UI**；不删除任何文件；不重置管理员密码；不直接替换现有 Nginx/Caddy 配置（只新增独立站点块，且先备份并测试语法）；不执行 `docker compose down -v`、`docker volume rm`、`rm -rf` 这类会删除数据的命令；不让两代程序写同一份数据。不把 API Key、密码、设置码、Cookie、备份文件写入 Git、日志或报告。

### 1. 只读检查现有环境

下列命令只读取信息。逐条执行、记录结果；遇到不认识的结构先停下询问。

```bash
uname -a; cat /etc/os-release
node --version; which node; ls /opt /usr/local/bin 2>/dev/null | head -50
docker --version; docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
pm2 list 2>/dev/null; systemctl list-units --type=service --state=running | grep -Ei 'node|aij|nginx|caddy|pm2|docker'
sudo ss -ltnp
nginx -v 2>&1; sudo nginx -T 2>/dev/null | grep -nE 'server_name|listen|proxy_pass|ssl_certificate' | head -80
caddy version 2>/dev/null; sudo cat /etc/caddy/Caddyfile 2>/dev/null
```

需要确认：操作系统；Node 版本（V2 需要 24+）；第一代的运行方式（Docker / PM2 / systemd / 手动）；程序目录与数据目录；占用的端口；HTTPS 由谁提供（Nginx、Caddy、云负载均衡或其他）以及证书如何续期；可用磁盘与内存（`df -h`、`free -h`）。**不要假设第一代用 Docker。**

### 2. 先备份第一代（私有位置）

在确认第一代目录后，在负责人指定的私有目录（例如 `/srv/backups/aijavais-v1-<时间>`，权限 700）保存：

- 代码版本：`git -C <第一代目录> rev-parse HEAD`（若不是 Git 目录，打包代码目录）。
- 配置与数据：第一代 `data/`（含 `config.json`、模型连接、`credentials.json`、任务记录、成果等）。在线复制前先确认是否需要短暂停写；**未经批准不停服务**，可以先做一份在线副本并说明可能不一致，再在批准的维护窗口做一致副本。
- 进程/反向代理配置：PM2 ecosystem、systemd unit、Nginx/Caddy 站点文件、Docker compose 文件。

备份要校验（文件数、大小、`sha256sum`），并记录在部署报告里（只写位置与校验值，不写内容）。

### 3. 部署 V2（独立目录、独立数据、独立端口）

推荐两种方式，按第 1 步的结果选择：

**A. Docker（服务器已有 Docker）**

```bash
git clone https://github.com/chaow0879-collab/aijavais /srv/aijavais-v2/app
cd /srv/aijavais-v2/app && git checkout <批准的提交 SHA>
docker build -t aijavais-v2:<SHA> .
docker volume create aijavais_v2_data
docker run -d --name aijavais-v2 --restart unless-stopped \
  -p 127.0.0.1:18787:8787 -v aijavais_v2_data:/data \
  -e AIJ_ENV=production -e TRUST_PROXY=1 aijavais-v2:<SHA>
```

**B. 直接用 Node 24（不使用 Docker）**：安装 Node 24 到独立位置（例如 `/opt/node24`，不替换系统已有 Node），代码放 `/srv/aijavais-v2/app`，数据放 `/srv/aijavais-v2/data`（权限 700），以独立系统用户运行，`HOST=127.0.0.1 PORT=18787 AIJ_DATA_DIR=/srv/aijavais-v2/data AIJ_ENV=production TRUST_PROXY=1`，用新的 systemd unit 或新的 PM2 进程名管理。需要读取 PDF 时安装 `poppler-utils`；需要 Office 转换/渲染时安装 LibreOffice。

端口 `18787` 只是示例：必须选一个 `ss -ltnp` 中未占用的端口，并只监听 `127.0.0.1`。

### 4. 复用现有 HTTPS 入口

V2 页面与接口使用根路径（`/api/...`、`/workspace.html`），**请使用独立子域名**（例如 `v2.现有域名`），不要挂在现有站点的子路径下。

1. 在 DNS 增加子域名记录，指向同一台服务器。
2. 备份现有反向代理配置文件后，**新增**一个站点块（不修改第一代站点块）：
   - Nginx：`server_name v2.…; location / { proxy_pass http://127.0.0.1:18787; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $remote_addr; proxy_buffering off; proxy_read_timeout 3600s; }`，并按现有方式签发证书。
   - Caddy：`v2.… { reverse_proxy 127.0.0.1:18787 }`（自动 HTTPS）。
3. 先 `nginx -t` 或 `caddy validate`，通过后再平滑重载（`systemctl reload`），不要重启第一代。
4. 反向代理必须覆盖客户端传入的 `X-Forwarded-Proto/For`。

### 5. 上线前必须完成的测试（结果写入部署报告）

| # | 项目 | 做法 |
|---|---|---|
| 1 | 程序启动 | `curl -fsS http://127.0.0.1:18787/healthz` 返回 `{"ok":true}` |
| 2 | Node 24 | 容器内或进程环境 `node --version` ≥ 24 |
| 3 | 数据库初始化 | `npm run db:info`（Docker：`docker exec aijavais-v2 npm run db:info`），结构版本 2 |
| 4 | 管理员登录 | 用服务器上的 `setup-code.txt` 设置密码并登录；设置码不外传 |
| 5 | 模型连接 | 添加模型并测试；远程测试可能收费，按负责人批准的模型和额度执行 |
| 6 | MCP 与内置工具 | 能力中心：内置工具“可用”；如配置了 MCP，“测试连接”与“工具调用测试”成功 |
| 7 | 文件生成与下载 | 生成并下载 Word/Excel/PPT；上传 PDF/Word 并预览文字 |
| 8 | 多 AI 协作 | 两个岗位、两步流程完整运行至“等待审核”，查看交接消息 |
| 9 | Token 与费用限制 | 设置很低的 Token 上限，确认未发出请求即被拦截；付费模型未批准时返回 402 |
| 10 | 持久化与重启 | 重启 V2 后项目、成果、账本仍在，未完成运行显示“中断”且未自动重放 |
| 11 | HTTPS | `https://v2.…/healthz` 正常；浏览器证书有效；HTTP 访问受保护接口被拒绝 |
| 12 | 安全与权限 | 未登录访问 `/api/v2/projects` 为 401；应用端口未对公网开放（外部扫描 18787 不通） |

真实外部 API 测试只在负责人批准的额度和预算内进行，并记录实际费用。

### 6. 回滚方案（可直接执行）

V2 与第一代独立，回滚 V2 不影响第一代：

1. 移除或注释新增的 V2 反向代理站点块，`nginx -t`/`caddy validate` 后 reload。
2. 停止 V2：`docker stop aijavais-v2`（或停止 V2 的 systemd/PM2 进程）。**不要删除 V2 数据卷/目录**，保留用于排查。
3. 第一代始终未被修改；如反向代理配置出错，用第 2 步备份的配置文件恢复并 reload。

V2 自身的版本回滚见 [DEPLOYMENT.md](DEPLOYMENT.md) 的“回滚到完整恢复点”。

### 7. 正式切换

完成第 5 节全部测试后，先向负责人提交部署报告。**未经明确批准，不停止第一代、不把现有域名或生产流量切到 V2。** 切换方案（例如把主域名指向 V2、第一代改为只读归档）另行制定并批准。

### 8. 部署报告模板

- 服务器环境：操作系统、Node、Docker/PM2、反向代理及版本
- 安装方式：Docker / Node；镜像标签或提交 SHA
- 部署目录、数据目录（只写路径）
- HTTPS 方式：子域名、证书来源与续期方式
- 监听端口：V2 内部端口；确认仅 127.0.0.1
- 测试结果：第 5 节 12 项逐项结果与时间；真实 API 实际费用
- 备份位置说明与校验值（不含内容）
- 回滚步骤（按第 6 节，写明实际命令）
- 尚未完成的问题与风险


## 备份运维（原 BACKUP-OPERATIONS.md）

本页只描述**开发者自测过的行为与人工运维步骤**。没有任何自动删除、自动回滚或自动“认定可恢复”。真实生产操作（清理、恢复、迁移）需负责人另行批准。

### 1. 已修复：操作员备份的权限窗口与覆盖竞态（AUD-68-FU-03 扩展）

- **可达性（代码级证据）**：`ProjectStore.backup(target)` 在 `server.js`/`lib/v2-api.js` 中无调用者，但运维命令 `npm run db:backup -- <新文件>`（`tools/database.js`，README/DEPLOYMENT/USER-GUIDE 与就绪检查都推荐使用）使用**同一模式**：先 `sqlite.backup()` 写目标、再 `chmod 0600`。备份是整个 `projects.sqlite`（项目说明、上传资料原文与提取文字、运行输出、系统用量账本），属于敏感数据。
- **复现**：`tests/backup-operations-security.test.js` 第一项：umask 022、已存在 0755 目录时，旧模式写出的文件在 chmod 前为 **0644**（同机其他用户可读）。另有 `existsSync()`→写入之间若他人创建同名文件，SQLite backup 会覆盖它。
- **整改**：`lib/private-backup.js publishPrivateBackup()`（两处共用；**迁移备份 `migrationBackup()` 未改动**）：同目录 `mkdtemp(.private-backup-*)`（创建即 0700，并校验属主/模式）→ 在其中写备份 → `chmod 0600` + `lstat` 复核（chmod“假成功”失败关闭）→ `immutable=1` 只读 `PRAGMA quick_check` → `link()` 原子发布（EEXIST 绝不覆盖；同目录无 EXDEV）→ 移除自身暂存名。失败时目标不出现；因源库未被修改，自身暂存副本可安全移除。
- **故障矩阵（均为临时目录 + 真实 SQLite）**：已存在文件/符号链接/活动库路径、写入期间目标被并发创建、chmod EPERM、chmod 假成功、暂存目录非 0700（写入前拒绝）、EXDEV、ENOSPC、损坏副本（quick_check 失败不发布）、CLI 在 umask 022 + 0755 目录下发布 0600 且二次执行不覆盖。
- **信任边界（未改变，AUD-68-FU-02）**：目标父目录不得可被不可信用户写；同 UID 恶意进程、可被敌手写的父目录、ACL/非 POSIX 文件系统不在保证范围内。备份继承 WAL 模式：用普通连接打开会生成 `-wal/-shm`，请在私有目录内操作或用 `file:...?immutable=1` 只读打开。

### 2. 只读盘点 `.migration-backup-*` 等遗留物（AUD-68-FU-01）

```
npm run db:backup-inventory              # 默认 AIJ_DATA_DIR 或 ./data
node tools/backup-inventory.js /path/to/DATA --json
```

- 盘点对象：`.migration-backup-*`（迁移中断的私有暂存）、`.private-backup-*`（操作员备份中断的暂存）、`projects.sqlite.pre-vN-<毫秒>.bak`（已发布迁移备份）。
- 每项输出：类型、模式/属主（是否当前用户）、大小、时间、是否符号链接、SQLite 头（`user_version`）、`quick_check`、暂存副本是否与某个已发布 `.bak` 为同一 inode（`published`）、目录剩余字节与磁盘可用空间。
- **只读保证（有测试）**：不跟随符号链接（`lstat`，`O_NOFOLLOW`）；只对属于当前用户的普通文件用 `immutable=1` 只读连接做 `quick_check`，不产生 `-wal/-shm`；测试前后对目录做递归快照（名称/模式/大小/mtime/inode/sha256）完全一致；没有 `--delete/--restore` 等选项，未知选项直接拒绝。
- **退出码（失败关闭）**：0 = 已扫描且无需关注；2 = 已扫描，有需关注项；1 = 无法扫描（DATA 不存在/不是目录/读取错误）——不会给出部分“全部正常”。
- **解读**：`recoveryUse` 恒为 `manual_review_required`。`quick_check ok` 不证明副本完整或可用于恢复；`published:false` 的暂存副本可能来自 VACUUM 中途崩溃，绝不能未经人工核对就用于恢复。ACL 不检查（`aclChecked:false`）。

### 3. 人工处置建议（需另批，工具不执行）

1. 停止服务或确认无迁移进行中；对整个 DATA 目录做私有完整备份。
2. 运行盘点 `--json` 并保存输出；核对每个遗留物的 `user_version`、时间、`published` 与 `quick_check`。
3. 若某暂存副本 `published` 指向已发布 `.bak`：两者同一 inode，删除暂存名不影响已发布备份。
4. 若 `published:false`：与当前库/已发布备份比对后，由负责人决定保留或在私有位置归档；不要直接恢复。
5. 磁盘空间：关注 `leftoverBytes` 与 `disk.freeBytes`；反复启动失败会累积遗留物。

### 4. 测试入口

`node --test tests/backup-operations-security.test.js`（已纳入 `npm test`），并与原有 `tests/migration-backup-security.test.js`（#6/#8 已审计）共同运行。


## 账本恢复、迁移与回滚（原 LEDGER-RECOVERY.md）

状态：原候选c4d0a8c经独立审计REJECT；本轮仅返工AUD-68-SEC-01，等待人工触发新增差异复审；验证结果见HANDOFF与Issue #6/#8。授权：Issue #6 第十轮评论 6660869089；唯一开发者 Codex。分支 feat/codex-v2-p1-ledger-recovery，精确基线 b71faaa65bb66e04ea2a015c9238a3a129bdb68e。仅测试临时 SQLite，无生产迁移授权。

### Schema v4

新增 model_requests：PRIMARY KEY(owner_id,kind,request_id)，params_hash、state、唯一 ledger_id 外键引用 system_usage、created_at/updated_at/dispatched_at/settled_at。现有 runs、usage_ledger 及其 ProjectEngine 预算与恢复算法保持原语义。params_hash 为规范化服务器输入与目标配置快照的 SHA-256：description、prompt版本、connectionId、baseUrl/modelId/protocol/pricingMode/updatedAt、批准与Token/金额上限、USD价格。忽略无效额外字段和批准时间，密钥、提示词不存入请求表；摘要绑定完整描述但不公开。

按 owner + kind + requestId 隔离。当前产品为单管理员，仍使用认证 userId，以免未来主体串键。重复同参数返回409 duplicate_request与安全状态；不同参数返回409 idempotency_key_reused；任何状态均不得重发。请求ID/墓碑永久保留，本阶段无清理、无结果自动重放。

### 事务与状态机

1. 先执行共享 budget 的授权、目标、Token/金额检查。拒绝不派发、不预留。
2. claimModelRequest 在首个 await 前以 BEGIN IMMEDIATE 同时插入 system_usage reserved 与 model_requests claimed；失败全部回滚、不调用模型。SQLite唯一键是权威，active仅管理取消；删除seen淘汰机制。
3. 再校验目标与取消状态；网络调用前必须提交 claimed -> dispatching，记录派发时间。dispatching 仅表示可能已发送，即使在下一条网络语句前崩溃也按未知处理。
4. settleSystemUsage 在同一事务条件更新预留账行和请求行：claimed且已证实未调用 -> not_dispatched；dispatching -> completed/failed。一次ledgerId只结算一次，原始预留上界保留。费用未知时cost=null，不将预算上界当账单。结算写失败两表均保留原状态；保留#5的HTTP202/ok:false/usageRecorded:false/financiallyComplete:false与可编辑草案，不为补记账重新调用。
5. 启动恢复只在现有DATA独占锁下事务执行：claimed -> not_dispatched（实际费用0）；dispatching -> interrupted_unknown（cost=null，保留Token/费用预留和上界、model、requestId、时间）。重复恢复幂等；无模型重放。

### 迁移与历史

VACUUM写入前先通过mkdtemp创建并校验0700私有暂存目录（兼容既有0755 DATA与umask022）；私有目录中的备份chmod并校验为普通0600文件后，使用同文件系统原子hardlink无覆盖发布到原`projects.sqlite.pre-vN-时间.bak`，最后删除暂存副本/空目录。进程umask保持不变；文件系统不支持安全发布或权限校验失败则停止迁移，不退回到覆盖式rename。保留schema_migrations、PRAGMA user_version、事务和schema_newer失败关闭。建表与历史转换在同一迁移事务内。v3 intake_draft reserved没有派发证据，一律保守恢复为未知待核对，绝不归零。

所有可识别历史intake请求（含成功/失败）建立永久墓碑：若旧记录无owner，以保留主体*匹配任意真实管理员，拒绝旧ID再次收费；旧摘要不可重建，任何参数都拒绝。历史重复ID的所有账行完整保留，仅一个墓碑关联其中一行，其他行仍可单独查询核对；不删除或覆盖账单。无requestId的历史行仍恢复异常账本，但无法重建丢失的键，列为历史限制。新请求主体禁止使用保留*。

### 只读异常查询与人工核对

管理员现有认证门禁提供只读异常列表，按owner隔离（历史未知owner对管理员可见）。响应仅白名单：ledgerId、requestId、connectionId/modelId、UTC时间、请求与账本状态、cost及预算上界；不返回prompt、密钥、原始错误。能力中心提供待核对提示。估算不是厂商账单。本轮不新增写账/调余额/人工reconcile接口。

人工核对步骤：停止重复提交；记录ledgerId/requestId/UTC时间/model/上界；由负责人在厂商后台核对原始账单，留存脱敏证据；未知账单保持未知。若需实际改账，另行设计并申请授权，不能直接SQL改余额或重新生成作为补记账。

### 回滚

不自动降级。停唯一实例，归档当前完整DATA（含SQLite/WAL/JSON/密钥，勿提交Git），将迁移前一致备份恢复到隔离DATA并使用匹配v3代码验证。v3代码面对v4库必须schema_newer失败关闭。迁移后若已派发任何请求，直接恢复旧备份会丢失幂等墓碑并可能重复收费：此时不可恢复到旧库对外服务，先保留v4全部账本/墓碑，制定受审计前向修复或完整幂等数据保留方案。仅无后续请求的临时迁移实验可直接备份回退。

### 测试与范围

Mock模型+临时SQLite断言底层派发次数：并发同ID、异参、跨owner、重启和1000历史后；claim与dispatching崩溃边界；子进程强杀/重启、第二活进程锁拒绝；预留/结算事务故障；重复恢复；v3历史、备份/迁移失败、损坏库/未来版本；只读认证/脱敏；#5 HTTP202与原ProjectEngine预算恢复回归。运行npm test、test:intake、适用浏览器测试和本分支Actions。全部报告真实计数、失败/跳过与Mock次数。

不涉及#7底层忽略AbortSignal的取消生命周期或#9，不新增人工改账，不调用真实收费API，不改main/生产库/服务器/Caddy/S-UI。若必要依赖越界则BLOCKED。


### 实现检查点

设计提交：36e2c7a96cd107e9b88ed74eae1abaee758a75f1。事务/恢复实现提交：84dfd8ddd8cf06aaeb4bcf78857b79bf1e946191，相关54项回归通过（本地Mock、临时SQLite）。新增服务测试实际派发1002次后最早ID重启重试增量0；强杀窗口Mock计数为claimed=0/dispatching=0/called=1，恢复后增量0；HTTP服务强杀后底层Mock请求总数仍1。最终完整测试、只读UI和CI见HANDOFF及Issue #6/#8交付报告。

运行中已验证本地免费调用保留费用0（#5）；启动对dispatching一律按未知恢复，包括本地目标，以显式状态机的保守规则处理崩溃证据，不将legacy cost0当作未派发证明。恢复仅处理非终态/遗留预留，不改变已完成的本地0费用账单。


### AUD-68-SEC-01 权限返工边界

原实现先VACUUM到可遍历DATA目录、后chmod，存在初始0644窗口；本轮将整个写入和权限设置放进创建时即私有的0700目录。所有备份发布前必须通过0600验证，旧备份不可覆盖。成功才清理暂存副本；chmod、发布/清理失败或进程异常退出时保留私有暂存目录及/或正式0600备份，迁移未开始时原v3保持原样，迁移SQL失败仍按原事务回滚。

失败后先停止唯一实例，保留`.migration-backup-*`及正式备份，使用只读SQLite `quick_check`、schema版本及关键数据核验完整性。中断期间暂存文件可能不完整，不能直接把它作为有效备份回滚；不要自动删除，也不要未经核验移到公开目录。DATA必须由应用/可信管理员控制写入，0755可读遍历旧目录有本补丁保护；不支持不受信用户可写父目录的路径替换攻击。本轮仅在临时目录测试，不修改生产DATA。

第十四轮人工门禁：双Issue交付新完整SHA及CI后Codex停止；只有负责人在GPT会话明确说“开始审计”，GPT才复核。不得自动触发审计、ACCEPT、关闭Issue、唤醒Claude或开始#7/#9。


## P2 运行与验证边界（原 P2-OPERATIONS.md）

FU-01（FIXED_WITH_SOP）：既有GET /api/v2/intake/ai-draft/status为管理员只读诊断。使用已登录会话读取，不在命令行打印Cookie。tools/p2/preflight.js的diagnose可将该JSON转成只读容量警示。3槽永久挂起表示供应商可能仍计费；429是拒绝第四次派发，不应通过释放槽位、删账或重发恢复服务。

人工恢复SOP：暂停新提交；记录只读status及异常账本ledgerId/requestId/UTC/保守上界（不要提示词/密钥）；负责人另行批准停机窗口、完整备份与恢复路径；由授权运维停止唯一实例（close有界，但不证明供应商停止），确认旧进程已退出；归档完整DATA及WAL。授权启动后核对dispatching恢复interrupted_unknown、cost=null与上界保留；同ID拒绝、不重发。对照供应商账单人工核对，未经另批不修改账单或余额。生产演练NOT_RUN。Mock演练运行tests/intake-draft-cancel-lifecycle.test.js TC7-01/02/05，包含3槽、close有界和恢复；仅模拟永不settle，不能保证厂商停止。

FU-02（FIXED_TOOL / ENVIRONMENT_NOT_VERIFIED）：node tools/p2/preflight.js /explicit/isolated/path 默认只读；逐级lstat检查父链、owner、可写位、符号链接及getfacl。缺ACL工具/扩展ACL/非Linux/非受信owner/可写父链一律BLOCKED，不修改chmod、不跟随符号链接、不读取秘密。/tmp的sticky位不能替代受信父链。仅零问题输出READY_FOR_HUMAN_REVIEW，不代表生产可部署。同UID攻击者、特定生产OS/挂载/ACL实际核查仍须独立运维授权，本轮NOT_RUN。

FU-03（FIXED）：npm run test:p2在临时worker内注入5类真实生产模块语义回退（擅自批准、工具权限放大、重复请求、崩溃当未派发、提前释放容量），要求现有负面fixture确实失败；不修改磁盘生产源码、不增加生产后门。历史标题/断言计数护栏保留为辅助，npm test仍必跑。变异仅证明所选错误能被捕获，不是所有变异的完整证明。

FU-04（FIXED）：npm run test:release-industry要求独立Office解析PARSED，缺依赖/解析失败报BLOCKED并失败；普通开发模式可NOT_RUN，但summary为INCOMPLETE_NOT_RUN，不再写完整PASS。CI安装python-docx/openpyxl/python-pptx，严格模式实际导出和独立读取三行业文件，记录SHA256。缺依赖负例由tools/p2/office-gate与P2测试验证。

FU-05（DOC_ONLY）：AI-DRAFT明确#7基线缺陷已修；剩余永久不合作供应商可用性和未知费用边界仍保留。本轮无lib/public/schema改动，不修改Claude #17或QA #4文件。真实厂商、专业质量、E4/E5、生产均未验证。

本轮本地证据：npm test 276/276；test:p2 9/9（含5种危险语义变异被捕获、真实缺Python进程失败）；test:release-industry 3/3，三份summary均PARSED且有真实产物哈希；test:intake与test:workspace通过。当前开发目录只读父链检查无blocker，productionVerified=false。初次回归的既有fake-chmod夹具假定SQLite初始非600，现改为明确留下644验证拒绝发布，并保留全部原断言；不改lib实现。最终SHA/精确CI见Issue #15报告。

