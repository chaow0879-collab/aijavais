'use strict';
/*
 * AIJAVAIS 安全工具（零依赖，Node 18+）
 *
 * 出站请求（模型接口）策略 —— 默认拒绝，显式放行：
 *   1. 默认只允许 https，且端口只能是 443（可用 ALLOWED_BASE_PORTS 追加）。
 *   2. 默认所有目标（含官方主机、白名单主机）一律解析并分类，必须全部落在公网地址。
 *      显式 AIJ_PROXY_DNS=delegate 可将已允许的公共域名交给可信代理解析（下述限制）。
 *   3. 白名单（ALLOWED_BASE_HOSTS）只做“收紧”：设置后只允许官方主机与列表内主机，
 *      但不会绕过 https、端口、私网检查中的任何一条。
 *   4. 本地模型（Ollama 等）必须用 LOCAL_MODEL_TARGETS=host:port,… 逐条显式声明，
 *      只允许这些精确的 host:port，且只能解析到回环或私网地址；
 *      链路本地 / 云元数据 / 组播 / 保留地址永远禁止。
 *   5. 不跟随重定向。
 *   6. 直连固定到本次校验通过的 IP。配置 HTTPS_PROXY 时走 CONNECT，
 *      保留代理的域名策略与密钥注入；代理必须自行防止 DNS rebinding。
 *
 * 局限（诚实说明）：固定解析 IP 只保证“连到的就是校验过的地址”；
 * 若需防范被允许的公网主机本身被攻陷，仍应配合网络出口策略（防火墙 / 代理）。
 */
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { Readable, Transform } = require('stream');

/* 官方主机 → 与官方环境变量一一绑定，不存在例外 */
const OFFICIAL_HOSTS = new Set(['api.anthropic.com', 'api.openai.com', 'api.moonshot.cn', 'api.deepseek.com']);
const ENV_KEY_HOST = Object.freeze({
  ANTHROPIC_API_KEY: 'api.anthropic.com', OPENAI_API_KEY: 'api.openai.com',
  MOONSHOT_API_KEY: 'api.moonshot.cn', DEEPSEEK_API_KEY: 'api.deepseek.com',
});
const ENV_KEY_CUSTOM = /^AIJ_[A-Z0-9_]{1,40}_KEY$/;
const isAllowedEnvKey = name => !name || Object.prototype.hasOwnProperty.call(ENV_KEY_HOST, name) || ENV_KEY_CUSTOM.test(name);
/* 官方环境变量只能发往其绑定主机；AIJ_*_KEY 可用于任何已通过校验的主机。白名单不构成例外。 */
function envKeyHostOk(envKey, host) {
  const want = ENV_KEY_HOST[envKey];
  return !want || want === String(host).toLowerCase();
}

/* ------------------------------------------------------------------ IP 分类 */
const V4_BLOCKED = [ // 永远禁止（含元数据、保留、组播）
  ['0.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V4_PRIVATE = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]];
const v4int = ip => ip.split('.').reduce((a, b) => a * 256 + (+b), 0);
const inV4 = (ip, [base, bits]) => { const m = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return ((v4int(ip) & m) >>> 0) === ((v4int(base) & m) >>> 0); };

function classifyV4(ip) {
  if (inV4(ip, ['127.0.0.0', 8])) return 'loopback';
  if (V4_BLOCKED.some(r => inV4(ip, r))) return 'blocked';
  if (V4_PRIVATE.some(r => inV4(ip, r))) return 'private';
  return 'public';
}
function v6bytes(ip) { // 返回 16 字节数组；非法返回 null
  ip = ip.replace(/%.*$/, '');
  if (!net.isIPv6(ip)) return null;
  let tail = [];
  const dotted = ip.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) { const p = dotted[1].split('.').map(Number); tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]]; ip = ip.slice(0, -dotted[1].length) + '0:0'; }
  const [head, rest] = ip.split('::');
  const h = head ? head.split(':') : [], r = rest !== undefined && rest ? rest.split(':') : [];
  const fill = ip.includes('::') ? 8 - h.length - r.length : 0;
  const groups = [...h, ...Array(Math.max(0, fill)).fill('0'), ...r].map(x => parseInt(x || '0', 16));
  if (groups.length !== 8 || groups.some(x => !Number.isFinite(x))) return null;
  if (dotted) { groups[6] = tail[0]; groups[7] = tail[1]; }
  const b = [];
  for (const g of groups) b.push((g >> 8) & 255, g & 255);
  return b;
}
const bytesToV4 = (b, i) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
/*
 * 返回：'public' | 'loopback' | 'private' | 'blocked' | 'invalid'
 * 内嵌 IPv4 的形式（IPv4 映射 ::ffff:a.b.c.d / ::ffff:hhhh:hhhh、NAT64 64:ff9b::/96、6to4 2002::/16）
 * 一律按其内嵌的 IPv4 分类；IPv4 兼容地址、Teredo 等其余特殊用途地址直接 blocked。
 */
