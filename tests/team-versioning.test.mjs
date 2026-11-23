import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createServer} from '../server.mjs';

test('team permissions + same-name overwrite archives old version + restore and distribution',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexus-test-'));
 const server=createServer({dataDir:dir,password:'StrongAdminPassword2026!',baseUrl:'http://127.0.0.1',cookieSecure:false});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await new Promise(ok=>server.close(ok));await rm(dir,{recursive:true,force:true})});
 const request=(p,opts={})=>fetch(base+p,opts);
 async function login(username,password){const r=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200);const json=await r.json();return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:json.csrf}}
 const admin=await login('admin','StrongAdminPassword2026!');
 function req(pathname,auth,method='GET',body=null){return request(pathname,{method,headers:{cookie:auth.cookie,'x-csrf-token':auth.csrf,...(body!==null?{'content-type':'application/json'}:{})},body:body===null?undefined:JSON.stringify(body)})}
 let res=await req('/api/members',admin,'POST',{username:'writer1',password:'WriterStrongPassword!',role:'editor'});assert.equal(res.status,201);
 res=await req('/api/members',admin,'POST',{username:'reader1',password:'ReaderStrongPassword!',role:'viewer'});assert.equal(res.status,201);
 const writer=await login('writer1','WriterStrongPassword!'),reader=await login('reader1','ReaderStrongPassword!');
 assert.equal((await req('/api/members',writer)).status,403);
 assert.equal((await req('/api/audit',reader)).status,403);
 assert.equal((await req('/api/projects',reader,'POST',{name:'illegal'})).status,403);
 res=await req('/api/projects',writer,'POST',{name:'Design Systems'});assert.equal(res.status,201);const projectId=(await res.json()).project.id;
 const upload=(auth,name,content)=>request(`/api/upload?name=${encodeURIComponent(name)}&projectId=${projectId}`,{method:'POST',headers:{cookie:auth.cookie,'x-csrf-token':auth.csrf},body:Buffer.from(content)});
 assert.equal((await upload(reader,'spec.pdf','read-only')).status,403);
 res=await upload(writer,'spec.pdf','first revision');assert.equal(res.status,201);const first=await res.json();assert.equal(first.file.version,1);assert.equal(first.replaced,false);
 res=await upload(writer,'spec.pdf','second revision');assert.equal(res.status,201);const second=await res.json();assert.equal(second.file.version,2);assert.equal(second.replaced,true);assert.equal(second.archivedVersionId,first.file.id);
 res=await req('/api/documents',reader);assert.equal(res.status,200);const docs=(await res.json()).documents;assert.equal(docs.length,1);assert.equal(docs[0].versionCount,2);assert.equal(docs[0].currentFile.id,second.file.id);
 const docId=docs[0].id;
 res=await req(`/api/documents/${docId}/history`,reader);assert.equal(res.status,200);let {versions}=await res.json();assert.deepEqual(versions.map(v=>v.version),[2,1]);assert.equal(versions[1].state,'archived');assert.equal(versions[1].uploadedByName,'writer1');assert.equal(versions[1].uploadedBy,(await req('/api/members',admin).then(x=>x.json())).members.find(m=>m.username==='writer1').id);
 res=await req(`/api/documents/${docId}/compare?from=${first.file.id}&to=${second.file.id}`,reader);assert.equal(res.status,200);const compare=await res.json();assert.equal(compare.mode,'metadata_only');assert.equal(compare.identical,false);
 const oldDownload=await req(`/api/versions/${first.file.id}/download`,reader);assert.equal(oldDownload.status,200);assert.equal(await oldDownload.text(),'first revision');
 assert.equal((await req('/api/shares',reader,'POST',{fileId:first.file.id})).status,403);
 res=await req('/api/shares',writer,'POST',{fileId:second.file.id,ttlDays:0,maxDownloads:2});assert.equal(res.status,201);const share=await res.json();assert.equal((await request(new URL(share.url).pathname)).status,200);
 res=await req(`/api/documents/${docId}/restore`,writer,'POST',{versionId:first.file.id});assert.equal(res.status,201);const restored=(await res.json()).file;assert.equal(restored.version,3);assert.equal(restored.restoredFromId,first.file.id);assert.equal((await req(`/api/versions/${restored.id}/download`,reader)).status,200);
 const finalHistory=await req(`/api/documents/${docId}/history`,reader);versions=(await finalHistory.json()).versions;assert.deepEqual(versions.map(x=>x.version),[3,2,1]);assert.equal(versions.filter(x=>x.state==='archived').length,2);
 res=await req(`/api/documents/${docId}/archive`,writer,'POST');assert.equal(res.status,200);assert.ok((await res.json()).document.archivedAt);
 res=await req('/api/audit',admin);const actions=(await res.json()).events.map(e=>e.action);for(const action of ['member_create','project_create','document_create','version_replace','version_restore','archive','share_create'])assert.ok(actions.includes(action),action);
 assert.equal((await request('/api/documents')).status,401);
 assert.equal((await request('/api/versions/'+first.file.id+'/download')).status,401); // unlisted / unprivileged
});

test('v1 metadata migration retains original archive and share data',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'nexus-migrate-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(path.join(dir,'files'),{recursive:true});
 const id=crypto.randomUUID();const oldContent=Buffer.from('legacy archive');
 await writeFile(path.join(dir,'files',id),oldContent);
 await writeFile(path.join(dir,'metadata.json'),JSON.stringify({version:1,files:[{id,name:'legacy.zip',size:oldContent.length,uploadedAt:Date.now()-900000,downloads:0}],shares:[]}));
 const server=createServer({dataDir:dir,password:'StrongMigrationPassword!',baseUrl:'http://127.0.0.1',cookieSecure:false});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 await new Promise(ok=>server.close(ok));
 const meta=JSON.parse(await readFile(path.join(dir,'metadata.json'),'utf8'));
 assert.equal(meta.version,2);assert.equal(meta.files.length,1);assert.equal(meta.documents.length,1);assert.equal(meta.documents[0].currentFileId,id);assert.equal((await readFile(path.join(dir,'files',id))).toString(),'legacy archive');
});
