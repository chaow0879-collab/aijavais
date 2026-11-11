'use strict';
// CI diagnostics only, not an Agent runner: fixed existing test commands, same
// exit status. Structured annotations remain readable through GitHub's API when
// signed log/artifact download hosts are unavailable in the developer network.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),mode=process.argv[2];
const args=mode==='r57'?['--test','--test-reporter=tap',...fs.readdirSync(path.join(root,'tests/unattended-go-r57')).filter(n=>n.endsWith('.test.js')).sort().map(n=>'tests/unattended-go-r57/'+n)]:
 mode==='r55'?['--test','--test-reporter=tap',...fs.readdirSync(path.join(root,'tests/security-r55')).filter(n=>n.endsWith('.test.js')).sort().map(n=>'tests/security-r55/'+n)]:
 mode==='r48'?['tools/first-handoff-r49/run-r48.js']:null;
if(!args||process.argv.length!==3)throw Error('Usage: ci-tests.cjs r57|r55|r48');
const r=spawnSync(process.execPath,args,{cwd:root,env:process.env,encoding:'utf8',timeout:650000,maxBuffer:16*1024*1024});
const raw=(r.stdout||'')+(r.stderr||'');process.stdout.write(raw);
const counts={};for(const k of ['tests','pass','fail','skipped']){const m=[...raw.matchAll(new RegExp('^(?:#|ℹ) '+k+' (\\d+)','gm'))].at(-1);counts[k]=m?Number(m[1]):null;}
const escape=s=>s.replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
const summary={group:mode,exit:r.status,error:r.error?.code||null,counts};
if(mode==='r55')summary.os_isolation=require('../agent-executor/workspace').isolationStatus();
console.log('::notice title=R57 CI test counts::'+escape(JSON.stringify(summary)));
if(r.status!==0||r.error){
 const lines=raw.split('\n');const failures=[];
 for(let i=0;i<lines.length;i++)if(/^\s*not ok \d+|^✖ |^R48_HISTORICAL|^BLOCKED_SOURCE/.test(lines[i]))failures.push(lines.slice(i,i+18).join('\n'));
 const text=(failures.join('\n').slice(0,10000)||raw.slice(-5000)).replace(/Bearer\s+[^\s]+|\bsk-[A-Za-z0-9_-]+|\bgh[pousr]_[A-Za-z0-9]+/g,'[REDACTED]');
 console.log('::error title=R57 '+mode+' actual test failure::'+escape(text));
}
if(process.env.R57_EVIDENCE_DIR){fs.mkdirSync(process.env.R57_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.R57_EVIDENCE_DIR,mode+'-ci-tests.json'),JSON.stringify(summary,null,2));fs.writeFileSync(path.join(process.env.R57_EVIDENCE_DIR,mode+'-ci-tests.log'),raw);}
process.exitCode=r.status===0&&!r.error?0:1;
