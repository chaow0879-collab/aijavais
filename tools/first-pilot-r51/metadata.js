'use strict';
// Explicit public metadata probe only. Fresh HOME and a credential-free env;
// never executes -p/print/exec, never attempts official authentication.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const VERSION='2.1.318';
const FLAGS=['--print','--output-format','--max-budget-usd','--permission-mode','--allowedTools','--disallowedTools','--no-session-persistence','--strict-mcp-config','--bare'];
function inspect(executable){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'r51-public-cli-'));
 const env={PATH:process.env.PATH||'',HOME:home,TMPDIR:home,LANG:'C.UTF-8',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
 try{
  const probe=args=>spawnSync(executable,args,{env,encoding:'utf8',timeout:15000,maxBuffer:1048576});
  const v=probe(['--version']),h=probe(['--help']),version=String(v.stdout||'').trim();
  const help=String(h.stdout||''),missing=FLAGS.filter(x=>!help.includes(x)),lines=help.split('\n'),budgetLine=lines.findIndex(x=>x.includes('--max-budget-usd'));
  const ok=v.status===0&&h.status===0&&version===VERSION+' (Claude Code)'&&missing.length===0;
  return {state:ok?'METADATA_VERIFIED':'BLOCKED',reason:ok?null:'CLI_VERSION_OR_FLAGS_CHANGED',expected_version:VERSION,observed_version:/^[0-9.]+ \(Claude Code\)$/.test(version)?version:'UNVERIFIED',missing_flags:missing,budget_flag_description:budgetLine<0?null:lines.slice(budgetLine,budgetLine+2).map(x=>x.trim()).join(' '),help_sha256:crypto.createHash('sha256').update(help).digest('hex'),probe_status:{version_exit:v.status,help_exit:h.status,version_error:v.error?.code||null,help_error:h.error?.code||null},official_auth:'NOT_RUN',provider_hard_cap:'NOT_VERIFIED',model_calls:0};
 }finally{fs.rmSync(home,{recursive:true,force:true});}
}
if(require.main===module){if(process.argv.length!==3){console.error('EXPLICIT_PUBLIC_CLI_PATH_REQUIRED');process.exitCode=2;}else{const r=inspect(process.argv[2]);console.log(JSON.stringify(r,null,2));if(r.state!=='METADATA_VERIFIED')process.exitCode=1;}}
module.exports={inspect,VERSION,FLAGS};
