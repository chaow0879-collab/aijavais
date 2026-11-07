'use strict';
// Separate process, synthetic signer seed/IdP only, no host credentials inherited.
const fs=require('node:fs'),path=require('node:path'),{Broker,TestSigner}=require('../../tools/trusted-trigger-r50/broker'),{TriggerStore}=require('../../tools/trusted-trigger-r50/store'),{FixtureGitHubState}=require('../../tools/first-pilot-r51/app-state');
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),kind=process.argv[3],base=input.base;
const store=new TriggerStore(input.store),signer=new TestSigner({testOnly:true,seed:Buffer.from(input.synthetic_seed,'hex')}),keys=Object.values(base.config.trusted_keys).flatMap(x=>Object.values(x));
const broker=new Broker({signer,policy:input.r50_policy,store,separatedKeys:keys});
base.stateDir=path.join(path.dirname(base.stateDir),'joint-runner-'+process.pid);
base.backend=new FixtureGitHubState(async(method,route,body)=>{const r=await fetch(input.cas+route,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(2000)});return {status:r.status,data:await r.json()};},2500);
require('../../tools/first-pilot-r51/r50-bridge').handleTrusted({mode:'fake',kind,base,broker,approval:input.approval,now:input.now,...(kind==='event'?{delivery:input.delivery,webhookSecret:input.synthetic_webhook_secret}:{oidcToken:input.synthetic_oidc,jwks:input.synthetic_jwks})}).then(r=>{console.log(JSON.stringify(r));store.close();}).catch(()=>{store.close();process.exitCode=1;});
