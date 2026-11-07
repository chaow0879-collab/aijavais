'use strict';
// Independent loopback HTTP authoritative CAS fixture with real SQLite WAL.
const fs=require('node:fs'),http=require('node:http'),{DatabaseSync}=require('node:sqlite');
const {empty,valid}=require('../../tools/auto-handoff-r46/state');
if(!fs.existsSync(process.argv[2]))fs.closeSync(fs.openSync(process.argv[2],'wx',0o600));
const db=new DatabaseSync(process.argv[2]);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS authority(id INTEGER PRIMARY KEY,rev INTEGER,doc TEXT);CREATE TABLE IF NOT EXISTS http_events(id INTEGER PRIMARY KEY,method TEXT,route TEXT,committed INTEGER);');
db.prepare('INSERT OR IGNORE INTO authority VALUES(1,0,?)').run(JSON.stringify(empty()));let fault='';
const server=http.createServer((req,res)=>{const reply=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 if(req.url==='/state'){
  db.prepare('INSERT INTO http_events(method,route,committed)VALUES(?,?,NULL)').run(req.method,req.url);
  if(/^read-(403|429|500)$/.test(fault))return reply(Number(fault.slice(5)),{error:'synthetic HTTP refusal'});
  const row=db.prepare('SELECT * FROM authority WHERE id=1').get();return reply(200,{version:String(row.rev),document:JSON.parse(row.doc)});
 }
 let body='';req.on('data',b=>{body+=b;if(body.length>600000)req.destroy();});req.on('end',()=>{
  let x;try{x=JSON.parse(body);}catch{return reply(400,{});}
  if(req.url==='/fault'){fault=x.mode;return reply(200,{});}
  if(req.url!=='/cas'||req.method!=='POST'||!valid(x.document))return reply(400,{});
  db.exec('BEGIN IMMEDIATE');let won;try{won=db.prepare('UPDATE authority SET rev=rev+1,doc=? WHERE id=1 AND rev=?').run(JSON.stringify(x.document),Number(x.version)).changes===1;db.prepare('INSERT INTO http_events(method,route,committed)VALUES(?,?,?)').run(req.method,req.url,Number(won));db.exec('COMMIT');}catch{db.exec('ROLLBACK');return reply(500,{});}
  if(won&&fault==='kill-after-commit')process.kill(process.pid,'SIGKILL');
  if(won&&fault==='ack-lost'){fault='';return req.socket.destroy();}
  reply(200,{committed:won});
 });
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>{db.close();process.exit(0);});});