function classifyIp(raw) {
  const ip = String(raw).replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(ip)) return classifyV4(ip);
  const b = v6bytes(ip);
  if (!b) return 'invalid';
  const zero = (from, to) => b.slice(from, to).every(x => x === 0);
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return classifyV4(bytesToV4(b, 12)); // 映射
  if (zero(0, 12)) return (b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] === 1) ? 'loopback' : 'blocked'; // :: ::1 ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) { // NAT64
    const c = classifyV4(bytesToV4(b, 12)); return c === 'public' ? 'public' : (c === 'loopback' ? 'blocked' : c);
  }
  if (b[0] === 0x20 && b[1] === 0x02) { const c = classifyV4(bytesToV4(b, 2)); return c === 'public' ? 'public' : (c === 'loopback' ? 'blocked' : c); } // 6to4
  if (b[0] === 0xfc || b[0] === 0xfd) return 'private'; // ULA fc00::/7
  if ((b[0] & 0xe0) !== 0x20) return 'blocked'; // 只接受全局单播 2000::/3，其余（fe80::/10、fec0::/10、ff00::/8、100::/64…）一律禁止
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] < 0x02) return 'blocked'; // 2001::/23 IETF 保留（含 Teredo）
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'blocked'; // 文档 2001:db8::/32
  if (b[0] === 0x3f && (b[1] & 0xf0) === 0xf0) return 'blocked'; // 文档 3fff::/20
  return 'public';
}

/* ------------------------------------------------------------------ 策略 */
const parseList = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const hostPort = (h, p) => (net.isIPv6(h) ? `[${h}]` : h) + ':' + p;
function policyFromEnv(env = process.env) {
  const targets = new Set();
  for (const t of parseList(env.LOCAL_MODEL_TARGETS)) {
    const m = t.match(/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/);
    if (m && +m[2] > 0 && +m[2] < 65536) targets.add(hostPort(m[1].replace(/^\[|\]$/g, ''), +m[2]));
  }
  return {
    allowedHosts: parseList(env.ALLOWED_BASE_HOSTS),
    extraPorts: new Set(parseList(env.ALLOWED_BASE_PORTS).map(Number).filter(n => n > 0 && n < 65536)),
    localTargets: targets,
    lookup: null, // 仅供测试注入：async (host) => [{address, family}]
    dnsTimeoutMs: 5000, // DNS 解析超时；仅测试代码会改小
    maxResponseBytes: 16 << 20, // 单次响应体总量上限（pinnedFetch 默认值）
    // Retain the platform route and credential injection. NO_PROXY never
    // disables the proxy for public targets; explicit local models use direct,
    // validated, pinned connections instead.
    httpsProxy: env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '',
    proxyDnsDelegate: env.AIJ_PROXY_DNS === 'delegate',
    proxyTimeoutMs: 15000,
  };
}

/* 语法级检查（保存配置时用，不做 DNS）：返回 { ok, url?, host?, port?, local?, error? }
 * opts.requestUrl：校验的是“完整请求地址”（Base URL + 接口路径 + 查询参数），允许查询参数；
 * 保存的 Base URL 仍禁止查询参数。两种情况都拒绝锚点、内嵌账号，主机/协议/端口规则完全相同。 */
