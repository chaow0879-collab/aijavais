'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{once}=require('node:events');
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'r46-fixture-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
async function service(t,file){
 const child=spawn(process.execPath,[path.join(__dirname,'cas-server.cjs'),file],{env:{PATH:process.env.PATH||'',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});let raw='';
 const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture startup timeout')),5000);child.stdout.on('data',b=>{raw+=b;if(raw.includes('\n')){clearTimeout(timer);try{resolve('http://127.0.0.1:'+JSON.parse(raw.split('\n')[0]).port);}catch(e){reject(e);}}});child.once('error',reject);child.once('exit',code=>{if(!raw){clearTimeout(timer);reject(Error('fixture exited '+code));}});});
 const stop=async()=>{if(child.exitCode===null&&child.signalCode===null){const p=once(child,'exit');child.kill('SIGTERM');await p;}};t.after(stop);
 const backend={async read(){const r=await fetch(url+'/state',{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('read fixture');return r.json();},async compareAndSwap(version,document){const r=await fetch(url+'/cas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version,document}),signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('cas fixture');return r.json();}};
 return {child,url,backend,stop,async fault(mode){await fetch(url+'/fault',{method:'POST',body:JSON.stringify({mode})});}};
}
async function worker(url,file,cwd,mode){
 const c=spawn(process.execPath,[path.join(__dirname,'worker.cjs'),url,file,mode||'normal'],{cwd,env:{PATH:process.env.PATH||'',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>out+=b);const [code,signal]=await once(c,'close');return {code,signal,report:out?JSON.parse(out):null};
}
module.exports={temp,service,worker};
