# AIJAVAIS V2 并行部署方案（与第一代共存）

适用情况：负责人已在自己的服务器上运行第一代 AIJAVAIS 并通过 HTTPS 使用。V2 **与第一代并行部署**，复用现有 HTTPS 入口，不需要新购服务器。**本文件是执行手册，尚未在负责人服务器上执行**；执行前需要负责人提供服务器访问并逐步确认。

## 负责人服务器实况与本方案的适配（2026-11-05，经 GPT 审核确认）

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

## 0. 红线（确认现有环境前一律不做）

不停止第一代服务；不覆盖第一代代码；不修改、迁移或打开写入第一代数据库与数据目录；**不修改或重启 S-UI**；不删除任何文件；不重置管理员密码；不直接替换现有 Nginx/Caddy 配置（只新增独立站点块，且先备份并测试语法）；不执行 `docker compose down -v`、`docker volume rm`、`rm -rf` 这类会删除数据的命令；不让两代程序写同一份数据。不把 API Key、密码、设置码、Cookie、备份文件写入 Git、日志或报告。

## 1. 只读检查现有环境

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

## 2. 先备份第一代（私有位置）

在确认第一代目录后，在负责人指定的私有目录（例如 `/srv/backups/aijavais-v1-<时间>`，权限 700）保存：

- 代码版本：`git -C <第一代目录> rev-parse HEAD`（若不是 Git 目录，打包代码目录）。
- 配置与数据：第一代 `data/`（含 `config.json`、模型连接、`credentials.json`、任务记录、成果等）。在线复制前先确认是否需要短暂停写；**未经批准不停服务**，可以先做一份在线副本并说明可能不一致，再在批准的维护窗口做一致副本。
- 进程/反向代理配置：PM2 ecosystem、systemd unit、Nginx/Caddy 站点文件、Docker compose 文件。

备份要校验（文件数、大小、`sha256sum`），并记录在部署报告里（只写位置与校验值，不写内容）。

## 3. 部署 V2（独立目录、独立数据、独立端口）

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

## 4. 复用现有 HTTPS 入口

V2 页面与接口使用根路径（`/api/...`、`/workspace.html`），**请使用独立子域名**（例如 `v2.现有域名`），不要挂在现有站点的子路径下。

1. 在 DNS 增加子域名记录，指向同一台服务器。
2. 备份现有反向代理配置文件后，**新增**一个站点块（不修改第一代站点块）：
   - Nginx：`server_name v2.…; location / { proxy_pass http://127.0.0.1:18787; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $remote_addr; proxy_buffering off; proxy_read_timeout 3600s; }`，并按现有方式签发证书。
   - Caddy：`v2.… { reverse_proxy 127.0.0.1:18787 }`（自动 HTTPS）。
3. 先 `nginx -t` 或 `caddy validate`，通过后再平滑重载（`systemctl reload`），不要重启第一代。
4. 反向代理必须覆盖客户端传入的 `X-Forwarded-Proto/For`。

## 5. 上线前必须完成的测试（结果写入部署报告）

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

## 6. 回滚方案（可直接执行）

V2 与第一代独立，回滚 V2 不影响第一代：

1. 移除或注释新增的 V2 反向代理站点块，`nginx -t`/`caddy validate` 后 reload。
2. 停止 V2：`docker stop aijavais-v2`（或停止 V2 的 systemd/PM2 进程）。**不要删除 V2 数据卷/目录**，保留用于排查。
3. 第一代始终未被修改；如反向代理配置出错，用第 2 步备份的配置文件恢复并 reload。

V2 自身的版本回滚见 [DEPLOYMENT.md](DEPLOYMENT.md) 的“回滚到完整恢复点”。

## 7. 正式切换

完成第 5 节全部测试后，先向负责人提交部署报告。**未经明确批准，不停止第一代、不把现有域名或生产流量切到 V2。** 切换方案（例如把主域名指向 V2、第一代改为只读归档）另行制定并批准。

## 8. 部署报告模板

- 服务器环境：操作系统、Node、Docker/PM2、反向代理及版本
- 安装方式：Docker / Node；镜像标签或提交 SHA
- 部署目录、数据目录（只写路径）
- HTTPS 方式：子域名、证书来源与续期方式
- 监听端口：V2 内部端口；确认仅 127.0.0.1
- 测试结果：第 5 节 12 项逐项结果与时间；真实 API 实际费用
- 备份位置说明与校验值（不含内容）
- 回滚步骤（按第 6 节，写明实际命令）
- 尚未完成的问题与风险
