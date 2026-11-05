'use strict';
/*
 * Model Registry：模型连接的注册、修改、停用、删除与查询。
 *
 * 概念：
 *   providerId    服务商（目录见 catalog/providers.v1.json，如 anthropic / openai / gemini / custom）
 *   connectionId  用户配置的一条模型连接（服务商 + 模型 + 凭证），平台内唯一；事件里的 agentId 就是它
 *   modelId       服务商侧的模型名
 * 注册信息与凭证分离：注册信息存 data/models.json；API Key 存 data/credentials.json（0600），列表接口永不返回明文。
 * 调度逻辑只认 connectionId 与能力标签，不认任何品牌。
 */
const crypto = require('crypto');
const SEC = require('./security');

const CONN_ID_RE = /^[\w-]{1,40}$/;
const PRICING = ['paid_api', 'free_tier', 'local', 'unknown'];

const str = (s, n) => String(s == null ? '' : s).slice(0, n);
const hostOf = u => { try { return new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; } };
const normBase = u => String(u || '').trim().replace(/\/+$/, '');

class ModelRegistry {
  /* catalog：服务商目录 JSON；policy：出站策略（lib/security.js）；env：环境变量（读取 envKey） */
  constructor({ catalog, policy, env = process.env }) {
    this.catalog = catalog;
    this.providers = new Map(catalog.providers.map(p => [p.providerId, p]));
    this.capTags = Object.keys(catalog.capabilities || {});
    this.policy = policy;
    this.env = env;
    this.connections = []; // 注册信息
    this.creds = {};       // connectionId -> { apiKey, envKey }
  }

  /* ---------------- 载入与迁移 ---------------- */
  load({ models, credentials } = {}) {
    this.connections = Array.isArray(models && models.connections) ? models.connections.filter(c => c && CONN_ID_RE.test(c.connectionId)) : [];
    this.creds = credentials && typeof credentials === 'object' ? credentials : {};
    for (const id of Object.keys(this.creds)) if (!this.get(id)) delete this.creds[id];
    for (const c of this.connections) {
      const k = this.creds[c.connectionId];
      if (k && k.envKey && !SEC.isAllowedEnvKey(k.envKey)) k.envKey = ''; // 不合规的 envKey 一律清空
    }
  }
  /* 旧版 config.json 里的 providers 迁移为模型连接：保留原 id 作为 connectionId（大屏 agentId 不变） */
  migrateLegacy(providers) {
    let n = 0;
    for (const p of Array.isArray(providers) ? providers : []) {
      if (!p || !CONN_ID_RE.test(String(p.id)) || this.get(p.id)) continue;
      const prov = this.inferProvider(p.baseUrl, p.type);
      this.connections.push({
        connectionId: p.id, providerId: prov.providerId, protocol: p.type === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: normBase(p.baseUrl), modelId: str(p.model, 80), displayName: str(p.label || p.id, 40),
        enabled: p.enabled !== false, capabilities: [], pricingMode: prov.pricingMode || 'unknown', notes: str(p.role, 80),
        createdAt: Date.now(), updatedAt: Date.now(), lastTest: null, migratedFrom: 'config.providers',
      });
      this.creds[p.id] = { apiKey: p.apiKey || '', envKey: SEC.isAllowedEnvKey(p.envKey) ? (p.envKey || '') : '' };
      n++;
    }
    return n;
  }
  inferProvider(baseUrl, type) {
    const host = hostOf(baseUrl);
    for (const p of this.providers.values()) if (p.baseUrl && hostOf(p.baseUrl) === host && p.providerId !== 'custom') return p;
    return this.providers.get('custom') || { providerId: 'custom', pricingMode: 'unknown', protocol: type === 'anthropic' ? 'anthropic' : 'openai' };
  }
  serialize() {
    return { models: { version: 1, connections: this.connections }, credentials: this.creds };
  }

