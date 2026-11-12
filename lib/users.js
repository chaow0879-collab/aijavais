'use strict';
/*
 * B8 使用者（前台账号）。
 *
 * - 管理员仍是 auth.json 里的单管理员；使用者存 SQLite users 表（schema v5），用户名 + scrypt 密码（与管理员同参数），
 *   只存盐和哈希，不存明文，任何接口都不回传密码记录。
 * - 每个使用者有每月人民币上限（整数分）。本月 = 北京时间（UTC+8）自然月。
 * - 本月已花费按费用发生时间（AUD-C159-01）：本月写入账本的费用，加上所有还可能花钱的运行（不论哪个月创建）本轮剩余的已批准上限。
 * - 引擎账本是美元；换算用与新建页（public/smart-plan.js）相同的固定汇率 7.5（故意高于市价），
 *   所以按人民币确认的金额换回人民币不会变少。估算不等于厂商账单。
 */
const crypto = require('crypto');
const { passwordProblem, SCRYPT } = require('./auth');
const { ProjectError } = require('./project-store');

const FX = 7.5;
const TZ_MS = 8 * 3600e3;
const MAX_CAP_FEN = 100000 * 100;
const USERNAME = /^[A-Za-z0-9_.\-一-龥]{2,32}$/;
const scryptAsync = (pw, salt, o = SCRYPT) => new Promise((res, rej) => crypto.scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: SCRYPT.maxmem }, (e, k) => (e ? rej(e) : res(k))));
const safeEqHex = (a, b) => { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

function monthStart(now) { const d = new Date(now + TZ_MS); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_MS; }
const usdToFen = usd => Math.max(0, Math.ceil(Number(usd) * FX * 100 - 1e-6)); // 向上取整：已花费只会算多，不会算少
const yuan = fen => '¥' + (fen / 100).toFixed(2);

function capFen(value) {
  // QA-B8-03: a blank cap is never silently ¥0; the administrator has to type 0 on purpose
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) throw new ProjectError('请填每月上限（元）。填 0 表示这个人不能用收费模型', 'cap_required', 400);
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n * 100 > MAX_CAP_FEN) throw new ProjectError('每月上限要填 0 到 100000 之间的人民币金额', 'invalid_cap', 400);
  return Math.floor(n * 100 + 1e-9);
}
function cleanName(name) {
  const u = typeof name === 'string' ? name.trim() : '';
  if (!USERNAME.test(u)) throw new ProjectError('用户名 2–32 个字符，只能用中文、字母、数字、下划线、点或连字符', 'invalid_username', 400);
  return u;
}
async function hashPassword(pw, now) {
  const bad = passwordProblem(pw);
  if (bad) throw new ProjectError(bad, 'weak_password', 400);
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt);
  return { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen, salt: salt.toString('hex'), hash: key.toString('hex'), changedAt: now };
}

function createUsers({ store, now = Date.now, onRevoke = () => {}, audit = () => {} }) {
  if (!store) throw new Error('users requires the project store');
  function spend(user) {
    const since = monthStart(now());
    const s = store.ownerSpend(user.userId, since);
    const spentFen = usdToFen(s.committedUsd), settledFen = usdToFen(s.settledUsd);
    return { monthStart: since, capFen: user.monthlyCapFen, spentFen, settledFen, remainingFen: Math.max(0, user.monthlyCapFen - spentFen), activeRuns: s.activeRuns,
      capCny: user.monthlyCapFen / 100, spentCny: spentFen / 100, remainingCny: Math.max(0, user.monthlyCapFen - spentFen) / 100 };
  }
  const withSpend = u => (u ? { ...u, monthlyCapCny: u.monthlyCapFen / 100, month: spend(u) } : null);
  const must = userId => { const u = store.getUser(userId); if (!u) throw new ProjectError('使用者不存在', 'not_found', 404); return u; };
  return {
    FX,
    monthStart,
    list() { return store.listUsers().map(withSpend); },
    get(userId) { return withSpend(store.getUser(userId)); },
    /* 会话校验用：停用或删除的使用者立即失效 */
    active(userId) { const u = store.getUser(userId); return !!(u && u.enabled); },
    async create({ username, password, monthlyCapCny } = {}) {
      const name = cleanName(username), cap = capFen(monthlyCapCny);
      if (store.getUserCredentials(name)) throw new ProjectError('这个用户名已经有人用了', 'username_taken', 409);
      const u = store.createUser({ username: name, password: await hashPassword(password, now()), monthlyCapFen: cap });
      audit('user_created', { userId: u.userId, capFen: cap });
      return withSpend(u);
    },
    update(userId, { enabled, monthlyCapCny } = {}) {
      must(userId);
      if (enabled !== undefined && typeof enabled !== 'boolean') throw new ProjectError('enabled 只能是 true 或 false', 'invalid', 400);
      const u = store.updateUser(userId, { enabled, monthlyCapFen: monthlyCapCny === undefined ? undefined : capFen(monthlyCapCny) });
      if (enabled === false) onRevoke(userId, 'user_disabled');
      audit('user_updated', { userId, ...(enabled !== undefined ? { enabled } : {}), ...(monthlyCapCny !== undefined ? { capFen: u.monthlyCapFen } : {}) });
      return withSpend(u);
    },
    async resetPassword(userId, password) {
      must(userId);
      const u = store.updateUser(userId, { password: await hashPassword(password, now()) });
      onRevoke(userId, 'password_reset'); // 重置后旧会话全部失效
      audit('user_password_reset', { userId });
      return withSpend(u);
    },
    /* 常量时间：用户名不存在也算一次 scrypt；停用账号与密码错误给同一句话 */
    async authenticate(username, password) {
      const rec = typeof username === 'string' && username.length <= 64 ? store.getUserCredentials(username.trim()) : null;
      if (!rec || typeof password !== 'string' || password.length > 200) { await scryptAsync('x', 'dummy-salt-0000'); return null; }
      const p = rec.password;
      const key = await scryptAsync(password, Buffer.from(p.salt, 'hex'), { N: p.N, r: p.r, p: p.p, keylen: p.keylen });
      const fresh = store.getUserCredentials(rec.username);
      if (!fresh || fresh.password.hash !== p.hash || !safeEqHex(key.toString('hex'), p.hash) || !fresh.enabled) return null;
      return store.getUser(fresh.userId);
    },
    spend(userId) { return spend(must(userId)); },
    /* 运行 / 返工前：额度门禁。只收紧，不放宽引擎原有的预算门禁。addUsd = 本轮批准的上限（美元） */
    assertQuota(userId, addUsd) {
      const u = must(userId);
      if (!u.enabled) throw new ProjectError('这个账号已停用，请联系管理员', 'user_disabled', 403);
      const s = spend(u), add = Math.max(0, usdToFen(addUsd || 0));
      if (s.spentFen >= u.monthlyCapFen) throw new ProjectError('本月额度已用完，请联系管理员', 'monthly_quota_exhausted', 402);
      if (s.spentFen + add > u.monthlyCapFen) {
        const left = u.monthlyCapFen - s.spentFen;
        throw new ProjectError('本月额度只剩 ' + yuan(left) + '，这次最多要花 ' + yuan(add) + '。请把预算改到 ' + yuan(left) + ' 以内，或联系管理员', 'monthly_quota_insufficient', 402);
      }
      return s;
    },
  };
}

module.exports = { createUsers, monthStart, usdToFen, FX };
