#!/usr/bin/env node
'use strict';
const O=require('./official-port');
function main(args=[]){if(args.length)throw Error('LIVE_BUILD_DISABLED');return O.blocked();}
if(require.main===module)try{console.log(JSON.stringify(main(process.argv.slice(2)),null,2));}catch{console.log(JSON.stringify(O.blocked()));process.exitCode=2;}
module.exports={main};
