'use strict';
// Real localhost HTTP and SQLite transactions, synthetic controller records only.
// A single authoritative fixture service, not a per-runner local file lock.
const fs=require('node:fs'),http=require('node:http'),{DatabaseSync}=require('node:sqlite');
const {empty,valid}=require('../../tools/auto-handoff-r46/state'),{canonical}=require('../../tools/auto-handoff-r46/contract');
const file=process.argv[2];if(!fs.existsSync(file))fs.closeSync(fs.openSync(file,'wx',0o600));
const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, document TEXT NOT NULL);');
db.prepare('INSERT OR IGNORE INTO state VALUES (1,0,?)').run(canonical(empty()));let fault=null;
const server=http.createServer((req,res)=>{
 if(req.method==='GET'&&req.url==='/state'){const r=db.prepare('SELECT * FROM state WHERE id=1').get();res.setHeader('content-type','application/json');return res.end(JSON.stringify({version:String(r.version),document:JSON.parse(r.document)}));}
 let body='';req.on('data',b=>{body+=b;if(body.length>600000)req.destroy();});req.on('end',()=>{
  let x;try{x=JSON.parse(body);}catch{res.statusCode=400;return res.end();}
  if(req.url==='/fault'){fault=x.mode;return res.end('{}');}
  if(req.method!=='POST'||req.url!=='/cas'||!valid(x.document)){res.statusCode=400;return res.end();}
  db.exec('BEGIN IMMEDIATE');let committed;
  try{committed=db.prepare('UPDATE state SET version=version+1,document=? WHERE id=1 AND version=?').run(canonical(x.document),Number(x.version)).changes===1;db.exec('COMMIT');}catch{db.exec('ROLLBACK');res.statusCode=500;return res.end();}
  if(committed&&fault==='die-after-commit')process.kill(process.pid,'SIGKILL');
  if(committed&&fault==='lost-ack'){fault=null;return req.socket.destroy();}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({committed}));
 });
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>{db.close();process.exit(0);});});
