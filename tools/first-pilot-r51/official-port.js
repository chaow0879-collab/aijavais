'use strict';
const {command}=require('../agent-pilot-r45/runner'),{costFeasibility}=require('./admission');
const LIVE_BUILD_ENABLED=false;
function plan(){return {cli:'claude',mode:'noninteractive_readonly',args:command('claude','<approved-readonly-repo-summary>',.1),native_token_hard_cap:'NOT_VERIFIED',provider_cost_hard_cap:'NOT_VERIFIED',model_calls:0};}
function blocked(){return {state:'BLOCKED',reason:'LIVE_BUILD_DISABLED',blockers:['LIVE_BUILD_DISABLED',costFeasibility().reason,'BLOCKED_OFFICIAL_CREDENTIAL','BLOCKED_FINAL_INDEPENDENT_GATES','BLOCKED_TRUSTED_IDENTITY_AND_SIGNATURE','BLOCKED_PROTECTED_REMOTE_CAS','BLOCKED_OWNER_GO'],actual_agent_launches:0,model_spend:null,E4:'NOT_RUN',E5:'NOT_RUN',real_state_ref_write:'NOT_RUN',real_schedule:'NOT_ENABLED'};}
async function runOfficialOneShot(input){
 // No credential getter, process environment, preflight or remote write may be
 // reached while this compiled guard is closed. Env/config cannot change it.
 if(!LIVE_BUILD_ENABLED)return blocked();
 // A future audited source revision must install a verifiable provider-side
 // allowance and identity adapter. Merely opening the build guard is not GO.
 const cap=costFeasibility(input?.provider_allowance);
 if(cap.state!=='VERIFIED')return {...blocked(),reason:cap.reason};
 // Reuse the existing official port; no alternate process supervision loop.
 return require('../agent-pilot-r45/runner').runOnce(input.signed,input.verifiedR45Options);
}
module.exports={plan,blocked,runOfficialOneShot};
