'use strict';
/*
 * Team Registry：AI 团队 = 一组岗位；每个岗位分配主模型连接与备用模型连接。
 * 团队与模型解耦：更换模型只改岗位的 connectionId，团队与岗位不变；一个模型可承担多个岗位，多个模型也可承担同一岗位（主 + 备用）。
 * 不在这里调用模型；岗位到模型的选择（含备用与费用策略）由 resolveRole 给出，调用方执行。
 */
const crypto = require('crypto');

const TEAM_ID_RE = /^[\w-]{1,40}$/;
const ROLE_ID_RE = /^[\w-]{1,32}$/;
const BUDGET_MODES = ['free_first', 'quality_first'];
const DEFAULT_BUDGET = Object.freeze({ mode: 'free_first', allowPaidApi: false, monthlyPaidApiBudget: 0, requireApprovalForPaidApi: true });
const FREE = new Set(['local', 'free_tier']);
const str = (s, n) => String(s == null ? '' : s).slice(0, n);

function cleanBudget(b = {}, base = DEFAULT_BUDGET) {
  const o = { ...base };
  if (b.mode !== undefined) { if (!BUDGET_MODES.includes(b.mode)) return { error: 'budgetPolicy.mode 只能是 ' + BUDGET_MODES.join(' / ') }; o.mode = b.mode; }
  if (b.allowPaidApi !== undefined) o.allowPaidApi = !!b.allowPaidApi;
  if (b.requireApprovalForPaidApi !== undefined) o.requireApprovalForPaidApi = !!b.requireApprovalForPaidApi;
  if (b.monthlyPaidApiBudget !== undefined) {
    const v = Number(b.monthlyPaidApiBudget);
    if (!Number.isFinite(v) || v < 0) return { error: 'monthlyPaidApiBudget 必须是非负数' };
    o.monthlyPaidApiBudget = v;
  }
  return { budget: o };
}

class TeamRegistry {
  /* templates：模板 JSON；capTags：合法能力标签；hasConnection(id)：模型连接是否存在 */
  constructor({ templates, capTags, hasConnection }) {
    this.templatesDoc = templates;
    this.templates = new Map((templates.templates || []).map(t => [t.templateId, t]));
    this.capTags = capTags;
    this.hasConnection = hasConnection;
    this.teams = [];
  }
  load(doc) { this.teams = Array.isArray(doc && doc.teams) ? doc.teams.filter(t => t && TEAM_ID_RE.test(t.teamId)) : []; }
  serialize() { return { version: 1, teams: this.teams }; }
  list() { return this.teams.map(t => structuredClone(t)); }
  get(id) { const t = this.teams.find(x => x.teamId === id); return t ? structuredClone(t) : null; }
  _raw(id) { return this.teams.find(x => x.teamId === id) || null; }

  _cleanRole(r, i) {
    if (!r || typeof r !== 'object') return { error: `第 ${i + 1} 个岗位格式不正确` };
    const roleId = str(r.roleId, 32);
    if (!ROLE_ID_RE.test(roleId)) return { error: `岗位 ID 不合法：${roleId || '(空)'}` };
    const caps = Array.isArray(r.requiredCapabilities) ? [...new Set(r.requiredCapabilities.map(String))] : [];
    const badCap = caps.find(c => !this.capTags.includes(c));
    if (badCap) return { error: `岗位 ${roleId} 的能力标签未知：${badCap}` };
    const primary = r.primaryConnectionId ? str(r.primaryConnectionId, 40) : null;
    const fallbacks = Array.isArray(r.fallbackConnectionIds) ? [...new Set(r.fallbackConnectionIds.map(x => str(x, 40)))].filter(x => x && x !== primary) : [];
    for (const id of [primary, ...fallbacks]) if (id && !this.hasConnection(id)) return { error: `岗位 ${roleId} 引用的模型连接不存在：${id}` };
    if (fallbacks.length > 5) return { error: `岗位 ${roleId} 的备用模型最多 5 个` };
    return { role: { roleId, name: str(r.name || roleId, 30), duty: str(r.duty, 200), requiredCapabilities: caps, primaryConnectionId: primary, fallbackConnectionIds: fallbacks, humanReview: !!r.humanReview } };
  }
  _cleanWorkflow(w, roles) {
    const ids = new Set(roles.map(r => r.roleId));
    const lead = w && w.leadRoleId ? String(w.leadRoleId) : roles[0] && roles[0].roleId;
    const review = w && w.reviewRoleId ? String(w.reviewRoleId) : (roles.find(r => r.roleId !== lead) || {}).roleId || null;
    if (!ids.has(lead)) return { error: '流程的主责岗位（leadRoleId）不在岗位列表中' };
    if (review && !ids.has(review)) return { error: '流程的审核岗位（reviewRoleId）不在岗位列表中' };
    const steps = Array.isArray(w && w.steps) ? w.steps.map(s => str(s, 60)).slice(0, 20) : [];
    return { workflow: { leadRoleId: lead, reviewRoleId: review, steps } };
  }

