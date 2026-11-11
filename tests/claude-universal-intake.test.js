'use strict';
// R44 (#28): universal team drafts for unknown / cross-over industries. Offline engine
// (E2) plus the real server HTTP path (E3: real server.js, auth, SQLite). No model is
// configured or called; nothing here is a real-model (E4) or human (E5) result.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/planner/rules.js');
const U = require('../lib/planner/universal-team.js');
const catalog = require('../lib/planner/catalog.v1.json');
const H = require('./helpers');

// Three industries that do not appear anywhere in the template catalog (names, keywords, summaries).
const UNSEEN = {
  petFuneral: { description: '为城市宠物殡葬与纪念服务门店设计开业服务流程、价目表和客户告别仪式方案', audience: '失去宠物的家庭',
    universal: { domain: '宠物殡葬与纪念服务', successCriteria: '服务流程每一步都有负责人\n价目表包含成本测算', constraints: '遵守当地动物尸体无害化处理规定' } },
  dronePlantProtection: { description: '规划一个农业无人机植保作业季的排班、农药配比安全规范和农户沟通材料', audience: '合作社农户',
    universal: { domain: '农业无人机植保', outputs: ['schedule', 'document'], successCriteria: '排班覆盖全部地块；安全规范引用适用标准', constraints: '按当地农药使用规定执行' } },
  bambooLiveCommerce: { description: '为乡村非遗竹编手工艺开设短视频直播带货，做选品分析、直播脚本和视觉海报', audience: '直播间观众',
    universal: { domain: '非遗竹编直播电商', successCriteria: '三场直播脚本完整\n海报尺寸适配手机竖屏', constraints: '两周内上线' } }
};
const plan = input => { const r = E.buildPlan(catalog, { templateId: 'universal', ...input }); assert.equal(r.ok, true, r.errors && r.errors.join('; ')); return r; };

test('the three unseen industries really are absent from the catalog and get no strong template match', () => {
  const corpus = JSON.stringify(catalog);
  for (const [name, x] of Object.entries(UNSEEN)) {
    assert.ok(!corpus.includes(x.universal.domain), name + ' domain appears in catalog');
    const hits = E.matchTemplates(catalog, x.description, 5);
    assert.ok(hits.every(h => h.strength !== 'strong'), name + ': ' + JSON.stringify(hits.map(h => [h.name, h.score])));
    assert.ok(hits.every(h => h.matched === (h.score > 0)));
    assert.ok(hits.filter(h => !h.matched).every(h => /未匹配/.test(h.reason)), 'zero-score templates are labelled as unmatched samples');
  }
});

test('unseen industries get genuinely different teams, steps, tools, standards and risk handling', () => {
  const r = Object.fromEntries(Object.entries(UNSEEN).map(([k, x]) => [k, plan(x)]));
  const ids = k => r[k].plan.roles.map(x => x.id).sort().join(',');
  const tools = k => [...new Set(r[k].plan.steps.flatMap(s => s.tools))].sort().join(',');
  const keys = Object.keys(r);
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    assert.notEqual(ids(keys[i]), ids(keys[j]), 'role sets differ: ' + keys[i] + ' vs ' + keys[j]);
    assert.notEqual(tools(keys[i]), tools(keys[j]), 'tool sets differ');
  }
  for (const k of keys) {
    const p = r[k].plan;
    assert.ok(p.roles.length >= 5, k + ' is more than a renamed two-role team');
    assert.ok(p.roles.some(x => x.name.includes(UNSEEN[k].universal.domain)), 'lead role is named after the user\'s own domain');
    assert.equal(p.generation, 'offline_rules'); assert.equal(p.universal.verification, 'not_verified');
    assert.ok(p.universal.deliveryChecks.every(c => c.verification === 'not_verified'));
    assert.ok(p.universal.deliveryChecks.some(c => c.source === 'user'), 'user success criteria become checks');
    assert.match(p.projectTypeName, /^通用编队：/); assert.ok(!catalog.templates.some(t => t.name === p.projectTypeName), 'never presented as a catalog template');
    assert.ok(p.warnings.some(w => /未调用 AI 模型/.test(w)));
    assert.ok(p.roles.every(x => x.duty && x.standard), 'every role has duty and acceptance standard');
    assert.ok(p.steps.every(s => s.deliverable && s.quality && p.roles.some(x => x.id === s.roleId)));
  }
  // Specific, explainable differences driven by the user's words (not by an industry list).
  const pf = r.petFuneral.plan, dr = r.dronePlantProtection.plan, bb = r.bambooLiveCommerce.plan;
  assert.ok(pf.roles.some(x => x.id === 'u-costing') && pf.roles.some(x => x.id === 'u-sheet'), 'price list → costing + spreadsheet roles');
  assert.deepEqual(pf.universal.riskDomains.sort(), ['environment', 'legal']);
  assert.deepEqual(dr.universal.riskDomains.sort(), ['legal', 'safety'], '农药 → safety; 使用规定 → legal'); assert.equal(dr.risk, 'high'); assert.equal(dr.rigor, 'strict');
  assert.ok(dr.roles.some(x => x.id === 'u-planner') && dr.universal.outputsSource === 'user');
  assert.ok(dr.universal.humanCheckpoints.some(h => /人身\/生产安全/.test(h.requirement)));
  assert.ok(dr.roles.find(x => x.id === 'u-lead').boundary.includes('不得替代持证工程/安全人员签字'));
  assert.deepEqual(bb.universal.riskDomains, []); assert.ok(!bb.roles.some(x => x.id === 'u-risk'));
  assert.ok(bb.roles.some(x => x.id === 'u-visual') && bb.roles.some(x => x.id === 'u-editor') && bb.roles.some(x => x.id === 'u-analyst'));
  assert.ok(!bb.roles.some(x => x.id === 'u-engineer'), '"直播脚本" is a script for people, not software');
});

