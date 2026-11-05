/* AIJAVAIS Project Intake Engine v1.0 | MIT-style internal module; no API calls or side effects */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AIJProjectIntake = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RISK = ['low','medium','high'];
  const RIGOR = ['lean','normal','strict'];
  const FREE = new Set(['free_tier','local']);
  const words = x => String(x == null ? '' : x).trim();
  const uniq = arr => [...new Set(arr)];
  const find = (catalog, id) => ((catalog && catalog.templates) || []).find(t => t.id === id) || null;
  function validateCatalog(catalog) {
    const errors = [];
    if (!catalog || !Array.isArray(catalog.templates)) return { ok: false, errors: ['目录缺少 templates 数组'] };
    const tid = new Set();
    for (const t of catalog.templates) {
      if (!t || !t.id || !t.name || !Array.isArray(t.roles) || !Array.isArray(t.steps)) { errors.push('项目模板格式不完整'); continue; }
      if (tid.has(t.id)) errors.push('重复项目类型：' + t.id);
      tid.add(t.id);
      const rid = new Set();
      for (const r of t.roles) {
        if (!r.id || !r.name || !r.duty || !r.standard) errors.push(t.id + '：岗位信息不完整');
        if (rid.has(r.id)) errors.push(t.id + '：重复岗位 ' + r.id);
        rid.add(r.id);
      }
      const sid = new Set();
      for (const s of t.steps) {
        if (!s.id || !s.title || !s.quality || !s.deliverable) errors.push(t.id + '：流程步骤不完整');
        if (!rid.has(s.roleId)) errors.push(t.id + '：步骤指向不存在的岗位 ' + s.roleId);
        if (sid.has(s.id)) errors.push(t.id + '：重复步骤 ' + s.id);
        sid.add(s.id);
      }
      const qid = new Set();
      for (const q of (t.quantFields || [])) {
        if (!q.id || !q.label || !Array.isArray(q.options) || !q.options.length) errors.push(t.id + '：量化字段格式不正确');
        if (qid.has(q.id)) errors.push(t.id + '：重复字段 ' + q.id);
        qid.add(q.id);
        if (!q.options.some(o => o.value === q.defaultValue)) errors.push(t.id + '：字段默认值不存在 ' + q.id);
      }
    }
    return { ok: !errors.length, errors };
  }
  function matchTemplates(catalog, description, limit) {
    const q = words(description).toLowerCase();
    const items = ((catalog && catalog.templates) || []).map(t => {
      const name = words(t.name).toLowerCase();
      let score = q && q.includes(name) ? 15 : 0;
      for (const kw of (t.keywords || [])) {
        const k = words(kw).toLowerCase();
        if (!k || !q.includes(k)) continue;
        score += k.length > 4 ? 5 : 3;
      }
      if (q && t.summary && q.includes(words(t.summary).toLowerCase())) score += 5;
      return { templateId: t.id, name: t.name, summary: t.summary, score, reason: score ? '任务描述与该专业领域关键词匹配' : '可手动选择该团队类型' };
    }).sort((a,b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'));
    return items.slice(0, Math.max(1, Math.min(30, Number(limit) || 5)));
  }
  function suggestDefaults(template, description) {
    const q = words(description);
    const intrinsicallySensitive = ['engineering-design','contract-review','financial-budget'].includes(template.id);
    const high = intrinsicallySensitive || /人身安全|生命|事故|结构安全|重大投资|法定|投产|对外正式|高风险|强制认证|监管|生产环境/.test(q);
    const medium = /正式|上线|客户|实施|交付|制度|规模化/.test(q);
    return { risk: high ? 'high' : medium ? 'medium' : 'low', rigor: high ? 'strict' : medium ? 'normal' : 'lean', reason: high ? '涉及工程/资金/正式合规或其他较高风险，建议严格复核' : medium ? '涉及正式使用，建议独立复核' : '一般探索性任务可采用精简流程' };
  }
  function recommendRoles(template, options) {
    const risk = RISK.includes(options && options.risk) ? options.risk : 'low';
    const rigor = RIGOR.includes(options && options.rigor) ? options.rigor : 'lean';
    const selected = new Set(template.roles.filter(r => r.required).map(r => r.id));
    const optional = template.roles.filter(r => !r.required);
    const review = r => /审核|审校|复核|质量|测试|风险/.test(r.name);
    if (rigor !== 'lean' || risk !== 'low') {
      for (const r of optional) if (review(r)) selected.add(r.id);
    }
    if (rigor === 'strict' || risk === 'high') for (const r of optional) selected.add(r.id);
    const explanations = template.roles.map(r => ({
      roleId: r.id,
      recommended: selected.has(r.id),
      priority: r.required ? 100 : selected.has(r.id) ? 75 : 35,
      reason: r.required ? '这是完成专业核心工作的默认岗位，可手动调整，但会提示影响'
        : selected.has(r.id) ? '根据本项目的严谨程度，建议增加独立验证或辅助专业岗位'
          : '对精简项目可不设置此岗位，任务复杂时可以随时加回'
    }));
    return { selectedRoleIds: [...selected], explanations };
  }
  function getFieldOptions(template, supplied) {
    const answers = { ...(supplied || {}) };
    const errors = [];
    const selected = [];
    for (const field of (template.quantFields || [])) {
      const actual = answers[field.id] == null ? field.defaultValue : String(answers[field.id]);
      const opt = field.options.find(o => o.value === actual);
      if (!opt) { errors.push('量化字段“' + field.label + '”的值无效'); continue; }
      selected.push({ id: field.id, label: field.label, value: actual, selectedText: opt.text, help: field.help || '' });
    }
    return { selected, errors };
  }
  function normalizeToolStatus(availableTools) {
    const map = new Map();
    for (const item of (availableTools || [])) {
      if (typeof item === 'string') map.set(item, { id: item, available: true, verified: true });
      else if (item && item.id) map.set(item.id, { id: item.id, available: !!item.available, verified: !!item.verified });
    }
    return map;
  }
  function buildPlan(catalog, input) {
    input = input || {};
    const base = find(catalog, input.templateId);
    if (!base) return { ok: false, errors: ['请先选择有效的项目类型'], warnings: [] };
    const customRoles = (Array.isArray(input.customRoles) ? input.customRoles : []).slice(0, 12).map(r => ({
      id: words(r.id).slice(0, 32), name: words(r.name).slice(0, 50), duty: words(r.duty).slice(0, 400),
      standard: words(r.standard).slice(0, 400), required: false,
      capabilities: Array.isArray(r.capabilities) ? r.capabilities.map(x => words(x)).slice(0, 10) : []
    }));
    const customSteps = customRoles.map(r => ({
      id: 'step-' + r.id, title: '执行：' + r.name, roleId: r.id,
      deliverable: words((input.customDeliverables || {})[r.id]) || '形成可审核的工作成果',
      quality: r.standard, tools: []
    }));
    const t = { ...base, roles: [...base.roles, ...customRoles], steps: [...base.steps, ...customSteps] };
    const description = words(input.description);
    if (description.length < 8) return { ok: false, errors: ['请用至少 8 个字描述想解决的问题或期望成果'], warnings: [] };
    if (description.length > 20000) return { ok: false, errors: ['需求描述不能超过 20000 字符，请通过文件附件传递长材料'], warnings: [] };
    const inferred = suggestDefaults(t, description);
    const answers = { ...(input.answers || {}) };
    if (answers.risk == null) answers.risk = inferred.risk;
    if (answers.rigor == null) answers.rigor = inferred.rigor;
    const quant = getFieldOptions(t, answers);
    const risk = answers.risk;
    const rigor = answers.rigor;
    const roleSuggestion = recommendRoles(t, { risk, rigor });
    const roleIds = input.selectedRoleIds == null ? roleSuggestion.selectedRoleIds : uniq(input.selectedRoleIds.map(String));
    const stepIds = input.selectedStepIds == null ? null : uniq(input.selectedStepIds.map(String));
    const errors = [...quant.errors];
    if (Array.isArray(input.customRoles) && input.customRoles.length > 12) errors.push('自定义岗位最多 12 个');
    for (const r of customRoles) if (!/^custom-[a-z0-9-]{1,25}$/.test(r.id) || !r.name || !r.duty || !r.standard) errors.push('自定义岗位 ID、名称、职责或验收标准不完整');
    if (new Set(t.roles.map(r => r.id)).size !== t.roles.length) errors.push('岗位 ID 重复');
    if (new Set(t.steps.map(s => s.id)).size !== t.steps.length) errors.push('流程步骤 ID 重复');
    const warnings = [];
    if (!roleIds.length) errors.push('至少选择一个执行岗位');
    for (const id of roleIds) if (!t.roles.some(r => r.id === id)) errors.push('未知岗位 ' + id);
    if (stepIds) for (const id of stepIds) if (!t.steps.some(s => s.id === id)) errors.push('未知流程步骤 ' + id);
    const roles = t.roles.filter(r => roleIds.includes(r.id)).map(r => ({ ...r, selected: true, modelConnectionId: (input.assignments || {})[r.id] || null }));
    for (const r of t.roles) if (r.required && !roleIds.includes(r.id)) warnings.push('已移除核心岗位“' + r.name + '”，需重新安排其工作，否则可能无法完整交付');
    const steps = t.steps.filter(s => (!stepIds || stepIds.includes(s.id)) && roleIds.includes(s.roleId)).map(s => ({ ...s, roleName: (t.roles.find(r => r.id === s.roleId) || {}).name || '' }));
    const removed = t.steps.filter(s => (!stepIds || stepIds.includes(s.id)) && !roleIds.includes(s.roleId));
    for (const s of removed) warnings.push('因岗位被移除，步骤“' + s.title + '”未纳入流程，请确认不会遗漏交付要求');
    if (!steps.length) errors.push('当前组合没有可执行的流程步骤');
    const noReview = !roles.some(r => /审核|复核|测试|质量|审校|风险/.test(r.name));
    if (noReview && (risk === 'high' || rigor === 'strict')) warnings.push('高风险或严格标准项目未设置独立审核/质量岗位，建议至少增加独立验证或人工审查');
    const toolMap = normalizeToolStatus(input.availableTools);
    const requiredTools = uniq(steps.flatMap(s => s.tools || []));
    const missingTools = requiredTools.filter(id => !(toolMap.has(id) && toolMap.get(id).available && toolMap.get(id).verified));
    if (missingTools.length) warnings.push('尚未验证所需工具：' + missingTools.join('、') + '。工具未就绪时不能宣称已真实完成文件或工程交付');
    if (t.disclaimer) warnings.push(t.disclaimer);
    const assignments = roles.filter(r => r.modelConnectionId);
    const connectionMap = new Map((Array.isArray(input.availableModels) ? input.availableModels : []).map(c => [c.connectionId,c]));
    const freeOnly = input.budgetMode === 'free_only';
    const modelIssues = [];
    for (const role of roles) {
      if (!role.modelConnectionId) { modelIssues.push(role.name + '：未分配模型'); continue; }
      const c = connectionMap.get(role.modelConnectionId);
      if (!c) { modelIssues.push(role.name + '：未检测到所选模型连接的可信配置'); continue; }
      if (!c.enabled || !c.ready) modelIssues.push(role.name + '：模型已停用或尚未就绪');
      const verified = new Set(c.verifiedCapabilities || []);
      const notVerified = (role.capabilities || []).filter(x => !verified.has(x));
      if (notVerified.length) modelIssues.push(role.name + '：必要能力尚未实测 ' + notVerified.join('、'));
      if (freeOnly && !((c.pricingMode === 'local' && c.localityVerified === true) ||
        (c.pricingMode === 'free_tier' && c.freeEligibilityVerified === true))) {
        modelIssues.push(role.name + '：尚未确认免费资格，零额外费用模式下不得自动执行');
      }
    }
    if (modelIssues.length) warnings.push(...modelIssues);
    const plan = {
      schemaVersion: 1,
      projectType: t.id,
      projectTypeName: t.name,
      description,
      context: words(input.context),
      audience: words(input.audience),
      deliveryExpectation: words(input.deliveryExpectation),
      referenceNotes: words(input.referenceNotes),
      quantification: quant.selected,
      risk,
      rigor,
      suggestedRigor: inferred,
      roles,
      steps,
      requiredTools,
      missingTools,
      budgetMode: freeOnly ? 'free_only' : 'user_review',
      modelIssues,
      standards: roles.map(r => ({ roleId: r.id, roleName: r.name, duty: r.duty, acceptanceStandard: r.standard })),
      customizedRoles: customRoles,
      warnings,
      readyForAutomatedExecution: !!steps.length && !!roles.length && !missingTools.length && !modelIssues.length && assignments.length === roles.length,
      state: 'draft',
      note: '此计划是立项指导，不代表已执行模型调用或工具调用。'
    };
    if (assignments.length !== roles.length) warnings.push('部分岗位尚未分配模型，可先保存方案，执行前必须完成模型分配');
    return { ok: !errors.length, errors, warnings, plan, roleSuggestions: roleSuggestion.explanations };
  }
  function rankModels(role, connections, mode) {
    const required = new Set(role.capabilities || []);
    const freeOnly = mode === 'free_only';
    return (connections || []).map(c => {
      const caps = new Set(c.verifiedCapabilities || []);
      const claimed = new Set(c.capabilities || []);
      const verifiedHits = [...required].filter(x => caps.has(x));
      const claimedHits = [...required].filter(x => !caps.has(x) && claimed.has(x));
      const missing = [...required].filter(x => !caps.has(x) && !claimed.has(x));
      const available = c.enabled !== false && c.ready === true;
      const costOk = !freeOnly || (c.pricingMode === 'local' && c.localityVerified === true) ||
        (c.pricingMode === 'free_tier' && c.freeEligibilityVerified === true);
      const eligible = available && costOk && !missing.length;
      const score = Math.max(0, Math.min(100, Math.round(verifiedHits.length * 22 + claimedHits.length * 9 + (available ? 20 : 0) + (available && caps.has('chat') ? 15 : 0) + (FREE.has(c.pricingMode) ? 5 : 0) - missing.length * 20)));
      return { connectionId: c.connectionId, displayName: c.displayName || c.connectionId, eligible, score,
        verifiedHits, claimedHits, missing, pricingMode: c.pricingMode || 'unknown',
        notes: [!available ? '当前未就绪或已停用' : '', !costOk ? '免费模式不允许未验证的免费资格或收费连接' : '',
          missing.length ? '缺少必需能力：' + missing.join('、') : '',
          claimedHits.length ? '部分能力仅用户声明，尚未实测：' + claimedHits.join('、') : ''].filter(Boolean)
      };
    }).sort((a,b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
  }
  function formatPrompt(plan) {
    if (!plan) return '';
    const sec = (title, lines) => '\n【' + title + '】\n' + lines.join('\n');
    const out = ['请按以下项目立项方案组织工作。执行前确认工具、模型、资料和审批权限；不编造工具调用、结果或来源。'];
    out.push(sec('项目目标', [plan.projectTypeName + '：' + plan.description, plan.context ? '背景：' + plan.context : '', plan.audience ? '服务对象：' + plan.audience : '', plan.deliveryExpectation ? '期待成果：' + plan.deliveryExpectation : ''].filter(Boolean)));
    out.push(sec('量化要求', plan.quantification.map(q => q.label + '：' + q.selectedText)));
    out.push(sec('岗位职责边界', plan.roles.map(r => r.name + '：' + r.duty + '；验收标准：' + r.standard)));
    out.push(sec('建议工作流程', plan.steps.map((s,i) => (i+1) + '. ' + s.title + '（' + s.roleName + '）；成果：' + s.deliverable + '；检查：' + s.quality)));
    out.push(sec('工具需求', ['需要：' + (plan.requiredTools.join('、') || '不要求额外工具'), '未验证可用：' + (plan.missingTools.join('、') || '无')]));
    if (plan.referenceNotes) out.push(sec('资料提示', [plan.referenceNotes]));
    if (plan.warnings.length) out.push(sec('待确认事项', plan.warnings));
    out.push(sec('执行纪律', ['先检查权限和工具是否具备。', '缺材料时只问真正阻碍任务完成的关键问题。', '各岗位按交付标准提供可核查证据。', '任务需要文件时必须交付真实文件，不能以文字声称生成。', '高风险结论需要符合专业复核和人工确认要求。']));
    return out.join('\n');
  }
  return { validateCatalog, matchTemplates, suggestDefaults, recommendRoles, buildPlan, rankModels, formatPrompt };
});
