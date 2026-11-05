'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { AuthStore } = require('../lib/auth');
const H = require('./helpers');
function stores(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aij-auth-race-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return { dir, first:new AuthStore({dir}), second:new AuthStore({dir}) };
}

test('auth concurrency: two setup requests cannot both consume the same setup code', async t => {
  const {first} = stores(t);
  const code = first.ensureSetupCode();
  const passwords = ['first-setup-password-37', 'second-setup-password-81'];
  const results = await Promise.all(passwords.map(pw => first.setup(code,pw)));
  assert.deepEqual(results.map(r=>r.ok).sort(),[false,true]);
  assert.equal(results.find(r=>!r.ok).code,409);
  for(let i=0;i<2;i++) assert.equal(await first.verifyPassword(passwords[i]),results[i].ok);
  assert.equal(fs.existsSync(first.files.code),false);
});

test('auth concurrency: post-scrypt state recheck prevents another store from overwriting setup', async t => {
  const {first,second} = stores(t);
  const code = first.ensureSetupCode();
  const passwords = ['separate-store-one-87','separate-store-two-12'];
  const results = await Promise.all([first.setup(code,passwords[0]),second.setup(code,passwords[1])]);
  assert.equal(results.filter(r=>r.ok).length,1);
  assert.equal(results.find(r=>!r.ok).code,409);
  const fresh = new AuthStore({dir:first.dir});
  for(let i=0;i<2;i++) assert.equal(await fresh.verifyPassword(passwords[i]),results[i].ok);
});

test('auth concurrency: simultaneous changes using the same old password have one winner', async t => {
  const {first,second} = stores(t);
  const old = 'original-secret-password-54';
  assert.equal((await first.setup(first.ensureSetupCode(),old)).ok,true);
  const keep = first.createSession('admin');
  const other = first.createSession('admin');
  const next = ['changed-secret-one-46','changed-secret-two-92'];
  const results = await Promise.all([
    first.changePassword(old,next[0],keep.session.sid),
    second.changePassword(old,next[1],keep.session.sid),
  ]);
  assert.equal(results.filter(r=>r.ok).length,1);
  assert.ok([401,409].includes(results.find(r=>!r.ok).code));
  assert.equal(await first.verifyPassword(old),false);
  for(let i=0;i<2;i++) assert.equal(await first.verifyPassword(next[i]),results[i].ok);
  assert.ok(first.getSession(keep.token));
  assert.equal(first.getSession(other.token),null);
});

test('auth concurrency: local recovery invalidates pending setup and password verification', async t => {
  const {first,second} = stores(t);
  const code = first.ensureSetupCode();
  const pending = first.setup(code,'pending-setup-password-15');
  const recoveredCode = second.resetLocal();
  assert.equal((await pending).code,409);
  assert.equal(first.isSetup(),false);
  assert.equal((await first.setup(recoveredCode,'recovered-password-78')).ok,true);
  const login = first.verifyPassword('recovered-password-78');
  second.resetLocal();
  assert.equal(await login,false,'verification started before reset must not grant a later session');
  assert.equal(first.isSetup(),false);
});

test('auth concurrency: real concurrent HTTP setup and old-password changes only commit once', async t => {
  const s = await H.boot({login:false});
  t.after(()=>s.stop());
  const code = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(fs.readFileSync(path.join(s.dir,'setup-code.txt'),'utf8'))[1];
  const passwords = ['http-setup-one-secret-45','http-setup-two-secret-98'];
  const setup = await Promise.all(passwords.map(password=>H.call(s.port,'POST','/api/auth/setup',{code,password},{cookie:false})));
  assert.deepEqual(setup.map(r=>r.status).sort(),[200,409]);
  const winner = setup.findIndex(r=>r.status===200), cookie=H.cookieFrom(setup[winner]);
  const next = ['http-next-one-secret-26','http-next-two-secret-63'];
  const changed = await Promise.all(next.map(password=>H.call(s.port,'POST','/api/auth/password',{current:passwords[winner],next:password},{cookie})));
  assert.deepEqual(changed.map(r=>r.status).sort(),[200,409]);
  const changedWinner=changed.findIndex(r=>r.status===200);
  assert.equal((await H.call(s.port,'POST','/api/auth/login',{password:passwords[winner]},{cookie:false})).status,401);
  assert.equal((await H.call(s.port,'POST','/api/auth/login',{password:next[changedWinner]},{cookie:false})).status,200);
  assert.equal((await H.call(s.port,'POST','/api/auth/login',{password:next[1-changedWinner]},{cookie:false})).status,401);
});