  /* ---------------- 查询 ---------------- */
  get(id) { return this.connections.find(c => c.connectionId === id) || null; }
  has(id) { return !!this.get(id); }
  key(id) {
    const k = this.creds[id] || {};
    return k.apiKey || (k.envKey && SEC.isAllowedEnvKey(k.envKey) && this.env[k.envKey]) || '';
  }
  noKey(c) { const p = this.providers.get(c.providerId); return !!(p && p.noKey); }
  ready(id) { const c = this.get(id); return !!(c && c.modelId && c.baseUrl && (this.key(id) || this.noKey(c))); }
  status(id) {
    const c = this.get(id);
    if (!c) return 'missing';
    if (c.enabled === false) return 'disabled';
    if (!this.ready(id)) return 'not_ready';
    if (c.lastTest && !c.lastTest.ok) return 'error';
    if (c.lastTest && c.lastTest.ok) return 'available';
    return 'untested';
  }
  /* 公开视图：不含任何密钥 */
  view(c) {
    const k = this.creds[c.connectionId] || {};
    const prov = this.providers.get(c.providerId);
    return {
      connectionId: c.connectionId, providerId: c.providerId, providerName: prov ? prov.name : c.providerId, protocol: c.protocol,
      baseUrl: c.baseUrl, modelId: c.modelId, displayName: c.displayName, enabled: c.enabled !== false,
      capabilities: [...(c.capabilities || [])], pricingMode: c.pricingMode, pricingNote: prov ? prov.pricingNote : '', notes: c.notes || '',
      status: this.status(c.connectionId), ready: this.ready(c.connectionId), lastTest: c.lastTest || null,
      hasKey: !!k.apiKey, keyHint: k.apiKey ? '••••' + k.apiKey.slice(-4) : '', envKey: k.envKey || '', envReady: !!(k.envKey && this.env[k.envKey]),
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  }
  list() { return this.connections.map(c => this.view(c)); }
  getCapabilities(id) {
    const c = this.get(id);
    if (!c) return null;
    return { connectionId: id, declared: [...(c.capabilities || [])], verified: c.lastTest && c.lastTest.ok ? ['chat'] : [], pricingMode: c.pricingMode };
  }
  /* 调用模型用的运行时对象（含凭证，只在服务端内部使用，不得返回给客户端） */
  runtime(id) {
    const c = this.get(id);
    if (!c) return null;
    const k = this.creds[id] || {};
    return { id, label: c.displayName, type: c.protocol, baseUrl: c.baseUrl, model: c.modelId, apiKey: k.apiKey || '', envKey: k.envKey || '', enabled: c.enabled !== false, noKey: this.noKey(c) };
  }

  /* ---------------- 校验 ---------------- */
  _validate(next, existing, newKey, clearKey) {
    if (!next.displayName) return '请填写名称';
    if (!this.providers.has(next.providerId)) return '未知的服务商：' + next.providerId;
    if (!['anthropic', 'openai'].includes(next.protocol)) return '协议只能是 anthropic 或 openai';
    if (!SEC.isAllowedEnvKey(next.envKey)) return 'envKey 只能是 ' + Object.keys(SEC.ENV_KEY_HOST).join(' / ') + '，或以 AIJ_ 开头、以 _KEY 结尾的自定义名称';
    if (!PRICING.includes(next.pricingMode)) return 'pricingMode 只能是 ' + PRICING.join(' / ');
    const badCap = next.capabilities.find(t => !this.capTags.includes(t));
    if (badCap) return '未知的能力标签：' + badCap;
    let host = '';
    if (next.baseUrl) {
      const c = SEC.checkBaseUrlSyntax(next.baseUrl, this.policy);
      if (!c.ok) return c.error;
      host = c.host;
    }
    const keyAfter = clearKey ? '' : (newKey || (existing && this.creds[existing.connectionId]?.apiKey) || '');
    if (host && !keyAfter && next.envKey && !SEC.envKeyHostOk(next.envKey, host)) {
      return '环境变量 ' + next.envKey + ' 只能用于 ' + SEC.ENV_KEY_HOST[next.envKey] + '；第三方接口请直接填写 API Key，或改用 AIJ_ 开头的环境变量名';
    }
    /* 已保存的 API Key 不会自动转发到新主机：换主机必须重新填写 */
    if (existing && this.creds[existing.connectionId]?.apiKey && !newKey && !clearKey) {
      const old = hostOf(existing.baseUrl);
      if (old && host && old !== host) return '更换接口主机后需要重新填写 API Key（已保存的密钥不会自动发往新主机）';
    }
    return null;
  }

  /* 由输入构造注册信息：简易模式只需 providerId + modelId + apiKey，其余按服务商目录补齐 */
  _next(input, existing) {
    const providerId = str(input.providerId || (existing && existing.providerId) || 'custom', 30);
    const prov = this.providers.get(providerId);
    const pick = (k, dflt) => (input[k] !== undefined ? input[k] : existing ? existing[k] : dflt);
    const caps = pick('capabilities', []);
    return {
      providerId,
      protocol: str(pick('protocol', prov ? prov.protocol : 'openai'), 20),
      baseUrl: normBase(input.baseUrl !== undefined && input.baseUrl !== '' ? input.baseUrl : existing && existing.providerId === providerId ? existing.baseUrl : prov ? prov.baseUrl : ''),
      modelId: str(pick('modelId', ''), 80).trim(),
      displayName: str(pick('displayName', '') || (prov ? prov.name.replace(/（.*$/, '') : '') + (input.modelId ? ' · ' + input.modelId : ''), 40).trim(),
      enabled: pick('enabled', true) !== false,
      capabilities: Array.isArray(caps) ? [...new Set(caps.map(x => String(x)))].slice(0, 20) : [],
      pricingMode: str(pick('pricingMode', prov ? prov.pricingMode : 'unknown'), 20),
      notes: str(pick('notes', ''), 200),
      envKey: str(input.envKey !== undefined ? input.envKey : existing ? (this.creds[existing.connectionId]?.envKey || '') : prov ? prov.envKey || '' : '', 60).trim(),
    };
  }

  /* 保存前试连：按输入构造临时运行时对象（同样经过校验），不写入注册表 */
  draft(input = {}) {
    const next = this._next(input, null);
    const newKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const bad = this._validate(next, null, newKey, false);
    if (bad) return { ok: false, error: bad };
    if (!next.modelId) return { ok: false, error: '请先选择或填写模型' };
    const prov = this.providers.get(next.providerId);
    return { ok: true, runtime: { id: 'probe', label: '连接测试', type: next.protocol, baseUrl: next.baseUrl, model: next.modelId, apiKey: newKey, envKey: next.envKey, enabled: true, noKey: !!(prov && prov.noKey) } };
  }

  /* ---------------- 增删改 ---------------- */
  add(input = {}) {
    const next = this._next(input, null);
    const newKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const bad = this._validate(next, null, newKey, false);
    if (bad) return { ok: false, error: bad };
    let id = input.connectionId && CONN_ID_RE.test(input.connectionId) && !this.has(input.connectionId) ? input.connectionId : null;
    if (input.connectionId && !id) return { ok: false, error: 'connectionId 不合法或已存在' };
    while (!id || this.has(id)) id = 'mc_' + crypto.randomBytes(3).toString('hex');
    const { envKey, ...reg } = next;
    const now = Date.now();
    this.connections.push({ connectionId: id, ...reg, createdAt: now, updatedAt: now, lastTest: null });
    this.creds[id] = { apiKey: newKey, envKey };
    return { ok: true, connection: this.view(this.get(id)) };
  }
  update(id, input = {}) {
    const existing = this.get(id);
    if (!existing) return { ok: false, error: '模型连接不存在', code: 404 };
    const next = this._next(input, existing);
    const newKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const bad = this._validate(next, existing, newKey, !!input.clearKey);
    if (bad) return { ok: false, error: bad };
    const { envKey, ...reg } = next;
    const changedTarget = reg.baseUrl !== existing.baseUrl || reg.modelId !== existing.modelId || reg.protocol !== existing.protocol;
    Object.assign(existing, reg, { updatedAt: Date.now() });
    if (changedTarget) existing.lastTest = null; // 换了模型 / 接口，旧的测试结果作废
    const k = this.creds[id] || (this.creds[id] = { apiKey: '', envKey: '' });
    k.envKey = envKey;
    if (input.clearKey) k.apiKey = '';
    else if (newKey) { k.apiKey = newKey; existing.lastTest = null; }
    return { ok: true, connection: this.view(existing) };
  }
  setEnabled(id, enabled) {
    const c = this.get(id);
    if (!c) return { ok: false, error: '模型连接不存在', code: 404 };
    c.enabled = !!enabled; c.updatedAt = Date.now();
    return { ok: true, connection: this.view(c) };
  }
  recordTest(id, result) {
    const c = this.get(id);
    if (!c) return;
    c.lastTest = { ok: !!result.ok, at: Date.now(), ms: result.ms | 0, error: result.ok ? '' : str(result.error, 200), hint: result.ok ? '' : diagnose(result.error) };
  }
  /* 删除：调用方先用 impact() 检查引用；这里只负责移除注册信息与凭证 */
  remove(id) {
    const i = this.connections.findIndex(c => c.connectionId === id);
    if (i < 0) return { ok: false, error: '模型连接不存在', code: 404 };
    const [c] = this.connections.splice(i, 1);
    delete this.creds[id];
    return { ok: true, removed: { connectionId: c.connectionId, displayName: c.displayName, modelId: c.modelId, providerId: c.providerId } };
  }
}

/* 把连接错误翻译成普通用户能看懂的提示 */
function diagnose(err) {
  const e = String(err || '');
  if (!e) return '';
  if (/未配置 API Key|缺少 API Key/.test(e)) return '还没有填写 API Key。';
  if (/HTTP 401|HTTP 403|invalid.*key|Unauthorized|authentication/i.test(e)) return 'API Key 无效或没有权限：请检查是否复制完整、是否属于这个服务商。';
  if (/HTTP 404/.test(e)) return '找不到模型或接口：请检查模型名是否正确（可点“获取模型列表”选择）。';
  if (/HTTP 402|HTTP 429|quota|insufficient|余额|rate/i.test(e)) return '额度不足或请求过于频繁：请检查账户余额 / 免费额度，或稍后再试。';
  if (/HTTP 5\d\d/.test(e)) return '服务商暂时故障，请稍后重试。';
  if (/超时|timeout/i.test(e)) return '连接超时：网络不通或服务商响应太慢。';
  if (/DNS|无法解析/.test(e)) return '无法解析服务商地址：请检查网络或 Base URL。';
  if (/被拒绝|不允许|LOCAL_MODEL_TARGETS/.test(e)) return '安全策略拒绝了这个地址：本地模型需要管理员设置 LOCAL_MODEL_TARGETS，远程接口必须是 https。';
  if (/ECONNREFUSED|connect/i.test(e)) return '连接被拒绝：服务没有启动或地址端口不对。';
  return '连接失败，请查看错误详情。';
}

module.exports = { ModelRegistry, diagnose, CONN_ID_RE, PRICING };