test('high-risk domains always require a human expert; the platform never claims certification', () => {
  for (const [desc, domain] of [['为社区老人设计居家康复训练和用药提醒服务方案', 'medical'], ['给小学生设计课后托管安全制度和家长告知书', 'minors'], ['为小微企业设计贷款融资申请材料与税务准备清单', 'finance']]) {
    const p = plan({ description: desc, universal: { domain: '测试', successCriteria: '完成', outputs: ['document'] } }).plan;
    assert.ok(p.universal.riskDomains.includes(domain), desc);
    assert.equal(p.risk, 'high');
    assert.ok(p.roles.some(r => r.id === 'u-risk' && /非持证专家/.test(r.name)));
    assert.ok(p.universal.humanCheckpoints.length > 0);
    assert.ok(p.warnings.some(w => /人工专家审查/.test(w)));
    assert.ok(p.universal.clarifications.some(c => c.id === 'jurisdiction'));
  }
});

test('missing information is flagged needs_clarification and blocks automated execution, but drafting still works', () => {
  const r = plan({ description: '帮我把这件事情好好安排一下吧', assignments: {}, availableModels: [] });
  const u = r.plan.universal;
  assert.equal(u.status, 'needs_clarification');
  assert.deepEqual(u.clarifications.filter(c => c.blocking).map(c => c.id).sort(), ['domain', 'outputs', 'successCriteria']);
  assert.equal(r.plan.readyForAutomatedExecution, false);
  assert.ok(r.warnings.some(w => /^需要澄清：/.test(w)));
  assert.ok(r.plan.roles.some(x => x.name.includes('领域待确认')), 'unknown domain is shown as pending, not guessed');
  // Even with every role "assigned" to a ready verified model, clarification still blocks automation.
  const roles = r.plan.roles.map(x => x.id), model = { connectionId: 'm', enabled: true, ready: true, pricingMode: 'local', localityVerified: true, verifiedCapabilities: ['reasoning', 'writing', 'research', 'data_analysis', 'coding', 'vision'] };
  const assigned = plan({ description: '帮我把这件事情好好安排一下吧', selectedRoleIds: roles, assignments: Object.fromEntries(roles.map(x => [x, 'm'])), availableModels: [model] });
  assert.equal(assigned.plan.readyForAutomatedExecution, false);
  // Once the user answers, the same goal becomes an editable draft.
  assert.equal(plan({ description: '帮我把这件事情好好安排一下吧', universal: { domain: '社区读书会', outputs: ['schedule'], successCriteria: '每月一次活动' } }).plan.universal.status, 'draft_ready_for_edit');
});

