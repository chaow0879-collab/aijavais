#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const config=require('./config.json'),{disabled,inventory}=require('./policy');
function main(args){
 disabled(config);
 if(!args.includes('--fake-demo'))return {state:'DISABLED',actual_dispatch:false,would_launch:[],inventory:inventory(config)};
 const {demo}=require('./demo'),{Executor}=require('./engine'),{Store}=require('./store'),{FakeAdapter}=require('./adapters');
 const d=demo(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'aij-executor-demo-'));
 return {...new Executor(d.policy,new Store(dir)).run(d.request,d.approval,d.snapshot,new FakeAdapter('claude','cli',[{type:'result',tokens:5,elapsed:1}]),d.now),simulation_directory:dir,provenance:'EPHEMERAL_FAKE_APPROVAL_NOT_USER_AUTHORIZATION'};
}
if(require.main===module)try{console.log(JSON.stringify(main(process.argv.slice(2)),null,2));}catch{console.log(JSON.stringify({state:'BLOCKED',actual_dispatch:false,would_launch:[],reason:'UNSAFE_CONFIGURATION'}));process.exitCode=2;}
module.exports={main};
