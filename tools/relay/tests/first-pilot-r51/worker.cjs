'use strict';
const fs=require('node:fs'),path=require('node:path'),{FixtureGitHubState}=require('../../first-pilot-r51/app-state');
const url=process.argv[2],input=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
input.stateDir=path.join(path.dirname(input.stateDir),'r51-worker-'+process.pid);
input.backend=new FixtureGitHubState(async(method,route,body)=>{const r=await fetch(url+route,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(2000)});return {status:r.status,data:await r.json()};},2500);
if(process.argv[4]==='kill-after-marker'){const read=input.backend.read.bind(input.backend);input.backend.read=async()=>{const d=await read();if(Object.values(d.document.jobs).some(j=>j.state==='DISPATCHING'))process.kill(process.pid,'SIGKILL');return d;};}
input.trigger=require('../../auto-handoff-r46/triggers').tick(input.now,input.config);
require('../../first-pilot-r51/entry').runPilot(input).then(r=>console.log(JSON.stringify(r))).catch(()=>{process.exitCode=1;});
