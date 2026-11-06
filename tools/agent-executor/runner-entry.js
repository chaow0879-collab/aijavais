#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runLive,runStub}=require('./cli-runner');
async function main(args){
 if(args.includes('--stub')){const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'executor-cli-stub-'));try{return await runStub({mode:'success'},{cwd});}finally{fs.rmSync(cwd,{recursive:true,force:true});}}
 // No secrets are read, and no actual CLI starts in this revision.
 await runLive();
}
if(require.main===module)main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.log(JSON.stringify({state:'BLOCKED',reason:'LIVE_BUILD_DISABLED',actual_dispatch:false,actual_agent_launches:0}));process.exitCode=2;});
module.exports={main};
