'use strict';
/* User-facing V2 workspace. Never stores credentials or paid approval in browser storage. */
(() => {
  const $ = id => document.getElementById(id);
  const state = { projects: [], project: null, models: [], tools: [], skills: [], runs: [], run: null, files: [], timer: null, refreshing: false, dirty: false };
  const list = (x, key) => Array.isArray(x) ? x : Array.isArray(x && x[key]) ? x[key] : [];
  const identity = x => x && (x.id || x.toolId || x.skillId);
  const stringify = x => typeof x === 'string' ? x : JSON.stringify(x, null, 2);
  const statusNames = { draft:'草案', running:'运行中', queued:'等待执行', completed:'执行完成', done:'已完成', review_required:'等待审核', awaiting_review:'等待审核', approved:'审核通过', rework:'返工中', cancelled:'已取消', failed:'失败', error:'出错', blocked:'条件不足', pending:'待执行' };
  const statusName = x => statusNames[x] || x || '未知';
  function node(tag, props = {}, children = []) {
    const n = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') n.textContent = value == null ? '' : String(value);
      else if (key === 'class') n.className = value;
      else if (key.startsWith('on')) n.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(n.dataset, value);
      else if (key in n) n[key] = value;
      else n.setAttribute(key, value);
    }
    for (const child of children) n.append(typeof child === 'string' ? document.createTextNode(child) : child);
    return n;
  }
  function feedback(message = '', bad = false) { $('feedback').textContent = message; $('feedback').classList.toggle('bad', bad); }
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, { method, credentials:'same-origin', headers:{ Accept:'application/json', ...(body === undefined ? {} : {'content-type':'application/json'}) }, body:body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.assign('/login.html?next=/workspace.html'); throw Error('会话已过期，请重新登录'); }
    if (!res.ok) throw Object.assign(Error(data.error || data.message || '请求失败（HTTP ' + res.status + '）'), { code: data.code, status: res.status });
    return data;
  }
  function work(action) { return async event => {
    if (event) event.preventDefault();
    const button = event && event.currentTarget && event.currentTarget.tagName === 'BUTTON' ? event.currentTarget : null;
    if (button) button.disabled = true;
    try { await action(event); } catch (error) { feedback(error.message, true); }
    finally { if (button) button.disabled = false; }
  }; }
  function tab(name) {
    for (const id of ['project','run','resources']) { $('tab-'+id).setAttribute('aria-selected', String(id === name)); $('panel-'+id).hidden = id !== name; }
  }
  function blankProject() {
    return { name:'', description:'', standards:[], maxReworks:2, roles:[{roleId:'writer',name:'执行者',duty:'完成项目主要工作，提供可核查的成果',boundary:'不代替独立审核确认',standard:'满足项目验收标准',connectionId:''},{roleId:'reviewer',name:'审核者',duty:'逐项核对成果与验收标准，指出遗漏并提供证据',boundary:'不得宣称未实际进行的工具调用已完成',standard:'审核意见明确、可执行',connectionId:''}], steps:[{stepId:'draft',title:'完成初稿',roleId:'writer',prompt:'根据项目目标与验收标准，完成可交付的初稿。',checks:[],toolCalls:[]},{stepId:'review',title:'独立审核',roleId:'reviewer',prompt:'审核前序成果，逐项检查质量、证据和遗漏。',checks:[],toolCalls:[]}] };
  }
  function field(parent, label, tag, value, change, options = {}) {
    const control = node(tag, {value:value || '', ...options, oninput:event => { change(event.target.value); state.dirty = true; }});
    const id = 'field-' + (++field.next); control.id = id;
    parent.append(node('label', {text:label, htmlFor:id}), control);
    return control;
  }
  field.next = 0;
  function modelSelect(role) {
    const select = node('select', { 'aria-label':role.name + '使用的模型', onchange:e => {role.connectionId=e.target.value; state.dirty=true;} });
    select.append(node('option',{value:'',text:'请选择模型连接'}));
    for (const model of state.models) select.append(node('option',{value:model.connectionId,text:(window.ModelHints?ModelHints.platformLabel(model):(model.displayName || model.modelId || model.connectionId))+' · '+modelState(model)+' · '+(model.pricingMode || '费用未知')}));
    const current = role.connectionId || role.primaryConnectionId || role.modelConnectionId || '';
    if (current && !state.models.some(m => m.connectionId === current)) select.append(node('option',{value:current,text:current+'（连接已移除）'}));
    select.value = current; role.connectionId = current;
    return select;
  }
  function renderRoles() {
    const target = $('roles-editor'); target.replaceChildren();
    for (const role of state.project.roles) {
      const row = node('div',{class:'editor-row'});
      const head = node('div',{class:'inline-fields'});
      const a = node('div'), b = node('div');
      field(a,'岗位名称','input',role.name,v=>role.name=v,{maxLength:80,onchange:()=>renderSteps()});
      b.append(node('label',{text:'模型连接'}), modelSelect(role));
      head.append(a,b,node('button',{type:'button',class:'small danger',text:'移除岗位',onclick:()=>{
        if (state.project.roles.length < 2) return feedback('项目至少需要一个岗位',true);
        if (state.project.steps.some(s=>s.roleId===role.roleId) && !confirm('该岗位有关联步骤。移除后，请为这些步骤重新指定负责人。')) return;
        state.project.roles=state.project.roles.filter(r=>r!==role); state.dirty=true; renderRoles();renderSteps();
      }}));
      row.append(head);
      field(row,'岗位职责','textarea',role.duty,v=>role.duty=v,{maxLength:2000});
      const details=node('details'), grid=node('div',{class:'grid'}), left=node('div'), right=node('div');
      details.append(node('summary',{text:'职责边界与岗位验收标准'}));
      field(left,'职责边界','textarea',role.boundary,v=>role.boundary=v,{maxLength:2000});
      field(right,'岗位验收标准','textarea',role.standard,v=>role.standard=v,{maxLength:2000});
      grid.append(left,right);details.append(grid);row.append(details);target.append(row);
    }
  }
  function renderSteps() {
    const target=$('steps-editor');target.replaceChildren();
    state.project.steps.forEach((step,index)=>{
      const row=node('div',{class:'editor-row'}), head=node('div',{class:'row-head'});
      head.append(node('strong',{text:'步骤 '+(index+1)}),node('button',{type:'button',class:'small danger',text:'移除步骤',onclick:()=>{
        if(state.project.steps.length<2)return feedback('至少保留一个执行步骤',true);
        state.project.steps.splice(index,1);state.dirty=true;renderSteps();
      }}));
      row.append(head); const grid=node('div',{class:'grid'}),a=node('div'),b=node('div');
      field(a,'步骤名称','input',step.title,v=>step.title=v,{maxLength:160});
      const select=node('select',{'aria-label':'步骤'+(index+1)+'负责岗位',onchange:e=>{step.roleId=e.target.value;state.dirty=true;}});
      select.append(node('option',{value:'',text:'请选择负责人'}));
      state.project.roles.forEach(r=>select.append(node('option',{value:r.roleId,text:r.name || r.roleId})));
      select.value=step.roleId; b.append(node('label',{text:'负责岗位'}),select);grid.append(a,b);row.append(grid);
      field(row,'执行指令与交付要求','textarea',step.prompt,v=>step.prompt=v,{placeholder:'说明这一步应如何使用前序成果，并产出什么内容',maxLength:20000});
      const inputs=node('select',{'aria-label':'步骤'+(index+1)+'接收的前序成果',onchange:e=>{step.handoff=e.target.value;state.dirty=true;}});
      inputs.append(node('option',{value:'previous',text:'只接收上一步的成果'}),node('option',{value:'all',text:'接收前面所有步骤的成果'}));inputs.value=step.handoff || 'previous';
      const mat=node('input',{type:'checkbox',onchange:e=>{step.useMaterials=e.target.checked;state.dirty=true;}});mat.checked=step.useMaterials!==false;
      row.append(node('div',{class:'inline-fields'},[node('label',{},[node('span',{text:'交接内容 '}),inputs]),node('label',{class:'check'},[mat,node('span',{text:'本步骤读取项目资料'})])]));
      const advanced=node('details');advanced.append(node('summary',{text:'Skill、工具调用与质量检查（高级）'}));
      const skills=node('select',{'aria-label':'步骤'+(index+1)+' Skill',onchange:e=>{step.skillId=e.target.value || undefined;state.dirty=true;}});
      skills.append(node('option',{value:'',text:'不额外应用 Skill'}));
      state.skills.forEach(s=>skills.append(node('option',{value:identity(s),text:s.name || identity(s)})));
      skills.value=step.skillId || '';advanced.append(node('label',{text:'执行 Skill'}),skills);
      field(advanced,'工具调用 JSON，例如 [{"toolId":"builtin:text-stats","args":{"text":"要统计的文字"}}]','textarea',step._toolsJSON ?? JSON.stringify(step.toolCalls || [],null,2),v=>step._toolsJSON=v,{spellcheck:false,rows:3});
      field(advanced,'质量检查 JSON，例如 [{"type":"minLength","value":100}]','textarea',step._checksJSON ?? JSON.stringify(step.checks || [],null,2),v=>step._checksJSON=v,{spellcheck:false,rows:3});
      row.append(advanced);target.append(row);
    });
  }
  // #9 P2-04: show the CURRENT state; a historical successful probe on a disabled,
  // not-ready or unrecorded connection is never shown as tested/usable.
  function modelState(model) {
    if(model.enabled===false)return '已停用（历史测试不代表可用）';
    if(model.status==='available')return '连接已测试且当前可用';
    if(model.status==='not_ready')return '未就绪（缺少密钥或配置）';
    if(model.status==='error')return '最近一次测试失败';
    if(model.lastTest?.ok&&model.lastTest.usageRecorded===false)return '历史测试未完整记账，需重新测试';
    return model.ready?'已配置，未通过测试':'未就绪';
  }
  function resourceCheckboxes(id, resources, selected, key) {
    const target=$(id);target.replaceChildren();
    if(!resources.length){target.append(node('p',{class:'hint',text:'暂未注册'}));return;}
    resources.forEach(item=>{
      const value=identity(item), input=node('input',{type:'checkbox',value,checked:selected.includes(value),dataset:{[key]:value}});
      const label=node('label',{class:'check'},[input,node('span',{text:(item.name || value)+' ['+value+'] · '+(item.description || '')})]);target.append(label);
    });
  }
  function renderProject(project) {
    state.project=structuredClone(project);state.project.roles=state.project.roles || [];state.project.steps=state.project.steps || [];
    state.dirty=false;
    $('project-heading').textContent=project.name || '新建项目';$('project-name').value=project.name || '';
    $('project-description').value=project.description || ''; $('project-standards').value=(Array.isArray(project.standards)?project.standards:[]).map(stringify).join('\n');
    $('max-reworks').value=project.maxReworks == null ? 2 : project.maxReworks;
    $('project-deliverables').value=(project.deliverables || []).join('\n');$('required-tools').value=(project.requiredToolIds || []).join('\n');
    $('intake-note').textContent=project.plan || project.intake ? '该项目来自智能立项草案；请在执行前确认岗位、模型、成果标准与工具需求。' : '';
    $('approve-paid').checked=false; // Explicit approval is per invocation and never restored.
    $('approve-external').checked=false;
    $('validation').hidden=true;
    const mat=project.materials || {mode:'all',fileIds:[],maxChars:40000};$('materials-mode').value=mat.mode;$('materials-max').value=mat.maxChars;
    renderRoles();renderSteps();resourceCheckboxes('project-tools',state.tools,[],'projectTool');loadFiles().catch(e=>feedback(e.message,true));
    $('project-skills').textContent=state.skills.length?state.skills.map(s=>s.name || identity(s)).join('、'):'暂未注册 Skill';
    renderProjectList();
  }
  function collectProject() {
    if(!$('project-form').reportValidity())throw Error('请填写项目名称、目标和有效的预算限制');
    const project=structuredClone(state.project);
    project.name=$('project-name').value.trim();project.description=$('project-description').value.trim();
    project.standards=$('project-standards').value.split('\n').map(s=>s.trim()).filter(Boolean);
    project.deliverables=$('project-deliverables').value.split('\n').map(s=>s.trim()).filter(Boolean);
    project.requiredToolIds=$('required-tools').value.split('\n').map(s=>s.trim()).filter(Boolean);
    project.maxReworks=Number($('max-reworks').value);
    project.materials={mode:$('materials-mode').value,fileIds:[...document.querySelectorAll('[data-material]:checked')].map(x=>x.value),maxChars:Number($('materials-max').value) || 40000};
    for(const role of project.roles)if(!role.name || !role.duty)throw Error('请为每个岗位填写名称和职责');
    for(const step of project.steps){
      if(!step.title || !project.roles.some(r=>r.roleId===step.roleId))throw Error('每个步骤都必须有名称和有效负责人');
      for(const [temporary,key] of [['_toolsJSON','toolCalls'],['_checksJSON','checks']]){
        if(step[temporary] !== undefined){try{step[key]=JSON.parse(step[temporary]);}catch{throw Error(step.title+' 的 '+key+' 不是有效 JSON');}if(!Array.isArray(step[key]))throw Error(key+' 必须为数组');delete step[temporary];}
      }
    }
    return project;
  }
  function approval() {
    let prices;try{prices=JSON.parse($('prices-json').value);}catch{throw Error('价格 JSON 格式不正确');}
    if(!prices || typeof prices!=='object' || Array.isArray(prices))throw Error('价格表必须是以模型连接 ID 为键的对象');
    const maxTokens=Number($('max-tokens').value),maxCost=Number($('max-cost').value),maxOutputTokens=Number($('max-output-tokens').value);
    if(!Number.isSafeInteger(maxTokens)||maxTokens<1||!Number.isFinite(maxCost)||maxCost<0||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1)throw Error('请填写有效的 Token 与费用上限');
    return {approvePaid:$('approve-paid').checked,approveExternalTools:$('approve-external').checked,maxTokens,maxCost,maxOutputTokens,prices,allowedTools:[...document.querySelectorAll('[data-project-tool]:checked')].map(x=>x.value)};
  }
  const STATUS_TEXT={ok:'已读取文字',no_text:'没有可读取的文字',tool_unavailable:'服务器缺少解析程序',metadata_only:'仅保存，不识别内容'};
  async function loadFiles() {
    const target=$('materials-list');state.files=[];
    if(!state.project || !state.project.projectId){target.replaceChildren(node('p',{class:'empty',text:'保存项目后即可上传资料。'}));return;}
    const data=await api('/api/v2/projects/'+encodeURIComponent(state.project.projectId)+'/files');state.files=list(data,'files');renderFiles();
  }
  function renderFiles() {
    const target=$('materials-list');target.replaceChildren();
    if(!state.files.length){target.append(node('p',{class:'empty',text:'还没有资料。'}));return;}
    const chosen=new Set((state.project.materials && state.project.materials.fileIds) || []);
    for(const f of state.files){
      const pid=encodeURIComponent(state.project.projectId),fid=encodeURIComponent(f.fileId),ok=f.extraction && f.extraction.status==='ok';
      const row=node('div',{class:'resource'});
      const box=node('input',{type:'checkbox',value:f.fileId,'aria-label':'选用 '+f.filename});box.dataset.material='1';box.checked=chosen.has(f.fileId);
      row.append(node('label',{class:'check'},[box,node('strong',{text:f.filename})]));
      row.append(node('span',{class:'pill'+(ok?'':' bad'),text:(STATUS_TEXT[f.extraction && f.extraction.status] || '未知')+(ok?' · '+f.extraction.chars+' 字':'')}));
      row.append(node('small',{text:f.kind.toUpperCase()+' · '+Math.ceil(f.bytes/1024)+' KB · SHA-256 '+f.sha256.slice(0,12)+'…'+(f.extraction && f.extraction.note?' · '+f.extraction.note:'')}));
      if(ok)row.append(node('button',{type:'button',class:'small',text:'预览文字',onclick:work(async()=>{const d=await api('/api/v2/projects/'+pid+'/files/'+fid+'?limit=3000');const pre=$('material-preview');pre.hidden=false;pre.textContent=d.text.text+(d.text.nextOffset!=null?'\n……（共 '+d.text.total+' 字，仅显示开头）':'');})}));
      row.append(node('a',{href:'/api/v2/projects/'+pid+'/files/'+fid+'/download',download:f.filename,text:'下载原文件'}));
      row.append(node('button',{type:'button',class:'small danger',text:'删除',onclick:work(async()=>{if(!confirm('删除资料「'+f.filename+'」？'))return;await api('/api/v2/projects/'+pid+'/files/'+fid,'DELETE');await loadFiles();feedback('已删除资料。');})}));
      target.append(row);
    }
  }
  const fileBase64=file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1] || '');r.onerror=()=>reject(Error('无法读取文件：'+file.name));r.readAsDataURL(file);});
  async function uploadMaterials() {
    if(!state.project || !state.project.projectId)await saveProject();
    const files=[...$('material-input').files];if(!files.length)throw Error('请先选择要上传的文件');
    const done=[],failed=[];
    for(const file of files){
      if(file.size>8*1024*1024){failed.push(file.name+'：超过 8 MB');continue;}
      try{const data=await api('/api/v2/projects/'+encodeURIComponent(state.project.projectId)+'/files','POST',{filename:file.name,contentBase64:await fileBase64(file)});done.push(data.file);}
      catch(e){failed.push(file.name+'：'+e.message);}
    }
    $('material-input').value='';await loadFiles();
    feedback('已上传 '+done.length+' 个文件'+(failed.length?'；失败：'+failed.join('；'):'。'),failed.length>0);
  }
  async function refreshProjects() {
    const [data,tasks]=await Promise.all([api('/api/v2/projects'),api('/api/v2/tasks').catch(()=>null)]);state.projects=list(data,'projects');state.tasks=tasks?tasks.tasks:[];renderProjectList();
  }
  /* B5-F1：左侧任务列表显示人话状态；简单模式下点任务进它的进度/成果页，配置页只从“高级设置/调整团队”进入 */
  const TASK_STATE={running:'进行中',review:'需要你处理',stopped:'已停下',done:'已完成',draft:'草稿'};
  function renderProjectList() {
    const target=$('projects');target.replaceChildren();
    if(!state.projects.length)target.append(node('p',{class:'empty',text:'还没有项目。从智能立项开始，或点击新建。'}));
    for(const project of state.projects){
      const task=(state.tasks||[]).find(t=>t.projectId===project.projectId);
      const open=()=>{if(task&&task.runId&&document.body.dataset.mode!=='advanced'){location.assign('/workspace.html?run='+encodeURIComponent(task.runId));return;}return openProject(project.projectId);};
      const small=task?(task.runId?(task.group==='running'?'第 '+Math.min(task.stepsDone+1,task.stepsTotal||1)+'/'+(task.stepsTotal||1)+' 步':'完成 '+task.stepsDone+'/'+(task.stepsTotal||1)+' 步')+(task.downloadable&&task.group!=='running'?' · 有成果可下载':''):'还没开始'):(project.roles || []).length+' 个岗位';
      const button=node('button',{type:'button',class:'project-button','data-project-id':project.projectId,'aria-current':String(state.project && state.project.projectId===project.projectId),onclick:work(open)},[node('strong',{},[project.name,...(task?[node('span',{class:'pstate '+task.group,text:TASK_STATE[task.group]})]:[])]),node('small',{text:small})]);
      target.append(button);
    }
  }
  async function saveProject() {
    const draft=collectProject(), saved=await api('/api/v2/projects'+(draft.projectId?'/'+encodeURIComponent(draft.projectId):''),draft.projectId?'PUT':'POST',draft);
    const project=saved.project || saved; state.project={...draft,...project};state.dirty=false;
    $('project-heading').textContent=state.project.name;
    const url=new URL(location.href);url.searchParams.set('project',state.project.projectId);history.replaceState(null,'',url);
    await refreshProjects();await loadFiles();feedback('项目已保存。执行前请检查模型、工具和预算。');return state.project;
  }
  async function openProject(id) {
    if(state.dirty && !confirm('当前配置有未保存修改，仍要切换项目吗？'))return;
    const data=await api('/api/v2/projects/'+encodeURIComponent(id));document.body.dataset.mode='advanced';renderProject(data.project || data);
    state.runs=list(data,'runs');state.run=null;renderRunPicker();renderRun();
    const url=new URL(location.href);url.searchParams.set('project',id);history.replaceState(null,'',url);
    if(state.runs.length)await loadRun(state.runs[0].runId || state.runs[0].id);
    feedback('项目已载入');
  }
  function renderRunPicker() {
    const select=$('run-picker');select.replaceChildren(node('option',{value:'',text:'请选择任务'}));
    for(const run of state.runs)select.append(node('option',{value:run.runId || run.id,text:(run.runId || run.id)+' · '+statusName(run.status)}));
    if(state.run)select.value=state.run.runId || state.run.id;
  }
  async function loadRun(id) {
    if(!id)return;
    const data=await api('/api/v2/runs/'+encodeURIComponent(id));state.run=data.run || data;
    if(!state.runs.some(r=>r.runId===state.run.runId))state.runs.unshift(state.run);
    else state.runs=state.runs.map(r=>r.runId===state.run.runId?state.run:r);
    renderRunPicker();renderRun();
    if(!['running','queued'].includes(state.run.status))await loadDelivery(state.run.runId);else renderDelivery(null);
  }
  // #17 M4: four independent delivery facts; nothing is shown as usable/verified unless the server checked it.
  const DELIVERY_TONE={runnable_verified:'ok',graph_validated:'ok',evidence_mapped_unverified:'warn',structure_only:'warn',not_run:'warn',evidence_gaps:'bad',mock_placeholder:'bad',failed:'bad',valid:'ok',invalid:'bad'};
  function deliveryRow(name,s,extra=''){
    const cell=(key,text)=>node('td',{},[node('span',{class:'pill','data-state':s[key],'data-tone':DELIVERY_TONE[s[key]]||'',text})]);
    return node('tr',{'data-delivery-kind':s.kind,'data-usable':s.usable},[node('td',{text:name}),cell('generated',s.labels.generated),cell('structure',s.labels.structure),cell('usable',s.labels.usable),cell('expertReview',s.labels.expertReview),node('td',{class:'hint',text:[s.reason,extra].filter(Boolean).join('；')})]);
  }
  function renderDelivery(m){
    if(!m){$('delivery-summary').textContent='尚未运行交付检查。';$('delivery-results').replaceChildren();return;}
    const sum=m.summary;$('delivery-summary').textContent=`检查时间 ${m.checkedAt}：已生成 ${sum.generated} 项；结构可解析 ${sum.structureValid}；通过可用性检查 ${sum.usableVerified}；占位/Mock ${sum.mockPlaceholder}；领域专家已评审 ${sum.expertReviewed}。${m.humanReview?.note||''}`;
    const rows=[];
    for(const item of m.items||[]){
      const name={software:'软件交付',organization:'组织结构',research:'研究证据链'}[item.kind]||item.kind;
      const extra=item.kind==='software'?(item.smoke?.ran?`沙盒退出码 ${item.smoke.exitCode}`:'')+(item.warnings?.length?' 告警：'+item.warnings.join('；'):'')
        :item.kind==='organization'?(item.errors?.length?'错误：'+item.errors.join('；'):'')+(item.warnings?.length?' 提醒：'+item.warnings.join('；'):'')
        :item.kind==='research'?`主张${item.summary?.claims??0}，缺证${item.summary?.unsupported??0}，合成${item.summary?.synthetic??0}，未核实${item.summary?.unverified??0}，已核实0`+(item.errors?.length?' 错误：'+item.errors.join('；'):''):'';
      rows.push(deliveryRow(name,item.status,extra));
    }
    for(const f of m.files||[])rows.push(deliveryRow(f.filename+'（'+f.bytes+' 字节，SHA-256 '+String(f.sha256).slice(0,12)+'…）',f));
    const links=(m.generatedArtifacts||[]).map(a=>{const href=safeDownloadUrl(a.downloadUrl);return href?node('a',{href,'data-generated':a.filename,text:'下载 '+a.filename+'（SHA-256 '+a.sha256.slice(0,12)+'…）'}):null;}).filter(Boolean);
    $('delivery-results').replaceChildren(node('table',{id:'delivery-table'},[node('thead',{},[node('tr',{},['成果','文件已生成','结构可解析','可实际使用','领域专家评审','说明'].map(t=>node('th',{text:t})))]),node('tbody',{},rows)]),...links.map(a=>node('p',{},[a])));
  }
  async function loadDelivery(runId){
    try{const data=await api('/api/v2/runs/'+encodeURIComponent(runId)+'/delivery-check');renderDelivery(data.manifest);}catch{renderDelivery(null);}
  }
  function safeDownloadUrl(value) {
    try{const url=new URL(value,location.origin);return url.origin===location.origin && url.protocol===location.protocol && url.pathname.startsWith('/api/')?url.href:null;}catch{return null;}
  }
  function renderRun() {
    const run=state.run;$('run-empty').hidden=!!run;$('run-detail').hidden=!run;if(!run)return;
    $('run-status').textContent=statusName(run.status);
    const usage=run.usage || {},steps=Array.isArray(run.steps)?run.steps:[],tokens=usage.totalTokens ?? usage.tokens ?? ((usage.providerTokens || 0)+(usage.estimatedTokens || 0)+(usage.inputTokens || 0)+(usage.outputTokens || 0));
    $('run-tokens').textContent=Number(tokens).toLocaleString();// #9 P2-03: a missing cost is unknown, never 0; the figure is an estimate, not a vendor bill.
    const costValue=usage.cost ?? usage.totalCost ?? usage.estimatedCost,ledgerRows=Array.isArray(run.usageLedger)?run.usageLedger:[];
    const conservative=ledgerRows.some(e=>e.costSource==='conservative_reservation'||e.costSource==='restart_unknown'||e.tokenSource==='reserved_unknown');
    $('run-cost').textContent=costValue===null||costValue===undefined||!Number.isFinite(Number(costValue))?'未知（不是0）':Number(costValue).toFixed(6)+(conservative?'（含保守预留）':'');
    $('run-cost').title='按你填写的单价×厂商返回用量估算；用量未知的调用按保守预留计入。不是厂商账单，未与厂商账单核对。';
    $('run-progress').textContent=steps.filter(s=>['done','completed'].includes(s.status)).length+' / '+steps.length;
    $('run-error').textContent=run.error || '';$('cancel-run').disabled=!['running','queued'].includes(run.status);
    const awaiting=['review_required','awaiting_review','completed','done'].includes(run.status);
    $('approve-run').disabled=!awaiting;$('rework-run').disabled=!awaiting;
    $('review-status').textContent=run.review ? stringify(run.review) : '通过或返工会保存审阅记录。返工将按原费用控制重新检查执行权限。';
    const rows=steps.map((step,index)=>{
      const row=node('div',{class:'run-step',dataset:{status:step.status || 'pending'}});
      row.append(node('strong',{text:(index+1)+'. '+(step.title || step.stepId || step.id || '步骤')+' · '+statusName(step.status)}));
      row.append(node('p',{class:'hint',text:[step.roleId,step.connectionId,step.tokens!==undefined?'Token '+step.tokens:''].filter(Boolean).join(' · ')}));
      if(step.error)row.append(node('p',{class:'error-note',text:step.error}));
      const output=step.output ?? step.text ?? step.result;
      if(output!==undefined)row.append(node('pre',{text:stringify(output)}));
      if(step.checks || step.quality)row.append(node('details',{},[node('summary',{text:'质量检查证据'}),node('pre',{text:stringify(step.checks || step.quality)})]));
      return row;
    });$('run-steps').replaceChildren(...rows);
    const artifacts=[...(Array.isArray(run.deliveries)?run.deliveries:[]),...(Array.isArray(run.artifacts)?run.artifacts:[])];
    const artifactRows=artifacts.map(artifact=>{
      const row=node('div',{class:'resource'}), url=safeDownloadUrl(artifact.downloadUrl || artifact.url);
      row.append(node('strong',{text:artifact.filename || artifact.name || artifact.label || artifact.artifactId || artifact.id || '成果文件'}));
      row.append(node('p',{class:'hint',text:[artifact.format || artifact.mimeType,artifact.bytes!==undefined?artifact.bytes+' bytes':'',artifact.kind].filter(Boolean).join(' · ')}));
      if(url)row.append(node('a',{href:url,download:artifact.filename || '',text:'下载真实文件'}));
      else if(artifact.text)row.append(node('pre',{text:artifact.text}));
      else row.append(node('span',{class:'hint',text:'服务端尚未提供可下载链接'}));return row;
    });$('run-artifacts').replaceChildren(...(artifactRows.length?artifactRows:[node('p',{class:'empty',text:'暂无成果文件。任务完成后可导出，或查看步骤交接输出。'})]));
    const messages=Array.isArray(run.messages)?run.messages:Array.isArray(run.events)?run.events:[];
    $('run-messages').replaceChildren(...(messages.length?messages.map(message=>node('div',{class:'log-item'},[node('small',{text:[message.createdAt || message.timestamp || '',message.from || message.fromRoleId || '',message.to || message.toRoleId || '',message.type || message.eventType || ''].filter(Boolean).join(' · ')}),node('pre',{text:stringify(message.content ?? message.payload ?? message.text ?? message)})])):[node('p',{class:'hint',text:'本任务暂无单独通信记录。执行步骤与服务端任务详情仍可核查。'})]));
    $('run-json').textContent=JSON.stringify(run,null,2);
  }
  function renderResources() {
    $('tools-list').replaceChildren(...(state.tools.length?state.tools.map(tool=>node('div',{class:'resource'},[node('strong',{text:tool.name || identity(tool)}),node('p',{text:tool.description || ''}),node('span',{class:'pill',text:(tool.executionMode || tool.kind || tool.transport || '本地工具')+' · '+identity(tool)}),node('details',{},[node('summary',{text:'注册详情'}),node('pre',{text:JSON.stringify(tool,null,2)})])])):[node('p',{class:'empty',text:'未注册工具'})]));
    $('skills-list').replaceChildren(...(state.skills.length?state.skills.map(skill=>node('div',{class:'resource'},[node('strong',{text:skill.name || identity(skill)}),node('p',{text:skill.description || skill.instructions || ''}),node('details',{},[node('summary',{text:'查看规范与权限'}),node('pre',{text:JSON.stringify(skill,null,2)})])])):[node('p',{class:'empty',text:'未注册 Skill'})]));
  }
  async function refreshResources() {
    const [models,tools,skills]=await Promise.all([api('/api/models'),api('/api/v2/tools'),api('/api/v2/skills')]);
    state.models=list(models,'models');state.tools=list(tools,'tools');state.skills=list(skills,'skills');renderResources();
    if(state.project){
      const selected=[...document.querySelectorAll('[data-project-tool]:checked')].map(x=>x.value);
      resourceCheckboxes('project-tools',state.tools,selected,'projectTool');
      $('project-skills').textContent=state.skills.length?state.skills.map(s=>s.name || identity(s)).join('、'):'暂未注册 Skill';
      renderSteps();
    }
  }
  async function downloadExport() {
    if(!state.run)throw Error('请先选择任务');
    const format=$('export-format').value;
    const res=await fetch('/api/v2/runs/'+encodeURIComponent(state.run.runId)+'/export',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({format})});
    if(!res.ok){const data=await res.json().catch(()=>({}));throw Error(data.error || '导出失败（HTTP '+res.status+'）');}
    const blob=await res.blob();if(!blob.size)throw Error('服务端返回空文件');
    const disposition=res.headers.get('content-disposition') || '',match=/filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
    let filename='AIJAVAIS-'+state.run.runId+'.'+format;
    if(match){try{filename=decodeURIComponent(match[1] || match[2] || match[3]);}catch{}}
    const url=URL.createObjectURL(blob),a=node('a',{href:url,download:filename});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
    feedback('已收到真实文件：'+filename+'（'+blob.size+' bytes）');await loadRun(state.run.runId);
  }
  async function periodicRefresh() {
    if(state.refreshing || !state.run || !['running','queued'].includes(state.run.status))return;
    state.refreshing=true;try{await loadRun(state.run.runId);}catch(error){feedback(error.message,true);}finally{state.refreshing=false;}
  }
  function connectEvents() {
    const stream=new EventSource('/api/events');
    stream.onopen=()=>{$('stream-status').textContent='实时事件已连接';};stream.onerror=()=>{$('stream-status').textContent='事件流重连中；任务状态继续轮询';};
    stream.onmessage=event=>{
      let value;try{value=JSON.parse(event.data);}catch{return;}
      try{dispatchEvent(new CustomEvent('aij:event',{detail:value}));}catch{/* 首页实时动态卡只是展示 */}
      const payload=value.payload || value.data || value;
      if(state.run && (payload.runId===state.run.runId || value.runId===state.run.runId))periodicRefresh();
    };
    addEventListener('beforeunload',()=>{stream.close();clearInterval(state.timer);});
    state.timer=setInterval(periodicRefresh,1800);
  }
  window.AIJWorkspace={refreshProjects:()=>refreshProjects().catch(()=>{})};
  addEventListener('aij:tasks',e=>{if(!e.detail||!Array.isArray(e.detail.tasks))return;state.tasks=e.detail.tasks;if(e.detail.tasks.some(t=>!state.projects.some(p=>p.projectId===t.projectId)))refreshProjects().catch(()=>{});else renderProjectList();});
  /* QA-B7-04：人民币为主值，美元上限（专业设置里）自动换算，两边保持一致 */
  const FXR=window.SmartPlan?SmartPlan.FX:7.5;
  $('max-cost-cny').addEventListener('input',()=>{const y=Number($('max-cost-cny').value);if(Number.isFinite(y)&&y>=0)$('max-cost').value=String(Math.floor(y/FXR*100)/100);});
  $('max-cost').addEventListener('input',()=>{const u=Number($('max-cost').value);if(Number.isFinite(u)&&u>=0)$('max-cost-cny').value=String(Math.round(u*FXR*100)/100);});
  $('project-form').addEventListener('input',()=>state.dirty=true);
  $('project-form').addEventListener('submit',work(saveProject));
  for(const name of ['project','run','resources'])$('tab-'+name).addEventListener('click',()=>tab(name));
  $('new-project').addEventListener('click',()=>{if(state.dirty&&!confirm('放弃未保存修改并新建项目？'))return;renderProject(blankProject());state.runs=[];state.run=null;renderRunPicker();renderRun();history.replaceState(null,'','/workspace.html');tab('project');feedback('');document.body.dataset.mode='simple';window.AIJSimple?.reset();});
  $('add-role').addEventListener('click',()=>{const roleId='role-'+Date.now().toString(36);state.project.roles.push({roleId,name:'新岗位',duty:'',standard:'',connectionId:''});state.dirty=true;renderRoles();renderSteps();});
  $('add-step').addEventListener('click',()=>{state.project.steps.push({stepId:'step-'+Date.now().toString(36),title:'新步骤',roleId:state.project.roles[0]?.roleId || '',prompt:'',toolCalls:[],checks:[]});state.dirty=true;renderSteps();});
  let CAPS={};
  async function capNames(){if(!Object.keys(CAPS).length){try{CAPS=(await api('/api/catalog')).capabilities||{};}catch{CAPS={};}}return CAPS;}
  async function renderChecklist(result){
    const names=await capNames(),target=$('validation-list'),label=m=>window.ModelHints?ModelHints.platformLabel(m):(m.displayName||m.connectionId);
    target.replaceChildren();
    if(result.ok){target.append(node('p',{text:'✓ 执行条件都满足了，可以开始执行。'}));return;}
    for(const issue of result.issues||[]){
      const role=state.project.roles.find(r=>r.roleId===issue.roleId),model=role&&state.models.find(m=>m.connectionId===role.connectionId),row=node('div',{class:'alert'});
      if(issue.code==='capability_missing'&&role&&model){
        const missing=((/capabilities? (.+)$/.exec(issue.message||'')||[])[1]||'').split(/,\s*/).filter(Boolean),cn=missing.map(c=>names[c]||c);
        row.append(node('div',{text:'岗位「'+role.name+'」需要的能力，'+label(model)+' 还没有登记：'+cn.join('、')}));
        row.append(node('button',{type:'button',class:'fixbtn',text:'为 '+label(model)+' 补充能力：'+cn.join('、'),onclick:work(async()=>{await api('/api/models/'+encodeURIComponent(model.connectionId),'PUT',{capabilities:[...new Set([...(model.capabilities||[]),...missing])]});await refreshResources();await recheck();})}));
        const better=state.models.find(m=>m.connectionId!==model.connectionId&&m.enabled!==false&&missing.every(c=>(m.capabilities||[]).includes(c)));
        if(better)row.append(node('button',{type:'button',class:'fixbtn',text:'更换为 '+label(better),onclick:work(async()=>{role.connectionId=better.connectionId;state.dirty=true;renderRoles();await recheck();})}));
      }else{
        const info=window.SmartPlan?SmartPlan.explain({code:issue.code,message:issue.message},{modelName:model&&label(model)}):{text:issue.message};
        row.append(node('div',{text:(role?'岗位「'+role.name+'」：':'')+info.text}));
        if(info.fix&&info.fix.action==='fix_model')row.append(node('a',{class:'fixbtn',href:'/admin.html',text:info.fix.label}));
        if(info.fix&&info.fix.action==='auto_assign')row.append(node('button',{type:'button',class:'fixbtn',text:info.fix.label,onclick:work(async()=>{const pool=SmartPlan.usable(state.models);for(const r of state.project.roles)if(!r.connectionId&&pool[0])r.connectionId=pool[0].connectionId;renderRoles();await recheck();})}));
      }
      target.append(row);
    }
  }
  async function recheck(){const project=await saveProject();let limits;try{limits=approval();}catch{limits={};}const result=await api('/api/v2/projects/'+project.projectId+'/validate','POST',limits);$('validation').hidden=false;$('validation-text').textContent=JSON.stringify(result,null,2);await renderChecklist(result);feedback(result.ok?'执行条件检查通过。尚未开始调用模型。':'检查发现待处理事项，请按下面的提示修复。',!result.ok);$('validation').scrollIntoView({block:'start'});}
  $('validate-project').addEventListener('click',work(recheck));
  /* B7f：门禁拦下时，在按钮旁用中文说明原因并给一键修复；成功后立即进入执行进度 */
  function showStartError(error){
    const box=$('start-error'),info=window.SmartPlan?SmartPlan.explain(error):{text:error.message};
    box.replaceChildren(node('div',{text:'没有开始：'+info.text}));
    const fix=info.fix,act={
      set_budget:()=>{$('max-cost-cny').value=String(fix.budgetCny||1);$('max-cost').value=String(Math.floor((fix.budgetCny||1)/SmartPlan.CNY_PER_USD*100)/100);$('approve-paid').checked=true;},
      approve:()=>{$('approve-paid').checked=true;},
      conservative_prices:()=>{const prices={};for(const r of state.project.roles){const m=state.models.find(x=>x.connectionId===r.connectionId),u=m&&SmartPlan.usdRate(m);if(u)prices[m.connectionId]=u;}$('prices-json').value=JSON.stringify(prices,null,2);},
      auto_assign:()=>{const pool=SmartPlan.usable(state.models);for(const r of state.project.roles)if(!r.connectionId&&pool[0])r.connectionId=pool[0].connectionId;renderRoles();},
      retry:()=>{},
    }[fix&&fix.action];
    if(fix&&fix.action==='fix_model')box.append(node('a',{class:'fixbtn',href:'/admin.html',text:fix.label}));
    else if(fix&&fix.action==='add_caps')box.append(node('button',{type:'button',class:'fixbtn',text:'查看执行条件并修复',onclick:()=>$('validate-project').click()}));
    else if(act)box.append(node('button',{type:'button',class:'fixbtn',text:fix.label+(fix.action==='retry'?'':'，然后重新开始'),onclick:()=>{act();box.hidden=true;$('start-run').click();}}));
    if(info.detail)box.append(node('details',{},[node('summary',{text:'技术细节（给管理员看）'}),node('div',{text:info.detail})]));
    box.hidden=false;box.scrollIntoView({block:'center'});
  }
  $('start-run').addEventListener('click',work(async()=>{
    $('start-error').hidden=true;
    try{const project=await saveProject(),limits=approval();const data=await api('/api/v2/projects/'+project.projectId+'/runs','POST',limits);state.run=data.run || data;state.runs.unshift(state.run);$('approve-paid').checked=false;renderRunPicker();renderRun();tab('run');scrollTo(0,0);feedback('任务已开始，下面是实时执行进度。');}
    catch(error){showStartError(error);}
  }));
  $('run-picker').addEventListener('change',work(()=>loadRun($('run-picker').value)));
  $('refresh-run').addEventListener('click',work(async()=>{if(state.run)await loadRun(state.run.runId);else if(state.project.projectId)await openProject(state.project.projectId);}));
  $('cancel-run').addEventListener('click',work(async()=>{if(!state.run)return;await api('/api/v2/runs/'+state.run.runId+'/cancel','POST',{});await loadRun(state.run.runId);feedback('已请求取消任务');}));
  for(const [id,decision]of [['approve-run','approve'],['rework-run','rework']])$(id).addEventListener('click',work(async()=>{
    const comment=$('review-comment').value.trim();if(decision==='rework'&&!comment)throw Error('返工时请填写具体修改要求');
    await api('/api/v2/runs/'+state.run.runId+'/review','POST',{decision,feedback:comment,comment,...(decision==='rework'?approval():{})});$('approve-paid').checked=false;await loadRun(state.run.runId);feedback(decision==='approve'?'审核记录已保存':'返工要求已提交');
  }));
  $('export-run').addEventListener('click',work(downloadExport));
  $('delivery-check').addEventListener('click',work(async()=>{if(!state.run)throw Error('请先选择任务');const data=await api('/api/v2/runs/'+encodeURIComponent(state.run.runId)+'/delivery-check','POST',{smokeTest:$('delivery-smoke').checked});renderDelivery(data.manifest);feedback('交付检查完成：结果为服务端真实检查记录；领域专家评审仍未进行。');}));
  $('upload-materials').addEventListener('click',work(uploadMaterials));
  $('save-skill').addEventListener('click',work(async()=>{let skill;try{skill=JSON.parse($('skill-json').value);}catch{throw Error('Skill JSON 格式不正确');}await api('/api/v2/skills','POST',skill);await refreshResources();feedback('Skill 已注册。请在执行步骤中显式选择。');}));
  $('discover-tools').addEventListener('click',work(async()=>{const result=await api('/api/v2/tools/discover','POST',{});await refreshResources();feedback('已刷新服务端配置的 MCP 工具；新增工具需加入本次运行白名单。'+(result.servers?'\n连接诊断：'+JSON.stringify(result.servers):''));}));
  $('logout').addEventListener('click',work(async()=>{await api('/api/auth/logout','POST',{});location.assign('/login.html');}));
  (async()=>{
    try{await refreshResources();await refreshProjects();const id=new URLSearchParams(location.search).get('project');if(id)await openProject(id);else renderProject(blankProject());connectEvents();}
    catch(error){feedback(error.message,true);if(!state.project)renderProject(blankProject());}
  })();
})();
