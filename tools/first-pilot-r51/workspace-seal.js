'use strict';
// Full filesystem evidence independent of Git ignore/index configuration.
// POSIX permissions are defence in depth, NOT a same-UID/OS sandbox claim.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function scan(root){
 const out=new Map();let count=0,bytes=0;
 function visit(relative){
  if(++count>50000)throw Error('WORKSPACE_SCAN_LIMIT');const file=path.join(root,relative),s=fs.lstatSync(file,{bigint:true}),mode=Number(s.mode&0o777n),ctime=s.ctimeNs.toString();
  if(s.isSymbolicLink()){out.set(relative,{type:'link',mode,target:fs.readlinkSync(file),ctime});return;}
  if(s.isDirectory()){out.set(relative,{type:'dir',mode,ctime});for(const name of fs.readdirSync(file).sort())visit(relative?relative+'/'+name:name);return;}
  if(!s.isFile()||(bytes+=Number(s.size))>256*1024*1024)throw Error('WORKSPACE_SCAN_LIMIT');
  const content=fs.readFileSync(file),after=fs.lstatSync(file,{bigint:true});if(after.ctimeNs!==s.ctimeNs||after.size!==s.size||content.length!==Number(s.size))throw Error('WORKSPACE_CHANGED_DURING_SCAN');
  out.set(relative,{type:'file',mode,size:Number(s.size),hash:crypto.createHash('sha256').update(content).digest('hex'),ctime});
 }
 visit('');return out;
}
function changes(before,after,{directoryTimes=true}={}){
 const changed=[];for(const p of new Set([...before.keys(),...after.keys()])){let a=before.get(p),b=after.get(p);if(!directoryTimes&&a?.type==='dir'&&b?.type==='dir'){a={...a,ctime:null};b={...b,ctime:null};}if(JSON.stringify(a)!==JSON.stringify(b))changed.push(p);}return changed;
}
function readonly(root){
 function visit(file){const s=fs.lstatSync(file);if(s.isSymbolicLink())return;if(s.isDirectory()){for(const n of fs.readdirSync(file))visit(path.join(file,n));fs.chmodSync(file,0o555);}else if(s.isFile())fs.chmodSync(file,(s.mode&0o111)?0o555:0o444);else throw Error('WORKSPACE_SPECIAL_FILE');}
 visit(root);
}
function restore(root){
 if(!fs.existsSync(root))return;
 function visit(file){const s=fs.lstatSync(file);if(s.isSymbolicLink())return;if(s.isDirectory()){fs.chmodSync(file,0o700);for(const n of fs.readdirSync(file))visit(path.join(file,n));}else if(s.isFile())fs.chmodSync(file,0o600);}
 visit(root);
}
// A developer/QA commit may update only these Git internals; HEAD/config,
// hooks, excludes and other refs remain security-sensitive evidence.
function mutableGit(p,branch){return p==='.git/index'||p==='.git/COMMIT_EDITMSG'||p==='.git/logs/HEAD'||p==='.git/refs/heads/'+branch||p==='.git/logs/refs/heads/'+branch||p.startsWith('.git/objects/');}
module.exports={scan,changes,readonly,restore,mutableGit};