  _build(input, existing) {
    const name = str(input.name !== undefined ? input.name : existing && existing.name, 40).trim();
    if (!name) return { error: '请填写团队名称' };
    const rawRoles = input.roles !== undefined ? input.roles : existing ? existing.roles : [];
    if (!Array.isArray(rawRoles) || !rawRoles.length || rawRoles.length > 12) return { error: '团队需要 1–12 个岗位' };
    const roles = [];
    for (let i = 0; i < rawRoles.length; i++) { const r = this._cleanRole(rawRoles[i], i); if (r.error) return r; roles.push(r.role); }
    if (new Set(roles.map(r => r.roleId)).size !== roles.length) return { error: '岗位 ID 重复' };
    const wf = this._cleanWorkflow(input.workflow !== undefined ? input.workflow : existing && existing.workflow, roles);
    if (wf.error) return wf;
    const bg = cleanBudget(input.budgetPolicy || {}, existing ? existing.budgetPolicy : DEFAULT_BUDGET);
    if (bg.error) return bg;
    return { team: { name, description: str(input.description !== undefined ? input.description : existing && existing.description, 200), roles, workflow: wf.workflow, budgetPolicy: bg.budget } };
  }

  add(input = {}, ownerId = null) {
    const b = this._build(input, null);
    if (b.error) return { ok: false, error: b.error };
    let teamId;
    do teamId = 'team_' + crypto.randomBytes(3).toString('hex'); while (this._raw(teamId));
    const now = Date.now();
    const team = { teamId, ...b.team, templateId: input.templateId ? str(input.templateId, 40) : null, templateVersion: input.templateVersion || null, ownerId, createdAt: now, updatedAt: now };
    this.teams.push(team);
    return { ok: true, team: structuredClone(team) };
  }
  /* 从模板建立团队；assignments: { roleId: { primaryConnectionId, fallbackConnectionIds } } */
  fromTemplate(templateId, { name, assignments = {}, budgetPolicy } = {}, ownerId = null) {
    const tpl = this.templates.get(templateId);
    if (!tpl) return { ok: false, error: '模板不存在或尚未提供：' + templateId };
    const roles = tpl.roles.map(r => ({ ...r, ...(assignments[r.roleId] || {}) }));
    return this.add({ name: name || tpl.name, description: tpl.description, roles, workflow: tpl.workflow, budgetPolicy, templateId, templateVersion: tpl.version }, ownerId);
  }
  update(id, input = {}) {
    const t = this._raw(id);
    if (!t) return { ok: false, error: '团队不存在', code: 404 };
    const b = this._build(input, t);
    if (b.error) return { ok: false, error: b.error };
    Object.assign(t, b.team, { updatedAt: Date.now() });
    return { ok: true, team: structuredClone(t) };
  }
  /* 给单个岗位分配模型（换模型时团队与岗位不变） */
  assign(id, roleId, { primaryConnectionId, fallbackConnectionIds } = {}) {
    const t = this._raw(id);
    if (!t) return { ok: false, error: '团队不存在', code: 404 };
    const roles = t.roles.map(r => (r.roleId === roleId ? { ...r, ...(primaryConnectionId !== undefined ? { primaryConnectionId } : {}), ...(fallbackConnectionIds !== undefined ? { fallbackConnectionIds } : {}) } : r));
    if (!t.roles.some(r => r.roleId === roleId)) return { ok: false, error: '岗位不存在', code: 404 };
    return this.update(id, { roles });
  }
  remove(id) {
    const i = this.teams.findIndex(x => x.teamId === id);
    if (i < 0) return { ok: false, error: '团队不存在', code: 404 };
    this.teams.splice(i, 1);
    return { ok: true };
  }

  /* 哪些团队岗位引用了某个模型连接 */
  refs(connectionId) {
    const out = [];
    for (const t of this.teams) for (const r of t.roles) {
      if (r.primaryConnectionId === connectionId) out.push({ teamId: t.teamId, teamName: t.name, roleId: r.roleId, roleName: r.name, slot: 'primary' });
      if (r.fallbackConnectionIds.includes(connectionId)) out.push({ teamId: t.teamId, teamName: t.name, roleId: r.roleId, roleName: r.name, slot: 'fallback' });
    }
    return out;
  }
  /* 删除模型时：替换为 replacement，或从岗位中移除（主模型置空 = 待分配）。返回受影响的岗位数 */
  replaceConnection(oldId, replacement) {
    let n = 0;
    for (const t of this.teams) {
      let touched = false;
      for (const r of t.roles) {
        if (r.primaryConnectionId === oldId) { r.primaryConnectionId = replacement || null; n++; touched = true; }
        if (r.fallbackConnectionIds.includes(oldId)) {
          r.fallbackConnectionIds = [...new Set(r.fallbackConnectionIds.map(x => (x === oldId ? replacement : x)).filter(x => x && x !== r.primaryConnectionId))];
          n++; touched = true;
        }
      }
      if (touched) t.updatedAt = Date.now();
    }
    return n;
  }

