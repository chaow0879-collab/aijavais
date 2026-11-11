'use strict';
// M1: GitHub webhook intake through a REAL loopback Node HTTP server (raw-body HMAC).
// Synthetic secret and payloads only; no webhook or App is installed on the repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { serve } = require('../../trusted-trigger-r50/server');
const { TriggerStore } = require('../../trusted-trigger-r50/store');
const { verifyDelivery } = require('../../trusted-trigger-r50/intake');
const X = require('./helpers.cjs');

async function server(t, ctx, onTrigger = async r => ({ kind: r.kind, event: r.event })) {
  const s = await serve({ secret: X.SECRET, r46config: X.r46cfg(ctx.f), policy: X.r50Policy(), store: ctx.store, clock: () => ctx.f.now, onTrigger });
  t.after(() => new Promise(r => s.server.close(r)));
  return s;
}
const post = async (url, d) => { const r = await fetch(url, { method: 'POST', headers: d.headers, body: d.body }); return { status: r.status, json: await r.json() }; };

test('valid issue_comment and workflow_run deliveries are accepted over real HTTP; payload text is never an approval', async t => {
  const ctx = X.base(t), s = await server(t, ctx);
  const a = await post(s.url, X.delivery(ctx.f));
  assert.equal(a.status, 202); assert.deepEqual(a.json.result, { kind: 'github_webhook', event: 'issue_comment' });
  const b = await post(s.url, X.delivery(ctx.f, { event: 'workflow_run' }));
  assert.equal(b.status, 202, JSON.stringify(b.json));
  assert.ok(ctx.store.auditLog().filter(e => e.kind === 'event_accepted').length === 2);
  assert.doesNotMatch(JSON.stringify(ctx.store.auditLog()), /run it now please/, 'comment text is not stored or interpreted');
});

test('replay of a delivery id is refused, also after the receiver restarts (durable SQLite)', async t => {
  const ctx = X.base(t), d = X.delivery(ctx.f);
  let s = await server(t, ctx);
  assert.equal((await post(s.url, d)).status, 202);
  assert.deepEqual(await post(s.url, d), { status: 409, json: { state: 'REJECTED', reason: 'REPLAYED_DELIVERY' } });
  await new Promise(r => s.server.close(r));
  const reopened = new TriggerStore(ctx.store.file); t.after(() => reopened.close());
  s = await server(t, { ...ctx, store: reopened });
  assert.equal((await post(s.url, d)).json.reason, 'REPLAYED_DELIVERY');
});

test('a forged delivery cannot burn a real delivery id', async t => {
  const ctx = X.base(t), s = await server(t, ctx), good = X.delivery(ctx.f);
  const forged = { ...good, headers: { ...good.headers, 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } };
  assert.equal((await post(s.url, forged)).json.reason, 'BAD_SIGNATURE');
  assert.equal((await post(s.url, good)).status, 202);
});

const refusals = [
  ['bad HMAC (wrong secret)', f => X.delivery(f, { secret: 'WRONG_SECRET_WRONG_SECRET_WRONG_SECRET_1' }), 'BAD_SIGNATURE'],
  ['not from GitHub-Hookshot', f => X.delivery(f, { headers: { 'user-agent': 'curl/8' } }), 'NOT_A_GITHUB_DELIVERY'],
  ['non-UUID delivery id', f => X.delivery(f, { headers: { 'x-github-delivery': '../../../../etc' } }), 'EVENT_NOT_ALLOWED'],
  ['push event', f => X.delivery(f, { headers: { 'x-github-event': 'push' } }), 'EVENT_NOT_ALLOWED'],
  ['pull_request event', f => X.delivery(f, { headers: { 'x-github-event': 'pull_request' } }), 'EVENT_NOT_ALLOWED'],
  ['edited comment (R46 allows, R50 does not)', f => X.delivery(f, { payload: { action: 'edited' } }), 'ACTION_NOT_ALLOWED'],
  ['fork repository', f => X.delivery(f, { payload: { repository: { fork: true } } }), 'EVENT_SCOPE'],
  ['wrong repository id', f => X.delivery(f, { payload: { repository: { id: 1 } } }), 'EVENT_SCOPE'],
  ['unknown sender', f => X.delivery(f, { payload: { sender: { login: 'stranger' } } }), 'EVENT_SCOPE'],
  ['comment on a pull request', f => X.delivery(f, { payload: { issue: { pull_request: { url: 'x' } } } }), 'EVENT_SCOPE'],
  ['other issue', f => X.delivery(f, { payload: { issue: { number: 1 } } }), 'EVENT_SCOPE'],
  ['wrong App installation', f => X.delivery(f, { payload: { installation: { id: 999 } } }), 'INSTALLATION_MISMATCH'],
  ['missing App installation', f => X.delivery(f, { payload: { installation: null } }), 'INSTALLATION_MISMATCH'],
  ['stale event (20 min old)', f => X.delivery(f, { at: f.now - 20 * 60000 }), 'STALE_OR_FUTURE_EVENT'],
  ['event from the future', f => X.delivery(f, { at: f.now + 5 * 60000 }), 'STALE_OR_FUTURE_EVENT'],
  ['workflow_run from a pull_request', f => X.delivery(f, { event: 'workflow_run', payload: { workflow_run: { event: 'pull_request' } } }), 'UNTRUSTED_WORKFLOW_SOURCE'],
  ['workflow_run for another SHA', f => X.delivery(f, { event: 'workflow_run', payload: { workflow_run: { head_sha: '9'.repeat(40) } } }), 'UNTRUSTED_WORKFLOW_SOURCE'],
  ['workflow_run from a fork head', f => X.delivery(f, { event: 'workflow_run', payload: { workflow_run: { head_repository: { fork: true } } } }), 'UNTRUSTED_WORKFLOW_SOURCE'],
  ['failed workflow_run', f => X.delivery(f, { event: 'workflow_run', payload: { workflow_run: { conclusion: 'failure' } } }), 'UNTRUSTED_WORKFLOW_SOURCE']
];
for (const [name, make, reason] of refusals) test('refused: ' + name, async t => {
  const ctx = X.base(t); let fired = 0;
  const s = await server(t, ctx, async () => { fired++; });
  const r = await post(s.url, make(ctx.f));
  assert.equal(r.status, 401); assert.equal(r.json.reason, reason);
  assert.equal(fired, 0, 'a refused delivery never reaches the pipeline');
});

test('oversized body 413, wrong method/path 404, receiver refuses non-loopback binding', async t => {
  const ctx = X.base(t), s = await server(t, ctx);
  const big = X.delivery(ctx.f, { payload: { comment: { body: 'x'.repeat(70000) } } });
  assert.equal((await post(s.url, big)).status, 413);
  assert.equal((await fetch(s.url, { method: 'GET' })).status, 404);
  await assert.rejects(serve({ secret: X.SECRET, r46config: X.r46cfg(ctx.f), policy: X.r50Policy(), store: ctx.store, onTrigger: async () => 0, host: '0.0.0.0' }), /LOOPBACK_ONLY/);
});

test('intake records cannot be forged as plain objects', () => {
  const { isMinted } = require('../../trusted-trigger-r50/identity');
  assert.equal(isMinted({ kind: 'github_webhook', sender: 'planner', repository_id: 1446621245 }), false);
  assert.equal(typeof verifyDelivery, 'function');
});
