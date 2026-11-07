'use strict';
const fs=require('node:fs'),path=require('node:path'),F=require('./flow-fixture.cjs');
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));input.stateDir=path.join(path.dirname(input.stateDir),'worker-journal-'+process.pid);input.backend=F.backend(process.argv[3],process.argv[4]==='kill-marker');input.trigger=require('../../tools/auto-handoff-r46/triggers').tick(input.now,input.config);
require('../../tools/first-handoff-r49/control').execute(input).then(report=>console.log(JSON.stringify({pid:process.pid,report}))).catch(e=>{console.error(e.message);process.exitCode=1;});
