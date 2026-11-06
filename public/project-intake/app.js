/* AIJAVAIS Project Intake Wizard - self-contained standalone UI, no secrets or background API calls */
(() => {
  'use strict';
  const E = window.AIJProjectIntake;
  const $ = id => document.getElementById(id);
  const html = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const STEPS = [
    ['明确任务目标','用普通话描述你想解决的问题。系统会帮助你拆解岗位、标准和工具。'],
    ['选择项目类型','根据任务内容推荐适合的专业团队，也可以从全部项目类型中选择。'],
    ['设置量化标准','用下拉框确定项目规模、风险、成果和严谨程度，无需编写复杂提示词。'],
    ['确定岗位与模型','增删岗位，查看每个岗位的职责与验收标准，自由配置模型。'],
    ['选择执行流程','每一步都应有明确负责人、成果、工具和可检查的质量标准。'],
    ['确认方案与提示词','生成可交给 AIJAVAIS 调度器的结构化项目计划，并导出完整提示词。']
  ];
  const state = {
    catalog:null, step:0, description:'',context:'',audience:'',deliveryExpectation:'',referenceNotes:'',
    templateId:null, answers:{}, selectedRoleIds:null, selectedStepIds:null, assignments:{},
    models:[], freeOnly:true, showAll:false, result:null, availableTools:[], modelLoadNote:'',
    customRoles:[], customDeliverables:{},
    universal:{domain:'',outputs:null,successCriteria:'',constraints:'',risks:''}, roleEdits:{}, stepEdits:{}, importNote:''
  };
  const U=E.UNIVERSAL_ID;
  const isUniversal=()=>state.templateId===U;
  function showError(msg) { $('error').textContent = msg || ''; $('error').classList.toggle('show',!!msg); }
  function universalInput(){const u=state.universal;return {...u,outputs:Array.isArray(u.outputs)?u.outputs:[]};}
  function t() { return isUniversal() ? E.Universal.buildTemplate(opts()) : state.catalog.templates.find(x => x.id === state.templateId) || null; }
  function opts() {
    return {
      ...(isUniversal()?{universal:universalInput()}:{}),roleEdits:state.roleEdits,stepEdits:state.stepEdits,
      templateId:state.templateId,description:state.description,context:state.context,audience:state.audience,
      deliveryExpectation:state.deliveryExpectation,referenceNotes:state.referenceNotes,
      answers:state.answers,selectedRoleIds:state.selectedRoleIds,selectedStepIds:state.selectedStepIds,
      assignments:state.assignments,availableTools:state.availableTools,availableModels:state.models,
      budgetMode:state.freeOnly?'free_only':'user_review',customRoles:state.customRoles,
      customDeliverables:state.customDeliverables
    };
  }
  function templatePreview() {
    const tpl=t();if(!tpl)return null;
    return E.buildPlan(state.catalog,opts());
  }
  function field(id,label,placeholder,value,isArea) {
    return '<div class="field"><label class="label" for="'+html(id)+'">'+html(label)+'</label>'+
      (isArea?'<textarea id="'+html(id)+'" placeholder="'+html(placeholder)+'">'+html(value)+'</textarea>':
        '<input id="'+html(id)+'" type="text" placeholder="'+html(placeholder)+'" value="'+html(value)+'">')+'</div>';
  }
  function renderTask() {
    return '<div class="note">任何行业、任何类型的任务都可以。举例：“开发一个预约小程序并附测试”“分析近三年销售数据并给出 Excel 结论”“写一份新品发布 PPT”“为一门入门课程设计 8 次课的教案”。</div>'+
      field('description','你想完成什么项目？（必填）','描述问题、目标和希望得到的成果，至少8个字',state.description,true)+
      '<div class="grid">'+
      field('context','项目背景（可选）','例如企业规模、行业或目前存在的问题',state.context,true)+
      field('audience','给谁使用或汇报？（可选）','例如总经理、客户、团队成员',state.audience,true)+
      field('deliveryExpectation','最终希望得到什么？（可选）','例如可编辑PPTX、Word报告、Excel模型、代码文件',state.deliveryExpectation,true)+
      field('referenceNotes','已经有哪些材料？（可选）','例如组织图、岗位标准、数据表；这里不上传文件',state.referenceNotes,true)+'</div>'+
      '<p class="detail">隐私说明：本向导不会自动把输入发送给任何 AI 模型，也不把任务正文保存到浏览器持久存储。点击导出后由你自行保存。</p>'+
      '<div class="card" style="margin-top:14px"><h3>继续编辑以前的草案</h3><p>导入此前用“导出可再编辑草案”保存的 JSON 文件；只读取你自己的输入，不包含模型连接或密钥，也不会自动执行。</p>'+
      '<label class="btn" for="import-draft" style="display:inline-flex;align-items:center">导入草案 JSON</label><input type="file" id="import-draft" accept="application/json,.json" style="position:absolute;left:-9999px">'+
      (state.importNote?'<p class="hint" id="import-note">'+html(state.importNote)+'</p>':'')+'</div>';
  }
  function renderTypes() {
    const hits = E.matchTemplates(state.catalog,state.description,5);
    const strong = hits.filter(x=>x.strength==='strong');
    const suggested = hits.filter(x=>x.score>0);
    const list = state.showAll ? state.catalog.templates.map(x=>({templateId:x.id,name:x.name,summary:x.summary,score:0,strength:'none'})) : (suggested.length ? suggested : hits);
    const badge=x=>state.templateId===x.templateId?'✓ 当前选择':x.strength==='strong'?'关键词匹配':x.strength==='weak'?'弱匹配，请确认是否是你的领域':'参考样例（未匹配）';
    const universalCard='<button type="button" class="card choice '+(isUniversal()?'selected':'')+'" data-template="'+U+'" id="universal-choice"><h3>通用编队：按你的目标生成团队</h3><p>适用于任何行业或陌生领域。根据你写的目标、成果形式、使用对象、成功标准和风险，生成可逐项编辑的岗位、职责、边界、步骤和交付检查项（离线规则，不调用模型）。</p><span class="pill good">'+(isUniversal()?'✓ 当前选择':strong.length?'也可选择':'推荐')+'</span></button>';
    return '<div class="note" id="match-note">'+(strong.length?'已找到关键词匹配的参考模板；如果它们与你的领域不符，请选择“通用编队”。':'没有找到与你的领域明确匹配的模板。推荐使用“通用编队”；下方模板只是参考样例，不代表适合你的行业。')+'</div>'+
      '<div class="grid" style="margin-top:18px">'+universalCard+'</div>'+
      '<h3 class="label" style="margin-top:22px">'+(strong.length?'参考模板':'参考样例（未匹配你的领域）')+'</h3>'+
      '<div class="grid" style="margin-top:8px">'+list.map(x=>'<button type="button" class="card choice '+(state.templateId===x.templateId?'selected':'')+'" data-template="'+html(x.templateId)+'" data-strength="'+html(x.strength||'none')+'"><h3>'+html(x.name)+'</h3><p>'+html(x.summary)+'</p><span class="pill">'+badge(x)+'</span></button>').join('')+'</div>'+
      '<button type="button" class="btn" id="toggle-all" style="margin-top:20px">'+(state.showAll?'仅显示推荐':'查看全部 '+state.catalog.templates.length+' 类专业项目')+'</button><div id="ai-draft-root" style="margin-top:20px"></div>';
  }
  function renderUniversalGoal(tpl) {
    const u=state.universal, a=tpl.universal, chosen=new Set(a.outputs);
    const pill=(ok,txt)=>'<span class="pill '+(ok?'good':'warn')+'">'+html(txt)+'</span>';
    return '<div class="note">通用编队只根据<strong>你自己写的内容</strong>拆分岗位，不会套用其他行业的模板。信息越具体，岗位和检查项越贴切。所有建议都未经领域专家验证。</div>'+
      '<div class="grid" style="margin-top:16px">'+
      field('u-domain','领域或行业（用你的话写）','例如：社区养老助餐、宠物殡葬服务、无人机植保',u.domain,false)+
      field('u-success','成功标准（每行一条，怎样算做好了）','例如：服务流程每一步都有负责人',u.successCriteria,true)+
      field('u-constraints','必须遵守的规范、地区、时间或资源限制','例如：遵守当地卫生规定；两周内完成',u.constraints,true)+
      field('u-risks','已知风险或敏感点（可选）','例如：涉及老人健康信息',u.risks,true)+'</div>'+
      '<label class="label">需要交付的成果形式（可多选；未选时按描述自动识别）</label><div class="grid" id="u-outputs">'+
      E.Universal.OUTPUT_OPTIONS.map(o=>'<label class="card" style="display:flex;gap:10px;align-items:center"><input type="checkbox" data-uoutput="'+html(o.value)+'" '+(chosen.has(o.value)?'checked':'')+'> '+html(o.text)+'</label>').join('')+'</div>'+
      '<div class="actions" style="margin-top:14px"><button type="button" class="btn" data-action="reanalyze">根据补充信息重新生成团队建议</button></div>'+
      '<div class="card" id="u-analysis" style="margin-top:16px" data-status="'+html(a.status)+'"><h3>分析结果 '+pill(a.status!=='needs_clarification',a.status==='needs_clarification'?'需要澄清':'可编辑草案')+' '+pill(false,'未验证')+'</h3>'+
      '<p>成果形式：'+html(a.outputs.map(k=>(E.Universal.OUTPUT_OPTIONS.find(o=>o.value===k)||{}).text).join('、')||'未确定')+'（'+(a.outputsSource==='user'?'你选择的':'从描述识别')+'）</p>'+
      '<p>识别到的工作类型：'+html(a.activities.map(k=>E.Universal.LABELS.activities[k]).join('、')||'无')+'；风险领域：'+html(a.riskDomains.map(k=>E.Universal.LABELS.risks[k]).join('、')||'未发现')+'</p>'+
      (a.clarifications.length?'<ul id="u-clarifications">'+a.clarifications.map(c=>'<li data-blocking="'+c.blocking+'">'+(c.blocking?'【必须补充】':'【建议补充】')+html(c.question)+'</li>').join('')+'</ul>':'<p>暂无待澄清问题。</p>')+'</div>';
  }
  function renderQuant() {
    const tpl=t();if(!tpl)return '<p>请先选择项目类型</p>';
    const d=E.suggestDefaults(tpl,state.description);
    if(!state.answers.risk)state.answers.risk=d.risk;
    if(!state.answers.rigor)state.answers.rigor=d.rigor;
    return (tpl.universal?renderUniversalGoal(tpl):'')+'<div class="note" style="margin-top:16px">系统建议：'+html(d.reason)+'。你可以调整每项量化选项；这些选项会直接影响岗位和工作流程推荐。</div>'+
      '<div class="grid" style="margin-top:17px">'+tpl.quantFields.map(q=>{
        const val=state.answers[q.id] || q.defaultValue;
        return '<div class="card"><label class="label" for="q-'+html(q.id)+'">'+html(q.label)+'</label><select id="q-'+html(q.id)+'" data-quant="'+html(q.id)+'">'+
        q.options.map(o=>'<option value="'+html(o.value)+'" '+(val===o.value?'selected':'')+'>'+html(o.text)+'</option>').join('')+
        '</select><p class="detail">'+html(q.help||'可自行选择，不确定时保留默认建议')+'</p></div>';
      }).join('')+'</div>'+
      '<div class="note" style="margin-top:18px">量化选项只是项目输入参数，不代表已完成专业计算或质量测试。高风险项目仍需要适用规范、真实验证和必要的专业人员复核。</div>';
  }
  function allRoles(tpl) { return [...tpl.roles,...state.customRoles].map(r=>({...r,...(state.roleEdits[r.id]||{})})); }
  function editor(kind,id,fields,item){
    return '<details class="edit" style="margin-top:10px"><summary class="hint" style="cursor:pointer">✎ 编辑'+(kind==='role'?'岗位名称、职责、边界与验收标准':'步骤名称、成果与检查标准')+'</summary>'+
      fields.map(([k,label,area])=>'<label class="label" for="'+kind+'-'+html(id)+'-'+k+'">'+label+'</label>'+(area?'<textarea':'<input type="text"')+' id="'+kind+'-'+html(id)+'-'+k+'" data-'+kind+'edit="'+html(id)+'" data-field="'+k+'"'+(area?'>'+html(item[k]||'')+'</textarea>':' value="'+html(item[k]||'')+'">')).join('')+'</details>';
  }
  function allSteps(tpl) { return [...tpl.steps,...state.customRoles.map(r=>({
    id:'step-'+r.id,title:'执行：'+r.name,roleId:r.id,
    deliverable:state.customDeliverables[r.id] || '形成可审核的工作成果',quality:r.standard,tools:[]
  }))].map(s=>({...s,...(state.stepEdits[s.id]||{})})); }
  function selectedRoles(tpl) {
    if(state.selectedRoleIds===null)state.selectedRoleIds=E.recommendRoles(tpl,state.answers).selectedRoleIds;
    return state.selectedRoleIds;
  }
  function roleModels(role) {
    const list=E.rankModels(role,state.models,state.freeOnly?'free_only':'quality');
    const current=state.assignments[role.id] || '';
    return '<div class="roleModel"><label for="model-'+html(role.id)+'">该岗位使用的模型（可暂不分配）</label><select id="model-'+html(role.id)+'" data-modelrole="'+html(role.id)+'"><option value="">暂未分配模型</option>'+
      list.map(x=>'<option value="'+html(x.connectionId)+'" '+(current===x.connectionId?'selected':'')+'>'+html(x.displayName)+' · 初评'+x.score+'分 '+(x.eligible?'✓ 候选':'⚠ 待确认')+'</option>').join('')+
      '</select><small>'+(list.length?'模型排名仅初评，能力标签可能未经实测，最终以真实任务验证为准。':'未检测到已连接的模型。你仍可以先制定团队方案。')+'</small></div>';
  }
  function renderRoles() {
    const tpl=t();if(!tpl)return '';
    const s=E.recommendRoles(tpl,state.answers);
    const selected=selectedRoles(tpl);
    const rank=new Map(s.explanations.map(x=>[x.roleId,x]));
    return (state.importNote?'<p class="hint" id="import-note">'+html(state.importNote)+'</p>':'')+'<div class="note">岗位可以增删，也可以展开“编辑”直接修改岗位名称、职责、边界和验收标准。系统不会强制每个项目都设置项目经理、审核员和质量负责人。移除负责某个流程的岗位时，相关步骤也会被标记为需要重新安排。</div>'+
      '<label class="label" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="free-only" '+(state.freeOnly?'checked':'')+' style="accent-color:#55e7ff"> 只显示经过验证的免费候选优先（其他模型仍可选，但不能视为免费）</label>'+
      '<p class="hint">'+html(state.modelLoadNote)+'</p>'+
      '<div class="grid" style="margin-top:18px">'+allRoles(tpl).map(role=>{
        const rec=rank.get(role.id) || { recommended:true };
        const checked=selected.includes(role.id);
        return '<div class="card '+(checked?'':'muted')+'" data-rolecard="'+html(role.id)+'"><div class="roleTop"><input type="checkbox" aria-label="启用 '+html(role.name)+'" data-role="'+html(role.id)+'" '+(checked?'checked':'')+'><div class="roleMeta"><strong>'+html(role.name)+'</strong><p>'+html(role.duty)+'</p>'+(role.boundary?'<p class="hint">权责边界：'+html(role.boundary)+'</p>':'')+'<span class="pill '+(role.required?'good':'')+'">'+(role.required?'核心岗位（可删减）':rec.recommended?'建议增加':'可选岗位')+'</span></div></div><div class="roleStand">岗位验收标准：'+html(role.standard)+'</div>'+
          editor('role',role.id,[['name','岗位名称'],['duty','职责',1],['boundary','权责边界（可留空）',1],['standard','验收标准',1]],role)+roleModels(role)+'</div>';
      }).join('')+'</div>'+
      '<button type="button" class="btn" id="restore-roles" style="margin-top:18px">恢复系统建议的岗位组合</button>'+
      '<div class="card" style="margin-top:18px"><h3>＋ 新增自定义岗位</h3><p>不确定职责时，可以先写“负责完成什么”，再写“怎样判断合格”。</p>'+
      '<div class="grid">'+
      '<div>'+field("new-role-name","岗位名称","例如：质量检查员","",false)+'</div>'+
      '<div>'+field("new-role-deliverable","本岗位交付成果","例如：可编辑审查清单","",false)+'</div>'+
      '<div>'+field("new-role-duty","岗位职责","例如：核对方案是否符合公司制度","",true)+'</div>'+
      '<div>'+field("new-role-standard","岗位验收标准","例如：每一项审核意见必须给出处或案例","",true)+'</div>'+
      '</div><button type="button" class="btn" data-action="addcustom">添加到当前项目</button></div>'+
      '<p class="detail">自定义岗位会自动新增对应工作步骤；可通过复选框临时停用该岗位。团队与执行引擎集成后可进一步配置工具权限。</p>';
  }
  function renderWorkflow() {
    const tpl=t();if(!tpl)return '';
    selectedRoles(tpl);
    const selectedSteps=state.selectedStepIds;
    const activeRoles=new Set(state.selectedRoleIds);
    const items=allSteps(tpl).map((step,i)=>{
      const roleOk=activeRoles.has(step.roleId);
      const checked=roleOk && (selectedSteps===null || selectedSteps.includes(step.id));
      const role=allRoles(tpl).find(x=>x.id===step.roleId);
      return '<div class="item"><input type="checkbox" data-flow="'+html(step.id)+'" '+(checked?'checked':'')+' '+(!roleOk?'disabled':'')+' aria-label="启用步骤 '+html(step.title)+'"><div><h3>'+(i+1)+'. '+html(step.title)+(roleOk?'':' · 岗位未启用')+'</h3><p>负责岗位：'+html(role?role.name:'未知')+' ｜ 交付：'+html(step.deliverable)+'</p><p>验收标准：'+html(step.quality)+'</p><p>所需工具：'+html((step.tools||[]).join('、')||'无需专用工具')+'（当前未提供实际工具就绪证明）</p>'+editor('step',step.id,[['title','步骤名称'],['deliverable','交付成果'],['quality','检查标准',1]],step)+'</div></div>';
    }).join('');
    return '<div class="note">以下是建议的真实工作顺序。你可以取消不需要的步骤；但若取消审核、测试或质量关口，平台会在高风险项目中给出提醒。</div>'+
      '<div class="card" style="margin-top:18px">'+items+'</div>';
  }
  function renderResult() {
    const r=templatePreview();state.result=r;
    if(!r||!r.ok)return '<div class="warnbox">'+html(r&&r.errors&&r.errors.join('；')||'无法生成计划')+'</div>';
    const p=r.plan;
    const unresolved=state.models.length===0?'尚未配置可用模型。':'如需自动执行，还需由执行引擎验证所选模型和工具。';
    return '<div class="status"><span class="light '+(p.readyForAutomatedExecution?'ok':'')+'"></span><div><strong>'+html(p.projectTypeName)+' · 项目立项草案</strong><div class="detail">'+
      (p.readyForAutomatedExecution?'配置初步具备执行条件，仍需调度器确认。':'已生成方案；尚不具备直接自动执行的完整条件。')+'</div></div></div>'+
      '<div class="grid"><div class="card"><h3>团队岗位</h3><p>'+p.roles.length+' 个岗位：'+html(p.roles.map(x=>x.name).join('、'))+'</p></div>'+
      '<div class="card"><h3>工作流程</h3><p>'+p.steps.length+' 个步骤：'+html(p.steps.map(x=>x.title).join(' → '))+'</p></div>'+
      '<div class="card"><h3>工具检查</h3><p>需要 '+p.requiredTools.length+' 种能力。'+html(unresolved)+'</p></div>'+
      '<div class="card"><h3>项目标准</h3><p>风险：'+html((p.quantification.find(q=>q.id==='risk')||{}).selectedText||p.risk)+'；审核：'+html((p.quantification.find(q=>q.id==='rigor')||{}).selectedText||p.rigor)+'</p></div></div>'+
      '<div class="card" id="tool-check" style="margin-top:14px"><h3>平台工具实时检查</h3><p class="hint">正在向服务器核实所需工具……</p></div>'+
      (p.universal?'<div class="card" id="u-result" data-status="'+html(p.universal.status)+'" style="margin-top:14px"><h3>通用编队草案 · '+(p.universal.status==='needs_clarification'?'<span class="pill warn">需要澄清</span>':'<span class="pill good">可编辑草案</span>')+' <span class="pill warn">未验证</span></h3>'+
        '<p>生成方式：离线规则（未调用 AI 模型）。所有交付检查项均未验证，需要按实际成果逐项核对。</p><ul id="u-checks">'+p.universal.deliveryChecks.map(c=>'<li data-source="'+html(c.source)+'">'+html(c.text)+(c.source==='user'?'（你的标准）':'')+'</li>').join('')+'</ul>'+
        (p.universal.humanCheckpoints.length?'<p><strong>人工专家审查：</strong></p><ul id="u-human">'+p.universal.humanCheckpoints.map(h=>'<li>'+html(h.requirement)+'</li>').join('')+'</ul>':'')+'</div>':'')+
      (r.warnings.length?'<div class="warnbox"><strong>实施前需要注意：</strong><br>'+r.warnings.map(x=>'· '+html(x)).join('<br>')+'</div>':'')+
      '<h3 class="label" style="font-size:17px">可直接复用的项目提示词</h3><pre class="result" id="prompt-output">'+html(E.formatPrompt(p))+'</pre>'+
      '<div class="actions" style="margin-top:15px"><button class="btn primary" data-action="save-project">保存草案并进入工作台</button><button class="btn" data-action="copy">复制提示词</button><button class="btn" data-action="prompt">导出提示词 TXT</button><button class="btn" data-action="json">导出结构化方案 JSON</button><button class="btn" data-action="draft">导出可再编辑草案</button></div>'+
      '<p class="hint">保存草案不会调用模型或消耗 Token。工作台会重新检查模型、工具与预算；需要你明确开始执行后才运行任务。</p>';
  }
  function render() {
    if(state.step!==1)window.AIJIntakeDraft?.unmount();
    showError('');
    const universalGoal=state.step===2&&isUniversal();
    $('step-title').textContent=universalGoal?'说明领域与成功标准':STEPS[state.step][0];
    $('step-intro').textContent=universalGoal?'用你自己的话补充领域、成果形式和怎样算做好；系统据此生成可编辑的团队草案。':STEPS[state.step][1];
    $('step-badge').textContent='STEP '+String(state.step+1).padStart(2,'0')+' / 06';
    document.querySelectorAll('#steps-nav li').forEach((li,i)=>li.className=i===state.step?'active':i<state.step?'done':'');
    $('step-content').innerHTML=[renderTask,renderTypes,renderQuant,renderRoles,renderWorkflow,renderResult][state.step]();
    if(state.step===1)window.AIJIntakeDraft?.mount($('ai-draft-root'),{description:state.description,models:state.models});
    if(state.step===5)loadToolCheck();
    $('back').disabled=state.step===0;
    $('next').textContent=state.step===5?'重新检查方案 ↻':state.step===4?'生成项目方案 →':'下一步 →';
  }
  function sync() {
    if(state.step===0){for(const k of ['description','context','audience','deliveryExpectation','referenceNotes'])state[k]=($(k)||{}).value||'';}
    if(state.step===2){
      if(isUniversal()&&$('u-domain')){
        const before=JSON.stringify(state.universal);
        state.universal={domain:$('u-domain').value,successCriteria:$('u-success').value,constraints:$('u-constraints').value,risks:$('u-risks').value,
          outputs:[...document.querySelectorAll('[data-uoutput]:checked')].map(x=>x.dataset.uoutput)};
        // A different goal analysis changes the suggested team: re-suggest roles/steps, keep edits for roles that still exist.
        if(JSON.stringify(state.universal)!==before){state.selectedRoleIds=null;state.selectedStepIds=null;}
      }
      document.querySelectorAll('[data-quant]').forEach(el=>state.answers[el.dataset.quant]=el.value);
    }
    if(state.step===3){
      state.selectedRoleIds=[...document.querySelectorAll('[data-role]:checked')].map(x=>x.dataset.role);
      document.querySelectorAll('[data-modelrole]').forEach(el=>state.assignments[el.dataset.modelrole]=el.value||'');
      collectEdits('role');
    }
    if(state.step===4){state.selectedStepIds=[...document.querySelectorAll('[data-flow]:checked')].map(x=>x.dataset.flow);collectEdits('step');}
  }
  // Only fields that differ from the suggestion are stored, so re-analysis can still refresh untouched text.
  function collectEdits(kind){
    const tpl=t();if(!tpl)return;
    const originals=new Map((kind==='role'?[...tpl.roles,...state.customRoles]:[...tpl.steps,...state.customRoles.map(r=>({id:'step-'+r.id,title:'执行：'+r.name,deliverable:state.customDeliverables[r.id]||'形成可审核的工作成果',quality:r.standard}))]).map(x=>[x.id,x]));
    const store=kind==='role'?state.roleEdits:state.stepEdits;
    document.querySelectorAll('[data-'+kind+'edit]').forEach(el=>{
      const id=el.dataset[kind+'edit'],f=el.dataset.field,orig=originals.get(id);if(!orig)return;
      const v=el.value;
      if(v===(orig[f]||'')){if(store[id]){delete store[id][f];if(!Object.keys(store[id]).length)delete store[id];}}
      else (store[id]||(store[id]={}))[f]=v;
    });
  }
  function go(offset){
    sync();
    if(offset>0){
      if(state.step===0&&state.description.trim().length<8)return showError('请至少用 8 个字描述项目目标。');
      if(state.step===1&&!t())return showError('请先选择一个项目类型。');
      if(state.step===3||state.step===4){const r=templatePreview();if(r&&!r.ok&&r.errors.some(e=>/编辑|不能为空|必须是文字/.test(e)))return showError(r.errors.join('；'));}
      if(state.step===3&&!state.selectedRoleIds.length)return showError('至少选择一个岗位；可以是单岗位精简团队。');
      if(state.step===4&&state.selectedStepIds.length===0)return showError('至少保留一个工作流程步骤。');
    }
    state.step=Math.max(0,Math.min(5,state.step+offset));render();
  }
  function download(name,text,contentType){
    const blob=new Blob([text],{type:contentType});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }
  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
  }
  const TOOL_STATUS={available:['可用','ok'],needs_setup:['需要配置','warn'],not_implemented:['平台尚未实现','bad'],unknown:['目录中没有','bad']};
  async function loadToolCheck() {
    const box=$('tool-check');if(!box)return;
    try{
      const r=await fetch('/api/v2/intake/plan',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(opts())});
      const data=await r.json().catch(()=>({}));
      if(!r.ok)throw Error(data.error||'HTTP '+r.status);
      const rows=(data.toolCheck||[]).map(t=>{const st=TOOL_STATUS[t.status]||['未知','warn'];
        return '<tr><td>'+html(t.capability||t.intakeId)+'</td><td><span class="pill '+st[1]+'">'+st[0]+'</span>'+(t.free===false?' <span class="pill warn">可能收费</span>':'')+(t.needsApiKey?' <span class="pill warn">需要 API Key</span>':'')+'</td><td>'+html(t.status==='available'?'已有真实实现，执行时需在工作台勾选授权。':(t.howTo||''))+(t.status!=='available'&&t.alternative?'<br><span class="hint">替代方案：'+html(t.alternative)+'</span>':'')+'</td></tr>';}).join('');
      const missing=(data.toolCheck||[]).filter(t=>t.status!=='available').length;
      box.innerHTML='<h3>平台工具实时检查</h3><p>'+(missing?'有 '+missing+' 项能力暂不可用。可以先保存草案；缺少的工具不会被假装完成，执行前需要配置或移除该要求。':'所需工具均已具备真实实现。')+' 详见<a href="/capabilities.html">能力中心</a>。</p>'+
        (rows?'<table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left">能力</th><th style="text-align:left">状态</th><th style="text-align:left">说明</th></tr></thead><tbody>'+rows+'</tbody></table>':'<p class="hint">本方案不需要专用工具。</p>');
    }catch(e){box.innerHTML='<h3>平台工具实时检查</h3><p class="hint">暂时无法向服务器核实（'+html(e.message)+'）。保存草案后可在工作台「检查执行条件」。</p>';}
  }
  async function refreshModels() {
    try{
      const r=await fetch('/api/models',{credentials:'same-origin',headers:{Accept:'application/json'}});
      if(!r.ok)throw Error('模型接口不可用（HTTP '+r.status+'）');
      const data=await r.json();state.models=Array.isArray(data.models)?data.models:[];
      state.modelLoadNote='已发现 '+state.models.length+' 个模型连接；能力排序仍需真实任务校准。';
    }catch(e){state.models=[];state.modelLoadNote='模型连接未读取成功：'+e.message+'。可先制定方案，不影响立项。';}
  }
  async function load() {
    try {
      const r=await fetch('/project-intake/catalog.v1.json',{credentials:'same-origin',cache:'no-store'});
      if(!r.ok)throw Error('HTTP '+r.status);
      const catalog=await r.json();const check=E.validateCatalog(catalog);
      if(!check.ok)throw Error(check.errors.join('；'));
      state.catalog=catalog;
      await refreshModels();
      render();
    }catch(e){$('step-title').textContent='无法加载项目目录';$('step-content').textContent='项目向导初始化失败：'+e.message;$('next').disabled=true;}
  }
  $('back').addEventListener('click',()=>go(-1));
  $('next').addEventListener('click',()=>{if(state.step===5){render();return;}go(1);});
  $('reset').addEventListener('click',()=>{if(!window.confirm('确定清空当前未导出的立项草案吗？'))return;
    window.AIJIntakeDraft?.reset();
    Object.assign(state,{step:0,description:'',context:'',audience:'',deliveryExpectation:'',referenceNotes:'',templateId:null,answers:{},selectedRoleIds:null,selectedStepIds:null,assignments:{},customRoles:[],customDeliverables:{},showAll:false,result:null,
      universal:{domain:'',outputs:null,successCriteria:'',constraints:'',risks:''},roleEdits:{},stepEdits:{},importNote:''});render();
  });
  $('step-content').addEventListener('click',async event=>{
    const tplButton=event.target.closest('[data-template]');
    if(tplButton){
      const id=tplButton.dataset.template;
      if(state.templateId!==id){state.templateId=id;state.answers={};state.selectedRoleIds=null;state.selectedStepIds=null;state.assignments={};state.customRoles=[];state.customDeliverables={};state.roleEdits={};state.stepEdits={};}
      render();return;
    }
    if(event.target.id==='toggle-all'){state.showAll=!state.showAll;render();return;}
    if(event.target.id==='restore-roles'){state.selectedRoleIds=[...E.recommendRoles(t(),state.answers).selectedRoleIds,...state.customRoles.map(r=>r.id)];render();return;}
    const action=event.target.closest('[data-action]')?.dataset.action;
    if(action==='reanalyze'){sync();state.answers={};render();return;}
    if(action==='addcustom'){
      sync();
      if(state.customRoles.length>=12)return showError('自定义岗位最多 12 个');
      const name=($('new-role-name')?.value||'').trim();
      const duty=($('new-role-duty')?.value||'').trim();
      const standard=($('new-role-standard')?.value||'').trim();
      const deliverable=($('new-role-deliverable')?.value||'').trim();
      if(!name||!duty||!standard)return showError('请填写岗位名称、职责和验收标准');
      const id='custom-'+Math.random().toString(36).slice(2,10);
      state.customRoles.push({id,name,duty,standard,capabilities:[],required:false});
      state.customDeliverables[id]=deliverable||'形成可审核的工作成果';
      state.selectedRoleIds.push(id);
      if(state.selectedStepIds!==null)state.selectedStepIds.push('step-'+id);
      render();return;
    }
    if(action){
      const r=state.result;if(!r||!r.ok)return;
      if(action==='save-project'){
        event.target.disabled=true;
        try{
          const response=await fetch('/api/v2/intake/projects',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(opts())});
          const saved=await response.json().catch(()=>({}));
          if(!response.ok)throw Error(saved.error||'保存项目失败（HTTP '+response.status+'）');
          if(!saved.project?.projectId)throw Error('服务端未返回项目 ID');
          window.location.assign('/workspace.html?project='+encodeURIComponent(saved.project.projectId));
        }catch(error){showError(error.message);event.target.disabled=false;}
      }
      else if(action==='copy'){const ok=await copyText(E.formatPrompt(r.plan));event.target.textContent=ok?'已复制 ✓':'复制失败，请手动选择文字';}
      else if(action==='prompt')download('AIJAVAIS-项目描述词.txt',E.formatPrompt(r.plan),'text/plain;charset=utf-8');
      else if(action==='json')download('AIJAVAIS-项目立项.json',JSON.stringify(r.plan,null,2),'application/json;charset=utf-8');
      else if(action==='draft')download('AIJAVAIS-立项草案-可再编辑.json',JSON.stringify(E.exportDraft(opts()),null,2),'application/json;charset=utf-8');
    }
  });
  async function importDraftFile(file){
    let data;
    try{ if(file.size>2<<20)throw Error('文件超过 2MB'); data=JSON.parse(await file.text()); }
    catch(e){state.importNote='导入失败：'+e.message;render();return;}
    const r=E.importDraft(state.catalog,data);
    if(!r.ok){state.importNote='导入失败：'+r.errors.join('；');render();return;}
    const i=r.input;
    Object.assign(state,{templateId:i.templateId,description:i.description,context:i.context,audience:i.audience,deliveryExpectation:i.deliveryExpectation,referenceNotes:i.referenceNotes,
      answers:i.answers||{},selectedRoleIds:i.selectedRoleIds,selectedStepIds:i.selectedStepIds,customRoles:i.customRoles||[],customDeliverables:i.customDeliverables||{},
      roleEdits:i.roleEdits||{},stepEdits:i.stepEdits||{},assignments:{},freeOnly:i.budgetMode==='free_only',
      universal:i.universal?{domain:i.universal.domain,outputs:i.universal.outputs,successCriteria:i.universal.successCriteria.join('\n'),constraints:i.universal.constraints,risks:i.universal.risks}:{domain:'',outputs:null,successCriteria:'',constraints:'',risks:''},
      importNote:'已导入草案（模型分配需要重新选择）。',step:3});
    render();
  }
  $('step-content').addEventListener('change',event=>{
    if(event.target.id==='import-draft'&&event.target.files&&event.target.files[0]){importDraftFile(event.target.files[0]);return;}
    if(event.target.id==='free-only'){sync();state.freeOnly=event.target.checked;render();}
    // 量化阶段不立即重绘，避免用户输入中断；进入角色配置时会根据选择重新推荐。
  });
  load();
})();
