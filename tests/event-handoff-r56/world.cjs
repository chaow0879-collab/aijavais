'use strict';
// R56 E3 world. All identities, keys, approvals and reviews are SYNTHETIC test material confined to
// this fixture; nothing here can authorize live code. Stages run through the existing chain:
// R50 trigger/approval/broker -> R51 handleTrusted (fake) -> R49 -> R46 Git-ref CAS -> R45 Fake CLI.
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setup } = require('../first-pilot-r51/helpers.cjs');
const H50 = require('../trusted-trigger-r50/helpers.cjs');
const { service } = require('../first-pilot-r51/http.cjs');
const { Broker, TestSigner } = require('../../tools/trusted-trigger-r50/broker');
const { TriggerStore } = require('../../tools/trusted-trigger-r50/store');
const { verifyDelivery } = require('../../tools/trusted-trigger-r50/intake');
const { verifyOidc } = require('../../tools/trusted-trigger-r50/oidc');
const Pol = require('../../tools/agent-pilot-r45/policy');
const C = require('../../tools/auto-handoff-r46/contract');
const T = require('../../tools/auto-handoff-r46/triggers');
const { Ledger } = require('../../tools/auto-handoff-r46/state');
const R46 = require('../../tools/auto-handoff-r46/reconcile');
const { handleTrusted } = require('../../tools/first-pilot-r51/r50-bridge');
const { GitHubFacts } = require('../../tools/event-handoff-r56/github');
const Bridge = require('../../tools/event-handoff-r56/bridge');

