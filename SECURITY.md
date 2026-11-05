# AIJAVAIS 安全说明（出站请求与密钥）

## 出站（模型接口）策略：默认拒绝，显式放行
| 规则 | 说明 |
|---|---|
| 协议与端口 | 只允许 `https`，端口仅 443。`ALLOWED_BASE_PORTS=8443,…` 可追加 |
| 地址分类 | **所有**目标（含官方主机、白名单主机）都做 DNS 解析并逐个分类，必须全部是公网地址。覆盖 IPv4、IPv6、IPv4 映射（`::ffff:`）、NAT64、6to4、Teredo、ULA、链路本地、元数据、组播与保留地址；十进制 / 十六进制 IP 写法由 URL 解析归一化后同样被拒绝 |
| 白名单 | `ALLOWED_BASE_HOSTS=a.com,b.com` 只做**收紧**（只允许官方主机与列表内主机），不绕过 https、端口、地址分类 |
| 本地模型 | 必须用 `LOCAL_MODEL_TARGETS=localhost:11434,192.168.1.20:8080` 逐条声明精确的 `host:port`；只允许解析到回环或私网；元数据 / 链路本地 / 组播永远禁止 |
| 重定向 | 一律不跟随，3xx 直接报错 |
| DNS rebinding | 每次请求只解析一次，连接**固定**到校验通过的那个 IP（保留原 Host / SNI），校验与连接之间没有第二次解析 |

局限：固定 IP 只保证“连到的就是校验过的地址”，不能防范被允许的公网主机本身被攻陷；高安全场景请再配合网络出口策略（防火墙 / 出口代理）。

### 默认模式 vs 严格模式（请区分）
- **默认（未设置任何白名单）**：允许任意**公网 https:443** 主机，前提是 DNS 解析出的所有地址都是公网地址。适合开箱即用，但不限定“能连哪些公网主机”。
- **严格模式**：设置 `ALLOWED_BASE_HOSTS` 后，只允许官方主机 + 列表内主机；其余一律拒绝。公开部署 / 多人共用请使用严格模式。
- 无论哪种模式，私网 / 回环 / 元数据地址都不会被访问，除非用 `LOCAL_MODEL_TARGETS` 逐条显式声明。

## 流式响应与超时
| 规则 | 说明 |
|---|---|
| DNS 超时 | 解析超过 5 秒失败，不无限等待 |
| 响应体上限 | pinnedFetch 对单次响应总量有上限（默认 16MB）；错误响应体只读前 4KB |
| SSE 解析 | 按规范合并多行 `data:`；单事件 ≤ 1MB，单次调用 ≤ 8MB，单任务累计 ≤ 32MB，超限即中断并记为 `model_error` |
| 总超时 | 单次调用受 `timeoutSec` 限制，超时同样记为 `model_error` |
| 启动日志 | 局域网模式不再在日志里打印管理令牌（令牌见 `data/config.json`） |
| 测试专用 | `AIJ_TEST_TIMEOUT_MS`、`AIJ_TEST_MAX_CALL_BYTES` 仅供自动化测试缩短限制，生产不要设置 |

## 事件真实性
- 事件的 `source`（server / external / demo）与 `verification`（observed / reported / simulated）只由服务端按来源赋值，不读取客户端传来的值。
- 外部上报不能使用模型连接 ID 或 `demo-` 前缀的 `agentId`，也不能与已存在的不同来源 agent 同名；支持 `clientEventId` 去重。
- 只有 `source=server` 的真实模型调用计入 `totals.calls / tokens / errors`；外部与演示事件只计事件数；厂商返回的用量与估算值（`estimatedTokens`）分开统计。

