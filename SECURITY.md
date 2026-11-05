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

## 密钥
| 规则 | 说明 |
|---|---|
| 优先级 | 供应商里显式保存的 `apiKey` **优先于**环境变量 `envKey` |
| 环境变量白名单 | `envKey` 只能是 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MOONSHOT_API_KEY` / `DEEPSEEK_API_KEY`，或 `AIJ_*_KEY` |
| 官方变量绑定 | 官方变量与官方主机**严格一一绑定**（无任何例外）：`OPENAI_API_KEY`→`api.openai.com`，`ANTHROPIC_API_KEY`→`api.anthropic.com`，`MOONSHOT_API_KEY`→`api.moonshot.cn`，`DEEPSEEK_API_KEY`→`api.deepseek.com`。第三方接口请填写 API Key 或使用 `AIJ_*_KEY` |
| 换主机 | 已保存 API Key 的供应商更换 Base URL 主机时，必须重新填写 Key，不会自动转发到新主机 |
| 不回传 | `/api/config` 不返回管理令牌与完整密钥 |
| 脱敏 | 写入事件、任务记录、接口响应的错误文本，先去掉已知密钥与常见密钥形态 |
| 保存顺序 | `/api/providers` 先校验、通过后才修改配置，校验失败不留下半成品 |

## 测试
`npm test`（Node 原生 `node:test`，零依赖）。
