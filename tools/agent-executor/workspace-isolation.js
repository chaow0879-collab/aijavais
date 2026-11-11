'use strict';
// OS enforcement, not chmod/snapshot inference. No model or agent entrypoint.
const fs=require('node:fs'),path=require('node:path');
const {reject}=require('./policy'),plans=new WeakMap();
const STUB=path.join(__dirname,'stub-program.cjs');
function inspect(root){let count=0;function walk(file){if(++count>50000)reject('WORKSPACE_SCOPE_VIOLATION');const s=fs.lstatSync(file);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||(s.isFile()&&s.nlink!==1))reject('WORKSPACE_SCOPE_VIOLATION');if(s.isDirectory())for(const p of fs.readdirSync(file))walk(path.join(file,p));}walk(root);}
function paths(root,allowed,role){if(!Array.isArray(allowed)||allowed.length>100||!['qa','developer','audit'].includes(role))reject('INVALID_FILE_SCOPE');return allowed.map(p=>{
 if(typeof p!=='string'||!p||p.includes('\\')||p.includes('\0')||path.posix.normalize(p)!==p||p.startsWith('/')||p.split('/').some(x=>x==='..'||x==='.'||!x)||p==='.git'||p.startsWith('.git/')||(role==='qa'&&p!=='tests'&&!p.startsWith('tests/'))||role==='audit')reject('INVALID_FILE_SCOPE');
 const full=path.join(root,p);if(!fs.existsSync(full)||fs.realpathSync(full)!==full)reject('INVALID_FILE_SCOPE');return full;
 });}
function binary(){for(const p of ['/usr/bin/bwrap','/bin/bwrap'])try{if(fs.statSync(p).isFile()){fs.accessSync(p,fs.constants.X_OK);return p;}}catch{}return null;}
function argv(root,writable,executable,args,fdMap){
 const a=['--unshare-user','--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--disable-userns'];
 for(const p of ['/usr','/lib','/lib64'])if(fs.existsSync(p))a.push('--ro-bind',p,p);
 a.push('--symlink','usr/bin','/bin','--proc','/proc','--remount-ro','/proc','--dev','/dev','--remount-ro','/dev','--tmpfs','/tmp','--dir','/tmp/home','--dir','/tmp/private-tmp','--tmpfs','/tmp/home','--tmpfs','/tmp/private-tmp');
 const bind=(file,readonly)=>a.push(fdMap?(readonly?'--ro-bind-fd':'--bind-fd'):(readonly?'--ro-bind':'--bind'),fdMap?String(fdMap.get(file)):file,file);
 if(!executable.startsWith('/usr/')&&!executable.startsWith('/bin/'))bind(executable,true);
 bind(root,true);
 for(const p of writable)bind(p,false);
 // Only the repository-owned Stub is additionally readable. No host HOME,
 // credentials, control-plane state, workspace neighbours or inherited FDs.
 bind(STUB,true);a.push('--chdir',root,'--remount-ro','/tmp','--remount-ro','/','--',executable,...args);return a;
}
let cached;
function selfTestCommand(root){const b=binary();if(!b)return null;
 const code="const f=require('fs');f.writeFileSync('tests/allowed','ok');let denied=false;try{f.writeFileSync('protected','bad')}catch{denied=true}if(!denied)process.exit(3);denied=false;try{f.writeFileSync('../outside','bad')}catch{denied=true}if(!denied)process.exit(4);";
 return {executable:b,args:argv(root,[path.join(root,'tests')],process.execPath,['-e',code])};
}
function status(){if(!cached)cached=require('./cli-runner').probeWriteIsolation();return {...cached};}
function create(root,role,allowed){const s=status();if(!s.available)reject('BLOCKED_OS_WRITE_ISOLATION');root=fs.realpathSync(root);inspect(root);const writable=paths(root,allowed,role),out=Object.freeze({mechanism:s.mechanism,scope:'WORKSPACE_SCOPED_WRITES_AND_PRIVATE_HOME_TMP',live_enabled:false});plans.set(out,{root,writable,role});return out;}
function command(plan,executable,args){const p=plans.get(plan);if(!p)reject('BLOCKED_OS_WRITE_ISOLATION');inspect(p.root);if(!status().available)reject('BLOCKED_OS_WRITE_ISOLATION');
 const descriptors=[],map=new Map(),open=file=>{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),s=fs.fstatSync(fd);if((!s.isFile()&&!s.isDirectory())||(s.isFile()&&s.nlink!==1)){fs.closeSync(fd);reject('WORKSPACE_SCOPE_VIOLATION');}return fd;};
 try{const rootFd=open(p.root);descriptors.push(rootFd);map.set(p.root,3);
  for(const target of p.writable){let parent=rootFd;const intermediates=[];try{for(const part of path.relative(p.root,target).split(path.sep)){const fd=open('/proc/self/fd/'+parent+'/'+part);intermediates.push(fd);parent=fd;}const leaf=intermediates.pop();map.set(target,3+descriptors.length);descriptors.push(leaf);}finally{for(const fd of intermediates)fs.closeSync(fd);}}
  for(const file of [executable,STUB])if(!map.has(file)){map.set(file,3+descriptors.length);descriptors.push(open(file));}
  return {executable:binary(),args:argv(p.root,p.writable,executable,args,map),cwd:p.root,stdio:['pipe','pipe','pipe',...descriptors],close:()=>{for(const fd of descriptors)fs.closeSync(fd);},env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:'/tmp/home',TMPDIR:'/tmp/private-tmp',LANG:'C.UTF-8',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}};
 }catch(e){for(const fd of descriptors)fs.closeSync(fd);throw e;}
}
function restoreDirectories(root){
 // Linux O_PATH permits pinning mode-000 directories without following links.
 // Change the pinned directory via procfd, never a raced original pathname;
 // regular files (especially external hardlink aliases) are never chmodded.
 const fd=fs.openSync(root,0x200000|fs.constants.O_NOFOLLOW);try{if(!fs.fstatSync(fd).isDirectory())return;const pinned='/proc/self/fd/'+fd;fs.chmodSync(pinned,0o700);for(const n of fs.readdirSync(pinned))restoreDirectories(pinned+'/'+n);}finally{fs.closeSync(fd);}
}
module.exports={status,inspect,create,command,restoreDirectories,selfTestCommand};
