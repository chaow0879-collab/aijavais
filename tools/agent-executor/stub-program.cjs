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
 process.stdout.write(JSON.stringify({type:'result',status:'FAKE_SUCCESS'})+'\n');
});
