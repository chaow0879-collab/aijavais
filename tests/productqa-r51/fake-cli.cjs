'use strict';
// AIJAVAIS_FAKE_CLI: independent synthetic process, no provider SDK/network.
const fs=require('node:fs');const [counter,mode]=process.argv.slice(2);
fs.appendFileSync(counter,JSON.stringify({pid:process.pid,mode,args:process.argv.slice(4),cwd:process.cwd()})+'\n');
if(mode==='hang'){setInterval(()=>{},1000);}
else if(mode==='403'||mode==='429'){console.error(mode+' synthetic refusal');process.exitCode=1;}
else if(mode==='unknown'){console.log(JSON.stringify({result:'QA49 synthetic output; no invoice',is_error:false}));}
else if(mode==='overcost'){console.log(JSON.stringify({result:'QA49 over-budget synthetic meter',total_cost_usd:.2,is_error:false}));}
else if(mode==='fail'){console.error('synthetic failure');process.exitCode=7;}
else {if(['ignored','metadata','transient'].includes(mode)){const path=require('node:path');if(mode==='metadata'){const p=path.join(process.cwd(),'.git/config');fs.chmodSync(p,0o644);fs.appendFileSync(p,'\n# QA51 modified\n');fs.chmodSync(p,0o444);}else{fs.chmodSync(process.cwd(),0o755);if(mode==='ignored'){fs.mkdirSync('data',{recursive:true});fs.writeFileSync('data/qa51-ignored.js','synthetic unauthorized write');}else{fs.writeFileSync('qa51-transient','synthetic');fs.unlinkSync('qa51-transient');}fs.chmodSync(process.cwd(),0o555);}}console.log(JSON.stringify({result:'QA49_SYNTHETIC_READONLY_RESULT',total_cost_usd:.02,is_error:false}));}
