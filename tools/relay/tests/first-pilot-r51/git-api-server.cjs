'use strict';
// Real localhost HTTP/SQLite, synthetic GitHub REST objects. This is a fixture,
// not a production state engine or proof of real GitHub cross-host durability.
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const C=require('../../auto-handoff-r46/contract'),S=require('../../auto-handoff-r46/state'),{REF,FILE,blobHash}=require('../../auto-handoff-r46/github-state');
const file=process.argv[2];if(!fs.existsSync(file))fs.closeSync(fs.openSync(file,'wx',0o600));const db=new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ref(id INTEGER PRIMARY KEY, sha TEXT NOT NULL);');
const put=(kind,body,id=crypto.createHash('sha1').update(kind+JSON.stringify(body)).digest('hex'))=>{db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?,?)').run(id,kind,JSON.stringify(body));return id;};
const get=(kind,id)=>{const row=db.prepare('SELECT body FROM objects WHERE id=? AND kind=?').get(id,kind);return row?JSON.parse(row.body):null;};
if(!db.prepare('SELECT sha FROM ref WHERE id=1').get()){
 const text=C.canonical(S.empty()),blob=put('blobs',{encoding:'base64',content:Buffer.from(text).toString('base64')},blobHash(text)),tree=put('trees',{tree:[{path:FILE,mode:'100644',type:'blob',sha:blob}]}),head=put('commits',{tree:{sha:tree},parents:[]});db.prepare('INSERT INTO ref VALUES (1,?)').run(head);
}
let fault=null,patches=0;
const server=http.createServer((req,res)=>{
 const send=(status,data)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
 if(req.method==='GET'&&req.url==='/fixture/stats')return send(200,{patches,head:db.prepare('SELECT sha FROM ref WHERE id=1').get().sha});
 if(['403','429','500'].includes(fault))return send(Number(fault),{message:'Bearer PRIVATE_FIXTURE_STATUS_BODY'});
 if(req.method==='GET'){
  if(req.url==='/git/ref/'+REF)return send(200,{object:{sha:db.prepare('SELECT sha FROM ref WHERE id=1').get().sha}});
  const m=/^\/git\/(commits|trees|blobs)\/([a-f0-9]{40})$/.exec(req.url),data=m&&get(m[1],m[2]);return send(data?200:404,data||{});
 }
 let raw='';req.on('data',b=>{raw+=b;if(raw.length>1048576)req.destroy();});req.on('end',()=>{
  let body;try{body=JSON.parse(raw);}catch{return send(400,{});}
  if(req.url==='/fixture/fault'){fault=body.mode;return send(200,{});}
  if(req.method==='POST'&&req.url==='/git/blobs'){const text=Buffer.from(body.content,'base64').toString('utf8');return send(201,{sha:put('blobs',body,blobHash(text))});}
  if(req.method==='POST'&&req.url==='/git/trees')return send(201,{sha:put('trees',{tree:body.tree})});
  if(req.method==='POST'&&req.url==='/git/commits')return send(201,{sha:put('commits',{tree:{sha:body.tree},parents:body.parents,message:body.message})});
  if(req.method==='PATCH'&&req.url==='/git/refs/'+REF){
   if(body.force!==false)return send(403,{});const next=get('commits',body.sha);if(!next||next.parents.length!==1)return send(422,{});
   db.exec('BEGIN IMMEDIATE');let won=false;try{won=db.prepare('UPDATE ref SET sha=? WHERE id=1 AND sha=?').run(body.sha,next.parents[0]).changes===1;db.exec('COMMIT');}catch{db.exec('ROLLBACK');return send(500,{});}
   if(!won)return send(422,{});patches++;
   if(fault==='die-after-commit')process.kill(process.pid,'SIGKILL');
   if(fault==='lost-ack'){fault=null;return req.socket.destroy();}
   return send(200,{object:{sha:body.sha}});
  }
  send(404,{});
 });
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>{db.close();process.exit(0);});});
