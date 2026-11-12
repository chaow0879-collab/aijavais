'use strict';
/*
 * 访问控制（第四阶段 4A 起）：只认服务端会话与外部上报凭证，二者严格分离。
 *
 * 主体（principal）：
 *   admin     已登录的管理员会话（Cookie aij_session）——全部接口，事件流完整级别
 *   display   大屏观看会话（管理员生成的一次性链接换得）——只能看大屏与事件流（第 1 级）
 *   user      B8 使用者（前台账号，用户名+密码）——只能操作自己的项目；事件流按匿名级别脱敏（第 0 级）
 *   ingest    外部上报凭证（x-ingest-token）——只能 POST /api/event，不能登录、不能看任何数据
 *   local     仅当显式开启 AIJ_LOCAL_INGEST=1 且未设置 TRUST_PROXY 时，本机回环连接可上报事件（不授予任何其它权限）
 *   none      未登录
 * 不再有：localhost Host 头特权、管理令牌登录、匿名观看。
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

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { const k = part.slice(0, i).trim(); if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 忽略 */ } } }
  }
  return out;
}

/*
 * opts: { auth: AuthStore, ingestTokens: () => [{ name, hash, agents }], trustProxy: bool, localIngest: bool, userActive: userId => bool }
 */
function createAccess(opts) {
  const ingestMatch = token => {
    const h = sha256(token);
    for (const t of opts.ingestTokens()) if (t.hash && safeEq(h, t.hash)) return t;
    return null;
  };
  function clientIp(req) {
    if (opts.trustProxy) {
      const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (f) return f.slice(0, 64);
    }
    return req.socket.remoteAddress || '';
  }
  /* 返回 { kind, level, id, sid?, agents?, presented, invalid } */
  function identify(req) {
    const cookieTok = parseCookies(req.headers.cookie).aij_session;
    const ingestTok = req.headers['x-ingest-token'];
    const presented = !!(cookieTok || ingestTok);
    if (ingestTok) {
      const t = ingestMatch(String(ingestTok));
      if (t) return { kind: 'ingest', level: LEVEL.ANON, id: 'ingest:' + t.name, agents: Array.isArray(t.agents) ? t.agents : [], presented, invalid: false };
      return { kind: 'none', level: LEVEL.ANON, id: 'none', presented, invalid: true };
    }
    if (cookieTok) {
      const s = opts.auth.getSession(cookieTok);
      /* B8: a front-end user sees only anonymous-level live events (no titles/IDs of anyone's tasks) and
       * their own projects through the owner-checked API; a disabled/deleted user is treated as logged out. */
      if (s && s.kind === 'user') {
        if (!opts.userActive || !opts.userActive(s.userId)) return { kind: 'none', level: LEVEL.ANON, id: 'none', presented, invalid: false, expired: true };
        return { kind: 'user', level: LEVEL.ANON, id: 'user:' + s.userId, userId: s.userId, sid: s.sid, session: s, presented, invalid: false };
      }
      if (s) return { kind: s.kind, level: s.kind === 'admin' ? LEVEL.ADMIN : LEVEL.VIEWER, id: s.kind === 'admin' ? 'admin' : 'display:' + s.sid, sid: s.sid, session: s, presented, invalid: false };
      return { kind: 'none', level: LEVEL.ANON, id: 'none', presented, invalid: false, expired: true }; // 过期 / 已撤销的会话不计入暴力破解
    }
    if (opts.localIngest && !opts.trustProxy && isLoopbackAddr(req.socket.remoteAddress)) return { kind: 'local', level: LEVEL.ANON, id: 'local', presented: false, invalid: false };
    return { kind: 'none', level: LEVEL.ANON, id: 'none', presented: false, invalid: false };
  }
  return { identify, clientIp };
}

/* 生成上报凭证：明文只返回一次，配置里只保存哈希 */
function newIngestToken() {
  const token = 'aij_ing_' + crypto.randomBytes(18).toString('base64url');
  return { token, hash: sha256(token), hint: token.slice(-4) };
}

module.exports = { LEVEL, FIELDS, redactEvent, redactAgent, createAccess, newIngestToken, parseCookies, sha256 };
