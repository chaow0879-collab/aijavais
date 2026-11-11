'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');
const {REPO,reject}=require('./policy');
function find(name,env=process.env){
 if(!['codex','claude'].includes(name))reject('UNKNOWN_CLIENT');
 for(const dir of (env.PATH||'').split(path.delimiter).filter(Boolean))try{const p=path.resolve(dir,name),s=fs.statSync(p);if(s.isFile()){fs.accessSync(p,fs.constants.X_OK);return p;}}catch{}
 return null;
}
function parseVersion(text){return String(text).match(/\b\d+\.\d+(?:\.\d+)?\b/)?.[0]||null;}
async function probe(kind){
 const executable=find(kind);const base={kind,installed:!!executable,version:null,authenticated:'NOT_VERIFIED',model_request_sent:false,raw_output_persisted:false};
 if(!executable)return {...base,status:'CLIENT_NOT_INSTALLED'};
 // Fixed public metadata command only. No login/status/config/exec task.
 return new Promise(resolve=>execFile(executable,['--version'],{timeout:8000,maxBuffer:16384,encoding:'utf8',env:{PATH:process.env.PATH||'',LANG:'C.UTF-8'}},(err,out,stderr)=>{
  const version=parseVersion(out);resolve({...base,version,status:err?'VERSION_PROBE_FAILED':version?'VERSION_ONLY_VERIFIED':'VERSION_UNRECOGNIZED',exit_code:err?typeof err.code==='number'?err.code:null:0});
 }));
}
function contextHealth(env=process.env){
 return {repository:env.GITHUB_REPOSITORY===REPO?'EXPECTED':env.GITHUB_REPOSITORY?'OTHER':'LOCAL',hosted_runner:env.GITHUB_ACTIONS==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted',untrusted_event:['pull_request','pull_request_target'].includes(env.GITHUB_EVENT_NAME),secrets_checked:false,production_actions:false};
}
function readiness({clients={},fixedGateSha,v1AuditAccepted=false,v2AuditAccepted=false,identityVerified=false,nativeLimitsVerified=false,operatorWindowApproved=false}={}){
 const blockers=[];
 if(!/^[a-f0-9]{40}$/.test(fixedGateSha||'')||fixedGateSha==='6363e8d10595a566a1ba266cb70017711cc806be'||!v1AuditAccepted)blockers.push('WAIT_AUDITED_GATE');
 if(!v2AuditAccepted)blockers.push('WAIT_V2_AUDIT');
 if(!identityVerified)blockers.push('BLOCKED_CREDENTIALS');
 if(!nativeLimitsVerified)blockers.push('BLOCKED_NATIVE_LIMITS');
 if(!operatorWindowApproved)blockers.push('WAIT_OPERATOR_WINDOW');
 const perClient=Object.fromEntries(['codex','claude'].map(kind=>[kind,{version:clients[kind]?.version||null,status:clients[kind]?.status||'NOT_PROBED',authenticated:'NOT_VERIFIED',blockers:[...(clients[kind]?.status==='VERSION_ONLY_VERIFIED'?[]:['CLIENT_VERSION_UNVERIFIED']),...blockers]}]));
 return {state:blockers.length||Object.values(perClient).some(c=>c.blockers.length)?'BLOCKED':'PLANNED_FOR_VERIFIED_ENTRY',blockers,clients:perClient,actual_dispatch:false,credential_values_read:false};
}
module.exports={find,parseVersion,probe,contextHealth,readiness};
