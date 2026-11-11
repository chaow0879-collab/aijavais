'use strict';
// Reuse the R46 Git object protocol and Ledger format. This class adds no CAS,
// no App installation and no token acquisition/retry mechanism of its own.
const {GitHubState,REF}=require('../auto-handoff-r46/github-state'),{REPO}=require('../auto-handoff-r46/contract');
const APP_TRANSPORT_BUILD_ENABLED=false;
class ProtectedAppState extends GitHubState {
 constructor(context){
  // Crucially precedes even reading the supplied credential context/getters.
  if(!APP_TRANSPORT_BUILD_ENABLED)throw Error('LIVE_GITHUB_STATE_TRANSPORT_DISABLED');
  if(context?.repo!==REPO||context.ref!==REF||context.verified_installation!==true||context.protected_ff_ref!==true||!Number.isSafeInteger(context.expires_at)||context.expires_at<=Date.now()||typeof context.tokenProvider!=='function')throw Error('BLOCKED_APP_IDENTITY_OR_REF_PROTECTION');
  super(async(method,route,body)=>{
   if(Date.now()>=context.expires_at)throw Error('BLOCKED_APP_IDENTITY_EXPIRED');
   const credential=await context.tokenProvider();
   const response=await fetch('https://api.github.com/repos/'+REPO+route,{method,redirect:'error',headers:{authorization:'Bearer '+credential,accept:'application/vnd.github+json','content-type':'application/json','x-github-api-version':'2022-11-28'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
   let size=0,parts=[];for await(const chunk of response.body){size+=chunk.length;if(size>1048576)throw Error('REMOTE_RESPONSE_LIMIT');parts.push(Buffer.from(chunk));}
   return {status:response.status,data:JSON.parse(Buffer.concat(parts).toString('utf8'))};
  });
 }
}
// Explicit transport injection is solely the existing protocol's offline seam.
// Tests use a real localhost HTTP/SQLite Git-object API, never github.com writes.
module.exports={ProtectedAppState,FixtureGitHubState:GitHubState};
