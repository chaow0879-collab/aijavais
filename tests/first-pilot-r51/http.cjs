'use strict';
const {spawn}=require('node:child_process'),{once}=require('node:events'),path=require('node:path'),{FixtureGitHubState}=require('../../tools/first-pilot-r51/app-state');
async function service(t,file){
 const c=spawn(process.execPath,[path.join(__dirname,'git-api-server.cjs'),file],{env:{PATH:process.env.PATH,LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});let raw='';
 const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('FIXTURE_START_TIMEOUT')),5000);c.stdout.on('data',b=>{raw+=b;if(raw.includes('\n')){clearTimeout(timer);try{resolve('http://127.0.0.1:'+JSON.parse(raw.split('\n')[0]).port);}catch(e){reject(e);}}});c.once('error',reject);c.once('exit',()=>{if(!raw){clearTimeout(timer);reject(Error('FIXTURE_START_FAILED'));}});});
 const stop=async()=>{if(c.exitCode===null&&c.signalCode===null){const done=once(c,'close');c.kill('SIGTERM');await done;}};t.after(stop);
 const backend=new FixtureGitHubState(async(method,route,body)=>{const r=await fetch(url+route,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(2000)});return {status:r.status,data:await r.json()};},2500);
 return {url,backend,child:c,stop,async fault(mode){await fetch(url+'/fixture/fault',{method:'POST',body:JSON.stringify({mode})});},async stats(){return (await fetch(url+'/fixture/stats')).json();}};
}
module.exports={service};
