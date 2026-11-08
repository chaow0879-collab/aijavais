'use strict';
// E3 fixture worker. Private test keys are loaded ONLY from the test's mode-0600
// synthetic fixture file, never from environment credentials or production stores.
const fs=require('node:fs'),crypto=require('node:crypto');
const {Broker,TestSigner}=require('../../tools/trusted-trigger-r50/broker');
const {TriggerStore}=require('../../tools/trusted-trigger-r50/store');
const {signReviews}=require('./helpers.cjs');
const {runOnce}=require('../../tools/unattended-go-r57/control');
(async()=>{const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(x.synthetic!==true)throw Error('NOT_A_TEST');
 const store=new TriggerStore(x.store),signer=new TestSigner({testOnly:true,seed:Buffer.from(x.seed,'hex')});
 const broker=new Broker({store,signer,policy:x.brokerPolicy,separatedKeys:x.separated});
 const base=x.base;
 base.backend={async read(){const r=await fetch(x.cas+'/state');return r.json();},async compareAndSwap(version,document){const r=await fetch(x.cas+'/cas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version,document})});return r.json();}};
 const f={authorization:base.authorization,now:x.packet.now,pairs:Object.fromEntries(Object.entries(x.privatePairs).map(([role,pem])=>[role,{privateKey:crypto.createPrivateKey(pem)}]))};
 try{const r=await runOnce({mode:'fake',packet:{...x.packet,base,broker},collectionPolicy:x.collectionPolicy,
  readGitHub:async(method,route)=>{const r=await fetch(x.github+route,{method});return {status:r.status,data:await r.json()};},readReviews:c=>signReviews(f,c)});
  console.log(JSON.stringify({pid:process.pid,state:r.state,reason:r.reason,actual_agent_launches:r.actual_agent_launches}));
 }finally{store.close();}
})().catch(()=>{console.log(JSON.stringify({state:'BLOCKED',reason:'TEST_WORKER_FAILURE'}));process.exitCode=1;});
