'use strict';
// R48 files are preserved verbatim. Apply its test-only broker/mapping to the
// current R49 implementations, separately from its historical frozen matrix.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {setup}=require('./helpers.cjs'),B=require('../../first-handoff-r49/control'),I=require('../../agent-interop-r48/bridge'),P=require('../../agent-pilot-r45/contract'),A=require('../../agent-pilot-r45/policy'),N=require('../../auto-handoff-r46/pilot-contract');
for(const role of ['audit','qa'])test('R49 current '+role+' consumes unchanged R48 TestBroker and real Fake receipt mapping',async t=>{
 const f=setup(t,'success',{role,phase:role}),broker=new I.TestBroker({testOnly:true}),prepared=B.prepare(f.input());
 f.signed=I.toR45(prepared,{broker,canonical:P.canonical}).envelope;
 assert.equal(A.authorize(f.signed,A.loadPolicy()),'UNTRUSTED_KEY','shipped policy must not trust a test broker');
 f.policy=A.loadPolicy({allow_fake_cli:true,trusted_keys:broker.trustEntry(),allowed_issues:[32],pinned_gate_sha:f.candidate_sha});
 const r=await B.execute(f.input());assert.equal(r.state,'SUCCEEDED');assert.equal(r.actual_agent_launches,0);assert.equal(f.cli.launches(),1);
 const receipt=JSON.parse(fs.readFileSync(path.join(f.stateDir,'outcome-'+P.dedupeKey(f.signed)+'.json'),'utf8'));
 const mapped=I.toR46(receipt);assert.equal(mapped.status,'MAPPED');assert.equal(N.normalize(mapped.outcome,prepared,f.envelope,f.refs).exit_code,0);
 assert.throws(()=>I.toR46({...receipt,agent_launch:{real_agent_launch:true,actual_agent_launches:1}}),/REAL_OUTCOME/);
 assert.throws(()=>N.normalize({...receipt,agent_launch:{real_agent_launch:true,actual_agent_launches:1}},prepared,f.envelope,f.refs));
});
