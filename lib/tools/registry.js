'use strict';
/*
 * Tool Registry：工具注册、发现、参数校验、权限与审批、执行、超时 / 取消、结果裁剪、调用日志。
 *
 * 工具定义：{ id, title, description, category, risk, inputSchema, run(args, ctx), available?(), timeoutMs, source, serverId? }
 *   risk：read（只读）/ write（只写任务内文件）/ network（访问外部网络）/ exec（执行代码或命令，高风险）
 * 策略（每个工具）：auto 自动执行 / ask 每次需要批准（可批准本任务内不再询问）/ deny 禁止。
 *   默认：read、write、network → auto；exec → ask；第三方 MCP 工具 → ask。
 * 执行上下文 ctx：{ taskId, stepId, instanceId, roleId, workspace, artifacts, signal, allowedTools, approvalGranted, by }
 * 所有调用写入 tool_calls 表并发出 tool_start / tool_done 事件。没有可用工具时返回 unavailable，模型不能也无法“假装执行”。
 */
const crypto = require('crypto');
const Ajv = require('ajv');

const RISKS = ['read', 'write', 'network', 'exec'];
const POLICIES = ['auto', 'ask', 'deny'];
const MAX_RESULT_CHARS = 12000;
const llmNameOf = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '__').slice(0, 64);

class ToolRegistry {
  constructor({ db, emit = () => {} }) {
    this.db = db; this.emit = emit;
    this.tools = new Map();
    this.byLlmName = new Map();
    this.ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
    this.validators = new Map();
  }
  register(def) {
    if (!def.id || typeof def.run !== 'function') throw new Error('工具定义不完整');
    if (!RISKS.includes(def.risk)) throw new Error('未知风险等级：' + def.risk);
    const t = { source: 'builtin', category: 'other', timeoutMs: 60000, inputSchema: { type: 'object', properties: {} }, ...def };
    t.llmName = llmNameOf(t.id);
    this.tools.set(t.id, t);
    this.byLlmName.set(t.llmName, t.id);
    this.validators.set(t.id, this.ajv.compile(t.inputSchema));
    return t;
  }
  unregisterWhere(pred) { for (const [id, t] of this.tools) if (pred(t)) { this.tools.delete(id); this.byLlmName.delete(t.llmName); this.validators.delete(id); } }
  get(id) { return this.tools.get(id) || null; }
  idFromLlmName(name) { return this.byLlmName.get(name) || null; }

  settings(id) { return this.db.getDoc('tool_settings', 'tool_id', id) || {}; }
  policyOf(id) {
    const t = this.tools.get(id);
    const s = this.settings(id);
    if (POLICIES.includes(s.policy)) return s.policy;
    if (!t) return 'deny';
    if (t.source === 'mcp') return 'ask';
    return t.risk === 'exec' ? 'ask' : 'auto';
  }
  setPolicy(id, policy) {
    if (!POLICIES.includes(policy)) throw new Error('策略只能是 auto / ask / deny');
    this.db.putDoc('tool_settings', 'tool_id', id, { ...this.settings(id), toolId: id, policy, updatedAt: Date.now() });
  }
  async availability(t) {
    if (!t.available) return { ok: true };
    try { return await t.available(); } catch (e) { return { ok: false, reason: e.message }; }
  }
  async list() {
    const out = [];
    for (const t of this.tools.values()) {
      const av = await this.availability(t);
      out.push({ id: t.id, title: t.title || t.id, description: t.description, category: t.category, risk: t.risk, source: t.source, serverId: t.serverId || null, available: av.ok, reason: av.reason || '', policy: this.policyOf(t.id), inputSchema: t.inputSchema });
    }
    return out.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }
  /* 交给模型的工具定义（只包含允许且可用的工具） */
  async definitions(ids) {
    const defs = [];
    for (const id of ids) {
      const t = this.tools.get(id);
      if (!t || this.policyOf(id) === 'deny') continue;
      if (!(await this.availability(t)).ok) continue;
      defs.push({ name: t.llmName, description: `[${t.risk}] ${t.description}`.slice(0, 1000), inputSchema: t.inputSchema, toolId: id });
    }
    return defs;
  }

