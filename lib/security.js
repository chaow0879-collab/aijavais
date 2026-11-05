'use strict';
/*
 * AIJAVAIS 安全工具（零依赖）
 *  - validateBaseUrl：防 SSRF（协议、凭据、私网 / 元数据地址、DNS 解析结果）
 *  - isAllowedEnvKey：限制可被读取的环境变量名，防止借“envKey”外泄任意密钥
 *  - AuthThrottle：令牌防爆破
 *  - RateLimiter：外部事件限流
 */
const dns = require('dns').promises;
const net = require('net');

/* 官方主机：始终允许（仍要求 https） */
const OFFICIAL_HOSTS = new Set(['api.anthropic.com', 'api.openai.com', 'api.moonshot.cn', 'api.deepseek.com']);

/* 允许通过 envKey 读取的环境变量：官方预设 + 以 AIJ_ 开头并以 _KEY 结尾的自定义名 */
const ENV_KEY_FIXED = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY']);
const ENV_KEY_CUSTOM = /^AIJ_[A-Z0-9_]{1,40}_KEY$/;
const isAllowedEnvKey = name => !name || ENV_KEY_FIXED.has(name) || ENV_KEY_CUSTOM.test(name);
/* 官方环境变量只会发往对应官方主机，防止“新建供应商 + 恶意 Base URL”外泄官方密钥。
   第三方 OpenAI 兼容接口请用 AIJ_*_KEY，或把主机写进 ALLOWED_BASE_HOSTS。 */
const ENV_KEY_HOST = { ANTHROPIC_API_KEY: 'api.anthropic.com', OPENAI_API_KEY: 'api.openai.com', MOONSHOT_API_KEY: 'api.moonshot.cn', DEEPSEEK_API_KEY: 'api.deepseek.com' };
function envKeyHostOk(envKey, host, policy) {
  const want = ENV_KEY_HOST[envKey];
  return !want || want === host || policy.allowedHosts.includes(host);
}

function ipv4ToInt(ip) { return ip.split('.').reduce((a, b) => (a * 256 + (+b)), 0); }
function inV4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}
const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
function isLoopbackIp(ip) {
  if (net.isIPv4(ip)) return inV4(ip, '127.0.0.0', 8);
  if (net.isIPv6(ip)) return ip === '::1' || /^::ffff:127\./i.test(ip);
  return false;
}
/* 私网 / 回环 / 链路本地 / 元数据 / 组播 / 保留地址 */
function isPrivateIp(ip) {
  ip = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) return PRIVATE_V4.some(([b, n]) => inV4(ip, b, n));
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    return /^(fc|fd)/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  }
  return true; // 不是合法 IP 时按不安全处理
}

const parseList = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

/*
 * 配置来源（环境变量）：
 *   ALLOWED_BASE_HOSTS=host1,host2   设置后只允许这些主机 + 官方主机（严格模式，云端推荐）
 *   ALLOW_PRIVATE_BASE_URLS=1        允许回环 / 私网 / http（本地大模型如 Ollama）
 * 未设置 ALLOW_PRIVATE_BASE_URLS 时，仅当服务只监听本机（localOnly）才允许回环地址。
 */
function policyFromEnv(env, localOnly) {
  return {
    allowedHosts: parseList(env.ALLOWED_BASE_HOSTS),
    allowPrivate: env.ALLOW_PRIVATE_BASE_URLS === '1',
    localOnly: !!localOnly,
  };
}

/* 同步检查（保存供应商时）。返回 { ok, url?, error? } */
function checkBaseUrlSync(raw, policy) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, error: 'Base URL 格式不正确' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Base URL 只支持 http(s)' };
  if (u.username || u.password) return { ok: false, error: 'Base URL 不允许内嵌用户名或密码' };
  if (u.search || u.hash) return { ok: false, error: 'Base URL 不应包含查询参数或锚点' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const official = OFFICIAL_HOSTS.has(host);
  const listed = policy.allowedHosts.includes(host);
  if (policy.allowedHosts.length && !official && !listed) {
    return { ok: false, error: '主机 ' + host + ' 不在 ALLOWED_BASE_HOSTS 允许列表中' };
  }
  const literalIp = net.isIP(host) ? host : null;
  const isLocalName = host === 'localhost' || host.endsWith('.localhost');
  const privateLike = literalIp ? isPrivateIp(literalIp) : isLocalName;
  if (privateLike && !official && !listed) {
    const loopback = literalIp ? isLoopbackIp(literalIp) : isLocalName;
    const okLocal = loopback && policy.localOnly;
    if (!policy.allowPrivate && !okLocal) {
      return { ok: false, error: '不允许指向本机 / 内网 / 元数据地址（' + host + '）。如确需本地模型，设置 ALLOW_PRIVATE_BASE_URLS=1' };
    }
  } else if (u.protocol === 'http:' && !official && !listed && !policy.allowPrivate) {
    return { ok: false, error: '远程接口必须使用 https' };
  }
  return { ok: true, url: u };
}

/*
 * 异步检查（每次调用模型前）：在同步检查之上解析 DNS，任何一条解析结果落在私网即拒绝，
 * 以防“看起来是公网域名，实际解析到内网”的绕过。
 * 局限：解析与 fetch 之间仍有极短窗口（DNS rebinding），因此另设 redirect:'error'，
 * 且生产环境建议配合 ALLOWED_BASE_HOSTS 严格模式。
 */
async function validateBaseUrl(raw, policy) {
  const r = checkBaseUrlSync(raw, policy);
  if (!r.ok) return r;
  const host = r.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host) || OFFICIAL_HOSTS.has(host) || policy.allowedHosts.includes(host)) return r;
  if (host === 'localhost' || host.endsWith('.localhost')) return r;
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { return { ok: false, error: '无法解析主机 ' + host }; }
  const bad = addrs.find(a => isPrivateIp(a.address));
  if (bad && !policy.allowPrivate) return { ok: false, error: '主机 ' + host + ' 解析到内网地址，已拒绝' };
  return r;
}

/* 每个来源 IP：windowMs 内失败 max 次后锁定 lockMs */
class AuthThrottle {
  constructor({ max = 8, windowMs = 60000, lockMs = 300000 } = {}) { this.max = max; this.windowMs = windowMs; this.lockMs = lockMs; this.m = new Map(); }
  locked(key, now = Date.now()) { const r = this.m.get(key); return !!(r && r.lockUntil > now); }
  fail(key, now = Date.now()) {
    let r = this.m.get(key);
    if (!r || now - r.first > this.windowMs) r = { n: 0, first: now, lockUntil: 0 };
    r.n++;
    if (r.n >= this.max) r.lockUntil = now + this.lockMs;
    this.m.set(key, r);
    if (this.m.size > 5000) for (const [k, v] of this.m) if (v.lockUntil < now && now - v.first > this.windowMs) this.m.delete(k);
  }
  ok(key) { this.m.delete(key); }
}

/* 令牌桶：容量 burst，每秒补充 perSec */
class RateLimiter {
  constructor(perSec, burst) { this.perSec = perSec; this.burst = burst; this.tokens = burst; this.t = Date.now(); }
  take(now = Date.now()) {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.t) / 1000 * this.perSec);
    this.t = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

module.exports = { OFFICIAL_HOSTS, isAllowedEnvKey, envKeyHostOk, isPrivateIp, policyFromEnv, checkBaseUrlSync, validateBaseUrl, AuthThrottle, RateLimiter };