function checkBaseUrlSyntax(raw, policy, opts = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, error: 'Base URL 格式不正确' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Base URL 只支持 http(s)' };
  if (u.username || u.password) return { ok: false, error: 'Base URL 不允许内嵌用户名或密码' };
  if (u.hash) return { ok: false, error: 'Base URL 不应包含锚点' };
  if (u.search && !opts.requestUrl) return { ok: false, error: 'Base URL 不应包含查询参数或锚点' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = +(u.port || (u.protocol === 'https:' ? 443 : 80));
  const local = policy.localTargets.has(hostPort(host, port));
  if (!local) {
    if (policy.allowedHosts.length && !OFFICIAL_HOSTS.has(host) && !policy.allowedHosts.includes(host)) {
      return { ok: false, error: '主机 ' + host + ' 不在 ALLOWED_BASE_HOSTS 允许列表中' };
    }
    if (u.protocol !== 'https:') return { ok: false, error: '远程接口必须使用 https（本地模型请在 LOCAL_MODEL_TARGETS 中显式声明 host:port）' };
    if (port !== 443 && !policy.extraPorts.has(port)) return { ok: false, error: '端口 ' + port + ' 不允许（默认仅 443，可用 ALLOWED_BASE_PORTS 追加）' };
  }
  return { ok: true, url: u, host, port, local };
}

/*
 * 完整解析与校验（每次出站前）：语法检查 + DNS 解析 + 逐个地址分类。
 * 返回 { ok, url, host, port, local, address, family } —— address 即应当固定连接的那个 IP。
 */
async function resolveTarget(raw, policy, opts = {}) {
  const c = checkBaseUrlSyntax(raw, policy, opts);
  if (!c.ok) return c;
  // Explicit trust decision for cloud runtimes without direct DNS. Never infer
  // delegation from a DNS failure. Restrict it to named official/allowlisted
  // public-domain destinations, not IP literals or obvious local hostnames.
  // The proxy, rather than this process, must enforce resolved-IP policy here.
  const publicName = !net.isIP(c.host) && c.host.includes('.') && !/(^|\.)(localhost|local|internal|lan)$/.test(c.host);
  if (!c.local && policy.httpsProxy && policy.proxyDnsDelegate && publicName &&
      (OFFICIAL_HOSTS.has(c.host) || policy.allowedHosts.includes(c.host))) {
    return { ...c, address: null, family: 0, proxyDnsDelegated: true };
  }
  let addrs;
  if (net.isIP(c.host)) addrs = [{ address: c.host, family: net.isIPv6(c.host) ? 6 : 4 }];
  else {
    const ms = policy.dnsTimeoutMs > 0 ? policy.dnsTimeoutMs : 5000;
    let timer;
    try {
      const look = policy.lookup ? policy.lookup(c.host) : dns.lookup(c.host, { all: true, verbatim: true });
      addrs = await Promise.race([look, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('dns timeout')), ms); })]);
    } catch (e) { return { ok: false, error: e && e.message === 'dns timeout' ? 'DNS 解析超时（' + ms + 'ms）：' + c.host : '无法解析主机 ' + c.host }; }
    finally { clearTimeout(timer); }
    if (!addrs || !addrs.length) return { ok: false, error: '无法解析主机 ' + c.host };
  }
  for (const a of addrs) {
    const k = classifyIp(a.address);
    const good = c.local ? (k === 'loopback' || k === 'private') : k === 'public';
    if (!good) return { ok: false, error: '主机 ' + c.host + ' 解析到不允许的地址（' + k + '）：' + a.address };
  }
  return { ...c, address: addrs[0].address, family: addrs[0].family || (net.isIPv6(addrs[0].address) ? 6 : 4) };
}

/*
 * CONNECT uses the original hostname because managed proxies enforce domain
 * policies and inject destination-bound credentials. Resolve/classify the
 * destination before opening the tunnel, and verify its TLS hostname/chain.
 * Limitation: the trusted proxy resolves the hostname again; only direct
 * connections are DNS-pinned. The proxy must independently reject private and
 * metadata destinations to close the DNS-rebinding window on that route.
 */
function proxyTunnel(target, rawProxy, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let proxy;
    try { proxy = new URL(rawProxy); } catch { return reject(new Error('HTTPS_PROXY 格式不正确')); }
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.pathname !== '/' || proxy.search || proxy.hash) return reject(new Error('HTTPS_PROXY 必须是 http(s) 代理地址，不能含路径或查询参数'));
    const authority = hostPort(target.host, target.port);
    const headers = { host: authority };
    if (proxy.username || proxy.password) {
      try { headers['proxy-authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64'); }
      catch { return reject(new Error('HTTPS_PROXY 认证格式不正确')); }
    }
    let socket, secureSocket, settled = false;
    const mod = proxy.protocol === 'https:' ? https : http;
    const req = mod.request({ method: 'CONNECT', hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), path: authority, headers, agent: false });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { req.destroy(); secureSocket?.destroy(); socket?.destroy(); reject(error); }
      else resolve(value);
    };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('代理请求已取消'));
    const timer = setTimeout(() => finish(new Error('HTTPS_PROXY CONNECT/TLS 超时')), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    req.once('error', e => finish(new Error('HTTPS_PROXY 连接失败：' + e.code)));
    req.once('connect', (response, raw, head) => {
      socket = raw;
      if (response.statusCode !== 200) return finish(new Error('HTTPS_PROXY CONNECT 被拒绝（HTTP ' + response.statusCode + '）'));
      if (head.length) raw.unshift(head);
      secureSocket = tls.connect({ socket: raw, host: target.host, servername: net.isIP(target.host) ? undefined : target.host, rejectUnauthorized: true });
      secureSocket.once('error', e => finish(new Error('目标 TLS 验证/连接失败：' + (e.code || e.message))));
      secureSocket.once('secureConnect', () => finish(null, secureSocket));
    });
    req.end();
  });
}

