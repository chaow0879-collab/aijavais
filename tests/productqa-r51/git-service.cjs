'use strict';
// ProductQA-owned Git-object protocol fixture. Only loopback synthetic state.
const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const C=require('../../tools/auto-handoff-r46/contract'),S=require('../../tools/auto-handoff-r46/state'),G=require('../../tools/auto-handoff-r46/github-state');
const file=process.argv[2];if(!fs.existsSync(file))fs.closeSync(fs.openSync(file,'wx',0o600));const db=new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,kind TEXT,body TEXT);CREATE TABLE IF NOT EXISTS current(id INTEGER PRIMARY KEY,sha TEXT);CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,method TEXT,route TEXT,committed INTEGER);');
const put=(kind,body,sha=crypto.createHash('sha1').update(kind+JSON.stringify(body)).digest('hex'))=>{db.prepare('INSERT OR IGNORE INTO objects VALUES(?,?,?)').run(sha,kind,JSON.stringify(body));return sha;};
const get=(kind,sha)=>{const r=db.prepare('SELECT body FROM objects WHERE id=? AND kind=?').get(sha,kind);return r?JSON.parse(r.body):null;};
if(!db.prepare('SELECT sha FROM current').get()){const text=C.canonical(S.empty()),blob=put('blobs',{encoding:'base64',content:Buffer.from(text).toString('base64')},G.blobHash(text)),tree=put('trees',{tree:[{path:G.FILE,mode:'100644',type:'blob',sha:blob}]}),commit=put('commits',{tree:{sha:tree},parents:[]});db.prepare('INSERT INTO current VALUES(1,?)').run(commit);}
let fault='';
const server=http.createServer((req,res)=>{
 const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 if(req.url!=='/fault')db.prepare('INSERT INTO requests(method,route)VALUES(?,?)').run(req.method,req.url);
 if(req.url.startsWith('/git/')&&/^status-/.test(fault))return send(Number(fault.slice(7)),{error:'QA51 synthetic HTTP error'});
 if(req.method==='GET'){if(req.url==='/git/ref/'+G.REF)return send(200,{object:{sha:db.prepare('SELECT sha FROM current').get().sha}});const m=/^\/git\/(blobs|trees|commits)\/([a-f0-9]{40})$/.exec(req.url),x=m&&get(m[1],m[2]);return send(x?200:404,x||{});}
 let raw='';req.on('data',b=>{raw+=b;if(raw.length>1048576)req.destroy();});req.on('end',()=>{let b;try{b=JSON.parse(raw);}catch{return send(400,{});}
 if(req.url==='/fault'){fault=b.mode;return send(200,{});}
 if(req.method==='POST'&&req.url==='/git/blobs'){const text=Buffer.from(b.content,'base64').toString('utf8');return send(201,{sha:put('blobs',b,G.blobHash(text))});}
 if(req.method==='POST'&&req.url==='/git/trees')return send(201,{sha:put('trees',{tree:b.tree})});
 if(req.method==='POST'&&req.url==='/git/commits')return send(201,{sha:put('commits',{tree:{sha:b.tree},parents:b.parents})});
 if(req.method==='PATCH'&&req.url==='/git/refs/'+G.REF){const next=get('commits',b.sha);if(b.force!==false||!next||next.parents.length!==1)return send(422,{});db.exec('BEGIN IMMEDIATE');let won;
  try{won=db.prepare('UPDATE current SET sha=? WHERE id=1 AND sha=?').run(b.sha,next.parents[0]).changes===1;db.prepare('UPDATE requests SET committed=? WHERE id=(SELECT max(id) FROM requests)').run(Number(won));db.exec('COMMIT');}catch{db.exec('ROLLBACK');return send(500,{});}
  if(!won)return send(422,{});if(fault==='kill-after-commit')process.kill(process.pid,'SIGKILL');if(fault==='ack-lost'){fault='';return req.socket.destroy();}return send(200,{object:{sha:b.sha}});
 }
 send(404,{});
 });
});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>{db.close();process.exit(0);});});
