#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
function preflight(target,{aclProbe=p=>spawnSync('getfacl',['-cp','--',p],{encoding:'utf8',timeout:3000})}={}) {
 const checks=[],blockers=[];let p=path.resolve(target);
 if(process.platform!=='linux')blockers.push('OS_UNVERIFIED');
 for(;;){
  try {const s=fs.lstatSync(p);const row={path:p,mode:(s.mode&0o7777).toString(8),uid:s.uid};checks.push(row);
   if(!s.isDirectory()||s.isSymbolicLink())blockers.push('NON_DIRECTORY_OR_SYMLINK');
   if((s.mode&0o022)!==0)blockers.push('UNTRUSTED_WRITERS');
   if(typeof process.getuid!=='function'||![0,process.getuid()].includes(s.uid))blockers.push('FOREIGN_OWNER');
   const acl=s.isDirectory()&&!s.isSymbolicLink()?aclProbe(p):{status:1};if(acl.status!==0)blockers.push('ACL_UNKNOWN');
   else if(/^(default:|user:[^:]|group:[^:]|mask:)/m.test(acl.stdout))blockers.push('EXTENDED_ACL_REQUIRES_REVIEW');
  }catch{blockers.push('PATH_UNREADABLE');}
  const parent=path.dirname(p);if(parent===p)break;p=parent;
 }
 return {readOnly:true,status:blockers.length?'BLOCKED':'READY_FOR_HUMAN_REVIEW',checks,blockers:[...new Set(blockers)],productionVerified:false};
}
function diagnose(stats){if(!stats||!Number.isInteger(stats.activeSlots)||stats.maxSlots!==3) return {status:'UNKNOWN',readOnly:true};return {readOnly:true,status:stats.activeSlots>=3?'CAPACITY_BLOCKED':'OBSERVED',activeSlots:stats.activeSlots,providerMayStillBill:stats.outstanding>0||stats.activeSlots>0,action:'人工核对；不释放在途槽位，不重发；按SOP授权安全重启'};}
module.exports={preflight,diagnose};
if(require.main===module){const r=preflight(process.argv[2]||'.');console.log(JSON.stringify(r,null,2));process.exitCode=r.status==='BLOCKED'?2:0;}
