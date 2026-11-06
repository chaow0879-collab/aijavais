'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),path=require('node:path');
const {requireParsed}=require('../../tools/p2/office-gate');
test('release Office gate rejects missing and failed parsing; ordinary evidence remains incomplete',()=>{
 for(const status of ['NOT_RUN','FAILED']) assert.throws(()=>requireParsed({status},true),/BLOCKED/);
 assert.equal(requireParsed({status:'NOT_RUN'},false).complete,false);
 assert.equal(requireParsed({status:'PARSED'},true).complete,true);
});
for(const [mutation,file] of Object.entries({approval:'intake-draft.test.js',permission:'projects-v2.test.js',duplicate:'intake-draft-idempotency.test.js',recovery:'model-request-recovery.test.js',capacity:'intake-draft-cancel-lifecycle.test.js'})) test('semantic guard kills '+mutation+' regression',()=>{
 const env={...process.env,P2_MUTANT:mutation};delete env.NODE_TEST_CONTEXT;
 const r=spawnSync(process.execPath,['--require',path.join(__dirname,'mutant.cjs'),'--test','--test-reporter=tap',path.join(__dirname,'..',file)],{env,encoding:'utf8',timeout:45000});
 assert.equal(r.error,undefined);assert.notEqual(r.status,0,'dangerous mutation survived');
 assert.match(r.stdout, /not ok/);assert.doesNotMatch(r.stderr,/Mutation anchor missing|SyntaxError/);
});
test('release industry process fails with real missing Python dependency probe',t=>{
 const fs=require('node:fs'),os=require('node:os');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p2-no-python-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'python3'),'#!/bin/sh\nexit 127\n',{mode:0o700});
 const env={...process.env,PATH:dir,AIJ_RELEASE_VALIDATION:'1'};delete env.NODE_TEST_CONTEXT;
 const r=spawnSync(process.execPath,['--test','--test-reporter=tap',path.join(__dirname,'..','industry-mock-e2e.test.js')],{env,encoding:'utf8',timeout:45000});
 assert.equal(r.error,undefined);assert.notEqual(r.status,0);assert.match(r.stdout,/BLOCKED: independent Office parsing required/);assert.doesNotMatch(r.stdout,/INDUSTRY E2E PASS/);
});
