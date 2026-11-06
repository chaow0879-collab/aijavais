const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {preflight,diagnose}=require('../../tools/p2/preflight');
test('read-only parent chain detects writable ancestor, ACL uncertainty, symlink and does not chmod',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p2-chain-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const before=fs.statSync(dir).mode;let r=preflight(dir,{aclProbe:()=>({status:0,stdout:'user::rwx\ngroup::---\nother::---'})});
 assert.ok(r.blockers.includes('UNTRUSTED_WRITERS')); // /tmp must never be waved through, sticky bit is insufficient.
 assert.equal(fs.statSync(dir).mode,before);assert.equal(r.readOnly,true);
 assert.ok(preflight(dir,{aclProbe:()=>({status:1})}).blockers.includes('ACL_UNKNOWN'));
 const link=path.join(dir,'link');fs.symlinkSync(dir,link);assert.ok(preflight(link).blockers.includes('NON_DIRECTORY_OR_SYMLINK'));
});
test('diagnostics never claim hung provider stopped or release three slots',()=>{
 assert.equal(diagnose({activeSlots:3,maxSlots:3,outstanding:3}).status,'CAPACITY_BLOCKED');
 assert.equal(diagnose({activeSlots:3,maxSlots:3}).providerMayStillBill,true);
 assert.equal(diagnose(null).status,'UNKNOWN');
});
