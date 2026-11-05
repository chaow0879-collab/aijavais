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

## 访问控制（第三阶段 A）
| 主体 | 怎么获得 | 能做什么 |
|---|---|---|
| 本机 | 在服务器本机用 `http://localhost` 访问 | 等同管理员 |
| 管理员 | `x-admin-token` 或 `Authorization: Bearer`（令牌在 `data/config.json`，或环境变量 `ADMIN_TOKEN`） | 全部接口；完整事件流 |
| 上报凭证 | 管理员在 `/api/ingest-tokens` 创建（明文只显示一次，配置只存哈希），或环境变量 `INGEST_TOKEN`（+`INGEST_AGENTS` 限定可用的 agentId） | 只能 `POST /api/event`；不能看事件流、不能调管理接口 |
| 观看者 | 环境变量 `VIEW_TOKEN`；浏览器打开 `/?view=令牌`，服务端写入 HttpOnly Cookie 后去掉地址栏里的令牌 | 事件流第 1 级：含任务标题与错误摘要，不含模型原文、文件路径、元数据 |
| 匿名 | 不带凭证 | 事件流第 0 级：只含驱动大屏动画的字段；`ANON_VIEW=0` 可完全禁止 |

- 脱敏采用**字段允许列表**（`lib/access.js`）：新增字段默认不会外泄给观看者 / 匿名。
- 外部上报：内部任务一律拒绝写入（403）；外部任务归属第一次创建它的上报主体；agentId 绑定来源与主体；凭证可限定 agentId。
- 防爆破：同一 IP 1 分钟内 8 次无效凭证后锁定 5 分钟（本机访问不受影响）。限流：上报每主体每秒 100 条（突发 200），远程新建任务每秒 2 个（突发 10，本机不限）。
- 反向代理后部署需设 `TRUST_PROXY=1` 才按 `X-Forwarded-For` 识别 IP；否则不要设置（防伪造）。
- 人工团队角色（系统管理员、团队管理员、项目负责人、普通员工、审核人员、访客）的权限矩阵已在 `lib/permissions.js` 定义；目前只有单管理员部署，多用户登录尚未实现。

## 当前已知缺口
- **尚不支持公网多人安全使用**：没有多用户账号与登录，所有管理操作共用一个管理令牌；未做 HTTPS 终止（请放在反向代理后）。
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
