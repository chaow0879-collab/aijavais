'use strict';
/*
 * 个人部署的登录与会话（第四阶段 4A）。
 *
 * - 首次使用：服务端生成一次性“设置码”，只打印在服务器控制台并写入 data/setup-code.txt（0600）。
 *   只有能看到服务器本机的人才能拿到设置码 → 设置管理员密码。公网上的陌生人即使先打开页面也无法抢先设置。
 * - 密码：scrypt（N=2^15, r=8, p=1, 64 字节）+ 随机盐，只存哈希；比较用常量时间。
 * - 会话：32 字节随机令牌放在 HttpOnly / SameSite=Strict Cookie；服务端只存令牌的 SHA-256。
 *   空闲超时 + 绝对过期；支持退出、撤销单个会话、撤销全部；改密码撤销其它所有会话。
 * - 大屏观看链接：管理员生成一次性链接（10 分钟内有效、只能用一次），打开后得到只读的“观看会话”。
 * - 本地恢复：tools/reset-password.js 在服务器本机运行，清除密码与全部会话并生成新设置码；运行中的服务检测到文件变化后自动重新加载。
 * - 审计：登录、失败、退出、改密码、撤销、设置等写入 data/audit.log（JSON 行，超过 1MB 轮转）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 });
const DEFAULTS = Object.freeze({ idleMs: 8 * 3600e3, absoluteMs: 7 * 24 * 3600e3, displayMaxMs: 30 * 24 * 3600e3, linkMs: 10 * 60e3, maxSessions: 200 }); // B8: user sessions share the store; 200 keeps an admin session from being evicted by a few users
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqHex = (a, b) => { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const scryptAsync = (pw, salt, o = SCRYPT) => new Promise((res, rej) => crypto.scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: SCRYPT.maxmem }, (e, k) => (e ? rej(e) : res(k))));

function passwordProblem(pw) {
  if (typeof pw !== 'string') return '密码格式不正确';
  if (pw.length < 10) return '密码至少 10 个字符';
  if (pw.length > 200) return '密码最多 200 个字符';
  if (/^(.)\1+$/.test(pw)) return '密码不能是同一个字符重复';
  if (/^(0123456789|1234567890|password|qwertyuiop)/i.test(pw)) return '密码过于简单';
  return null;
}
/* 设置码：12 位，去掉易混淆字符，约 60 位熵；显示为 XXXX-XXXX-XXXX */
function newSetupCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += A[b[i] % A.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

class AuthStore {
  constructor({ dir, options = {}, now = Date.now }) {
    this.dir = dir;
    this.o = { ...DEFAULTS, ...options };
    this.now = now;
    this.files = { auth: path.join(dir, 'auth.json'), sessions: path.join(dir, 'sessions.json'), code: path.join(dir, 'setup-code.txt'), audit: path.join(dir, 'audit.log') };
    this.mtimes = {};
    this.auth = {};
    this.sessions = [];
    this.links = new Map(); // 观看链接（一次性，内存中，10 分钟过期）
    this._lastSeenSave = 0;
    this._passwordMutation = false;
    this.reload(true);
  }

  /* ---------------- 持久化 ---------------- */
  _mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }
  /* 外部（本地恢复工具）修改了文件时重新加载 */
  reload(force = false) {
    const ma = this._mtime(this.files.auth), ms = this._mtime(this.files.sessions);
    if (force || ma !== this.mtimes.auth) {
      try { this.auth = JSON.parse(fs.readFileSync(this.files.auth, 'utf8')) || {}; } catch { this.auth = {}; }
      this.mtimes.auth = ma;
    }
    if (force || ms !== this.mtimes.sessions) {
      try { const s = JSON.parse(fs.readFileSync(this.files.sessions, 'utf8')); this.sessions = Array.isArray(s) ? s : []; } catch { this.sessions = []; }
      this.mtimes.sessions = ms;
    }
  }
  _write(file, obj) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return this._mtime(file);
  }
  _saveAuth() { this.mtimes.auth = this._write(this.files.auth, this.auth); }
  _saveSessions() { this.mtimes.sessions = this._write(this.files.sessions, this.sessions); }
  /* 返回 true 表示审计行已写入；写入失败返回 false（不抛出，审计失败不影响登录等服务）。 */
  audit(event, detail = {}) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (this._mtime(this.files.audit) && fs.statSync(this.files.audit).size > 1 << 20) fs.renameSync(this.files.audit, this.files.audit + '.1');
      fs.appendFileSync(this.files.audit, JSON.stringify({ t: new Date(this.now()).toISOString(), event, ...detail }) + '\n', { mode: 0o600 });
      return true;
    } catch { return false; /* 审计失败不影响服务，但如实告知调用方 */ }
  }

  /* ---------------- 首次设置 ---------------- */
  isSetup() { this.reload(); return !!(this.auth.password && this.auth.password.hash); }
  /* 未设置密码时确保存在设置码；返回明文（仅在新生成时），否则 null */
  ensureSetupCode() {
    this.reload();
    if (this.isSetup()) return null;
    if (this.auth.setupCodeHash && fs.existsSync(this.files.code)) return null;
    const code = newSetupCode();
    this.auth.setupCodeHash = sha256(normCode(code));
    this._saveAuth();
    this._write(this.files.code, `AIJAVAIS 首次设置码（只用一次）：${code}\n生成时间：${new Date(this.now()).toISOString()}\n`);
    this.audit('setup_code_generated');
    return code;
  }
  readSetupCodeFile() { try { return fs.readFileSync(this.files.code, 'utf8'); } catch { return ''; } }
  async setup(code, password, meta = {}) {
    if (this._passwordMutation) return { ok: false, code: 409, error: '密码操作正在处理，请稍后重试' };
    this._passwordMutation = true;
    try {
      this.reload(true);
      if (this.isSetup()) return { ok: false, code: 409, error: '已经设置过密码，请直接登录' };
      const setupHash = this.auth.setupCodeHash;
      if (!setupHash || !safeEqHex(sha256(normCode(code)), setupHash)) { this.audit('setup_failed', meta); return { ok: false, code: 401, error: '设置码不正确（见服务器控制台或 data/setup-code.txt）' }; }
      const bad = passwordProblem(password);
      if (bad) return { ok: false, code: 400, error: bad };
      const record = await this._passwordRecord(password);
      // scrypt yields to other requests and the local recovery tool. Re-read
      // before the synchronous commit; never overwrite a newer password/reset.
      this.reload(true);
      if (this.auth.password?.hash || this.auth.setupCodeHash !== setupHash) return { ok: false, code: 409, error: '账户状态已变化，请重新加载后操作' };
      this.auth.password = record;
      delete this.auth.setupCodeHash;
      this._saveAuth();
      try { fs.unlinkSync(this.files.code); } catch { /* 已不存在 */ }
      this.audit('setup_done', meta);
      return { ok: true };
    } finally { this._passwordMutation = false; }
  }
  async _passwordRecord(pw) {
    const salt = crypto.randomBytes(16);
    const key = await scryptAsync(pw, salt);
    return { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen, salt: salt.toString('hex'), hash: key.toString('hex'), changedAt: this.now() };
  }
  async verifyPassword(pw) {
    this.reload();
    const p = this.auth.password;
    if (!p || typeof pw !== 'string' || pw.length > 200) { await scryptAsync('x', 'dummy-salt-0000'); return false; } // 无论是否存在都耗费相同时间
    const key = await scryptAsync(pw, Buffer.from(p.salt, 'hex'), { N: p.N, r: p.r, p: p.p, keylen: p.keylen });
    this.reload(true);
    return this.auth.password?.hash === p.hash && safeEqHex(key.toString('hex'), p.hash);
  }
  async changePassword(current, next, keepSid, meta = {}) {
    if (this._passwordMutation) return { ok: false, code: 409, error: '密码操作正在处理，请稍后重试' };
    this._passwordMutation = true;
    try {
      this.reload(true);
      const passwordHash = this.auth.password?.hash;
      if (!(await this.verifyPassword(current))) { this.audit('password_change_failed', meta); return { ok: false, code: 401, error: '当前密码不正确' }; }
      const bad = passwordProblem(next);
      if (bad) return { ok: false, code: 400, error: bad };
      const record = await this._passwordRecord(next);
      this.reload(true);
      if (!passwordHash || this.auth.password?.hash !== passwordHash) return { ok: false, code: 409, error: '账户状态已变化，请重新登录后操作' };
      this.auth.password = record;
      this._saveAuth();
      const n = this.revokeAll(keepSid, 'password_changed');
      this.audit('password_changed', { ...meta, revoked: n });
      return { ok: true, revoked: n };
    } finally { this._passwordMutation = false; }
  }

  /* ---------------- 会话 ---------------- */
  _expired(s, now) {
    if (now > s.expiresAt) return true;
    if ((s.kind === 'admin' || s.kind === 'user') && now - s.lastSeen > this.o.idleMs) return true; // B8: users idle out like the admin
    return false;
  }
  _gc(now = this.now()) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => !this._expired(s, now));
    return before !== this.sessions.length;
  }
  createSession(kind, meta = {}, absoluteMs) {
    this.reload();
    const now = this.now();
    this._gc(now);
    while (this.sessions.length >= this.o.maxSessions) this.sessions.shift();
    const token = crypto.randomBytes(32).toString('base64url');
    const idHash = sha256(token);
    if (kind === 'user' && (typeof meta.userId !== 'string' || !meta.userId)) throw new Error('user session requires a userId');
    const s = { sid: idHash.slice(0, 16), idHash, kind, ...(kind === 'user' ? { userId: meta.userId } : {}), createdAt: now, lastSeen: now, expiresAt: now + Math.min(absoluteMs || this.o.absoluteMs, kind === 'display' ? this.o.displayMaxMs : this.o.absoluteMs),
      ip: String(meta.ip || '').slice(0, 64), ua: String(meta.ua || '').slice(0, 120), label: String(meta.label || '').slice(0, 40) };
    this.sessions.push(s);
    this._saveSessions();
    this.audit(kind === 'display' ? 'display_session_created' : kind === 'user' ? 'user_login' : 'login', { sid: s.sid, ip: s.ip, label: s.label, ...(s.userId ? { userId: s.userId } : {}) });
    return { token, session: this._public(s) };
  }
  /* 校验 Cookie 里的令牌；有效则刷新最后活动时间 */
  getSession(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    this.reload();
    const now = this.now();
    const h = sha256(token);
    const s = this.sessions.find(x => safeEqHex(x.idHash, h));
    if (!s) return null;
    if (this._expired(s, now)) { this.sessions = this.sessions.filter(x => x !== s); this._saveSessions(); return null; }
    s.lastSeen = now;
    if (now - this._lastSeenSave > 60e3) { this._lastSeenSave = now; this._saveSessions(); } // 最后活动时间每分钟最多落盘一次
    return this._public(s);
  }
  _public(s) { return { sid: s.sid, kind: s.kind, ...(s.userId ? { userId: s.userId } : {}), createdAt: s.createdAt, lastSeen: s.lastSeen, expiresAt: s.expiresAt, ip: s.ip, ua: s.ua, label: s.label }; }
  list() { this.reload(); this._gc(); return this.sessions.map(s => this._public(s)); }
  revoke(sid, reason = 'revoked') {
    this.reload();
    const i = this.sessions.findIndex(s => s.sid === sid);
    if (i < 0) return false;
    this.sessions.splice(i, 1);
    this._saveSessions();
    this.audit('session_revoked', { sid, reason });
    return true;
  }
  /* B8: a disabled user / password reset ends every session of that user at once */
  revokeUser(userId, reason = 'user_revoked') {
    this.reload();
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => !(s.kind === 'user' && s.userId === userId));
    const n = before - this.sessions.length;
    if (n) { this._saveSessions(); this.audit('user_sessions_revoked', { userId, count: n, reason }); }
    return n;
  }
  revokeAll(exceptSid = null, reason = 'revoke_all') {
    this.reload();
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.sid === exceptSid);
    this._saveSessions();
    const n = before - this.sessions.length;
    if (n) this.audit('sessions_revoked_all', { except: exceptSid, count: n, reason });
    return n;
  }

  /* ---------------- 大屏观看链接 ---------------- */
  createDisplayLink({ label = '大屏', hours = 24 } = {}) {
    const now = this.now();
    for (const [k, v] of this.links) if (now > v.expiresAt) this.links.delete(k);
    const token = crypto.randomBytes(24).toString('base64url');
    const h = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
    this.links.set(sha256(token), { label: String(label).slice(0, 40), displayMs: h * 3600e3, expiresAt: now + this.o.linkMs });
    this.audit('display_link_created', { label, hours: h });
    return { token, linkExpiresAt: now + this.o.linkMs, sessionHours: h };
  }
  redeemDisplayLink(token, meta = {}) {
    const k = sha256(String(token || ''));
    const v = this.links.get(k);
    if (!v) return null;
    this.links.delete(k); // 一次性
    if (this.now() > v.expiresAt) return null;
    return this.createSession('display', { ...meta, label: v.label }, v.displayMs);
  }

  /* ---------------- 本地恢复（tools/reset-password.js 调用） ---------------- */
  resetLocal() {
    this.reload(true);
    delete this.auth.password;
    this.auth.setupCodeHash = null;
    this._saveAuth();
    this.sessions = [];
    this._saveSessions();
    try { fs.unlinkSync(this.files.code); } catch { /* 无 */ }
    this.audit('local_password_reset');
    return this.ensureSetupCode();
  }
}

module.exports = { AuthStore, passwordProblem, newSetupCode, SCRYPT, AUTH_DEFAULTS: DEFAULTS };