test('ordinary users can rewrite roles and steps; bad edits are rejected, not executed or merged into objects', () => {
  const x = UNSEEN.bambooLiveCommerce;
  const r = plan({ ...x, roleEdits: { 'u-visual': { name: '竹编海报美工', duty: '做三张竖屏海报', boundary: '只用自有照片', standard: '手机上文字清晰' } }, stepEdits: { 'u-step-visual': { title: '海报定稿', deliverable: '三张 PNG 海报', quality: '竖屏 9:16' } } });
  const role = r.plan.roles.find(v => v.id === 'u-visual'), step = r.plan.steps.find(s => s.id === 'u-step-visual');
  assert.equal(role.name, '竹编海报美工'); assert.equal(role.duty, '做三张竖屏海报（边界：只用自有照片）'); assert.equal(role.standard, '手机上文字清晰');
  assert.deepEqual([step.title, step.deliverable, step.quality, step.roleName], ['海报定稿', '三张 PNG 海报', '竖屏 9:16', '竹编海报美工']);
  const bad = (edits, re) => { const res = E.buildPlan(catalog, { templateId: 'universal', ...x, ...edits }); assert.equal(res.ok, false); assert.match(res.errors.join(';'), re); };
  bad({ roleEdits: { 'u-visual': { name: '   ' } } }, /不能为空/);
  bad({ roleEdits: { 'u-nope': { name: 'x' } } }, /不存在的岗位/);
  bad({ roleEdits: { 'u-visual': { name: { toString: () => 'x' } } } }, /必须是文字/);
  bad({ roleEdits: [] }, /编辑格式不正确/);
  bad({ stepEdits: Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['s' + i, {}])) }, /编辑格式不正确/);
  bad({ roleEdits: JSON.parse('{"__proto__":{"name":"pwn"}}') }, /不存在的岗位/);
  assert.equal({}.name, undefined, 'no prototype pollution');
  // Long text is bounded.
  const long = plan({ ...x, roleEdits: { 'u-visual': { duty: 'x'.repeat(5000) } } }).plan.roles.find(v => v.id === 'u-visual');
  assert.ok(long.duty.length <= 400 + 300 + 10, 'duty and boundary are each bounded');
  // The same edit mechanism works for ordinary catalog templates too (backwards compatible).
  const ppt = E.buildPlan(catalog, { templateId: 'ppt-production', description: '制作一份新品发布演示稿', roleEdits: { storyline: { name: '故事线编辑' } } });
  assert.equal(ppt.ok, true); assert.equal(ppt.plan.roles.find(v => v.id === 'storyline').name, '故事线编辑');
});

test('malicious and out-of-range input stays inert text and is bounded', () => {
  const evil = '<img src=x onerror="globalThis.__pwn=1"><script>globalThis.__pwn=1</script>';
  const r = plan({ description: evil + ' 为社区设计活动计划表和宣传文案', audience: evil, universal: { domain: evil + 'x'.repeat(500), outputs: ['schedule', 'nope', '__proto__', 'media'], successCriteria: Array.from({ length: 30 }, (_, i) => evil + i).join('\n'), constraints: 'y'.repeat(10000) } });
  const u = r.plan.universal;
  assert.equal(globalThis.__pwn, undefined);
  assert.ok(u.domain.length <= U.LIMITS.domain);
  assert.deepEqual(u.outputs, ['schedule', 'media'], 'unknown output keys dropped');
  assert.ok(u.deliveryChecks.filter(c => c.source === 'user').length <= U.LIMITS.criteria);
  assert.ok(u.input.constraints.length <= U.LIMITS.field);
  assert.ok(r.plan.roles.length <= U.LIMITS.maxRoles);
  // Engine output is plain data: text is carried as-is for the UI to escape (verified in Chromium).
  assert.ok(JSON.stringify(r.plan).includes('<img src=x'));
  // Non-object universal input is treated as empty.
  for (const v of [null, 'x', 7, [1, 2]]) assert.equal(plan({ description: '为社区设计一份活动计划', universal: v }).plan.universal.domain, '');
  // Very wide goals are capped at 12 roles and the user is told to split the work.
  const wide = plan({ description: '调研数据预算采购客户流程，做报告表格PPT软件海报排期课程文案，涉及食品安全', universal: { domain: '综合', successCriteria: 'ok' } });
  assert.equal(wide.plan.roles.length, U.LIMITS.maxRoles);
  assert.ok(['u-scope', 'u-lead', 'u-risk', 'u-review'].every(id => wide.plan.roles.some(r => r.id === id)), 'scope, lead, risk and review are never dropped');
  assert.ok(wide.plan.universal.clarifications.some(c => c.id === 'scope-size'));
});

