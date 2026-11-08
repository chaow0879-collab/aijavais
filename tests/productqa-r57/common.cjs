'use strict';
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
require('./subject.cjs');
const H=require('./harness.cjs');
const GOALS=[
 {key:'moss-acoustic',domain:'苔藓孢子标本与声学走廊',goal:'为苔藓孢子标本与声学走廊共展制作编号对照表和志愿者观察报告'},
 {key:'neon-sign',domain:'霓虹招牌修复与手语导览',goal:'为霓虹招牌修复档案与手语导览设计志愿者培训课程和演示课件'},
 {key:'meteorite-rubbing',domain:'陨石拓印与社区夜跑',goal:'为陨石拓印与社区夜跑联展编排展位轮班表和讲解短视频脚本'},
 {key:'steam-scent',domain:'蒸汽玩具与嗅觉展览',goal:'为蒸汽玩具与嗅觉展览写档案来源核对手册和对照海报'},
 {key:'driftwood-library',domain:'漂流木图书馆与潮汐日历',goal:'为漂流木图书馆与潮汐日历开放日准备排期表和访客通知文案'},
 {key:'pollen-post',domain:'冰川花粉档案与声音邮局',goal:'为冰川花粉档案与声音邮局设计数据字段表、分析报告和演示文稿'},
 {key:'bamboo-robot',domain:'竹编机器人外壳与剧场服装',goal:'为竹编机器人外壳与剧场服装共创活动编写课程、材料清单和工序说明文档'},
 {key:'planet-tickets',domain:'行星植物纹样与触摸票券',goal:'为行星植物纹样与触摸票券展览设计海报、签到表和讲解课程'}
];
class Provider{
 constructor(){this.calls=[];this.probes=0;this.peak=0;this.active=0;this.held=new Set();this.mode='ok';}
 async start(){this.server=http.createServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const body=JSON.parse(raw),prompt=(body.messages||[]).map(m=>m.content).join('\n');const probe=!/Design|岗位|目标|步骤|goal|work|QA57/i.test(prompt)&&this.calls.length===0;const entry={at:Date.now(),path:req.url,promptSha256:H.hash(prompt),messages:body.messages,mode:this.mode};
  // Connection probe is explicit and happens before any project. No rule planner call is a model call.
  if(this.probing){this.probes++;res.writeHead(200,{'content-type':'text/event-stream'});return this.reply(res,{probe:true});}
  this.calls.push(entry);this.active++;this.peak=Math.max(this.peak,this.active);res.once('close',()=>{this.active--;this.held.delete(res);entry.closedAt=Date.now();});
  if(this.mode==='error-429'){res.writeHead(429,{'content-type':'application/json'});return res.end(JSON.stringify({error:{message:'QA57 synthetic provider rate limit'}}));}
  res.writeHead(200,{'content-type':'text/event-stream'});if(this.mode==='hold'){res.write(': QA57 held model\n\n');this.held.add(res);return;}
  this.reply(res);
 });});await new Promise(r=>this.server.listen(0,'127.0.0.1',r));this.port=this.server.address().port;return this;}
 reply(res,override){const content=JSON.stringify(override||{sections:[{heading:'QA57_CHAIN',text:'QA57_CHAIN synthetic local output. Role collaboration evidence only; not professionally verified.'}],rows:[['QA57_FIELD','value'],['synthetic_check',this.calls.length]],slides:[{title:'QA57_CHAIN',bullets:['Synthetic local evidence','Professional quality NOT_VERIFIED']}]});res.write('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n');if(this.mode!=='unknown')res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:31,completion_tokens:47}})+'\n\n');res.end('data: [DONE]\n\n');}
 release(){for(const r of [...this.held]){this.held.delete(r);this.reply(r);}}
 async stop(){this.server.closeAllConnections();await new Promise(r=>this.server.close(r));}
}
async function boot(label){const provider=await new Provider().start(),app=new H.App(provider,label);await app.start();const r=await app.call('POST','/api/models',{providerId:'ollama',modelId:'QA57_LOCAL_ONLY',displayName:'QA57 独立本地合成模型',pricingMode:'local',baseUrl:'http://127.0.0.1:'+provider.port+'/v1',capabilities:['reasoning','writing','coding','research','data_analysis','vision']});if(r.status!==200)throw Error(r.text);app.mid=r.json.connection.connectionId;provider.probing=true;const test=await app.call('POST','/api/models/'+app.mid+'/test',{});provider.probing=false;if(!test.json.ok)throw Error('Local model probe failed');return {app,provider,async close(extra={}){provider.release();await app.cleanup(extra);await provider.stop();}};}
function approve(p,mid,requestId,extra={}){return {requestId,approved:true,projectId:p.projectId,expectedProjectVersion:p.version,expiresAt:Date.now()+300000,maxTokens:500000,maxOutputTokens:256,maxCost:0,allowedTools:[],rolePermissions:Object.fromEntries(p.roles.map(r=>[r.roleId,{approved:true,connectionId:mid,allowedTools:[],maxTokens:100000,maxCost:0}])),...extra};}
async function create(f,goal){const r=await f.app.call('POST','/api/v2/universal/plan',{goal:goal.goal,domain:goal.domain,acceptance:'每条事实标注来源，未知保留；编号一致；文件可编辑',audience:'志愿者'});if(r.status!==200)throw Error(r.text);const project=r.json.project;project.roles.forEach(x=>x.connectionId=f.app.mid);project.roles[0].duty+='；用户补充：保留未经核实的假设';const saved=await f.app.call('POST','/api/v2/universal/projects',{project});if(saved.status!==201)throw Error(saved.text);return {draft:r.json,project:saved.json.project};}
async function settled(app,id){let last;await H.until(async()=>{last=(await app.call('GET','/api/v2/universal/runs/'+id)).json.run;return last&&!last.executionActive;},'run settled',30000);return last;}
function sqlite(app){const db=new DatabaseSync(path.join(app.dir,'projects.sqlite'),{readOnly:true});try{return {integrity:db.prepare('PRAGMA quick_check').get().quick_check,version:db.prepare('PRAGMA user_version').get().user_version,ledger:db.prepare('SELECT doc FROM usage_ledger').all().map(r=>JSON.parse(r.doc)),messages:db.prepare('SELECT doc FROM messages').all().map(r=>JSON.parse(r.doc)),requests:db.prepare("SELECT key,doc FROM settings WHERE key LIKE 'r53-request:%'").all().map(r=>({key:r.key,...JSON.parse(r.doc)}))};}finally{db.close();}}
async function file(app,url,name){const r=await fetch(app.origin+url,{headers:{cookie:app.cookie}}),b=Buffer.from(await r.arrayBuffer());if(r.status!==200)throw Error('Download '+r.status);H.write('files/'+name,b);return {bytes:b.length,sha256:H.hash(b)};}
module.exports={H,GOALS,boot,approve,create,settled,sqlite,file};
