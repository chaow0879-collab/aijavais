'use strict';
/*
 * 访问控制（Permission & Audit 的鉴权部分）：识别请求主体、三级可见性、字段允许列表脱敏。
 *
 * 主体（principal）：
 *   local      本机回环访问（127.0.0.1 且 Host 为 localhost）——等同管理员，便于单机使用
 *   admin      持管理令牌（x-admin-token 或 Authorization: Bearer）
 *   ingest     持外部上报凭证（x-ingest-token，或在上述头里放上报凭证）——只能 POST /api/event
 *   viewer     持观看令牌（VIEW_TOKEN；浏览器通过 ?view=令牌 换取 HttpOnly Cookie，大屏无需改代码）
 *   anonymous  未提供凭证
 * 可见级别：2 完整（local/admin）；1 观看者；0 匿名（ingest 不能订阅事件流）。
 * 脱敏采用“允许列表”：只输出列出的字段，新增字段默认不外泄。
 */
const crypto = require('crypto');

const LEVEL = Object.freeze({ ANON: 0, VIEWER: 1, ADMIN: 2 });

/* 事件：匿名只保留驱动大屏动画所需字段；观看者另加任务标题、错误摘要与关联 ID；管理员完整 */
const EVENT_L0 = ['v', 'eventId', 'sequence', 'timestamp', 'eventType', 'status', 'source', 'verification', 'agentId', 'attempt', 'durationMs', 'tokenUsage',
  'type', 't', 'agent', 'label', 'model', 'role', 'tokens', 'ms', 'to', 'working'];
const EVENT_L1 = [...EVENT_L0, 'taskId', 'runId', 'spanId', 'parentSpanId', 'agentInstanceId', 'roleId', 'task', 'error', 'toolName'];
const AGENT_L0 = ['id', 'label', 'model', 'role', 'status', 'calls', 'tokens', 'estimatedTokens', 'errors', 'since', 'last', 'ms', 'live', 'source', 'verification'];
const AGENT_L1 = [...AGENT_L0, 'task'];
const FIELDS = { event: { 0: EVENT_L0, 1: EVENT_L1 }, agent: { 0: AGENT_L0, 1: AGENT_L1 } };

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k];
  return o;
}
function redactEvent(ev, level) {
  if (!ev || typeof ev !== 'object' || level >= LEVEL.ADMIN) return ev;
  return pick(ev, FIELDS.event[level >= LEVEL.VIEWER ? 1 : 0]);
}
function redactAgent(a, level) {
  if (!a || typeof a !== 'object' || level >= LEVEL.ADMIN) return a;
  return pick(a, FIELDS.agent[level >= LEVEL.VIEWER ? 1 : 0]);
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isLoopbackAddr = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const localHostHeader = req => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { const k = part.slice(0, i).trim(); if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 忽略 */ } } }
  }
  return out;
}

/*
 * opts: { adminToken: () => string, viewToken: string, ingestTokens: () => [{ name, hash, agents }], trustProxy: bool }
 */
function createAccess(opts) {
  const ingestMatch = token => {
    const h = sha256(token);
    for (const t of opts.ingestTokens()) if (t.hash && safeEq(h, t.hash)) return t;
    return null;
  };
  /* 按令牌值判定主体；无法识别返回 null */
  const byToken = token => {
    const admin = opts.adminToken();
    if (admin && safeEq(token, admin)) return { kind: 'admin', level: LEVEL.ADMIN, id: 'admin' };
    const ing = ingestMatch(token);
    if (ing) return { kind: 'ingest', level: LEVEL.ANON, id: 'ingest:' + ing.name, agents: Array.isArray(ing.agents) ? ing.agents : [] };
    if (opts.viewToken && safeEq(token, opts.viewToken)) return { kind: 'viewer', level: LEVEL.VIEWER, id: 'viewer' };
    return null;
  };

  function clientIp(req) {
    if (opts.trustProxy) {
      const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (f) return f.slice(0, 64);
    }
    return req.socket.remoteAddress || '';
  }

  /* 返回 { kind, level, id, agents?, presented, invalid } */
  function identify(req) {
    const headerTok = req.headers['x-ingest-token'] || req.headers['x-admin-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const cookieTok = parseCookies(req.headers.cookie).aij_view;
    const presented = !!(headerTok || cookieTok);
    if (isLoopbackAddr(req.socket.remoteAddress) && localHostHeader(req)) return { kind: 'local', level: LEVEL.ADMIN, id: 'local', presented, invalid: false };
    if (headerTok) {
      const p = byToken(String(headerTok));
      if (p) return { ...p, presented, invalid: false };
      return { kind: 'anonymous', level: LEVEL.ANON, id: 'anonymous', presented, invalid: true };
    }
    if (cookieTok) {
      if (opts.viewToken && safeEq(cookieTok, opts.viewToken)) return { kind: 'viewer', level: LEVEL.VIEWER, id: 'viewer', presented, invalid: false };
      return { kind: 'anonymous', level: LEVEL.ANON, id: 'anonymous', presented, invalid: true };
    }
    return { kind: 'anonymous', level: LEVEL.ANON, id: 'anonymous', presented: false, invalid: false };
  }

  /* 观看令牌是否有效（用于 ?view= 换 Cookie） */
  const viewTokenOk = t => !!(opts.viewToken && t && safeEq(t, opts.viewToken));

  return { identify, clientIp, viewTokenOk };
}

/* 生成上报凭证：明文只返回一次，配置里只保存哈希 */
function newIngestToken() {
  const token = 'aij_ing_' + crypto.randomBytes(18).toString('base64url');
  return { token, hash: sha256(token), hint: token.slice(-4) };
}

module.exports = { LEVEL, FIELDS, redactEvent, redactAgent, createAccess, newIngestToken, parseCookies, sha256 };