async function emulator(t, file) {
  const c = spawn(process.execPath, [path.join(__dirname, 'github-emulator.cjs'), file], { env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let raw = '';
  const url = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('EMULATOR_START_TIMEOUT')), 5000); c.stdout.on('data', b => { raw += b; if (raw.includes('\n')) { clearTimeout(timer); resolve('http://127.0.0.1:' + JSON.parse(raw.split('\n')[0]).port); } }); c.once('error', reject); });
  const stop = async () => { if (c.exitCode === null && c.signalCode === null) { const done = once(c, 'close'); c.kill('SIGTERM'); await done; } };
  if (t) t.after(stop);
  const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  return { url, stop, child: c,
    client: new GitHubFacts(transport(url), { repo: C.REPO, timeoutMs: 1500 }),
    comment: b => post('/fixture/comment', b), run: b => post('/fixture/run', b), ref: (branch, sha) => post('/fixture/ref', { branch, sha }), fault: mode => post('/fixture/fault', { mode }),
    stats: () => fetch(url + '/fixture/stats').then(r => r.json()) };
}
function transport(url) {
  return async (method, route, body) => {
    const r = await fetch(url + route, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(1500) });
    return { status: r.status, data: await r.json() };
  };
}
function reviewerKeys() { const k = {}; for (const role of ['audit', 'qa']) k[role] = crypto.generateKeyPairSync('ed25519'); return k; }
const pem = k => k.export({ type: 'spki', format: 'pem' });
function pipeline(f0, keys, over = {}) {
  return { schema: 'aijavais.event-handoff.pipeline/v1', enabled: false, live_read_enabled: false, live_report_enabled: false, repo: C.REPO, repository_id: 1446621245, review_issues: { audit: 2, qa: 4 },
    actors: { developer: ['claude-dev'], integrator: ['codex-int'], audit: ['auditor'], qa: ['qa-tester'], owner: ['owner'], bridge: ['r56-bridge'] },
    reviewer_keys: { audit: keys ? { 'aud-1': pem(keys.audit.publicKey) } : {}, qa: keys ? { 'qa-1': pem(keys.qa.publicKey) } : {} },
    ci: { workflows: ['r57-candidate-ci'], required_jobs: ['tests', 'browser'], events: ['push', 'workflow_dispatch'] }, review_ttl_ms: 86400000, max_snapshot_age_ms: 900000,
    work_items: [item(f0)], ...over };
}
function item(f0, over = {}) {
  return { id: 'r57-final', issue: f0.envelope.issue, branch: f0.envelope.branch, candidate_from: 'integrator', task_prefix: 'r56',
    stages: [{ stage: 'integration', role: 'integrator', phase: 'integration', kind: 'claude' }, { stage: 'audit', role: 'audit', phase: 'audit', kind: 'claude' }, { stage: 'qa', role: 'qa', phase: 'qa', kind: 'claude' }], ...over };
}
const report = (lines) => ['[AGENT_REPORT_V1]', ...lines, '[/AGENT_REPORT_V1]'].join('\n');
function readyBody(sha, status = 'READY_FOR_REVIEW') { return report(['role: Codex-Integrator', 'status: ' + status, 'head_sha: ' + sha, 'evidence: E3_FAKE']); }
function verdictBody({ role, key, keyId, verdict, sha, it, now, ttl = 3600000, tamper }) {
  const payload = { role, verdict, reviewed_sha: sha, work_item: it.id, issue: it.issue, expires_at: now + ttl };
  const signature = key ? crypto.sign(null, Buffer.from(C.canonical(payload)), key).toString('base64') : 'AA==';
  const proof = { key_id: keyId, payload: tamper ? { ...payload, ...tamper } : payload, signature };
  return report(['role: ' + (role === 'audit' ? 'Independent-CodeAudit' : 'ProductQA'), 'work_item: ' + it.id, 'issue: ' + it.issue, 'verdict: ' + verdict, 'reviewed_sha: ' + sha, 'proof: ' + JSON.stringify(proof)]);
}
async function seedCandidate(em, f0, it, { at = Date.now() } = {}) {
  await em.ref(it.branch, f0.candidate_sha);
  await em.comment({ issue: it.issue, login: 'codex-int', association: 'COLLABORATOR', body: readyBody(f0.candidate_sha), created_at: new Date(at - 5000).toISOString() });
}
async function seedCi(em, f0, it, { id = 7001, conclusion = 'success', fork = false, event = 'push' } = {}) {
  await em.run({ id, name: 'r57-candidate-ci', html_url: 'https://github.com/' + C.REPO + '/actions/runs/' + id, head_sha: f0.candidate_sha, head_branch: it.branch, event, status: 'completed', conclusion,
    head_repository: { full_name: C.REPO, fork }, jobs: [{ name: 'tests', conclusion }, { name: 'browser', conclusion }] });
}
async function seedReviews(em, f0, it, keys, now, { auditVerdict = 'ACCEPT', qaVerdict = 'PASS', at = now - 2000 } = {}) {
  // Same comment URLs the existing R46 gate fixture binds (issues #2 / #4), now carrying signed proofs.
  const id = u => Number(u.split('-').pop());
  await em.comment({ issue: 2, id: id(f0.envelope.audit_refs.audit), html_url: f0.envelope.audit_refs.audit, login: 'auditor', association: 'MEMBER', created_at: new Date(at).toISOString(), body: verdictBody({ role: 'audit', key: keys.audit.privateKey, keyId: 'aud-1', verdict: auditVerdict, sha: f0.candidate_sha, it, now }) });
  await em.comment({ issue: 4, id: id(f0.envelope.audit_refs.qa), html_url: f0.envelope.audit_refs.qa, login: 'qa-tester', association: 'MEMBER', created_at: new Date(at + 1).toISOString(), body: verdictBody({ role: 'qa', key: keys.qa.privateKey, keyId: 'qa-1', verdict: qaVerdict, sha: f0.candidate_sha, it, now }) });
}
// Stage provisioner: the operator-authorized preparation of the EXISTING chain for one ticket.
function provisioner({ t, cas, store, mode = () => 'success', fixtures = [] }) {
  const signer = new TestSigner({ testOnly: true });
  return async (ticket, trigger) => {
    const f = setup(t, typeof mode === 'function' ? mode(ticket) : mode, { runtime: 3000, role: ticket.role, phase: ticket.phase, task_id: ticket.task_id, after: ticket.after, kind: ticket.kind });
    f.backend = cas.backend;
    const keys = Object.values(f.pairs).map(p => p.publicKey.export({ type: 'spki', format: 'pem' }));
    const broker = new Broker({ signer, policy: H50.r50Policy(), store, separatedKeys: keys });
    f.policy = Pol.loadPolicy({ allow_fake_cli: true, allowed_issues: [f.envelope.issue], pinned_gate_sha: f.candidate_sha, trusted_keys: { [signer.keyId]: { pem: signer.publicPem, roles: ['dispatcher'] } } });
    f.refresh();
    fixtures.push(f);
    const approval = H50.approval(f);
    const how = trigger.kind === 'github_webhook' ? { kind: 'verified-event', record: trigger } : { kind: 'tick', oidcToken: H50.oidcToken({}, { now: f.now }), jwks: H50.JWKS };
    return { envelope: f.envelope, fixture: f, launch: () => handleTrusted({ mode: 'fake', ...how, base: f, broker, approval, now: f.now }) };
  };
}
function eventTrigger(f0, store, { event = 'issue_comment', now = Date.now(), delivery } = {}) {
  const d = delivery || H50.delivery(f0, { event, at: now });
  return verifyDelivery(d, { secret: H50.SECRET, r46config: H50.r46cfg(f0), policy: H50.r50Policy(), store, now });
}
function tickTrigger(now = Date.now()) { return verifyOidc(H50.oidcToken({}, { now }), { jwks: H50.JWKS, policy: H50.r50Policy(), now }); }
async function world(t, dir, opts = {}) {
  const f0 = setup(t, 'success', { runtime: 3000 });
  const cas = await service(t, path.join(dir, 'git.sqlite'));
  const em = await emulator(t, path.join(dir, 'github.sqlite'));
  const store = new TriggerStore(path.join(dir, 'r50.sqlite'));
  t.after(() => store.close());
  const keys = reviewerKeys(), pl = pipeline(f0, opts.noKeys ? null : keys), it = pl.work_items[0], fixtures = [];
  const provision = provisioner({ t, cas, store, mode: opts.mode, fixtures });
  const readLedger = (now = Date.now()) => new Ledger(cas.backend, f0.config).read(now);
  const recover = (now = Date.now()) => R46.recover({ simulate: true, config: f0.config, trigger: T.tick(now, f0.config), backend: cas.backend, now });
  // One bridge pass at an injectable clock (lease-expiry drills use now + lease).
  const step = (trigger, extra = {}) => { const now = extra.now || Date.now(); return Bridge.step({ mode: 'fake', pipeline: extra.pipeline || pl, item: extra.item || it, trigger,
    readSnapshot: () => em.client.snapshot(extra.pipeline || pl, extra.item || it, now), readLedger: () => readLedger(now), provision: extra.provision || provision, recover: () => recover(now),
    report: (issue, body) => em.client.report(issue, body), now, ...extra }); };
  const launches = () => fixtures.reduce((n, f) => n + f.cli.launches(), 0);
  return { f0, cas, em, store, keys, pipeline: pl, item: it, fixtures, provision, readLedger, recover, step, launches,
    event: (o = {}) => eventTrigger(f0, store, o), tick: (now = Date.now()) => tickTrigger(now),
    seedCandidate: () => seedCandidate(em, f0, it), seedCi: o => seedCi(em, f0, it, o), seedReviews: o => seedReviews(em, f0, it, keys, Date.now(), o) };
}
module.exports = { world, emulator, transport, pipeline, item, readyBody, verdictBody, reviewerKeys, seedCandidate, seedCi, seedReviews, provisioner, eventTrigger, tickTrigger, pem };