/*
 * 返回标准 Response。不跟随重定向（3xx 直接报错）。
 * 直连：固定解析 IP。公共 HTTPS：若配置代理则强制 CONNECT；不直连回退。
 * opts: { method, headers, body, signal }
 */
async function pinnedFetch(rawUrl, opts, policy) {
  // 请求地址可带查询参数（例如 Anthropic 模型列表 ?limit=100）；主机、协议、端口与 IP 校验不变。
  const t = await resolveTarget(rawUrl, policy, { requestUrl: true });
  if (!t.ok) throw new Error('Base URL 被拒绝：' + t.error);
  const mod = t.url.protocol === 'https:' ? https : http;
  const body = opts.body == null ? null : Buffer.from(opts.body);
  const headers = { ...(opts.headers || {}) };
  if (body) headers['content-length'] = body.length;
  const pinned = (host, o, cb) => { // 只返回已校验过的地址，不再做第二次解析
    if (o && o.all) cb(null, [{ address: t.address, family: t.family }]); else cb(null, t.address, t.family);
  };
  let agent = false;
  if (!t.local && policy.httpsProxy) {
    const socket = await proxyTunnel(t, policy.httpsProxy, { signal: opts.signal, timeoutMs: policy.proxyTimeoutMs || 15000 });
    agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
  }
  return new Promise((resolve, reject) => {
    const reqOpts = {
      method: opts.method || 'GET', hostname: t.url.hostname.replace(/^\[|\]$/g, ''), port: t.port,
      path: t.url.pathname + t.url.search, headers, agent, lookup: pinned,
    };
    if (mod === https && !net.isIP(reqOpts.hostname)) reqOpts.servername = reqOpts.hostname;
    let res = null;
    const req = mod.request(reqOpts, r => {
      res = r;
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); req.destroy(); return reject(new Error('不允许重定向（HTTP ' + r.statusCode + '）')); }
      const h = new Headers();
      for (const [k, v] of Object.entries(r.headers)) { try { h.set(k, Array.isArray(v) ? v.join(', ') : String(v)); } catch { /* 忽略非法头 */ } }
      const nullBody = r.statusCode === 204 || r.statusCode === 205 || r.statusCode === 304;
      let stream = r;
      if (!nullBody) { // 响应体总量上限：超过即中断，防止恶意 / 故障上游撑爆内存
        const max = opts.maxBytes > 0 ? opts.maxBytes : (policy.maxResponseBytes || 16 << 20);
        let seen = 0;
        stream = r.pipe(new Transform({ transform(chunk, _e, cb) { seen += chunk.length; if (seen > max) cb(new Error('响应体超过 ' + max + ' 字节上限')); else cb(null, chunk); } }));
        r.on('error', e => stream.destroy(e));
      }
      resolve(new Response(nullBody ? null : Readable.toWeb(stream), { status: r.statusCode, statusText: r.statusMessage || '', headers: h }));
    });
    if (agent) req.once('close', () => agent.destroy());
    const onAbort = () => { const reason = opts.signal.reason || new Error('aborted'); if (res) res.destroy(reason); else req.destroy(reason); reject(reason); };
    if (opts.signal) { if (opts.signal.aborted) return onAbort(); opts.signal.addEventListener('abort', onAbort, { once: true }); req.on('close', () => opts.signal.removeEventListener('abort', onAbort)); }
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ 密钥脱敏 */
const SECRET_PATTERNS = [/\bsk-[A-Za-z0-9_-]{8,}/g, /\b(?:pk|rk|key)-[A-Za-z0-9_-]{12,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, /\bx-api-key\s*[:=]\s*\S+/gi];
/* 从任何将写入事件、日志、任务记录的文本里去掉已知密钥和常见密钥形态 */
function scrubSecrets(text, secrets = []) {
  let s = String(text == null ? '' : text);
  for (const k of secrets) if (k && String(k).length >= 6) s = s.split(String(k)).join('[已隐藏]');
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[已隐藏]');
  return s;
}

/* ------------------------------------------------------------------ 防爆破与限流 */
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

module.exports = {
  OFFICIAL_HOSTS, ENV_KEY_HOST, isAllowedEnvKey, envKeyHostOk, classifyIp, policyFromEnv,
  checkBaseUrlSyntax, resolveTarget, pinnedFetch, scrubSecrets, AuthThrottle, RateLimiter,
};
