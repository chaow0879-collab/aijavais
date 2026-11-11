/* AIJAVAIS R52 planner | one natural-language goal -> editable AI team plan DTO.
 * Offline and explainable: it reuses the R44 industry-agnostic rules (universal-team.js) and adds
 * honest confidence, "what the AI team cannot do", model/tool availability and budget/authorization
 * blocks. It never calls a model; every plan it makes is labelled SIMULATED. A backend (existing
 * /api/v2/intake/plan or a future R53 contract) can replace tool/model status with server truth. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../lib/planner/universal-team.js'), require('../../lib/work-contract.js'));
  else root.R52Planner = factory(root.AIJUniversalTeam, root.R52Contract);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (U, C) {
  'use strict';
  const text = C.text;
  // Things an AI team in this product can never do by itself; each needs a named human action.
  const LIMITS = [
    { id: 'physical', re: /现场|实地|上门|采样|施工|手术|驾驶|搬运|种植|栽培|安装|维修|巡检|喂养|饲养|养殖|烹饪|配送|拍摄|测量|采摘|接种|驯养|布展|装修|放生|打捞|勘探|钻井|修剪/,
      text: 'AI 不能执行线下实体操作（如现场作业、采样、拍摄、安装）。这些步骤需要真人完成，并把照片、数据或记录交回团队。' },
    { id: 'external_action', re: /发布到|上架|下单|付款|转账|报名|投放广告|群发|发送邮件|签约|递交|报送|提交给/,
      text: '团队不会代你对外发布、付款、下单、报送或签约；这些动作只能由你本人在对应平台完成。' },
    { id: 'realtime', re: /实时|最新价格|今日行情|当天|直播中|在线监控/,
      text: '没有经过验证的联网工具时，团队拿不到实时信息；涉及最新数据的结论要由你核对来源。' },
    { id: 'credential', re: /我的账号|后台|登录|密码|账户/,
      text: '团队不会索取或使用你的账号密码；需要登录的平台操作请由你本人完成。' }
  ];
  const OPS = [
    { id: 'read_materials', label: '读取我上传的资料', default: true },
    { id: 'web_research', label: '使用已接入的联网检索工具', default: false },
    { id: 'generate_files', label: '生成文档/表格/演示等文件', default: true },
    { id: 'run_code', label: '运行代码（有副作用，需单独批准）', default: false },
    { id: 'external_publish', label: '对外发布、付款、发送消息', default: false, never: true }
  ];
  const TOOL_OP = { web_search: 'web_research', file_read: 'read_materials', code_execution: 'run_code', repository_access: 'run_code',
    docx_generation: 'generate_files', xlsx_generation: 'generate_files', pptx_generation: 'generate_files', chart_generation: 'generate_files', image_generation: 'generate_files',
    spreadsheet: 'generate_files', calculation: 'generate_files' };
  function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  const FREE = new Set(['local', 'free_tier']);

  function modelStatus(roleCaps, connection) {
    if (!connection) return { status: 'none', reason: '没有可用的模型连接：请管理员在“模型管理”接入并测试一个模型' };
    if (connection.enabled === false) return { status: 'unavailable', reason: '该模型连接已停用' };
    if (connection.ready === false || (connection.status && connection.status !== 'available')) return { status: 'unavailable', reason: '该模型连接尚未就绪或最近测试未通过（' + text(connection.status || 'not_ready', 30) + '）' };
    const declared = new Set(connection.capabilities || []);
    const missing = (roleCaps || []).filter(c => !declared.has(c));
    if (missing.length) return { status: 'capability_gap', reason: '该模型未声明岗位需要的能力：' + missing.join('、') };
    const paid = !FREE.has(connection.pricingMode);
    return { status: paid ? 'paid_needs_approval' : 'ready', reason: paid ? '收费或计费未知的模型：每次运行前必须单独批准费用上限和单价' : '本地/免费连接可用（能力只经用户声明，平台只实测过可对话）' };
  }
  function pickModel(role, models) {
    const usable = (models || []).filter(c => c && c.enabled !== false && c.ready !== false && (!c.status || c.status === 'available'));
    const score = c => { const d = new Set(c.capabilities || []); return (role.capabilities || []).filter(x => d.has(x)).length * 10 + (FREE.has(c.pricingMode) ? 3 : 0); };
    return usable.sort((a, b) => score(b) - score(a) || String(a.connectionId).localeCompare(String(b.connectionId)))[0] || null;
  }
  function toolStatus(id, tools) {
    if (!tools) return { status: 'unchecked', reason: '尚未向服务器核对该工具（离线模式）' };
    const t = tools[id];
    if (!t) return { status: 'unknown', reason: '平台目录中没有该工具；需要管理员接入，或从步骤中移除' };
    if (t.status === 'available') return { status: 'available', reason: '服务器能力中心确认可用', tool_id: t.toolId || id };
    return { status: t.status || 'needs_setup', reason: text(t.howTo || '工具尚未配置', 200) };
  }

  /* input: { goal, domain?, audience?, successCriteria?, outputs?, constraints?, risks?, models?, tools? }
   * tools: optional map intakeId -> {status, toolId, howTo} (e.g. from /api/v2/intake/plan toolCheck) */
  function plan(input) {
    input = input || {};
    const goal = text(input.goal, 2000);
    if (goal.length < 6) return { ok: false, error: '请用一句话写下你想完成的事（至少 6 个字）' };
    const universal = { domain: text(input.domain, 60), outputs: Array.isArray(input.outputs) ? input.outputs : [], successCriteria: text(input.successCriteria, 2000),
      constraints: text(input.constraints, 2000), risks: text(input.risks, 2000) };
    const t = U.buildTemplate({ description: goal, audience: text(input.audience, 200), universal });
    const u = t.universal;
    const corpus = [goal, universal.domain, universal.constraints, universal.risks].join('\n');
    // Honest confidence: how much the user's own words actually told us.
    const reasons = [];
    let score = 15;
    if (u.outputs.length) { score += Math.min(30, 12 * u.outputs.length); reasons.push('识别到成果形式：' + u.outputs.map(k => U.LABELS.outputs[k]).join('、')); } else reasons.push('没有识别到明确的成果形式');
    if (u.activities.length) { score += Math.min(25, 8 * u.activities.length); reasons.push('识别到工作类型：' + u.activities.map(k => U.LABELS.activities[k]).join('、')); } else reasons.push('没有识别到具体的工作类型');
    if (universal.domain) score += 15; else reasons.push('领域由你确认后才会写进岗位名称（系统不猜行业）');
    if (u.input.successCriteria.length) score += 10; else reasons.push('还没有可检查的成功标准');
    if (goal.length >= 25) score += 5;
    score = Math.min(100, score);
    const level = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
    const cannot = LIMITS.filter(l => l.re.test(corpus)).map(l => ({ id: l.id, text: l.text, needs: 'human' }));
    for (const h of u.humanCheckpoints) cannot.push({ id: 'licensed_' + h.domain, text: h.requirement, needs: 'licensed_human' });
    if (level === 'low') cannot.push({ id: 'low_confidence', text: '系统对这个目标的理解有限，下面的团队只是起点；请真人确认岗位是否合理，必要时补充说明或拆分任务。', needs: 'human' });
    const models = Array.isArray(input.models) ? input.models : [];
    const tools = input.tools && typeof input.tools === 'object' ? input.tools : null;
    const roles = t.roles.map(r => {
      const m = pickModel(r, models);
      const ms = modelStatus(r.capabilities, m);
      return { role_id: r.id, name: r.name, duty: r.duty, boundary: r.boundary || '', standard: r.standard, capabilities: r.capabilities.slice(), required: !!r.required, origin: 'suggested',
        model: { connection_id: m ? m.connectionId : null, display_name: m ? text(m.displayName || m.connectionId, 80) : null, pricing_mode: m ? text(m.pricingMode || 'unknown', 20) : null, ...ms } };
    });
    const steps = t.steps.map(s => ({ step_id: s.id, role_id: s.roleId, title: s.title, deliverable: s.deliverable, quality: s.quality,
      tools: (s.tools || []).map(id => ({ tool_id: id, ...toolStatus(id, tools) })) }));
    const plan = {
      schema: C.PLAN_SCHEMA, plan_id: 'plan-' + hash(goal + '|' + universal.domain + '|' + u.outputs.join(',')), source: 'offline_rules_v1', simulated: true, label: 'SIMULATED',
      evidence: 'E2_FAKE', generated_without_model: true, goal, domain: universal.domain, audience: u.audience, risk: u.suggestedRisk, rigor: u.suggestedRigor,
      status: u.status, confidence: { level, score, reasons }, cannot_do: cannot, clarifications: u.clarifications,
      roles, steps,
      deliverables: u.outputs.map(k => ({ id: 'out-' + k, label: U.LABELS.outputs[k], kind: k })),
      acceptance: u.deliveryChecks.map(c => ({ id: c.id, text: c.text, source: c.source, verification: 'not_verified' })),
      human_checkpoints: u.humanCheckpoints,
      budget: { estimate_usd: null, estimate_status: 'unknown', note: '未运行前无法知道真实费用；本地模型记 0 不是厂商账单，收费模型按你批准的上限保守预留。' },
      permissions: { allowed_ops: OPS.filter(o => o.default && !o.never).map(o => o.id), max_cost_usd: 0, max_tokens: 64000, max_output_tokens: 2048, approve_paid: false, approve_external_tools: false, prices: {}, confirmed: false },
      universal_input: u.input, disclaimer: t.disclaimer
    };
    plan.blocks = blocks(plan);
    return { ok: true, plan };
  }
  // Recomputed after every edit. Blocks are explanations; the backend remains the only authority.
  function blocks(p) {
    if (p.contract === 'r53') return blocksR53(p);
    const out = [];
    if (p.simulated) out.push({ code: 'PLAN_SIMULATED', severity: 'info', text: '这是离线规则生成的模拟方案（SIMULATED），没有调用 AI 模型，也未经领域专家确认。' });
    if (p.status === 'needs_clarification') out.push({ code: 'NEEDS_CLARIFICATION', severity: 'block', text: '还有必须补充的信息：' + p.clarifications.filter(c => c.blocking).map(c => c.question.split('？')[0]).join('；') });
    const noModel = p.roles.filter(r => !r.model.connection_id || ['none', 'unavailable'].includes(r.model.status));
    if (noModel.length) out.push({ code: 'NO_MODEL', severity: 'block', text: noModel.length + ' 个岗位没有可用模型：' + noModel.slice(0, 3).map(r => r.name + '（' + r.model.reason + '）').join('；') });
    const gap = p.roles.filter(r => r.model.status === 'capability_gap');
    if (gap.length) out.push({ code: 'MODEL_CAPABILITY_GAP', severity: 'warn', text: gap.map(r => r.name + '：' + r.model.reason).slice(0, 3).join('；') });
    if (p.roles.some(r => r.model.status === 'paid_needs_approval') && !(p.permissions.approve_paid && p.permissions.max_cost_usd > 0)) out.push({ code: 'PAID_NOT_APPROVED', severity: 'block', text: '有收费或计费未知的模型，需要你批准本次运行的费用上限和单价。' });
    const missingTools = [...new Set(p.steps.flatMap(s => s.tools.filter(t => t.status !== 'available').map(t => t.tool_id)))];
    if (missingTools.length) out.push({ code: 'TOOL_NOT_READY', severity: 'block', text: '这些工具还不可用或未核对：' + missingTools.join('、') + '。可以从步骤中移除，或请管理员接入。' });
    const needOps = [...new Set(p.steps.flatMap(s => s.tools.map(t => TOOL_OP[t.tool_id]).filter(Boolean)))].filter(op => !p.permissions.allowed_ops.includes(op));
    if (needOps.length) out.push({ code: 'OP_NOT_ALLOWED', severity: 'block', text: '步骤需要你尚未允许的操作：' + needOps.map(op => (OPS.find(o => o.id === op) || {}).label || op).join('、') });
    if (p.cannot_do.some(c => c.needs === 'licensed_human')) out.push({ code: 'HUMAN_EXPERT_REQUIRED', severity: 'warn', text: '成果对外使用前必须由具备资质的真人专家审查；平台不提供该认证。' });
    if (!p.permissions.confirmed) out.push({ code: 'NOT_AUTHORIZED', severity: 'block', text: '你还没有确认本次运行的授权范围与费用上限。' });
    return out;
  }
  // R53 universal backend (#37): server plan, per-role grants, peer review rule, local models only.
  const REMOTE_TEXT = '远程/收费模型的费用硬上限和官方授权还没有被证明，通用工作流只允许已验证的本地模型。';
  function blocksR53(p) {
    const out = [{ code: 'PLAN_SIMULATED', severity: 'info', text: '服务器离线规则草案（PLAN_SIMULATED / ' + (p.evidence || 'E2_RULES_NOT_AI') + '）：没有调用 AI，也未经领域专家确认。' }];
    if (p.status === 'needs_clarification' || (p.clarifications || []).some(c => c.blocking)) out.push({ code: 'NEEDS_CLARIFICATION', severity: 'warn', text: '建议补充：' + (p.clarifications || []).filter(c => c.blocking).map(c => String(c.question).split('？')[0]).join('；') });
    const noModel = p.roles.filter(r => !r.model || !r.model.connection_id || ['none', 'unavailable'].includes(r.model.status));
    if (noModel.length) out.push({ code: 'NO_MODEL', severity: 'block', text: noModel.length + ' 个岗位没有可用的本地模型：没有模型时只能保存模拟方案或看演示。' });
    const remote = p.roles.filter(r => r.model && r.model.connection_id && r.model.pricing_mode && r.model.pricing_mode !== 'local');
    if (remote.length) out.push({ code: 'BLOCKED_UNENFORCEABLE_COST_CAP', severity: 'block', text: remote.map(r => r.name).join('、') + '：' + REMOTE_TEXT });
    const reviews = p.steps.filter(s => s.kind === 'peer_review');
    if (!reviews.length) out.push({ code: 'PEER_REVIEW_MISSING', severity: 'block', text: '通用工作流需要至少一个独立复核步骤；请把某个步骤设为“独立复核”。' });
    for (const s of reviews) {
      const before = p.steps.slice(0, p.steps.indexOf(s));
      if (!before.length || before.some(x => x.role_id === s.role_id)) out.push({ code: 'PEER_REVIEW_CONFLICT', severity: 'block', text: '复核步骤“' + s.title + '”必须排在其他岗位的工作之后，且复核岗位不能复核自己做的工作。' });
    }
    if (p.expert_review_required) out.push({ code: 'HUMAN_EXPERT_REQUIRED', severity: 'warn', text: '验收时需要填写具备资质的人工审查说明；平台不认证该审查。' });
    const grants = p.permissions.roles || {};
    const pending = p.roles.filter(r => !(grants[r.role_id] && grants[r.role_id].approved));
    if (pending.length) out.push({ code: 'ROLE_NOT_APPROVED', severity: 'block', text: pending.length + ' 个岗位尚未逐一批准：' + pending.slice(0, 4).map(r => r.name).join('、') + (pending.length > 4 ? '…' : '') });
    if (!p.permissions.confirmed) out.push({ code: 'NOT_AUTHORIZED', severity: 'block', text: '你还没有确认整个团队的授权与上限。' });
    return out;
  }
  function serverTools(toolCheck) {
    const map = {};
    for (const t of Array.isArray(toolCheck) ? toolCheck : []) if (t && typeof t.intakeId === 'string') map[t.intakeId] = { status: t.status, toolId: t.toolId || null, howTo: t.howTo || '' };
    return map;
  }
  return { plan, blocks, blocksR53, modelStatus, pickModel, toolStatus, serverTools, OPS, TOOL_OP, LIMITS };
});
