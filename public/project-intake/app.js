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
    customRoles:[], customDeliverables:{}
  };
  function showError(msg) { $('error').textContent = msg || ''; $('error').classList.toggle('show',!!msg); }
  function t() { return state.catalog.templates.find(x => x.id === state.templateId) || null; }
  function opts() {
    return {
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
      '<p class="detail">隐私说明：本向导不会自动把输入发送给任何 AI 模型，也不把任务正文保存到浏览器持久存储。点击导出后由你自行保存。</p>';
  }
  function renderTypes() {
    const hits = E.matchTemplates(state.catalog,state.description,5);
    const suggested = hits.filter(x=>x.score>0);
    const list = state.showAll ? state.catalog.templates.map(x=>({templateId:x.id,name:x.name,summary:x.summary,score:0})) : (suggested.length ? suggested : hits);
    return '<div class="note">'+(suggested.length?'已根据你的描述找到相关项目类型。':'描述中尚无明确匹配词，先展示一些项目类型；也可以展开全部目录。')+
      ' 点击一个类型，下一步将生成相应岗位与专业标准。</div>'+
      '<div class="grid" style="margin-top:18px">'+list.map(x=>'<button type="button" class="card choice '+(state.templateId===x.templateId?'selected':'')+'" data-template="'+html(x.templateId)+'"><h3>'+html(x.name)+'</h3><p>'+html(x.summary)+'</p><span class="pill">'+(state.templateId===x.templateId?'✓ 当前选择':x.score>0?'智能推荐':'可选模板')+'</span></button>').join('')+'</div>'+
      '<button type="button" class="btn" id="toggle-all" style="margin-top:20px">'+(state.showAll?'仅显示推荐':'查看全部 '+state.catalog.templates.length+' 类专业项目')+'</button><div id="ai-draft-root" style="margin-top:20px"></div>';
  }
  function renderQuant() {
    const tpl=t();if(!tpl)return '<p>请先选择项目类型</p>';
    const d=E.suggestDefaults(tpl,state.description);
    if(!state.answers.risk)state.answers.risk=d.risk;
    if(!state.answers.rigor)state.answers.rigor=d.rigor;
    return '<div class="note">系统建议：'+html(d.reason)+'。你可以调整每项量化选项；这些选项会直接影响岗位和工作流程推荐。</div>'+
      '<div class="grid" style="margin-top:17px">'+tpl.quantFields.map(q=>{
        const val=state.answers[q.id] || q.defaultValue;
        return '<div class="card"><label class="label" for="q-'+html(q.id)+'">'+html(q.label)+'</label><select id="q-'+html(q.id)+'" data-quant="'+html(q.id)+'">'+
        q.options.map(o=>'<option value="'+html(o.value)+'" '+(val===o.value?'selected':'')+'>'+html(o.text)+'</option>').join('')+
        '</select><p class="detail">'+html(q.help||'可自行选择，不确定时保留默认建议')+'</p></div>';
      }).join('')+'</div>'+
      '<div class="note" style="margin-top:18px">量化选项只是项目输入参数，不代表已完成专业计算或质量测试。高风险项目仍需要适用规范、真实验证和必要的专业人员复核。</div>';
  }
  function allRoles(tpl) { return [...tpl.roles,...state.customRoles]; }
  function allSteps(tpl) { return [...tpl.steps,...state.customRoles.map(r=>({
    id:'step-'+r.id,title:'执行：'+r.name,roleId:r.id,
    deliverable:state.customDeliverables[r.id] || '形成可审核的工作成果',quality:r.standard,tools:[]
  }))]; }
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
    return '<div class="note">岗位可以增删，系统不会强制每个项目都设置项目经理、审核员和质量负责人。移除负责某个流程的岗位时，相关步骤也会被标记为需要重新安排。</div>'+
      '<label class="label" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="free-only" '+(state.freeOnly?'checked':'')+' style="accent-color:#55e7ff"> 只显示经过验证的免费候选优先（其他模型仍可选，但不能视为免费）</label>'+
      '<p class="hint">'+html(state.modelLoadNote)+'</p>'+
      '<div class="grid" style="margin-top:18px">'+allRoles(tpl).map(role=>{
        const rec=rank.get(role.id) || { recommended:true };
        const checked=selected.includes(role.id);
        return '<div class="card '+(checked?'':'muted')+'"><div class="roleTop"><input type="checkbox" aria-label="启用 '+html(role.name)+'" data-role="'+html(role.id)+'" '+(checked?'checked':'')+'><div class="roleMeta"><strong>'+html(role.name)+'</strong><p>'+html(role.duty)+'</p><span class="pill '+(role.required?'good':'')+'">'+(role.required?'核心岗位（可删减）':rec.recommended?'建议增加':'可选岗位')+'</span></div></div><div class="roleStand">岗位验收标准：'+html(role.standard)+'</div>'+roleModels(role)+'</div>';
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
      return '<div class="item"><input type="checkbox" data-flow="'+html(step.id)+'" '+(checked?'checked':'')+' '+(!roleOk?'disabled':'')+' aria-label="启用步骤 '+html(step.title)+'"><div><h3>'+(i+1)+'. '+html(step.title)+(roleOk?'':' · 岗位未启用')+'</h3><p>负责岗位：'+html(role?role.name:'未知')+' ｜ 交付：'+html(step.deliverable)+'</p><p>验收标准：'+html(step.quality)+'</p><p>所需工具：'+html((step.tools||[]).join('、')||'无需专用工具')+'（当前未提供实际工具就绪证明）</p></div></div>';
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
      (r.warnings.length?'<div class="warnbox"><strong>实施前需要注意：</strong><br>'+r.warnings.map(x=>'· '+html(x)).join('<br>')+'</div>':'')+
      '<h3 class="label" style="font-size:17px">可直接复用的项目提示词</h3><pre class="result" id="prompt-output">'+html(E.formatPrompt(p))+'</pre>'+
      '<div class="actions" style="margin-top:15px"><button class="btn primary" data-action="save-project">保存草案并进入工作台</button><button class="btn" data-action="copy">复制提示词</button><button class="btn" data-action="prompt">导出提示词 TXT</button><button class="btn" data-action="json">导出结构化方案 JSON</button></div>'+
      '<p class="hint">保存草案不会调用模型或消耗 Token。工作台会重新检查模型、工具与预算；需要你明确开始执行后才运行任务。</p>';
  }
  function render() {
    if(state.step!==1)window.AIJIntakeDraft?.unmount();
    showError('');
    $('step-title').textContent=STEPS[state.step][0];
    $('step-intro').textContent=STEPS[state.step][1];
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
    if(state.step===2){document.querySelectorAll('[data-quant]').forEach(el=>state.answers[el.dataset.quant]=el.value);}
    if(state.step===3){
      state.selectedRoleIds=[...document.querySelectorAll('[data-role]:checked')].map(x=>x.dataset.role);
      document.querySelectorAll('[data-modelrole]').forEach(el=>state.assignments[el.dataset.modelrole]=el.value||'');
    }
    if(state.step===4)state.selectedStepIds=[...document.querySelectorAll('[data-flow]:checked')].map(x=>x.dataset.flow);
  }
  function go(offset){
    sync();
    if(offset>0){
      if(state.step===0&&state.description.trim().length<8)return showError('请至少用 8 个字描述项目目标。');
      if(state.step===1&&!t())return showError('请先选择一个项目类型。');
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
    Object.assign(state,{step:0,description:'',context:'',audience:'',deliveryExpectation:'',referenceNotes:'',templateId:null,answers:{},selectedRoleIds:null,selectedStepIds:null,assignments:{},customRoles:[],customDeliverables:{},showAll:false,result:null});render();
  });
  $('step-content').addEventListener('click',async event=>{
    const tplButton=event.target.closest('[data-template]');
    if(tplButton){
      const id=tplButton.dataset.template;
      if(state.templateId!==id){state.templateId=id;state.answers={};state.selectedRoleIds=null;state.selectedStepIds=null;state.assignments={};state.customRoles=[];state.customDeliverables={};}
      render();return;
    }
    if(event.target.id==='toggle-all'){state.showAll=!state.showAll;render();return;}
    if(event.target.id==='restore-roles'){state.selectedRoleIds=[...E.recommendRoles(t(),state.answers).selectedRoleIds,...state.customRoles.map(r=>r.id)];render();return;}
    const action=event.target.closest('[data-action]')?.dataset.action;
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
    }
  });
  $('step-content').addEventListener('change',event=>{
    if(event.target.id==='free-only'){sync();state.freeOnly=event.target.checked;render();}
    // 量化阶段不立即重绘，避免用户输入中断；进入角色配置时会根据选择重新推荐。
  });
  load();
})();
