#!/usr/bin/env node
'use strict';
const {readiness}=require('./control');
function main(args=[]) {
  if(args.length) throw Error('R49_REAL_EXECUTION_DISABLED');
  return readiness();
}
if(require.main===module)try{console.log(JSON.stringify(main(process.argv.slice(2)),null,2));}catch{console.log(JSON.stringify({state:'BLOCKED',reason:'R49_REAL_EXECUTION_DISABLED',actual_agent_launches:0}));process.exitCode=2;}
module.exports={main};
