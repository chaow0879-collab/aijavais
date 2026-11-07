'use strict';
// Reexecute the five explicitly requested existing browser groups. These are
// developer-authored regressions, distinct from our independent acceptance.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const H=require('./harness.cjs');
const results=[];
for(const name of ['admin','workspace','intake-draft','industry','claude-delivery']){
 const dir=path.join(H.OUT,name);fs.mkdirSync(dir,{recursive:true});
 const env={};for(const key of ['PATH','HOME','LANG','NODE_PATH','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS'])if(process.env[key])env[key]=process.env[key];
 Object.assign(env,{UI_SHOTS:dir,PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium',AIJ_RELEASE_VALIDATION:'1'});
 const started=Date.now(),r=spawnSync(process.execPath,['tests/ui/'+name+'.e2e.js'],{cwd:H.ROOT,env,encoding:'utf8',timeout:300000,maxBuffer:10<<20});
 H.write(name+'/runner.log',(r.stdout||'')+'\n'+(r.stderr||''));
 const result={name,source:'existing developer-authored script, independently reexecuted; not independent test authorship',status:r.status===0?'PASS':'FAIL',exitCode:r.status,signal:r.signal,elapsedMs:Date.now()-started};results.push(result);console.log(JSON.stringify(result));
}
H.write('browser-groups.json',{businessSha:H.BUSINESS_SHA,results});H.manifest();if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
