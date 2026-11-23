import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const now = () => Date.now();
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
const hashPassword = (password, salt=crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(password,salt,64).toString('hex')}`;
const checkPassword = (password, stored) => {
  try {const [salt, hex]=stored.split(':'); const a=crypto.scryptSync(password,salt,64); const b=Buffer.from(hex,'hex');return b.length===a.length && crypto.timingSafeEqual(a,b);} catch{return false;}
};
const allowedExt = /\.(zip|rar|7z|tar|gz|tgz|xz|bz2|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|csv|json|yaml|yml|png|jpg|jpeg|webp|gif|svg|mp3|wav|mp4|mov|psd|ai|eps|fig|sketch)$/i;
const MIME={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8'};
function respond(res,code,data,headers={}) {
  const isJson=typeof data!=='string' && !Buffer.isBuffer(data);
  const payload=isJson?JSON.stringify(data):data;
  res.writeHead(code,{'Content-Type':isJson?'application/json; charset=utf-8':'text/plain; charset=utf-8','Cache-Control':'no-store',...headers});res.end(payload);
}
async function readJson(req,max=32768) {
  let total=0, chunks=[];
  for await(const chunk of req){total+=chunk.length; if(total>max)throw Object.assign(new Error('Request too large'),{httpStatus:413});chunks.push(chunk)}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))} catch{throw Object.assign(new Error('Invalid JSON'),{httpStatus:400})}
}
export function createServer(options={}) {
  const dataDir=path.resolve(options.dataDir||process.env.REPO_DATA_DIR||path.join(ROOT,'private-data'));
  const password=options.password??process.env.REPO_ADMIN_PASSWORD;
  const adminUser=options.adminUser||process.env.REPO_ADMIN_USER||'admin';
  const baseUrl=(options.baseUrl||process.env.REPO_BASE_URL||'https://repo.ailp.fun').replace(/\/$/,'');
  const maxUpload=Number(options.maxUpload||process.env.REPO_MAX_BYTES||1073741824);
  const cookieSecure=options.cookieSecure??(process.env.REPO_COOKIE_SECURE!=='false');
  if(!password || password.length<12)throw new Error('REPO_ADMIN_PASSWORD must contain at least 12 characters');
  if(!Number.isSafeInteger(maxUpload)||maxUpload<1024)throw new Error('Invalid max file size');
  if(!/^https?:\/\//.test(baseUrl))throw new Error('Invalid REPO_BASE_URL');
  fs.mkdirSync(path.join(dataDir,'files'),{recursive:true,mode:0o700});
  fs.mkdirSync(path.join(dataDir,'tmp'),{recursive:true,mode:0o700});
  const dbFile=path.join(dataDir,'metadata.json');
  let db=fs.existsSync(dbFile)?JSON.parse(fs.readFileSync(dbFile,'utf8')):{files:[],shares:[],version:1};
  if(!Array.isArray(db.files)||!Array.isArray(db.shares))throw new Error('Corrupt metadata; refusing to overwrite');
  // Upgrade the v1 file distributor without discarding existing bytes or share links.
  // Every uploaded blob becomes an immutable revision in a logical document.
  db.projects ||= [{id:'general',name:'通用资料库',description:'团队默认空间',createdAt:now(),createdBy:'owner'}];
  db.documents ||= [];
  db.users ||= [];
  db.audit ||= [];
  for(const f of db.files){
    if(!f.documentId){
      const docId=crypto.randomUUID();
      f.documentId=docId;f.version=1;f.state='current';f.uploadedBy='owner';f.projectId='general';f.archivedAt=null;
      db.documents.push({id:docId,name:f.name,projectId:'general',currentFileId:f.id,createdAt:f.uploadedAt,updatedAt:f.uploadedAt,createdBy:'owner',nextVersion:2,archivedAt:null});
    }
  }
  db.version=2;
  const adminHash=hashPassword(password);
  const sessions=new Map(),grants=new Map(),rate=new Map();
  function persist() {
    const tmp=path.join(dataDir,`.metadata-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp,JSON.stringify(db),{mode:0o600,flag:'wx'});
    fs.renameSync(tmp,dbFile);
  }
  function audit(actor,action,detail={}){
    db.audit.push({id:crypto.randomUUID(),at:now(),actor,action,detail});
    if(db.audit.length>3000)db.audit=db.audit.slice(-3000);
  }
  function publicUser(u){return {id:u.id,username:u.username,role:u.role,createdAt:u.createdAt};}
  const userName=userId=>userId==='owner'?adminUser:(db.users.find(x=>x.id===userId)?.username||'未知成员');
  const publicFile=f=>f?{...f,uploadedByName:userName(f.uploadedBy)}:null;
  function currentUser(session){
    if(!session)return null;
    if(session.userId==='owner')return {id:'owner',username:adminUser,role:'admin'};
    const u=db.users.find(x=>x.id===session.userId&&!x.disabled);
    return u?publicUser(u):null;
  }
  const canWrite=u=>u&&(u.role==='admin'||u.role==='editor');
  function requireUser(req,csrf=false,editor=false,admin=false){
    const session=getSession(req);const user=currentUser(session);
    if(!session||session.expires<=now()||!user)return {error:401};
    if(admin && user.role!=='admin')return {error:403};
    if(editor&&!canWrite(user))return {error:403};
    if(csrf && req.headers['x-csrf-token']!==session.csrf)return {error:403};
    if(csrf && req.headers.origin && req.headers.origin!==new URL(baseUrl).origin)return {error:403};
    return {session,user};
  }
  // Keep existing read-only v1 API semantics; team authorization is explicit for writes.
  function prune() {
    for(const [k,v] of sessions)if(v.expires<now())sessions.delete(k);
    for(const [k,v] of grants)if(v.expires<now())grants.delete(k);
    for(const [k,v] of rate)if(v.until<now())rate.delete(k);
  }
  function limited(key,ceiling=12) {
    let r=rate.get(key);if(!r||r.until<now())r={count:0,until:now()+15*60*1000};r.count++;rate.set(key,r);return r.count>ceiling;
  }
  const getSession=req=>{
    const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('repo_session='));
    const token=raw?.slice(13);return token?sessions.get(digest(token)):null;
  };
  function verifyAdmin(req,csrf=false) { return requireUser(req,csrf); }
  function idIn(s){return /^[a-f0-9-]{36}$/.test(s||'');}
  const docHistory=docId=>db.files.filter(f=>f.documentId===docId).sort((a,b)=>b.version-a.version);
  const readableDoc=doc=>({...doc,currentFile:publicFile(db.files.find(f=>f.id===doc.currentFileId)||null),versionCount:docHistory(doc.id).length});

  function shareByToken(token) {
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    const share=db.shares.find(s=>s.tokenHash===digest(token));
    if(!share || (share.expiresAt&&share.expiresAt<=now()) || (share.maxDownloads&&share.downloads>=share.maxDownloads))return null;
    const file=db.files.find(f=>f.id===share.fileId);return file?{share,file}:null;
  }
  async function download(res,share,file){
    const disk=path.join(dataDir,'files',file.id);
    let stat;try{stat=await fsp.stat(disk);if(!stat.isFile())throw new Error('not file')}catch{return respond(res,404,{error:'not_found'})}
    // Count authorized download starts, not completed transfers.
    share.downloads++;file.downloads++;persist();
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':stat.size,'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','Accept-Ranges':'none','X-Content-Type-Options':'nosniff'});
    try{await pipeline(fs.createReadStream(disk),res)}catch{}
  }
  const server=http.createServer(async(req,res)=>{
    prune();
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    const u=new URL(req.url,'http://localhost');const pathname=u.pathname;
    try{
      if(req.method==='GET'&&pathname==='/healthz')return respond(res,200,{ok:true});
      if(req.method==='GET'&&['/','/app.js','/style.css','/unlock.js'].includes(pathname)){
        const filename=pathname==='/'?'index.html':pathname.slice(1);const p=path.join(ROOT,'public',filename);
        return respond(res,200,await fsp.readFile(p),{'Content-Type':MIME[path.extname(p)],'Cache-Control':'no-store'});
      }
      if(req.method==='GET'&&pathname==='/api/session'){
        const session=getSession(req);const user=currentUser(session);const active=!!(session&&session.expires>now()&&user);
        return respond(res,200,{authenticated:active,csrf:active?session.csrf:null,adminUser,user:active?user:null});
      }
      if(req.method==='POST'&&pathname==='/api/login'){
        if(limited(`login:${req.socket.remoteAddress}`,15))return respond(res,429,{error:'rate_limited'});
        const b=await readJson(req);
        if(!b||typeof b!=='object'||Array.isArray(b))return respond(res,400,{error:'invalid_json_body'});
        const u=b.username===adminUser&&typeof b.password==='string'&&checkPassword(b.password,adminHash)?{id:'owner',username:adminUser,role:'admin'}:
          db.users.find(x=>x.username===b.username&&!x.disabled&&typeof b.password==='string'&&checkPassword(b.password,x.passwordHash));
        if(!u)return respond(res,401,{error:'wrong_credentials'});
        const token=random();const csrf=random();sessions.set(digest(token),{userId:u.id,csrf,expires:now()+12*3600*1000});
        res.setHeader('Set-Cookie',`repo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${cookieSecure?'; Secure':''}`);
        audit(u.id,'login');persist();
        return respond(res,200,{authenticated:true,csrf,user:publicUser(u)});
      }
      if(req.method==='POST'&&pathname==='/api/logout'){
        const auth=verifyAdmin(req,true);if(auth.error)return respond(res,auth.error,{error:'unauthorized'});
        const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('repo_session='));if(raw)sessions.delete(digest(raw.slice(13)));
        res.setHeader('Set-Cookie',`repo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecure?'; Secure':''}`);return respond(res,200,{ok:true});
      }
      if(pathname==='/api/files'&&req.method==='GET'){
        const a=verifyAdmin(req);if(a.error)return respond(res,a.error,{error:'unauthorized'});
        return respond(res,200,{files:db.files.map(publicFile).sort((a,b)=>b.uploadedAt-a.uploadedAt),shares:db.shares.map(s=>({id:s.id,fileId:s.fileId,createdAt:s.createdAt,expiresAt:s.expiresAt,maxDownloads:s.maxDownloads,downloads:s.downloads,hasPassword:!!s.passwordHash}))});
      }
      if(pathname==='/api/projects'&&req.method==='GET'){
        const a=requireUser(req);if(a.error)return respond(res,a.error,{error:'unauthorized'});
        return respond(res,200,{projects:db.projects});
      }
      if(pathname==='/api/projects'&&req.method==='POST'){
        const a=requireUser(req,true,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        const b=await readJson(req);const name=typeof b.name==='string'?b.name.trim():'';
        if(!name||name.length>100)return respond(res,400,{error:'invalid_project_name'});
        const project={id:crypto.randomUUID(),name,description:String(b.description||'').slice(0,500),createdAt:now(),createdBy:a.user.id};
        db.projects.push(project);audit(a.user.id,'project_create',{projectId:project.id});persist();return respond(res,201,{project});
      }
      if(pathname==='/api/documents'&&req.method==='GET'){
        const a=requireUser(req);if(a.error)return respond(res,a.error,{error:'unauthorized'});
        const projectId=u.searchParams.get('projectId');
        const docs=db.documents.filter(d=>!projectId||d.projectId===projectId).map(readableDoc).sort((x,y)=>y.updatedAt-x.updatedAt);
        return respond(res,200,{documents:docs});
      }
      if(pathname==='/api/members'&&req.method==='GET'){
        const a=requireUser(req,false,false,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        return respond(res,200,{members:[{id:'owner',username:adminUser,role:'admin'},...db.users.map(publicUser)]});
      }
      if(pathname==='/api/members'&&req.method==='POST'){
        const a=requireUser(req,true,false,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        const b=await readJson(req);const username=typeof b.username==='string'?b.username.trim():'';
        if(!/^[a-zA-Z][a-zA-Z0-9_.-]{2,31}$/.test(username)||typeof b.password!=='string'||b.password.length<12||!['editor','viewer'].includes(b.role)||username===adminUser||db.users.some(x=>x.username===username))return respond(res,400,{error:'invalid_member'});
        const user={id:crypto.randomUUID(),username,role:b.role,passwordHash:hashPassword(b.password),createdAt:now(),disabled:false};
        db.users.push(user);audit(a.user.id,'member_create',{memberId:user.id});persist();return respond(res,201,{member:publicUser(user)});
      }
      if(pathname==='/api/audit'&&req.method==='GET'){
        const a=requireUser(req,false,false,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        return respond(res,200,{events:db.audit.slice(-200).reverse().map(e=>({...e,actorName:userName(e.actor)}))});
      }
      if(pathname==='/api/upload'&&req.method==='POST'){
        const a=requireUser(req,true,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        const name=u.searchParams.get('name');
        if(!name||name.length>180||/[\\/\x00-\x1f\x7f]/.test(name)||!allowedExt.test(name))return respond(res,400,{error:'invalid_filename'});
        if(Number(req.headers['content-length']||0)>maxUpload)return respond(res,413,{error:'too_large'});
        const projectId=u.searchParams.get('projectId')||'general';
        if(!db.projects.some(x=>x.id===projectId))return respond(res,404,{error:'project_not_found'});
        let documentId=u.searchParams.get('documentId');
        if(documentId&&!idIn(documentId))return respond(res,400,{error:'invalid_document'});
        const autoReplace=u.searchParams.get('replace')!=='no';
        let doc=documentId?db.documents.find(d=>d.id===documentId):autoReplace?db.documents.find(d=>d.projectId===projectId&&d.name.toLowerCase()===name.toLowerCase()&&!d.archivedAt):null;
        if(documentId&&(!doc||doc.projectId!==projectId))return respond(res,404,{error:'document_not_found'});
        const id=crypto.randomUUID(),tmp=path.join(dataDir,'tmp',id);
        let size=0;const hash=crypto.createHash('sha256');
        const limit=new Transform({transform(chunk,enc,cb){size+=chunk.length;if(size>maxUpload)return cb(Object.assign(new Error('too_large'),{httpStatus:413}));hash.update(chunk);cb(null,chunk)}});
        try{
          await pipeline(req,limit,fs.createWriteStream(tmp,{flags:'wx',mode:0o600}));
          if(size===0)throw Object.assign(new Error('empty_file'),{httpStatus:400});
          await fsp.rename(tmp,path.join(dataDir,'files',id));
          const timestamp=now(),prev=doc?db.files.find(f=>f.id===doc.currentFileId):null;
          const version=doc?doc.nextVersion++:1;
          if(!doc){doc={id:crypto.randomUUID(),name,projectId,currentFileId:id,createdAt:timestamp,updatedAt:timestamp,createdBy:a.user.id,nextVersion:2,archivedAt:null};db.documents.push(doc)}
          else{if(prev){prev.state='archived';prev.archivedAt=timestamp}doc.currentFileId=id;doc.updatedAt=timestamp;doc.archivedAt=null}
          const file={id,name,size,uploadedAt:timestamp,downloads:0,sha256:hash.digest('hex'),documentId:doc.id,projectId,version,state:'current',archivedAt:null,uploadedBy:a.user.id};
          db.files.push(file);audit(a.user.id,prev?'version_replace':'document_create',{documentId:doc.id,version:file.version,replacedFileId:prev?.id||null});persist();
          return respond(res,201,{file:publicFile(file),document:readableDoc(doc),replaced:!!prev,archivedVersionId:prev?.id||null});
        }catch(e){await fsp.rm(tmp,{force:true}).catch(()=>{});throw e}
      }
      const historyMatch=pathname.match(/^\/api\/documents\/([a-f0-9-]{36})\/history$/);
      if(historyMatch&&req.method==='GET'){
        const a=requireUser(req);if(a.error)return respond(res,a.error,{error:'unauthorized'});
        const doc=db.documents.find(d=>d.id===historyMatch[1]);if(!doc)return respond(res,404,{error:'document_not_found'});
        return respond(res,200,{document:readableDoc(doc),versions:docHistory(doc.id).map(publicFile)});
      }
      const compareMatch=pathname.match(/^\/api\/documents\/([a-f0-9-]{36})\/compare$/);
      if(compareMatch&&req.method==='GET'){
        const a=requireUser(req);if(a.error)return respond(res,a.error,{error:'unauthorized'});
        const doc=db.documents.find(d=>d.id===compareMatch[1]);if(!doc)return respond(res,404,{error:'not_found'});
        const versions=docHistory(doc.id);const from=versions.find(x=>x.id===u.searchParams.get('from'));const to=versions.find(x=>x.id===u.searchParams.get('to'));
        if(!from||!to)return respond(res,400,{error:'invalid_version'});
        // Binary archives cannot be safely merged or text-diffed here: metadata-only comparison.
        return respond(res,200,{mode:'metadata_only',from:publicFile(from),to:publicFile(to),identical:!!from.sha256&&from.sha256===to.sha256,sizeDelta:to.size-from.size});
      }
      const restoreMatch=pathname.match(/^\/api\/documents\/([a-f0-9-]{36})\/restore$/);
      if(restoreMatch&&req.method==='POST'){
        const a=requireUser(req,true,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        const doc=db.documents.find(d=>d.id===restoreMatch[1]);if(!doc)return respond(res,404,{error:'document_not_found'});
        const b=await readJson(req);const old=db.files.find(f=>f.id===b.versionId&&f.documentId===doc.id);if(!old)return respond(res,404,{error:'version_not_found'});
        const id=crypto.randomUUID();await fsp.copyFile(path.join(dataDir,'files',old.id),path.join(dataDir,'files',id),fs.constants.COPYFILE_EXCL);
        const previous=db.files.find(f=>f.id===doc.currentFileId),timestamp=now();
        if(previous){previous.state='archived';previous.archivedAt=timestamp}
        const file={...old,id,version:doc.nextVersion++,state:'current',archivedAt:null,uploadedBy:a.user.id,uploadedAt:timestamp,downloads:0,restoredFromId:old.id};
        db.files.push(file);doc.currentFileId=file.id;doc.updatedAt=timestamp;doc.archivedAt=null;
        audit(a.user.id,'version_restore',{documentId:doc.id,sourceVersionId:old.id,newVersionId:id});persist();return respond(res,201,{file:publicFile(file),document:readableDoc(doc)});
      }
      const archiveMatch=pathname.match(/^\/api\/documents\/([a-f0-9-]{36})\/(archive|unarchive)$/);
      if(archiveMatch&&req.method==='POST'){
        const a=requireUser(req,true,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        const doc=db.documents.find(d=>d.id===archiveMatch[1]);if(!doc)return respond(res,404,{error:'not_found'});
        doc.archivedAt=archiveMatch[2]==='archive'?now():null;doc.updatedAt=now();audit(a.user.id,archiveMatch[2],{documentId:doc.id});persist();return respond(res,200,{document:readableDoc(doc)});
      }
      const versionDownload=pathname.match(/^\/api\/versions\/([a-f0-9-]{36})\/download$/);
      if(versionDownload&&req.method==='GET'){
        const a=requireUser(req);if(a.error)return respond(res,a.error,{error:'unauthorized'});
        const f=db.files.find(x=>x.id===versionDownload[1]);if(!f)return respond(res,404,{error:'not_found'});
        let st;try{st=await fsp.stat(path.join(dataDir,'files',f.id))}catch{return respond(res,404,{error:'not_found'})}
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':st.size,'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(f.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
        try{await pipeline(fs.createReadStream(path.join(dataDir,'files',f.id)),res)}catch{}return;
      }
      const delFile=pathname.match(/^\/api\/files\/([a-f0-9-]{36})$/);
      if(delFile&&req.method==='DELETE'){
        const a=requireUser(req,true,false,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        const file=db.files.find(f=>f.id===delFile[1]);if(!file)return respond(res,404,{error:'not_found'});
        const doc=db.documents.find(d=>d.id===file.documentId);
        const versions=doc?docHistory(doc.id):[file];
        db.files=db.files.filter(f=>!versions.some(v=>v.id===f.id));db.shares=db.shares.filter(s=>!versions.some(v=>v.id===s.fileId));
        db.documents=db.documents.filter(d=>d.id!==file.documentId);
        audit(a.user.id,'document_purge',{documentId:file.documentId});persist();
        for(const v of versions)await fsp.rm(path.join(dataDir,'files',v.id),{force:true});return respond(res,200,{ok:true});
      }
      if(pathname==='/api/shares'&&req.method==='POST'){
        const a=requireUser(req,true,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        const b=await readJson(req);if(!b||typeof b!=='object'||Array.isArray(b))return respond(res,400,{error:'invalid_json_body'});const file=db.files.find(f=>f.id===b.fileId);if(!file)return respond(res,404,{error:'file_not_found'});
        const ttlDays=Number(b.ttlDays||0),maxDownloads=Number(b.maxDownloads||0);
        if(!Number.isInteger(ttlDays)||ttlDays<0||ttlDays>365||!Number.isInteger(maxDownloads)||maxDownloads<0||maxDownloads>1000000|| (b.password && (typeof b.password!=='string'||b.password.length>128)))return respond(res,400,{error:'invalid_share_options'});
        const token=random();const share={id:crypto.randomUUID(),fileId:file.id,tokenHash:digest(token),createdAt:now(),expiresAt:ttlDays?now()+ttlDays*86400000:null,maxDownloads,downloads:0,passwordHash:b.password?hashPassword(b.password):null};
        db.shares.push(share);audit(a.user.id,'share_create',{shareId:share.id,fileId:file.id});persist();return respond(res,201,{id:share.id,url:`${baseUrl}/s/${token}`});
      }
      const revoke=pathname.match(/^\/api\/shares\/([a-f0-9-]{36})$/);
      if(revoke&&req.method==='DELETE'){
        const a=requireUser(req,true,true);if(a.error)return respond(res,a.error,{error:'forbidden'});
        if(!db.shares.some(s=>s.id===revoke[1]))return respond(res,404,{error:'not_found'});
        db.shares=db.shares.filter(s=>s.id!==revoke[1]);audit(a.user.id,'share_revoke',{shareId:revoke[1]});persist();return respond(res,200,{ok:true});
      }
      const shareRoute=pathname.match(/^\/s\/([A-Za-z0-9_-]{43})$/);
      if(shareRoute&&req.method==='GET'){
        const x=shareByToken(shareRoute[1]);if(!x)return respond(res,404,{error:'invalid_or_expired_share'});
        if(x.share.passwordHash)return respond(res,200,await fsp.readFile(path.join(ROOT,'public','unlock.html')),{'Content-Type':'text/html; charset=utf-8'});
        return download(res,x.share,x.file);
      }
      const unlock=pathname.match(/^\/api\/unlock\/([A-Za-z0-9_-]{43})$/);
      if(unlock&&req.method==='POST'){
        if(limited(`unlock:${req.socket.remoteAddress}`,30))return respond(res,429,{error:'rate_limited'});
        const x=shareByToken(unlock[1]);if(!x||!x.share.passwordHash)return respond(res,404,{error:'not_found'});
        const b=await readJson(req);if(!b||typeof b!=='object'||Array.isArray(b))return respond(res,400,{error:'invalid_json_body'});if(typeof b.password!=='string'||!checkPassword(b.password,x.share.passwordHash))return respond(res,403,{error:'wrong_password'});
        const token=random();grants.set(digest(token),{shareId:x.share.id,expires:now()+60000});return respond(res,200,{url:`/dl/${token}`});
      }
      const grantRoute=pathname.match(/^\/dl\/([A-Za-z0-9_-]{43})$/);
      if(grantRoute&&req.method==='GET'){
        const key=digest(grantRoute[1]);const grant=grants.get(key);grants.delete(key);
        if(!grant||grant.expires<=now())return respond(res,404,{error:'expired_grant'});
        const share=db.shares.find(s=>s.id===grant.shareId);if(!share)return respond(res,404,{error:'not_found'});
        if((share.expiresAt&&share.expiresAt<=now())||(share.maxDownloads&&share.downloads>=share.maxDownloads))return respond(res,404,{error:'invalid_share'});
        const file=db.files.find(f=>f.id===share.fileId);if(!file)return respond(res,404,{error:'not_found'});
        return download(res,share,file);
      }
      return respond(res,404,{error:'not_found'});
    }catch(e){if(!res.headersSent)respond(res,e.httpStatus||500,{error:e.httpStatus?e.message:'internal_error'});else res.destroy();}
  });
  persist(); // commit in-place v1 -> v2 metadata migration; original files remain untouched
  server.requestTimeout=10*60*1000;
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||8891);const bind=process.env.BIND_ADDRESS||'127.0.0.1';
  createServer().listen(port,bind,()=>console.log(`Repo share listening at ${bind}:${port}`));
}
