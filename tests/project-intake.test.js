'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/project-intake/engine.js');
const catalog = require('../public/project-intake/catalog.v1.json');
const full = id => catalog.templates.find(t => t.id === id);
const base = (templateId, description = '我需要完成一套实际可落地的项目方案与交付文件') => ({ templateId, description });

test('目录校验：覆盖不少于20类真实项目，每个岗位/流程/量化字段一致', () => {
  const r = E.validateCatalog(catalog);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.ok(catalog.templates.length >= 20);
  assert.ok(catalog.templates.every(t => t.roles.some(r=>r.required)));
  assert.ok(catalog.templates.every(t => t.steps.length >= 2));
});

test('自然语言推荐可区分组织结构、任职资格、工程设计、PPT与软件开发', () => {
  const cases = [
    ['请给企业设计一套组织架构和部门职责','organization-design'],
    ['重新建立岗位任职资格，区分行为成果素质能力知识技能','qualification-system'],
    ['帮我完成机械工程设计和技术方案','engineering-design'],
    ['制作科技风PPT演示稿','ppt-production'],
    ['开发一个网站代码程序','software-development']
  ];
  for (const [text,id] of cases) {
    const result = E.matchTemplates(catalog,text,10);
    assert.ok(result.slice(0,5).some(x=>x.templateId===id), id + ': ' + JSON.stringify(result));
  }
});

test('低风险精简立项不强制项目经理、审核、质量岗位', () => {
  const t = full('ppt-production');
  const roles = E.recommendRoles(t,{risk:'low',rigor:'lean'}).selectedRoleIds;
  assert.deepEqual(roles, ['storyline','slide-maker']);
  const p = E.buildPlan(catalog,{...base(t.id), answers:{risk:'low',rigor:'lean'}});
  assert.equal(p.ok,true);
  assert.equal(p.plan.roles.length,2);
  assert.deepEqual(p.plan.steps.map(s=>s.id), ['outline','build']);
});

test('工程等高风险项目建议严格复核，但用户仍可手动删减岗位且得到警示', () => {
  const t = full('engineering-design');
  const d = E.suggestDefaults(t,'涉及结构安全和正式施工');
  assert.deepEqual([d.risk,d.rigor],['high','strict']);
  const fullRoles = E.recommendRoles(t,d).selectedRoleIds;
  assert.ok(fullRoles.includes('independent-checker'));
  const p = E.buildPlan(catalog,{...base(t.id),answers:d,selectedRoleIds:['technical-designer']});
  assert.equal(p.ok,true);
  assert.ok(p.warnings.some(x=>x.includes('独立审核')));
  assert.ok(p.warnings.some(x=>x.includes('已移除核心岗位')));
  assert.deepEqual(p.plan.steps.map(x=>x.id),['design']);
  assert.equal(p.plan.readyForAutomatedExecution,false);
});

test('允许新增自定义岗位、职责、交付成果和验收标准', () => {
  const customRole = {id:'custom-validation',name:'独立质检专家',duty:'审核所有设计材料',standard:'逐项提供可复查证据',capabilities:['reasoning']};
  const p = E.buildPlan(catalog,{...base('organization-design'),selectedRoleIds:['org-designer','custom-validation'],customRoles:[customRole],customDeliverables:{'custom-validation':'正式质检清单'}});
  assert.equal(p.ok,true,p.errors.join('; '));
  assert.ok(p.plan.roles.some(r=>r.id==='custom-validation'));
  assert.ok(p.plan.steps.some(s=>s.roleId==='custom-validation'&&s.deliverable==='正式质检清单'));
  assert.match(E.formatPrompt(p.plan),/逐项提供可复查证据/);
});

test('量化下拉框值严格验证，不能提交未定义的标准', () => {
  const p = E.buildPlan(catalog,{...base('ppt-production'),answers:{slideCount:'999',rigor:'strict'}});
  assert.equal(p.ok,false);
  assert.ok(p.errors.some(x=>x.includes('页数范围')));
});

test('模型排序区分已实测能力、仅声明能力和费用不确定性', () => {
  const r=full('software-development').roles.find(x=>x.id==='developer');
  const models=[
    {connectionId:'verified-free',displayName:'已测试免费模型',enabled:true,ready:true,capabilities:['coding','tool_calling'],verifiedCapabilities:['coding','tool_calling'],pricingMode:'free_tier',freeEligibilityVerified:true,lastTest:{ok:true}},
    {connectionId:'maybe-free',displayName:'未实测模型',enabled:true,ready:true,capabilities:['coding','tool_calling'],pricingMode:'free_tier',freeEligibilityVerified:false},
    {connectionId:'paid',displayName:'需付费模型',enabled:true,ready:true,capabilities:['coding','tool_calling'],verifiedCapabilities:['coding','tool_calling'],pricingMode:'paid_api',lastTest:{ok:true}},
    {connectionId:'offline',displayName:'离线模型',enabled:false,ready:false,capabilities:['coding','tool_calling'],pricingMode:'local',freeEligibilityVerified:true}
  ];
  const scored = E.rankModels(r,models,'free_only');
  assert.equal(scored[0].connectionId,'verified-free');
  assert.equal(scored[0].eligible,true);
  for(const entry of scored.slice(1))assert.equal(entry.eligible,false,entry.connectionId);
});

test('工具缺失必须阻止被标记成可以自动执行', () => {
  const p = E.buildPlan(catalog,{...base('ppt-production'),selectedRoleIds:['storyline','slide-maker'],
    assignments:{'storyline':'model-a','slide-maker':'model-b'}});
  assert.equal(p.ok,true);
  assert.equal(p.plan.readyForAutomatedExecution,false);
  assert.ok(p.plan.missingTools.includes('pptx_generation'));
  assert.match(E.formatPrompt(p.plan),/未验证可用/);
});

test('所有工具已验证且岗位有模型分配时，立项仅标为“初步可执行”，不代表已执行任务', () => {
  const req=['file_read','pptx_generation','chart_generation'];
  const p=E.buildPlan(catalog,{...base('ppt-production'),answers:{risk:'low',rigor:'lean'},selectedRoleIds:['storyline','slide-maker'],
    assignments:{'storyline':'a','slide-maker':'b'},availableTools:req.map(id=>({id,available:true,verified:true}))});
  assert.equal(p.ok,true);
  assert.equal(p.plan.readyForAutomatedExecution,true);
  assert.equal(p.plan.state,'draft');
  assert.match(p.plan.note,/不代表已执行/);
});

test('缺少描述、未知岗位、空流程与非法自定义岗位必须拒绝', () => {
  assert.equal(E.buildPlan(catalog,base('software-development','abc')).ok,false);
  assert.equal(E.buildPlan(catalog,{...base('software-development'),selectedRoleIds:['not-real']}).ok,false);
  assert.equal(E.buildPlan(catalog,{...base('software-development'),selectedStepIds:[]}).ok,false);
  assert.equal(E.buildPlan(catalog,{...base('software-development'),customRoles:[{id:'evil',name:'x',duty:'y',standard:'z'}]}).ok,false);
});

test('工程高风险明确提示专业签审，研究任务强调真实来源', () => {
  const eng=E.buildPlan(catalog,base('engineering-design'));
  const research=E.buildPlan(catalog,base('deep-research'));
  assert.ok(eng.warnings.some(x=>x.includes('有资质')));
  const prompt=E.formatPrompt(research.plan);
  assert.match(prompt,/来源/);
  assert.match(prompt,/不编造工具调用/);
});