## 登录与访问控制（V2.0 起）
| 项目 | 做法 |
|---|---|
| 首次设置 | 服务端生成一次性设置码，只打印在服务器控制台、写入 `data/setup-code.txt`（0600）。拿不到服务器本机的人无法抢先设置密码 |
| 密码存储 | scrypt（N=2^15, r=8, p=1，64 字节）+ 16 字节随机盐，只存哈希；常量时间比较；不存在账号时同样耗时 |
| 会话 | 32 字节随机令牌，Cookie `aij_session`：HttpOnly、SameSite=Strict、HTTPS 下 Secure；服务端只存 SHA-256。空闲 8 小时 / 最长 7 天过期（`SESSION_IDLE_MIN`、`SESSION_MAX_DAYS` 可调）；支持退出、撤销单个会话、退出所有设备；改密码撤销其它全部会话；会话撤销后其事件流立即断开 |
| 受保护范围 | 除 `login.html`、`/api/auth/status|setup|login` 外，**所有页面（含 HALOFLUX 大屏）、静态资源、API、SSE 都需要登录**。不再有 localhost Host 头特权、管理令牌登录、匿名观看 |
| 大屏观看 | 管理员生成一次性观看链接（10 分钟内有效、只能用一次），换得只读的“观看会话”：只能看大屏与第 1 级事件流，不能访问任何工作台数据，可随时撤销 |
| 外部上报 | 上报凭证（`x-ingest-token`）与登录会话严格分离：只能 `POST /api/event`，不能登录、看大屏或读数据；会话令牌也不能当上报凭证用。本机免凭证上报需显式设置 `AIJ_LOCAL_INGEST=1`（设置了 `TRUST_PROXY` 时无效） |
| 限流 | 登录 / 设置 / 改密码：每 IP 15 分钟 5 次失败锁 15 分钟；全局 1 小时 50 次失败暂停全部登录 15 分钟。无效上报凭证：每 IP 1 分钟 8 次后锁 5 分钟，锁定期间该 IP 的上报一律拒绝 |
| 跨站 | 写操作要求同源 Origin，且请求体必须是 JSON；会话 Cookie SameSite=Strict |
| 响应头 | `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、CSP `frame-ancestors 'none'`；HTTPS 下加 HSTS |
| HTTPS | `AIJ_ENV=production` 时必须 HTTPS（`TLS_CERT_FILE`+`TLS_KEY_FILE` 直接启用，或在 HTTPS 反向代理后设 `TRUST_PROXY=1`），否则拒绝启动；生产模式下明文 HTTP 请求一律 403。非生产模式默认只允许监听本机地址 |
| 恢复 | 服务器本机运行 `node tools/reset-password.js --yes`：清除密码与全部会话、生成新设置码；运行中的服务自动感知 |
| 审计 | 设置、登录、失败、退出、改密码、撤销、观看链接等写入 `data/audit.log`（JSON 行，1MB 轮转） |

字段级脱敏仍采用允许列表（`lib/access.js`）：观看会话看不到模型原文、文件路径、元数据。

## 当前已知缺口
- 平台定位为**单人独立部署**：一个管理员密码，不提供多人账户。公网部署必须使用生产模式 + HTTPS。
- 任务记录（`data/tasks.json`）包含模型输出全文，尚无按保留期清理与加密；部署在共享服务器上时注意文件权限（已设 0600）。
- 消息与成果只在内存中，服务重启后无法查看历史消息正文（任务记录与步骤输出仍在）。

## 密钥
| 规则 | 说明 |
|---|---|
| 存放 | 模型注册信息在 `data/models.json`（不含密钥）；API Key 在 `data/credentials.json`（0600）。任何接口都不返回明文，只返回尾号 |
| 优先级 | 模型连接里显式保存的 `apiKey` **优先于**环境变量 `envKey` |
| 环境变量白名单 | `envKey` 只能是 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MOONSHOT_API_KEY` / `DEEPSEEK_API_KEY`，或 `AIJ_*_KEY` |
| 官方变量绑定 | 官方变量与官方主机**严格一一绑定**（无任何例外）：`OPENAI_API_KEY`→`api.openai.com`，`ANTHROPIC_API_KEY`→`api.anthropic.com`，`MOONSHOT_API_KEY`→`api.moonshot.cn`，`DEEPSEEK_API_KEY`→`api.deepseek.com`。第三方接口请填写 API Key 或使用 `AIJ_*_KEY` |
| 换主机 | 已保存 API Key 的模型连接更换 Base URL 主机时，必须重新填写 Key，不会自动转发到新主机 |
| 不回传 | `/api/config` 不返回管理令牌与完整密钥 |
| 脱敏 | 写入事件、任务记录、接口响应的错误文本，先去掉已知密钥与常见密钥形态 |
| 保存顺序 | `/api/providers` 先校验、通过后才修改配置，校验失败不留下半成品 |

## 测试
`npm test`（Node 原生 `node:test`，零依赖）。
