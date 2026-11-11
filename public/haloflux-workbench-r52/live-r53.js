/* AIJAVAIS R54 live contract | pure mapping between the workbench plan DTO and the R53 universal
 * backend (integrate/codex-r53-universal-workflow@397b46c, /api/v2/universal/*). No fetch here:
 * the controller performs requests; this module only builds bodies, maps responses and explains
 * server refusals. The server stays the only authority for approval, rework, criteria and acceptance. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./contract.js'), require('./planner.js'));
  else root.R54Live = factory(root.R52Contract, root.R52Planner);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, P) {
  'use strict';
  const text = C.text;
  const WORKFLOW = 'aijavais.universal-workflow/v1';
  const SAFE = /^[\w.-]{1,64}$/;
  // Server refusal codes -> words an ordinary user understands. Unknown codes are shown verbatim.
  const ERRORS = {
    approval_required: '需要你明确批准整个团队和每一个岗位后才能开始。',
    role_permission: '有岗位的模型或工具授权缺失、不匹配或超出总授权，服务器拒绝派发。',
    model_missing: '有岗位没有可用的模型连接（缺失或测试未通过）。',
    BLOCKED_UNENFORCEABLE_COST_CAP: '远程/收费模型的费用硬上限和官方授权还没有被证明，通用工作流只允许已验证的本地模型。',
    tool_permission: '有步骤需要的工具没有被授权。', external_tool_approval: '外部或执行代码的工具需要本次单独批准。',
    not_ready: '方案还不能运行（例如缺少独立复核步骤，或复核岗位也做了被复核的工作）。',
    concurrency_limit: '同时进行的任务已达上限（3 个），请等其他任务结束。',
    idempotency_key_reused: '同一个请求编号被用于不同的内容，服务器拒绝了，以免重复派发。请刷新后重试。',
    version_conflict: '服务器上的方案已被修改（版本冲突）。请重新载入后再改。', conflict: '服务器上的方案已被修改（版本冲突）。请重新载入后再改。',
    run_active: '工作还没结束或费用尚未结清，暂时不能这样操作。', round_conflict: '轮次已变化，请刷新到当前轮次后再保存检查结果。',
    artifact_version_conflict: '只能验收当前轮次、且内容哈希一致的交付文件；旧轮次文件不能验收。',
    delivery_invalid: '交付文件结构校验未通过，不能验收。', acceptance_required: '验收需要你确认验收标准，并确认知道这是模拟/本地 Mock 产出。',
    unknown_cost_ack_required: '这次运行有未知或估算的用量，需要你确认知道费用未知（服务器不会把它清零）。',
    criteria_not_passed: '服务器上保存的逐项检查里还有未通过或未核实的项目，不能验收。',
    expert_review_required: '这个任务涉及专业风险，需要填写具备资质的人工审查说明（平台不认证该审查）。',
    invalid_rework_step: '选择的返工起始步骤不存在。', rework_source_missing: '起始步骤之前的成果证据缺失，不能复用，请从更早的步骤返工。',
    rework_limit: '返工次数已达上限。', state_conflict: '当前状态不允许这个操作。', not_found: '服务器上找不到这个项目或任务。', no_output: '还没有实际产出，不能生成文件。',
    invalid_workflow: '提交的内容不符合要求。', invalid_plan: '方案内容不符合要求。', budget_required: '收费模型需要正数费用上限。', paid_approval_required: '收费模型需要单独批准。'
  };
  function explain(status, json) {
    const code = json && typeof json.code === 'string' ? json.code : status === 401 ? 'unauthenticated' : status === 409 ? 'conflict' : 'http_' + status;
    const raw = json && (json.error || json.message) ? text(json.error || json.message, 300) : '';
    const human = status === 401 ? '登录已失效，请重新登录。' : ERRORS[code] || '服务器拒绝：' + (raw || 'HTTP ' + status);
    return { code, status, human, raw };
  }
  // Stable request IDs: an identical retry (e.g. after a network drop) reuses the ID so the server
  // answers it idempotently; changed content gets a new ID. IDs never carry user text.
  function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  function canonical(x) { if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']'; if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}'; return JSON.stringify(x); }
  function requestIds(seed) {
    const map = new Map(); let n = 0;
    return function id(action, body) {
      const key = action + '|' + canonical(body);
      if (!map.has(key)) map.set(key, 'r54-' + action + '-' + String(seed || 's').replace(/[^\w.-]/g, '').slice(0, 24) + '-' + (++n) + '-' + fnv(key));
      return map.get(key);
    };
  }

  /* ---------- plan ---------- */
  function planRequest(inp) {
    const out = { goal: text(inp.goal, 2000), domain: text(inp.domain, 60), audience: text(inp.audience, 200), acceptance: text(inp.successCriteria, 2000), constraints: text(inp.constraints, 2000) };
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
  }
  // Server plan is the authority for roles/steps/standards/kinds; the local planner keeps the honest
  // extras (confidence, what the team cannot do). Models come only from server recommendations.
  function fromServerPlan(resp, local, models) {
    if (!C.isObj(resp) || resp.status !== 'PLAN_SIMULATED' || !C.isObj(resp.project)) throw new Error('不是 R53 计划响应');
    const proj = resp.project, list = Array.isArray(models) ? models : [];
    const rec = new Map((resp.modelRecommendations || []).map(r => [r.roleId, (r.candidates || []).map(c => c.connectionId)]));
    const roles = proj.roles.map(r => {
      const candidates = rec.get(r.roleId) || [];
      const c = list.find(m => candidates.includes(m.connectionId) && m.pricingMode === 'local') || list.find(m => candidates.includes(m.connectionId)) || null;
      const ms = P.modelStatus(r.requiredCapabilities, c);
      return { role_id: r.roleId, name: r.name, duty: r.duty, boundary: r.boundary || '', standard: r.standard, capabilities: (r.requiredCapabilities || []).slice(), required: true, origin: 'server',
        model: { connection_id: c ? c.connectionId : null, display_name: c ? text(c.displayName || c.connectionId, 80) : null, pricing_mode: c ? text(c.pricingMode || 'unknown', 20) : null, ...ms } };
    });
    const steps = proj.steps.map(s => ({ step_id: s.stepId, role_id: s.roleId, title: s.title, deliverable: s.deliverable || '', quality: s.quality || '', kind: s.kind === 'peer_review' ? 'peer_review' : 'work',
      tools: (s.toolCalls || []).map(t => ({ tool_id: t.toolId, status: 'unchecked', reason: '由服务器在运行时按授权检查' })) }));
    const plan = { ...local, contract: 'r53', source: 'r53_server_plan', server_status: resp.status, evidence: resp.evidence || 'E2_RULES_NOT_AI', label: 'PLAN_SIMULATED',
      roles, steps, acceptance: (proj.standards || []).map((t, i) => ({ id: 'criterion-' + (i + 1), text: t, source: 'server', verification: 'not_verified' })),
      expert_review_required: !!(resp.acceptance && resp.acceptance.expertReviewRequired), server_note: text(resp.note, 300),
      clarifications: Array.isArray(resp.clarifications) ? resp.clarifications : local.clarifications,
      server_project: { name: proj.name, description: proj.description, context: proj.context || '', deliverables: proj.deliverables || [], maxReworks: proj.maxReworks, planning: proj.planning || {} } };
    plan.permissions = { ...local.permissions, roles: Object.fromEntries(roles.map(r => [r.role_id, { approved: false, max_tokens: 100000, max_cost_usd: 0 }])), max_tokens: 500000, max_output_tokens: 1024 };
    plan.blocks = P.blocks(plan);
    return plan;
  }
  // A plan rebuilt from a run's server snapshot (refresh / reconnect): read-only view of what ran.
  function planFromSnapshot(run) {
    const s = run && run.projectSnapshot;
    if (!C.isObj(s)) return null;
    const plan = { schema: C.PLAN_SCHEMA, contract: 'r53', source: 'server_run_snapshot', simulated: true, label: 'SERVER_SNAPSHOT', goal: text(s.description, 2000), domain: '', readOnly: true, risk: 'unknown', status: 'snapshot', evidence: 'SERVER_SNAPSHOT',
      roles: s.roles.map(r => ({ role_id: r.roleId, name: r.name, duty: r.duty, boundary: r.boundary || '', standard: r.standard, capabilities: r.requiredCapabilities || [], required: true, origin: 'server',
        model: { connection_id: r.connectionId || null, display_name: r.connectionId || null, pricing_mode: null, status: 'snapshot', reason: '运行时的模型（服务器快照）' } })),
      steps: s.steps.map(st => ({ step_id: st.stepId, role_id: st.roleId, title: st.title, deliverable: st.deliverable || '', quality: st.quality || '', kind: st.kind || 'work', tools: [] })),
      acceptance: (s.standards || []).map((t, i) => ({ id: 'criterion-' + (i + 1), text: t, source: 'server', verification: 'not_verified' })),
      expert_review_required: !!(s.planning && s.planning.expertReviewRequired), cannot_do: [], clarifications: [], human_checkpoints: [], deliverables: [], confidence: { level: 'medium', score: 0, reasons: [] },
      permissions: { allowed_ops: [], roles: Object.fromEntries(s.roles.map(r => [r.roleId, { approved: false, max_tokens: 100000, max_cost_usd: 0 }])), max_cost_usd: 0, max_tokens: 500000, max_output_tokens: 1024, confirmed: false, approve_paid: false, approve_external_tools: false, prices: {} }, blocks: [] };
    plan.blocks = P.blocks(plan);
    return plan;
  }
  // Body for POST /universal/projects (create) and PUT /projects/:id (edit with expectedVersion).
  function toUniversalProject(plan) {
    const sp = plan.server_project || {};
    return {
      name: text(sp.name || (plan.domain ? plan.domain + '｜' : '') + plan.goal, 150), description: text(sp.description || plan.goal, 20000), context: sp.context || '',
      roles: plan.roles.map(r => ({ roleId: r.role_id, name: r.name, duty: r.duty, boundary: r.boundary || r.duty, standard: r.standard, requiredCapabilities: r.capabilities, connectionId: r.model && r.model.connection_id || '' })),
      steps: plan.steps.map(s => ({ stepId: s.step_id, roleId: s.role_id, title: s.title, deliverable: s.deliverable, quality: s.quality, kind: s.kind === 'peer_review' ? 'peer_review' : 'work', handoff: 'all',
        prompt: s.quality + '\n交付：' + s.deliverable, toolCalls: [] })),
      standards: plan.acceptance.map(c => c.text).slice(0, 30), requiredToolIds: [], deliverables: (sp.deliverables || []).slice(0, 20), maxReworks: Number.isInteger(sp.maxReworks) ? sp.maxReworks : 2,
      planning: { goal: plan.goal, humanDecisions: (plan.cannot_do || []).map(c => c.text).concat((plan.human_checkpoints || []).map(h => h.requirement)).slice(0, 30), requestedSkills: [],
        workflowSchema: WORKFLOW, expertReviewRequired: !!plan.expert_review_required }
    };
  }
  /* ---------- per-role authorization ---------- */
  function roleStatus(plan, role, projection) {
    const g = plan.permissions.roles && plan.permissions.roles[role.role_id] || {};
    const m = role.model || {};
    const unknownCost = !!(projection && projection.cost_by_role && projection.cost_by_role[role.role_id] && projection.cost_by_role[role.role_id].unknown);
    let status, reason;
    if (!m.connection_id || ['none', 'unavailable'].includes(m.status)) { status = 'blocked'; reason = m.reason || '没有可用模型；只能看模拟方案和演示'; }
    else if (m.pricing_mode && m.pricing_mode !== 'local') { status = 'blocked'; reason = ERRORS.BLOCKED_UNENFORCEABLE_COST_CAP; }
    else if (m.status === 'capability_gap') { status = g.approved ? 'approved' : 'pending'; reason = m.reason; }
    else if (g.approved) { status = 'approved'; reason = '已批准：模型 ' + (m.display_name || m.connection_id) + '，Token 上限 ' + g.max_tokens + '，费用上限 $' + g.max_cost_usd; }
    else { status = 'pending'; reason = '等待你批准这个岗位'; }
    return { role_id: role.role_id, status, unknown_cost: unknownCost, reason };
  }
  // Body for POST /universal/projects/:id/runs and /universal/runs/:id/rework (each a NEW approval).
  function approvalBody(plan, requestId) {
    const perm = plan.permissions;
    return { requestId, approved: perm.confirmed === true, maxTokens: perm.max_tokens, maxOutputTokens: perm.max_output_tokens || 1024, maxCost: perm.max_cost_usd || 0, allowedTools: [],
      rolePermissions: Object.fromEntries(plan.roles.map(r => { const g = perm.roles && perm.roles[r.role_id] || {}; return [r.role_id, { approved: g.approved === true, connectionId: r.model && r.model.connection_id || '', allowedTools: [], maxTokens: Math.min(g.max_tokens || 100000, perm.max_tokens), maxCost: Math.min(g.max_cost_usd || 0, perm.max_cost_usd || 0) }]; })) };
  }
  function reworkBody(plan, { requestId, feedback, fromStepId }) {
    const fb = text(feedback, 10000);
    if (!fb) return { ok: false, reason: '返工需要写明具体要改什么' };
    if (fromStepId !== undefined && fromStepId !== null && fromStepId !== '' && !plan.steps.some(s => s.step_id === fromStepId)) return { ok: false, reason: ERRORS.invalid_rework_step };
    const body = { ...approvalBody(plan, requestId), feedback: fb };
    if (fromStepId) body.fromStepId = fromStepId;
    return { ok: true, body };
  }
  function criteriaBody(run, marks, requestId) {
    const standards = run && run.projectSnapshot && Array.isArray(run.projectSnapshot.standards) ? run.projectSnapshot.standards : [];
    const checks = {};
    standards.forEach((_, i) => { const id = 'criterion-' + (i + 1), m = marks && marks[id]; const status = m && ['passed', 'failed', 'unverified'].includes(m.status) ? m.status : 'unverified';
      checks[id] = { status, ...(m && m.note ? { note: text(m.note, 2000) } : {}) }; });
    return { requestId, expectedRound: run.round, checks };
  }
  function acceptBody(artifact, { confirmCriteria, acknowledgeSimulation, acknowledgeUnknownCost, expertReviewNote }) {
    const b = { artifactId: artifact.artifact_id || artifact.artifactId, sha256: artifact.sha256, confirmCriteria: confirmCriteria === true, acknowledgeSimulation: acknowledgeSimulation === true, feedback: '用户在 R54 工作台验收当前轮次文件' };
    if (acknowledgeUnknownCost === true) b.acknowledgeUnknownCost = true;
    const note = text(expertReviewNote, 2000); if (note) b.expertReviewNote = note;
    return b;
  }
  // Current-round delivery files only; older rounds and other producers are never accept candidates.
  function deliveries(run, artifacts) {
    const round = run && run.round;
    const meta = new Map((run && Array.isArray(run.artifacts) ? run.artifacts : []).map(a => [a.artifactId, a]));
    return (artifacts || []).map(a => { const m = meta.get(a.artifact_id) || {}; return { ...a, round: m.round || null, producer: m.producer || a.producer, format: m.format || null, source_sha256: m.sourceSha256 || null, current: m.round === round }; })
      .filter(a => a.producer === 'universal_delivery');
  }
  function savedCriteria(run) {
    const list = (run && Array.isArray(run.artifacts) ? run.artifacts : []).filter(a => a.producer === 'human_criteria' && a.round === run.round);
    return list.length ? list[list.length - 1] : null;
  }
  /* ---------- incremental, cursor-based workbench feed ---------- */
  // fetchPage(after) -> { events, artifacts, cursor, status }. Pulls until a short page. Every page goes
  // through the projector's de-dup/order rules, so overlap after a reconnect is harmless.
  async function pull(fetchPage, projector, state, { limit = 200, maxPages = 50 } = {}) {
    let pages = 0, last = null;
    for (;;) {
      const page = await fetchPage(state.cursor || 0, limit);
      if (!page || !Array.isArray(page.events)) throw new Error('bad_workbench_page');
      projector.ingest(page.events);
      last = page; pages++;
      const next = Number.isSafeInteger(page.cursor) ? page.cursor : state.cursor;
      if (next < (state.cursor || 0)) throw new Error('cursor_moved_backwards');
      state.cursor = next;
      if (page.events.length < limit || pages >= maxPages) break;
    }
    return last;
  }
  return { WORKFLOW, ERRORS, explain, requestIds, planRequest, fromServerPlan, planFromSnapshot, toUniversalProject, roleStatus, blocksR53: P.blocksR53, approvalBody, reworkBody, criteriaBody, acceptBody, deliveries, savedCriteria, pull, SAFE };
});
