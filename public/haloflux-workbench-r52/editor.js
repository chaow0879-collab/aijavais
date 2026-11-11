/* AIJAVAIS R52 plan editor | pure, immutable edits on the plan DTO + conversion to EXISTING
 * backend request bodies. Editing never authorizes anything: the run request it builds is only a
 * proposal that the backend validates again (budget, paid approval, tool permission, readiness). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./planner.js'), require('../../lib/work-contract.js'));
  else root.R52Editor = factory(root.R52Planner, root.R52Contract);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P, C) {
  'use strict';
  const text = C.text;
  const MAX = { roles: 12, steps: 30, name: 50, duty: 400, boundary: 400, standard: 400, title: 120, deliverable: 200, quality: 400 };
  const SAFE = /^[\w.-]{1,64}$/;
  const clone = x => JSON.parse(JSON.stringify(x));
  class EditError extends Error { constructor(msg, code) { super(msg); this.code = code || 'invalid_edit'; } }
  const fail = (msg, code) => { throw new EditError(msg, code); };
  const roleOf = (p, id) => p.roles.find(r => r.role_id === id) || fail('找不到岗位 ' + text(id, 40), 'unknown_role');
  const stepOf = (p, id) => p.steps.find(s => s.step_id === id) || fail('找不到步骤 ' + text(id, 40), 'unknown_step');
  function field(patch, key, max, label, allowEmpty) {
    if (patch[key] === undefined) return undefined;
    if (typeof patch[key] !== 'string') fail(label + '必须是文字');
    const v = text(patch[key], max);
    if (!v && !allowEmpty) fail(label + '不能为空');
    return v;
  }
  // Any edit revokes the overall confirmation. Editing the team, steps or models also revokes every
  // per-role approval (R53); changing a single role's grant keeps the other roles' grants.
  function finish(p, ctx) {
    p.simulated = true; if (p.contract !== 'r53') p.label = 'SIMULATED'; p.edited = true; p.permissions.confirmed = false;
    if (p.contract === 'r53' && p.permissions.roles && !/^grant:|^set_permissions$/.test(ctx)) for (const g of Object.values(p.permissions.roles)) g.approved = false;
    if (p.contract === 'r53') { p.permissions.roles = p.permissions.roles || {}; for (const r of p.roles) if (!p.permissions.roles[r.role_id]) p.permissions.roles[r.role_id] = { approved: false, max_tokens: 100000, max_cost_usd: 0 };
      for (const id of Object.keys(p.permissions.roles)) if (!p.roles.some(r => r.role_id === id)) delete p.permissions.roles[id]; }
    p.blocks = P.blocks(p); if (ctx) p.last_edit = ctx; return p;
  }
  function nextId(p, prefix, list) { for (let i = 1; i < 1000; i++) { const id = prefix + i; if (!list.some(x => x === id)) return id; } fail('编号已满'); }

  const ops = {
    addRole(p, a, env) {
      if (p.roles.length >= MAX.roles) fail('团队最多 ' + MAX.roles + ' 个岗位；更大的工作请拆分为多个项目', 'limit');
      const name = field(a, 'name', MAX.name, '岗位名称'); if (name === undefined) fail('岗位名称不能为空');
      const id = nextId(p, 'custom-', p.roles.map(r => r.role_id));
      const caps = Array.isArray(a.capabilities) ? a.capabilities.filter(c => typeof c === 'string' && /^[a-z_]{2,30}$/.test(c)).slice(0, 6) : ['reasoning'];
      const role = { role_id: id, name, duty: field(a, 'duty', MAX.duty, '职责') || '按用户确认的职责完成工作', boundary: field(a, 'boundary', MAX.boundary, '边界', true) || '',
        standard: field(a, 'standard', MAX.standard, '验收标准') || '成果可被他人复核，未核实处已标注', capabilities: caps.length ? caps : ['reasoning'], required: false, origin: 'user', model: null };
      role.model = modelFor(role, env && env.models, null);
      p.roles.push(role);
      if (p.steps.length < MAX.steps) p.steps.push({ step_id: nextId(p, 'custom-step-', p.steps.map(s => s.step_id)), role_id: id, title: '执行：' + name, deliverable: field(a, 'deliverable', MAX.deliverable, '成果') || '可审核的工作成果', quality: role.standard, kind: 'work', tools: [] });
      return 'add_role:' + id;
    },
    removeRole(p, a) {
      const r = roleOf(p, a.role_id);
      if (p.roles.length <= 1) fail('至少保留一个岗位', 'limit');
      p.roles = p.roles.filter(x => x !== r);
      const removed = p.steps.filter(s => s.role_id === r.role_id).length;
      p.steps = p.steps.filter(s => s.role_id !== r.role_id);
      if (!p.steps.length) fail('删除后没有任何步骤，请先给其他岗位安排步骤', 'limit');
      p.warnings = (p.warnings || []).concat(r.required ? ['已移除核心岗位“' + r.name + '”及其 ' + removed + ' 个步骤，请确认不会遗漏交付要求'] : []).slice(-20);
      return 'remove_role:' + r.role_id;
    },
    editRole(p, a) {
      const r = roleOf(p, a.role_id);
      for (const [k, max, label, empty] of [['name', MAX.name, '岗位名称'], ['duty', MAX.duty, '职责'], ['boundary', MAX.boundary, '边界', true], ['standard', MAX.standard, '验收标准']]) {
        const v = field(a, k, max, label, empty); if (v !== undefined) r[k] = v;
      }
      return 'edit_role:' + r.role_id;
    },
    setModel(p, a, env) {
      const r = roleOf(p, a.role_id);
      if (a.connection_id !== null && (typeof a.connection_id !== 'string' || !SAFE.test(a.connection_id))) fail('模型连接 ID 不正确');
      r.model = modelFor(r, env && env.models, a.connection_id);
      return 'set_model:' + r.role_id;
    },
    moveStep(p, a) {
      const i = p.steps.indexOf(stepOf(p, a.step_id));
      const j = i + (a.delta === -1 ? -1 : a.delta === 1 ? 1 : fail('移动方向只能是上移或下移'));
      if (j < 0 || j >= p.steps.length) return 'move_step:noop';
      [p.steps[i], p.steps[j]] = [p.steps[j], p.steps[i]];
      return 'move_step:' + a.step_id;
    },
    setRoleGrant(p, a) {
      const r = roleOf(p, a.role_id);
      if (p.contract !== 'r53') fail('逐岗授权只在通用工作流后端可用');
      const g = { ...(p.permissions.roles[r.role_id] || { approved: false, max_tokens: 100000, max_cost_usd: 0 }) };
      if (a.max_tokens !== undefined) { const v = Math.floor(Number(a.max_tokens)); if (!(v >= 1000 && v <= 1000000)) fail('岗位 Token 上限需在 1000–1000000 之间'); g.max_tokens = v; }
      if (a.max_cost_usd !== undefined) { const v = Number(a.max_cost_usd); if (!Number.isFinite(v) || v < 0 || v > 10000) fail('岗位费用上限需在 0–10000 美元之间'); g.max_cost_usd = Math.round(v * 100) / 100; }
      if (a.approved !== undefined) {
        if (a.approved === true && (!r.model || !r.model.connection_id || ['none', 'unavailable'].includes(r.model.status))) fail('岗位“' + r.name + '”没有可用模型，不能批准', 'role_blocked');
        if (a.approved === true && r.model.pricing_mode && r.model.pricing_mode !== 'local') fail('岗位“' + r.name + '”使用远程/收费模型：费用硬上限未被证明，通用工作流不允许', 'BLOCKED_UNENFORCEABLE_COST_CAP');
        g.approved = a.approved === true;
      }
      p.permissions.roles[r.role_id] = g;
      return 'grant:' + r.role_id;
    },
    editStep(p, a) {
      const s = stepOf(p, a.step_id);
      if (a.kind !== undefined) { if (!['work', 'peer_review'].includes(a.kind)) fail('步骤类型只能是工作或独立复核'); s.kind = a.kind; }
      for (const [k, max, label] of [['title', MAX.title, '步骤名称'], ['deliverable', MAX.deliverable, '成果'], ['quality', MAX.quality, '检查标准']]) { const v = field(a, k, max, label); if (v !== undefined) s[k] = v; }
      if (a.role_id !== undefined) s.role_id = roleOf(p, a.role_id).role_id;
      return 'edit_step:' + s.step_id;
    },
    addStep(p, a) {
      if (p.steps.length >= MAX.steps) fail('最多 ' + MAX.steps + ' 个步骤', 'limit');
      const r = roleOf(p, a.role_id);
      const title = field(a, 'title', MAX.title, '步骤名称'); if (title === undefined) fail('步骤名称不能为空');
      const id = nextId(p, 'custom-step-', p.steps.map(s => s.step_id));
      p.steps.push({ step_id: id, role_id: r.role_id, title, deliverable: field(a, 'deliverable', MAX.deliverable, '成果') || '可审核的工作成果', quality: field(a, 'quality', MAX.quality, '检查标准') || r.standard, kind: a.kind === 'peer_review' ? 'peer_review' : 'work', tools: [] });
      return 'add_step:' + id;
    },
    removeStep(p, a) {
      const s = stepOf(p, a.step_id);
      if (p.steps.length <= 1) fail('至少保留一个步骤', 'limit');
      p.steps = p.steps.filter(x => x !== s);
      return 'remove_step:' + s.step_id;
    },
    removeTool(p, a) {
      const s = stepOf(p, a.step_id);
      s.tools = s.tools.filter(t => t.tool_id !== a.tool_id);
      return 'remove_tool:' + s.step_id;
    },
    editAcceptance(p, a) {
      if (a.add !== undefined) {
        const t = field(a, 'add', 200, '验收标准'); if (p.acceptance.length >= 20) fail('验收标准最多 20 条', 'limit');
        p.acceptance.push({ id: nextId(p, 'user-x', p.acceptance.map(c => c.id)), text: t, source: 'user', verification: 'not_verified' });
      }
      if (a.remove !== undefined) p.acceptance = p.acceptance.filter(c => c.id !== a.remove);
      return 'edit_acceptance';
    },
    setDomain(p, a) { p.domain = field(a, 'domain', 60, '领域', true) || ''; return 'set_domain'; },
    setPermissions(p, a) {
      const perm = p.permissions;
      if (a.allowed_ops !== undefined) {
        if (!Array.isArray(a.allowed_ops)) fail('允许的操作必须是列表');
        const known = new Set(P.OPS.filter(o => !o.never).map(o => o.id));
        if (a.allowed_ops.some(op => op === 'external_publish')) fail('对外发布、付款、发送消息永远不由 AI 团队执行', 'forbidden_op');
        perm.allowed_ops = [...new Set(a.allowed_ops.filter(op => known.has(op)))];
      }
      if (a.max_cost_usd !== undefined) { const v = Number(a.max_cost_usd); if (!Number.isFinite(v) || v < 0 || v > 10000) fail('费用上限需在 0–10000 美元之间'); perm.max_cost_usd = Math.round(v * 100) / 100; }
      if (a.max_tokens !== undefined) { const v = Math.floor(Number(a.max_tokens)); if (!(v >= 1000 && v <= 1000000)) fail('Token 上限需在 1000–1000000 之间'); perm.max_tokens = v; }
      if (a.approve_paid !== undefined) perm.approve_paid = a.approve_paid === true;
      if (a.approve_external_tools !== undefined) perm.approve_external_tools = a.approve_external_tools === true;
      if (a.prices !== undefined) {
        if (!C.isObj(a.prices)) fail('单价格式不正确');
        const prices = {};
        for (const [id, pr] of Object.entries(a.prices)) {
          if (!SAFE.test(id) || !C.isObj(pr)) fail('单价格式不正确');
          const i = Number(pr.inputPerMillion), o = Number(pr.outputPerMillion);
          if (!(i >= 0 && i <= 10000 && o >= 0 && o <= 10000)) fail('单价需在 0–10000 美元/百万 Token 之间');
          prices[id] = { inputPerMillion: i, outputPerMillion: o, currency: 'USD' };
        }
        perm.prices = prices;
      }
      return 'set_permissions';
    }
  };
  function modelFor(role, models, connectionId) {
    const list = Array.isArray(models) ? models : [];
    const c = connectionId === undefined || connectionId === null ? (connectionId === null ? null : P.pickModel(role, list)) : list.find(m => m.connectionId === connectionId) || null;
    if (connectionId && !c) return { connection_id: null, display_name: null, pricing_mode: null, status: 'unavailable', reason: '所选模型连接不存在或你无权使用' };
    const st = P.modelStatus(role.capabilities, c);
    return { connection_id: c ? c.connectionId : null, display_name: c ? text(c.displayName || c.connectionId, 80) : null, pricing_mode: c ? text(c.pricingMode || 'unknown', 20) : null, ...st };
  }
  // apply(plan, action, env) -> new plan. Throws EditError; the input plan is never mutated.
  function apply(plan, action, env) {
    if (!C.isObj(plan) || plan.schema !== C.PLAN_SCHEMA) fail('不是工作方案', 'bad_plan');
    if (!C.isObj(action) || typeof action.op !== 'string' || !Object.prototype.hasOwnProperty.call(ops, action.op)) fail('不支持的编辑操作', 'bad_op');
    const p = clone(plan);
    const ctx = ops[action.op](p, action, env || {});
    return finish(p, ctx);
  }
  // The user's explicit confirmation of scope + caps. Still only a proposal for the backend.
  function confirm(plan, yes) { const p = clone(plan); p.permissions.confirmed = yes === true; p.blocks = P.blocks(p); return p; }
  function validate(plan) {
    const errors = [], warnings = [];
    const roleIds = new Set(plan.roles.map(r => r.role_id));
    if (!plan.roles.length || plan.roles.length > MAX.roles) errors.push('岗位数量需在 1–' + MAX.roles + ' 之间');
    if (!plan.steps.length || plan.steps.length > MAX.steps) errors.push('步骤数量需在 1–' + MAX.steps + ' 之间');
    for (const s of plan.steps) if (!roleIds.has(s.role_id)) errors.push('步骤“' + s.title + '”指向不存在的岗位');
    for (const r of plan.roles) if (!plan.steps.some(s => s.role_id === r.role_id)) warnings.push('岗位“' + r.name + '”没有安排任何步骤');
    if (!plan.roles.some(r => /复核|审核|审查|测试|质量/.test(r.name))) warnings.push('团队里没有独立复核岗位，成果可能未经他人检查');
    const blocks = P.blocks(plan);
    return { ok: !errors.length, errors, warnings, blocks, executable: !errors.length && !blocks.some(b => b.severity === 'block') };
  }
  // -> body for the EXISTING POST /api/v2/projects (saves only; never runs a model).
  function toProject(plan, toolIdMap) {
    const v = validate(plan);
    if (!v.ok) fail(v.errors.join('；'), 'invalid_plan');
    const map = toolIdMap || {};
    const tools = [...new Set(plan.steps.flatMap(s => s.tools.map(t => map[t.tool_id] || t.tool_id)))];
    const domain = plan.domain || '（领域待确认）';
    return {
      name: text((plan.domain ? plan.domain + '｜' : '') + plan.goal, 150), description: plan.goal,
      roles: plan.roles.map(r => ({ roleId: r.role_id, name: r.name, duty: r.duty, boundary: r.boundary, standard: r.standard, connectionId: r.model && r.model.connection_id || '', requiredCapabilities: r.capabilities })),
      steps: plan.steps.map(s => ({ stepId: s.step_id, roleId: s.role_id, title: s.title, deliverable: s.deliverable, quality: s.quality,
        prompt: '领域：' + domain + '\n目标：' + plan.goal + '\n本步骤：' + s.title + '\n交付：' + s.deliverable + '\n检查标准：' + s.quality + '\n不得虚构数据、来源或已完成的工作；未核实处标注“待确认”。' })),
      standards: plan.acceptance.map(c => c.text).slice(0, 30),
      deliverables: plan.steps.map(s => s.deliverable).filter((x, i, a) => a.indexOf(x) === i).slice(0, 20),
      requiredToolIds: tools, maxReworks: 2,
      planning: { goal: plan.goal, humanDecisions: plan.cannot_do.map(c => c.text).concat(plan.human_checkpoints.map(h => h.requirement)).slice(0, 30), requestedSkills: [] }
    };
  }
  // -> body for the EXISTING POST /api/v2/projects/:id/runs, or a refusal. The backend re-checks everything.
  function runRequest(plan, toolIdMap) {
    const v = validate(plan);
    // Real blockers first (confirming would not help), then the missing confirmation.
    const hard = v.blocks.filter(b => b.severity === 'block' && b.code !== 'PLAN_SIMULATED' && b.code !== 'NOT_AUTHORIZED');
    if (!v.ok) return { ok: false, code: 'INVALID_PLAN', reason: v.errors.join('；') };
    if (hard.length) return { ok: false, code: hard[0].code, reason: hard.map(b => b.text).join('；'), blocks: hard };
    if (!plan.permissions.confirmed) return { ok: false, code: 'NOT_AUTHORIZED', reason: '请先确认授权范围与费用上限' };
    const map = toolIdMap || {};
    const perm = plan.permissions;
    return { ok: true, body: { maxTokens: perm.max_tokens, maxOutputTokens: perm.max_output_tokens, maxCost: perm.max_cost_usd, approvePaid: perm.approve_paid,
      approveExternalTools: perm.approve_external_tools, allowedTools: [...new Set(plan.steps.flatMap(s => s.tools.map(t => map[t.tool_id] || t.tool_id)))], prices: perm.prices } };
  }
  return { apply, confirm, validate, toProject, runRequest, EditError, MAX };
});
