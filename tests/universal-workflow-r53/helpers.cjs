'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),H=require('../helpers');
async function boot(t){
 const state={calls:0,prompts:[],mode:'ok',held:[]};
 const provider=http.createServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{const b=JSON.parse(raw),prompt=b.messages.at(-1).content;state.calls++;state.prompts.push(prompt);
  res.writeHead(200,{'content-type':'text/event-stream'});if(state.mode==='hang'){state.held.push(res);res.write(': waiting\n\n');return;}
  const content=JSON.stringify({sections:[{heading:'E3 synthetic workflow evidence',body:'Synthetic role output; not professionally verified. '+prompt.slice(0,220)}],rows:[['source','value'],['synthetic',state.calls]],slides:[{title:'E3 synthetic evidence',bullets:['Unverified mock provider output','Human review required']}],trace:'synthetic-role-output-'+state.calls});
  res.write('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n');if(state.mode!=='unknown')res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:20,completion_tokens:30}})+'\n\n');res.end('data: [DONE]\n\n');});});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const env={LOCAL_MODEL_TARGETS:'127.0.0.1:'+provider.address().port};let app=await H.boot({env});
 t.after(async()=>{for(const res of state.held)res.end();await app.stop();provider.closeAllConnections();await new Promise(r=>provider.close(r));});
 const added=await app.call('POST','/api/models',{providerId:'ollama',modelId:'MOCK-r53',displayName:'R53 local MOCK only',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,pricingMode:'local',capabilities:['reasoning','writing','coding','research','data_analysis','vision']});assert.equal(added.status,200);
 const model=added.json.connection.connectionId;assert.equal((await app.call('POST',`/api/models/${model}/test`,{})).json.ok,true);
 return {state,model,get app(){return app;},async restart(){const dir=app.dir;await app.kill();app=await H.boot({dir,env});}};
}
async function finished(f,id){for(let i=0;i<250;i++){const r=await f.app.call('GET','/api/v2/universal/runs/'+id);if(!r.json.run.executionActive)return r.json.run;await H.sleep(20);}throw Error('Work did not settle');}
function approval(p,model,id){return {requestId:id,approved:true,maxTokens:500000,maxOutputTokens:128,maxCost:0,allowedTools:[],rolePermissions:Object.fromEntries(p.roles.map(r=>[r.roleId,{approved:true,connectionId:model,allowedTools:[],maxTokens:100000,maxCost:0}]))};}
async function download(f,url){const r=await fetch(`http://127.0.0.1:${f.app.port}${url}`,{headers:{cookie:f.app.cookie}});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());}

module.exports={boot,finished,approval,download};