  /*
   * 执行工具。返回 { status, content, data, artifacts, callId, ms, approval? }
   *   status：ok / error / needs_approval / denied / unavailable / invalid / cancelled / timeout
   */
  async execute(id, args, ctx = {}) {
    const t = this.tools.get(id);
    const callId = 'tc_' + crypto.randomBytes(6).toString('hex');
    const base = { callId, toolId: id, taskId: ctx.taskId || null, stepId: ctx.stepId || null, instanceId: ctx.instanceId || null, roleId: ctx.roleId || null };
    const record = (status, extra = {}) => {
      const doc = { ...base, status, args: clip(JSON.stringify(args ?? {}), 4000), ...extra, updatedAt: Date.now(), createdAt: extra.createdAt || Date.now() };
      try { this.db.putDoc('tool_calls', 'call_id', callId, doc, { task_id: base.taskId, step_id: base.stepId, status, tool_id: id }); } catch { /* 日志失败不影响执行 */ }
      return doc;
    };
    if (!t) { record('unavailable', { error: '工具不存在' }); return { status: 'unavailable', content: `工具 ${id} 不存在。`, callId }; }
    if (ctx.allowedTools && !ctx.allowedTools.has(id)) { record('denied', { error: '岗位 / 技能未授权' }); return { status: 'denied', content: `当前岗位没有使用 ${id} 的权限。`, callId }; }
    const policy = this.policyOf(id);
    if (policy === 'deny') { record('denied', { error: '工具已被禁用' }); return { status: 'denied', content: `工具 ${id} 已被用户禁用。`, callId }; }
    const validate = this.validators.get(id);
    const a = structuredClone(args ?? {});
    if (!validate(a)) {
      const msg = validate.errors.map(e => `${e.instancePath || '参数'} ${e.message}`).join('；');
      record('invalid', { error: msg });
      return { status: 'invalid', content: `参数不合法：${msg}`, callId };
    }
    const av = await this.availability(t);
    if (!av.ok) { record('unavailable', { error: av.reason }); return { status: 'unavailable', content: `工具 ${id} 当前不可用：${av.reason}。不要假装已执行。`, callId }; }
    if (policy === 'ask' && !ctx.approvalGranted) {
      record('needs_approval', {});
      return { status: 'needs_approval', content: `工具 ${id} 需要用户批准后才能执行。`, callId, approval: { toolId: id, title: t.title || id, risk: t.risk, args: a } };
    }
    const started = Date.now();
    record('running', { createdAt: started });
    this.emit({ type: 'tool_start', ...base, callId, title: t.title || id, risk: t.risk });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), t.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, ac.signal]) : ac.signal;
    let status = 'ok', content = '', data, artifacts = [], error;
    try {
      /* 工具不响应取消信号时也不会让调用方一直等待：超时 / 取消立即结束本次调用 */
      const aborted = new Promise((_, rej) => { if (signal.aborted) rej(new Error('aborted')); signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }); });
      aborted.catch(() => {});
      const r = await Promise.race([t.run(a, { ...ctx, signal, callId, toolId: id }), aborted]);
      content = typeof r === 'string' ? r : (r && r.content) || '';
      data = r && typeof r === 'object' ? r.data : undefined;
      artifacts = (r && r.artifacts) || [];
      if (r && r.isError) { status = 'error'; error = content; }
    } catch (e) {
      if (ctx.signal && ctx.signal.aborted) status = 'cancelled';
      else if (ac.signal.aborted) status = 'timeout';
      else status = 'error';
      error = status === 'timeout' ? `执行超时（${Math.round(t.timeoutMs / 1000)} 秒）` : status === 'cancelled' ? '已取消' : (e && e.message) || String(e);
      content = `工具执行失败：${error}`;
    } finally { clearTimeout(timer); }
    const full = content.length;
    if (content.length > MAX_RESULT_CHARS) content = content.slice(0, MAX_RESULT_CHARS) + `\n…（结果共 ${full} 字符，已截断；请用分页参数继续读取，或读取对应成果文件）`;
    const ms = Date.now() - started;
    record(status, { createdAt: started, ms, error, resultChars: full, result: clip(content, 2000), artifacts });
    this.emit({ type: 'tool_done', ...base, callId, title: t.title || id, status, ms, error, artifacts });
    return { status, content, data, artifacts, callId, ms };
  }

  calls(taskId, limit = 500) { return this.db.listDocs('tool_calls', 'task_id = ?', [taskId], 'created_at ASC', limit); }
}
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

module.exports = { ToolRegistry, RISKS, POLICIES, llmNameOf, MAX_RESULT_CHARS };
