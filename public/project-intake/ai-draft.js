/* Explicit, one-shot AI planning. All proposal content is text, never HTML or
 * executable instructions. No automatic model calls, project saves or runs. */
(() => {
  'use strict';
  let root, models = [], source = '', controller;
  const fresh = () => ({ open:false, description:'', connectionId:'', maxTokens:32000, maxOutputTokens:2048, maxCost:0,
    inputRate:'', outputRate:'', consent:false, estimate:null, busy:false, result:null, draft:null, saveConsent:false, message:'', current:null });
  let state = fresh();
  const NOT_DISPATCHED=new Set(['draft_busy','paid_approval_required','budget_required','price_required','token_budget_exceeded','cost_budget_exceeded','model_not_ready','model_changed','invalid_input','service_closing','usage_ledger_unavailable']);
  const shortId=id=>String(id||'').slice(0,8);
  const $ = id => document.getElementById(id);
  const lines = text => text.split('\n').map(s=>s.trim()).filter(Boolean);
  function el(tag, props = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k,v] of Object.entries(props)) {
      if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2),v);
      else if (k in n) n[k] = v;
      else n.setAttribute(k,v);
    }
    for (const child of children) n.append(typeof child === 'string' ? document.createTextNode(child) : child);
    return n;
  }
  function field(parent, label, id, value, change, { area=false, ...props } = {}) {
    const control = el(area?'textarea':'input',{id,value:value??'',...props,oninput:e=>change(e.target.value)});
    parent.append(el('label',{className:'label',htmlFor:id,text:label}),control); return control;
  }
  function changed() { state.saveConsent=false; if($('ai-save-confirm'))$('ai-save-confirm').checked=false; if($('ai-save'))$('ai-save').disabled=true; }
  function invalidate() {
    state.estimate=null;state.consent=false;
    if($('ai-consent'))$('ai-consent').checked=false;
    if($('ai-generate'))$('ai-generate').disabled=true;
    if($('ai-estimate-text'))$('ai-estimate-text').textContent='参数已改变，请重新估算；估算不会调用模型。';
  }
  const payload = () => ({description:state.description,connectionId:state.connectionId,maxTokens:Number(state.maxTokens),maxOutputTokens:Number(state.maxOutputTokens),
    maxCost:Number(state.maxCost),price:{inputPerMillion:Number(state.inputRate),outputPerMillion:Number(state.outputRate),currency:'USD'}});
  async function api(path, body, signal) {
    const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
    let data;try{data=await r.json();}catch(e){if(e.name==='AbortError')throw e;data={};}
    if(!r.ok)throw Object.assign(Error(data.error || data.usageWarning || '请求失败（HTTP '+r.status+'）'),{data});
    return data;
  }
  function message(text) {state.message=text; if($('ai-message'))$('ai-message').textContent=text;}
  function eligible() {return !state.busy&&state.consent&&state.estimate?.fitsTokens&&state.estimate?.fitsCost;}
  async function estimate() {
    const quoted=JSON.stringify(payload());
    try {
      state.consent=false;state.estimate=null;render();
      const data=await api('/api/v2/intake/ai-draft/estimate',JSON.parse(quoted));
      if(JSON.stringify(payload())!==quoted){message('参数已改变，请重新估算。');render();return;}
      state.estimate=data;
      message('估算完成，尚未向模型发送请求。请检查上限，再批准这一次生成。');render();
    }catch(e){message(e.message+'；你仍可使用上方模板或手工编辑已有草案。');render();}
  }
  async function cancel() {
    if(!state.busy||!controller)return;
    const active=controller;
    try{const reply=await api('/api/v2/intake/ai-draft/cancel',{requestId:active.requestId});if(reply.cancelled)return;}catch{/* HTTP disconnect still forwards cancellation. */}
    active.abort();
  }
  async function generate() {
    if(!eligible())return;
    const currentState=state;
    const input={...payload(),approvePaid:state.consent,requestId:crypto.randomUUID()};
    controller=new AbortController();controller.requestId=input.requestId;const active=controller;
    // #19: every cost fact is attributed to the request it was answered for. A new request starts
    // with no usage of its own; any earlier usage stays visible only as an explicitly labelled previous request.
    state.current={requestId:input.requestId,status:'pending',sent:null,code:null};
    state.busy=true;state.consent=false;message('正在请求团队草案；不会执行项目或调用工具。');render();
    try{
      const result=await api('/api/v2/intake/ai-draft',input,controller.signal);
      if(state!==currentState)return;
      state.result={...result,usageRequestId:input.requestId};state.draft=result.draft;state.saveConsent=false;
      state.current={requestId:input.requestId,status:'answered',sent:result.requestSent===true,code:result.code||null};
      message(result.financiallyComplete===false?'草案已生成，可编辑，确认后才会保存（不会自动执行或授权工具）；但费用账本未完成，'+(result.usage&&result.usage.cost===null?'费用未知，':'')+'需要人工核对。'+(result.usageWarning?' '+result.usageWarning:'')+' '+(result.retryWarning||''):'AI草案已生成，尚未保存。请逐项编辑与人工确认。');
    }catch(e){
      if(state!==currentState)return;
      const data=e.data;
      if(data?.usage)state.result={...(state.result||{}),usage:data.usage,usageRequestId:input.requestId,usageRecorded:data.usageRecorded,usageWarning:data.usageWarning,financiallyComplete:data.financiallyComplete,billingStatus:data.billingStatus,ledgerId:data.ledgerId};
      // Refused before any claim/dispatch (capacity, approval, budget, readiness): provably not sent, cost 0 for THIS request.
      const notSent=data?.requestSent===false||NOT_DISPATCHED.has(data?.code);
      state.current={requestId:input.requestId,status:'answered',sent:data?.usage?data.requestSent===true:notSent?false:null,code:data?.code||(e.name==='AbortError'?'aborted':null)};
      if(!state.draft&&data?.fallbackDraft)state.draft=data.fallbackDraft;
      // The user's request ending is not the provider call ending: say so plainly.
      const outstanding=data?.billingStatus==='dispatch_outstanding';
      message(outstanding?(data.code==='timeout'?'请求已超时。':'已取消本次等待。')+'供应商调用尚未确认结束，可能仍在处理并计费：费用未知（不是0），账本保留预留上界'+(data.ledgerId?'（账本 '+data.ledgerId+'）':'')+'；它结束前继续占用一个并发名额，结束后自动结算一次。请勿为此重新生成。'
        :data?.code==='draft_busy'?'已有3个草案模型调用仍在进行（含已取消但供应商尚未结束的调用），本次未发送请求、未产生费用；请稍后再试。'
        :e.name==='AbortError'||data?.code==='cancelled'?'已取消。'+(data?.requestSent===false?'请求尚未发送，费用为0。':'已发送的模型请求仍可能产生费用，请查看系统用量账本。')
        :e.message+'；已回退手工方案，也可继续使用原模板。'+(data?.usageWarning?' '+data.usageWarning:''));
    }finally{if(state===currentState){state.busy=false;render();}if(controller===active)controller=null;}
  }
  function selectModel(value, change, id) {
    const select=el('select',{id,onchange:e=>change(e.target.value)});
    select.append(el('option',{value:'',text:'请选择已注册并通过试连的模型'}));
    for(const c of models)select.append(el('option',{value:c.connectionId,text:(c.displayName||c.connectionId)+' · '+c.pricingMode+(c.status==='available'?'':'（需完成试连）'),disabled:c.status!=='available'}));
    select.value=value;return select;
  }
  function editor(parent) {
    const d=state.draft;
    parent.append(el('h3',{text:'编辑草案 · 修改后仍须人工确认保存'}));
    field(parent,'项目名称','ai-project-name',d.name,v=>{d.name=v;changed();});
    field(parent,'项目目标 / 原始需求','ai-project-goal',d.description,v=>{d.description=v;changed();},{area:true});
    field(parent,'AI建议目标','ai-proposed-goal',d.planning?.goal||d.name,v=>{d.planning??={humanDecisions:[],requestedSkills:[]};d.planning.goal=v;changed();},{area:true});
    const roles=el('div',{id:'ai-roles'});
    for(const role of d.roles){
      const card=el('div',{className:'card'});
      field(card,'岗位名称','ai-role-'+role.roleId,role.name,v=>{role.name=v;changed();},{className:'ai-role-name'});
      card.append(selectModel(role.connectionId,v=>{role.connectionId=v;changed();},'ai-model-'+role.roleId));
      for(const [key,label] of [['duty','岗位职责'],['boundary','权责边界'],['standard','岗位验收标准']])field(card,label,'ai-'+key+'-'+role.roleId,role[key],v=>{role[key]=v;changed();},{area:true});
      field(card,'需要的模型能力（逗号分隔，声明不等于实测）','ai-caps-'+role.roleId,role.requiredCapabilities.join(', '),v=>{role.requiredCapabilities=v.split(',').map(x=>x.trim()).filter(Boolean);changed();});
      const rec=state.result?.modelRecommendations?.find(x=>x.roleId===role.roleId)?.recommendations||[];
      card.append(el('p',{className:'hint',text:'服务器推荐（需你选择，不自动分配）：'+(rec.slice(0,3).map(x=>x.displayName).join('、')||'暂无合适已测连接')}));
      card.append(el('button',{type:'button',className:'btn',text:'删除岗位及关联步骤',disabled:d.roles.length<=1,onclick:()=>{
        if(!confirm('删除该岗位及其负责的步骤？其他岗位和步骤保留。'))return;
        d.roles=d.roles.filter(x=>x!==role);d.steps=d.steps.filter(x=>x.roleId!==role.roleId);changed();render();
      }}));roles.append(card);
    }
    parent.append(roles,el('button',{type:'button',id:'ai-add-role',className:'btn',text:'＋ 增加岗位',disabled:d.roles.length>=12,onclick:()=>{
      d.roles.push({roleId:'role-'+crypto.randomUUID().slice(0,8),name:'新增岗位',duty:'请补充职责',boundary:'不得自行扩大权限或预算',standard:'请补充验收标准',connectionId:'',requiredCapabilities:[],fallbackConnectionIds:[]});changed();render();
    }}));
    const steps=el('div',{id:'ai-steps'});
    d.steps.forEach((step,index)=>{
      const card=el('div',{className:'card'});card.append(el('h3',{text:'步骤 '+(index+1)}));
      field(card,'步骤名称','ai-step-'+step.stepId,step.title,v=>{step.title=v;changed();},{className:'ai-step-title'});
      const role=el('select',{'aria-label':'步骤'+(index+1)+'岗位',onchange:e=>{step.roleId=e.target.value;changed();}});
      for(const r of d.roles)role.append(el('option',{value:r.roleId,text:r.name}));role.value=step.roleId;card.append(role);
      for(const [key,label] of [['prompt','执行指令'],['deliverable','阶段成果'],['quality','验收要求']])field(card,label,'ai-step-'+key+'-'+step.stepId,step[key],v=>{step[key]=v;changed();},{area:true});
      const handoff=el('select',{'aria-label':'步骤'+(index+1)+'交接',onchange:e=>{step.handoff=e.target.value;changed();}});
      handoff.append(el('option',{value:'previous',text:'接收前一步成果'}),el('option',{value:'all',text:'接收全部前序成果'}));handoff.value=step.handoff;card.append(handoff);
      card.append(el('button',{type:'button',className:'btn',text:'上移',disabled:index===0,onclick:()=>{[d.steps[index-1],d.steps[index]]=[step,d.steps[index-1]];changed();render();}}),
        el('button',{type:'button',className:'btn',text:'删除步骤',disabled:d.steps.length<=1,onclick:()=>{d.steps.splice(index,1);changed();render();}}));steps.append(card);
    });parent.append(el('h3',{text:'工作顺序与交接'}),steps,el('button',{type:'button',id:'ai-add-step',className:'btn',text:'＋ 增加步骤',disabled:d.steps.length>=30,onclick:()=>{
      d.steps.push({stepId:'step-'+crypto.randomUUID().slice(0,8),roleId:d.roles[0].roleId,title:'新增步骤',prompt:'请补充执行要求',deliverable:'请补充阶段成果',quality:'请补充验收标准',handoff:'previous',toolCalls:[],checks:[],skillId:''});changed();render();
    }}));
    field(parent,'最终验收标准（每行一项）','ai-acceptance',d.standards.join('\n'),v=>{d.standards=lines(v);changed();},{area:true});
    field(parent,'最终成果（每行一项）','ai-deliverables',d.deliverables.join('\n'),v=>{d.deliverables=lines(v);changed();},{area:true});
    field(parent,'需要的工具ID（仅要求，不是调用授权）','ai-required-tools',d.requiredToolIds.join('\n'),v=>{d.requiredToolIds=lines(v);changed();},{area:true});
    d.planning??={goal:d.name,humanDecisions:[],requestedSkills:[]};
    field(parent,'需要的Skills（每行一项，尚未授权执行）','ai-required-skills',d.planning.requestedSkills.join('\n'),v=>{d.planning.requestedSkills=lines(v);changed();},{area:true});
    field(parent,'必须由人决定或审批的事项','ai-human-decisions',d.planning.humanDecisions.join('\n'),v=>{d.planning.humanDecisions=lines(v);changed();},{area:true});
    const checks=state.result?.toolCheck||[], recs=state.result?.toolRecommendations||[];
    parent.append(el('p',{id:'ai-tool-check',className:'hint',text:'生成时工具检查（编辑后请在工作台重新核实）：'+checks.map(x=>x.intakeId+'：'+x.status).join('；')}));
    // AI suggestions vs. permissions: nothing here is granted; each run asks separately.
    parent.append(el('p',{id:'ai-tool-permissions',className:'note',text:'AI建议的工具（未授予任何权限）：'+(recs.length?recs.map(x=>x.intakeId+'［'+(x.verification==='registered_available'?'已注册可用':'未验证')+'·需逐次运行批准'+(x.highRisk?'·高风险/外部或未知':'')+'］').join('；'):'无')+'。保存草案不会授权工具、不会开始执行。'}));
    parent.append(el('p',{id:'ai-skill-check',className:'hint',text:'生成时Skills检查：'+(state.result?.skillCheck||[]).map(x=>x.skillId+'：'+(x.available?'已注册（仍需配置执行步骤）':'尚未注册')).join('；')}));
    parent.append(el('label',{className:'label'},[el('input',{id:'ai-save-confirm',type:'checkbox',checked:state.saveConsent,onchange:e=>{state.saveConsent=e.target.checked;$('ai-save').disabled=!state.saveConsent||state.busy;}}),'我已人工检查草案；仅保存项目，不开始执行或授权工具。']),
      el('button',{id:'ai-save',type:'button',className:'btn primary',text:'确认后保存草案并进入工作台',disabled:!state.saveConsent||state.busy,onclick:save}));
  }
  async function save(){
    if(!state.saveConsent||!state.draft||state.busy)return;
    try{
      $('ai-save').disabled=true;
      const saved=await api('/api/v2/projects',state.draft);
      if(!saved.project?.projectId)throw Error('未返回项目ID');
      window.location.assign('/workspace.html?project='+encodeURIComponent(saved.project.projectId));
    }catch(e){message(e.message);if($('ai-save'))$('ai-save').disabled=!state.saveConsent;}
  }
  function render(){
    if(!root?.isConnected)return;root.replaceChildren();
    const card=el('section',{className:'card',id:'ai-team-card'});
    card.append(el('h3',{text:'没有合适模板？让AI帮你设计团队'}),el('p',{className:'hint',text:'保留上方规则模板。这里仅在你估算并批准后调用一次模型，生成可以自由编辑的方案；不会自动执行。'}));
    if(!state.open){card.append(el('button',{id:'ai-draft-open',type:'button',className:'btn',text:'让AI帮我设计团队',onclick:()=>{state.open=true;render();}}));root.append(card);return;}
    const config=el('fieldset',{disabled:state.busy});
    field(config,'项目需求','ai-description',state.description,v=>{state.description=v;invalidate();},{area:true,maxLength:20000});
    config.append(el('label',{className:'label',htmlFor:'ai-model',text:'用于这一次团队设计的模型'}),selectModel(state.connectionId,v=>{state.connectionId=v;invalidate();},'ai-model'));
    const limits=el('div',{className:'grid'});
    for(const [key,label,id,min,max] of [['maxTokens','本次Token上限','ai-max-tokens',1,1000000],['maxOutputTokens','输出Token上限','ai-output-tokens',1,8192],['maxCost','本次金额上限（USD）','ai-max-cost',0,10000],['inputRate','每百万输入Token价格（USD）','ai-input-rate',0,1000000],['outputRate','每百万输出Token价格（USD）','ai-output-rate',0,1000000]]){
      const f=el('div');field(f,label,id,state[key],v=>{state[key]=v;invalidate();},{type:'number',min,max,step:'any'});limits.append(f);
    }config.append(limits,el('p',{className:'hint',text:'远程模型需要明确批准及非零价表；不能仅凭“免费”标签免除费用检查。本地模型由服务器核实精确目标。'}),el('button',{id:'ai-estimate',type:'button',className:'btn',text:'先估算（不调用模型）',onclick:estimate}));
    card.append(config);
    const e=state.estimate;
    card.append(el('p',{id:'ai-estimate-text',className:'note',text:e?`保守上界：输入 ${e.inputTokensBound} + 输出 ${e.outputTokensBound} = ${e.tokenBound} Token；费用最高估算 $${e.costBound.toFixed(6)} USD。${e.fitsTokens&&e.fitsCost?'当前上限可覆盖。':'当前上限不足，请调整后重新估算。'}`:'先选择模型并估算。这里显示上界，不是供应商实际账单。'}),
      el('label',{className:'label'},[el('input',{id:'ai-consent',type:'checkbox',checked:state.consent,disabled:state.busy||!e,onchange:ev=>{state.consent=ev.target.checked;$('ai-generate').disabled=!eligible();}}),'我明确批准这一次模型请求及以上上限；不授权项目执行或任何工具操作。']),
      el('button',{id:'ai-generate',type:'button',className:'btn primary',text:'生成可编辑团队草案',disabled:!eligible(),onclick:generate}),
      el('button',{id:'ai-cancel',type:'button',className:'btn',text:'取消本次请求',disabled:!state.busy,onclick:cancel}),
      el('p',{id:'ai-message',role:'status',className:'note',text:state.message}));
    const cur=state.current;
    if(cur)card.append(el('p',{id:'ai-current-request',className:'hint','data-request-id':cur.requestId,text:'本次请求（ID '+shortId(cur.requestId)+'）：'+(cur.status==='pending'?'进行中':cur.sent===false?'未发送请求，本次费用为0。':cur.sent===true?'已发送，本次费用见下方“本次用量”。':'发送状态未知，请查看系统用量账本，不要视为0。')}));
    // Usage of a different (earlier) request is never shown as "本次".
    const ownUsage=state.result?.usage&&cur&&state.result.usageRequestId===cur.requestId;
    if(state.result?.usage&&!ownUsage){const u=state.result.usage;card.append(el('p',{id:'ai-usage-previous',className:'hint','data-request-id':state.result.usageRequestId||'',text:`上一请求（ID ${shortId(state.result.usageRequestId)}，与本次请求无关）的用量：费用${u.cost===null||u.cost===undefined?'未知，不能视为零':'$'+u.cost+' USD'}${state.result.billingStatus==='dispatch_outstanding'?'；该请求的供应商调用尚未结束，可能仍计费':''}${u.billingFactText?'（'+u.billingFactText+'）':''}。`}));}
    if(ownUsage){const u=state.result.usage;card.append(el('p',{id:'ai-usage',className:'hint','data-request-id':state.result.usageRequestId,text:`本次用量：${u.tokens??'未知'} Token（${u.tokenSource}）；费用：${u.cost===null||u.cost===undefined?'未知，不能视为零':('$'+u.cost+' USD')}${u.billingFactText?'（'+u.billingFactText+'）':''}；${state.result.financiallyComplete===true?'已记录账本':state.result.billingStatus==='dispatch_outstanding'?'供应商调用尚未结束：费用未知，可能仍计费；结束后自动结算一次，不会自动重发。':(u.cost===null?'账本未完成：费用未知，需要人工核对；请勿为补记账重新生成。':'账本未写入（本次费用已确定为 $'+u.cost+' USD），需要人工核对记录。')}`}));}
    if(state.draft)editor(card);root.append(card);
  }
  window.AIJIntakeDraft={mount(container,options){root=container;models=options.models||[];if(source!==options.description){source=options.description;state.description=source;invalidate();}render();},
    unmount(){root=null;if(state.busy)void cancel();},reset(){if(state.busy)void cancel();state=fresh();source='';root=null;}};
})();