  /*
   * 为岗位选择模型连接。models：ModelRegistry；budget：团队费用策略；approvePaid：用户是否已批准本次使用付费 / 费用未知的模型。
   * 规则：候选 = 主模型 + 备用模型；跳过不存在 / 停用 / 未就绪的；free_first 时免费（本地 / 已标记免费额度）优先；
   *       付费或费用未知的模型在 allowPaidApi=false 时需要本次批准，否则返回 needsApproval，绝不自动收费。
   */
  resolveRole(team, roleId, models, { approvePaid = false } = {}) {
    const role = team.roles.find(r => r.roleId === roleId);
    if (!role) return { ok: false, code: 'role_missing', error: '岗位不存在：' + roleId };
    const cand = [role.primaryConnectionId, ...role.fallbackConnectionIds].filter(Boolean);
    if (!cand.length) return { ok: false, code: 'role_unassigned', error: `岗位「${role.name}」还没有分配模型` };
    const skipped = [];
    let usable = [];
    for (const id of cand) {
      const st = models.status(id);
      if (st === 'missing') skipped.push({ connectionId: id, reason: '已删除' });
      else if (st === 'disabled') skipped.push({ connectionId: id, reason: '已停用' });
      else if (st === 'not_ready') skipped.push({ connectionId: id, reason: '未就绪' });
      else usable.push(models.get(id));
    }
    if (!usable.length) return { ok: false, code: 'role_no_available_model', error: `岗位「${role.name}」分配的模型都不可用（${skipped.map(s => s.reason).join('、')}）`, skipped };
    const budget = team.budgetPolicy || DEFAULT_BUDGET;
    usable = [...usable.filter(c => !(c.lastTest && !c.lastTest.ok)), ...usable.filter(c => c.lastTest && !c.lastTest.ok)]; // 最近测试失败的排后面
    if (budget.mode === 'free_first') usable = [...usable.filter(c => FREE.has(c.pricingMode)), ...usable.filter(c => !FREE.has(c.pricingMode))];
    const pick = usable[0];
    const paid = !FREE.has(pick.pricingMode);
    if (paid && !budget.allowPaidApi && !approvePaid) {
      return { ok: false, code: 'paid_approval_required', needsApproval: true, connectionId: pick.connectionId,
        error: `岗位「${role.name}」只有付费或费用未知的模型可用（${pick.displayName}）。团队设置为不自动使用付费 API，请确认本次允许使用后再运行。`, skipped };
    }
    return { ok: true, connectionId: pick.connectionId, role, usedFallback: pick.connectionId !== role.primaryConnectionId, paid, pricingMode: pick.pricingMode, skipped };
  }

  /* 团队健康检查：给普通用户看的问题清单 */
  validate(id, models) {
    const t = this._raw(id);
    if (!t) return null;
    const issues = [];
    for (const r of t.roles) {
      const cand = [r.primaryConnectionId, ...r.fallbackConnectionIds].filter(Boolean);
      if (!cand.length) { issues.push({ roleId: r.roleId, level: 'error', text: `岗位「${r.name}」还没有分配模型` }); continue; }
      const live = cand.filter(c => ['available', 'untested', 'error'].includes(models.status(c)));
      if (!live.length) issues.push({ roleId: r.roleId, level: 'error', text: `岗位「${r.name}」分配的模型都不可用` });
      else if (!r.fallbackConnectionIds.length) issues.push({ roleId: r.roleId, level: 'info', text: `岗位「${r.name}」没有备用模型` });
      const primary = r.primaryConnectionId && models.get(r.primaryConnectionId);
      if (primary) {
        const missing = r.requiredCapabilities.filter(c => !(primary.capabilities || []).includes(c));
        if (missing.length) issues.push({ roleId: r.roleId, level: 'warn', text: `岗位「${r.name}」的主模型未声明能力：${missing.join('、')}` });
        if (!FREE.has(primary.pricingMode) && !t.budgetPolicy.allowPaidApi) issues.push({ roleId: r.roleId, level: 'warn', text: `岗位「${r.name}」的主模型${primary.pricingMode === 'paid_api' ? '是付费 API' : '费用未知'}，每次运行需要确认` });
      }
    }
    const lead = t.workflow.leadRoleId, rev = t.workflow.reviewRoleId;
    const lr = t.roles.find(r => r.roleId === lead), rr = rev && t.roles.find(r => r.roleId === rev);
    if (lr && rr && lr.primaryConnectionId && lr.primaryConnectionId === rr.primaryConnectionId) issues.push({ roleId: rev, level: 'info', text: '主责与审核岗位使用同一个模型，交叉审核效果可能较弱' });
    return { teamId: id, ok: !issues.some(i => i.level === 'error'), issues };
  }
}

module.exports = { TeamRegistry, DEFAULT_BUDGET, BUDGET_MODES, cleanBudget, TEAM_ID_RE, ROLE_ID_RE };
