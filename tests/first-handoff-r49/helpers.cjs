'use strict';
// Synthetic keys and reviews are confined to this test fixture. They cannot
// authorize live code; never export private keys into reports or child env.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const H=require('../agent-pilot-r45/helpers.cjs'),F=require('../auto-handoff-r46/fixtures.cjs');
const C=require('../../tools/auto-handoff-r46/contract'),P=require('../../tools/agent-pilot-r45/contract'),B=require('../../tools/first-handoff-r49/control');
function setup(t,mode='success',options={}) {
 const f=F.fixture({kind:'claude',...options}),dir=H.tmp(t,'r49-fixture-');
 f.candidate_sha=H.HEAD;f.config.source_sha=H.HEAD;f.config.max_cost=.1;f.config.max_daily_cost=.5;
 f.config.allowed_issues=[32];f.config.allowed_branches=['integrate/codex-r49-first-real-handoff'];f.config.trusted_event_branches=[...f.config.allowed_branches];f.envelope.issue=32;f.envelope.branch=f.config.allowed_branches[0];
 f.envelope.source_sha=H.HEAD;f.envelope.limits.max_cost=.1;f.envelope.limits.runtime_ms=options.runtime||3000;
 Object.assign(f.snapshot,JSON.parse(JSON.stringify(f.snapshot).replaceAll(C.SOURCE,H.HEAD)));
 f.snapshot.refs[f.envelope.branch]=H.HEAD;
 f.sourceRepo=H.ROOT;f.stateDir=path.join(dir,'pilot');
 f.refs={log_ref:'https://github.com/'+C.REPO+'/actions/runs/1',ci_ref:'https://github.com/'+C.REPO+'/actions/runs/1',report_ref:'https://github.com/'+C.REPO+'/issues/32#issuecomment-1'};
 f.cli=H.fakeCli(dir,mode);f.fakeExecutable=f.cli.file;
 const keys=crypto.generateKeyPairSync('ed25519');
 f.policy=H.policy({allowed_issues:[32],pinned_gate_sha:H.HEAD,trusted_keys:{'r49-fixture':{pem:keys.publicKey.export({type:'spki',format:'pem'}),roles:['dispatcher']}}});
 f.input=(extra={})=>({simulate:true,...f,trigger:require('../../tools/auto-handoff-r46/triggers').tick(f.now,f.config),...extra});
 f.signPilot=()=>{f.sign();const prepared=B.prepare(f.input());f.signed={...prepared.unsigned_envelope,signature:{alg:'ed25519',key_id:'r49-fixture',value:crypto.sign(null,Buffer.from(P.canonical(prepared.unsigned_envelope)),keys.privateKey).toString('base64')}};return f;};
 return f.signPilot();
}
module.exports={setup};
