'use strict';
// Explicit subprocess fixture. Never imports an Agent SDK or invokes a CLI.
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{text+=s;if(text.length>100000)process.exit(2);});
process.stdin.on('end',()=>{
 let s;try{s=JSON.parse(text);}catch{process.exit(2);}
 if(s.mode==='hang'){setInterval(()=>{},1000);return;}
 if(s.mode==='output-limit'){process.stdout.write('x'.repeat(100000));return;}
 if(s.mode==='secret'){process.stdout.write('Bearer '+s.secret+'\n');process.stderr.write(s.secret);return;}
 if(s.mode==='usage'){process.stdout.write(JSON.stringify({type:'usage',tokens:s.tokens,spend:s.spend})+'\n');return;}
 if(s.mode==='fail'){process.stderr.write('FAKE_FAILURE');process.exitCode=3;return;}
 if(s.mode==='filesystem-probe'){
  const fs=require('node:fs');if(!Array.isArray(s.operations)||s.operations.length>50){process.exitCode=2;return;}
  try{for(const o of s.operations){if(!o||typeof o.path!=='string'||o.path.length>4000)throw Error('BAD_PROBE');switch(o.op){case 'write':fs.writeFileSync(o.path,String(o.text||'fixture'));break;case 'unlink':fs.unlinkSync(o.path);break;case 'symlink':fs.symlinkSync(o.target,o.path);break;case 'hardlink':fs.linkSync(o.target,o.path);break;case 'rename':fs.renameSync(o.path,o.target);break;case 'read':fs.readFileSync(o.path);break;default:throw Error('BAD_PROBE');}}}catch(e){process.stdout.write(JSON.stringify({mode:'FIXED_STUB',blocked:true,code:e.code||'INVALID_PROBE'}));process.exitCode=13;return;}
 }
 process.stdout.write(JSON.stringify({type:'result',status:'FAKE_SUCCESS'})+'\n');
});
