'use strict';
// AIJAVAIS_FAKE_CLI: independent synthetic process, no provider SDK/network.
const fs=require('node:fs');const [counter,mode]=process.argv.slice(2);
fs.appendFileSync(counter,JSON.stringify({pid:process.pid,mode,args:process.argv.slice(4),cwd:process.cwd()})+'\n');
if(mode==='hang'){setInterval(()=>{},1000);}
else if(mode==='403'||mode==='429'){console.error(mode+' synthetic refusal');process.exitCode=1;}
else if(mode==='unknown'){console.log(JSON.stringify({result:'QA49 synthetic output; no invoice',is_error:false}));}
else if(mode==='overcost'){console.log(JSON.stringify({result:'QA49 over-budget synthetic meter',total_cost_usd:.2,is_error:false}));}
else if(mode==='fail'){console.error('synthetic failure');process.exitCode=7;}
else console.log(JSON.stringify({result:'QA49_SYNTHETIC_READONLY_RESULT',total_cost_usd:.02,is_error:false}));