test('re-editable draft export/import round-trips and rejects foreign or malformed files', () => {
  const input = { templateId: 'universal', ...UNSEEN.petFuneral, assignments: { 'u-scope': 'secret-connection' }, availableModels: [{ connectionId: 'secret-connection', apiKey: 'sk-should-not-leak' }],
    roleEdits: { 'u-sheet': { name: '价目表制作员' } }, stepEdits: { 'u-step-scope': { deliverable: '开业范围说明' } }, selectedRoleIds: null, budgetMode: 'free_only' };
  const file = JSON.stringify(E.exportDraft(input));
  assert.doesNotMatch(file, /secret-connection|sk-should-not-leak|availableModels|assignments/);
  const back = E.importDraft(catalog, JSON.parse(file));
  assert.equal(back.ok, true, back.errors.join(';'));
  const before = plan(input).plan, after = plan(back.input).plan;
  assert.deepEqual(after.roles.map(r => [r.id, r.name, r.duty, r.standard]), before.roles.map(r => [r.id, r.name, r.duty, r.standard]));
  assert.deepEqual(after.steps.map(s => [s.id, s.deliverable]), before.steps.map(s => [s.id, s.deliverable]));
  assert.equal(after.roles.find(r => r.id === 'u-sheet').name, '价目表制作员');
  for (const [data, re] of [[{}, /format/], [{ format: 'aijavais-intake-draft', version: 2, input: {} }, /format/], [{ format: 'aijavais-intake-draft', version: 1, input: { templateId: 'no-such' , description: '一个足够长的描述内容' } }, /不存在/],
    [{ format: 'aijavais-intake-draft', version: 1, input: { templateId: 'universal', description: 7 } }, /文字/], [{ format: 'aijavais-intake-draft', version: 1, input: { templateId: 'universal', description: '一个足够长的描述内容', selectedRoleIds: Array(60).fill('a') } }, /格式不正确/],
    [{ format: 'aijavais-intake-draft', version: 1, input: { templateId: 'universal', description: '一个足够长的描述内容', roleEdits: { 'u-scope': { name: '' } } } }, /不能为空/]])
    assert.match(E.importDraft(catalog, data).errors.join(';'), re);
  // Catalog-template drafts round-trip too.
  const tpl = E.importDraft(catalog, E.exportDraft({ templateId: 'excel-analysis', description: '清洗销售数据并输出结论表格' }));
  assert.equal(tpl.ok, true); assert.equal(tpl.plan.projectType, 'excel-analysis');
});

test('existing catalog behaviour is unchanged for familiar goals', () => {
  assert.equal(E.validateCatalog(catalog).ok, true);
  const m = E.matchTemplates(catalog, '开发一个网站代码程序', 3);
  assert.equal(m[0].templateId, 'software-development'); assert.equal(m[0].strength, 'strong');
  for (const t of catalog.templates) {
    const r = E.buildPlan(catalog, { templateId: t.id, description: '我需要完成一套实际可落地的项目方案与交付文件' });
    assert.equal(r.ok, true, t.id); assert.equal(r.plan.universal, null); assert.equal(r.plan.generation, 'catalog_template');
    assert.ok(r.plan.roles.every(x => !/（边界：/.test(x.duty)), 'catalog duties untouched');
  }
});

test('E3 real server: universal plan, save to workspace and read back; auth gate; no model call or ledger row', async t => {
  const S = await H.boot(); t.after(() => S.stop());
  const body = { templateId: 'universal', ...UNSEEN.dronePlantProtection, roleEdits: { 'u-planner': { name: '飞防排班员' } } };
  assert.equal((await S.call('POST', '/api/v2/intake/plan', body, { cookie: false })).status, 401);
  const p = await S.call('POST', '/api/v2/intake/plan', body);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.plan.universal.status, 'draft_ready_for_edit');
  assert.ok(Array.isArray(p.json.toolCheck) && p.json.toolCheck.length > 0, 'capability center checks the universal tools honestly');
  const saved = await S.call('POST', '/api/v2/intake/projects', body);
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  const got = await S.call('GET', '/api/v2/projects/' + saved.json.project.projectId);
  assert.equal(got.status, 200);
  const proj = got.json.project;
  assert.match(proj.name, /^通用编队：农业无人机植保/);
  assert.ok(proj.roles.some(r => r.name === '飞防排班员'));
  assert.ok(proj.roles.some(r => /非持证专家/.test(r.name)));
  assert.equal(saved.json.plan.universal.verification, 'not_verified');
  assert.equal(proj.intake.projectType, 'universal'); assert.equal(proj.intake.risk, 'high');
  // Delivery checks survive in the persisted review step (the project schema has no universal field; see docs).
  assert.ok(proj.steps.some(s => /逐条核对：.*排班覆盖全部地块/.test(s.prompt)));
  assert.equal(got.json.runs.length, 0, 'saving a draft never starts a run');
  const bad = await S.call('POST', '/api/v2/intake/projects', { ...body, roleEdits: { 'u-planner': { name: '' } } });
  assert.equal(bad.status, 400);
  const usage = await S.call('GET', '/api/v2/usage/system');
  assert.equal(usage.status, 200); assert.equal((usage.json.usage || []).length, 0, 'no model request or ledger row');
});
