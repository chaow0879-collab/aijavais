'use strict';
// Separate OS process running ONE R56 bridge pass against the shared local GitHub emulator, the shared
// Git-ref CAS service and the shared R50 SQLite store. Synthetic material only; no host credentials.
const fs = require('node:fs');
const W = require('./world.cjs');
const { setup } = require('../first-pilot-r51/helpers.cjs');
const { TriggerStore } = require('../../tools/trusted-trigger-r50/store');
const { FixtureGitHubState } = require('../../tools/first-pilot-r51/app-state');
const { Ledger } = require('../../tools/auto-handoff-r46/state');
const { GitHubFacts } = require('../../tools/event-handoff-r56/github');
const Bridge = require('../../tools/event-handoff-r56/bridge');
const C = require('../../tools/auto-handoff-r46/contract');
const x = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), kind = process.argv[3];
const cleanups = [], t = { after: fn => cleanups.push(fn) };
const f0 = setup(t, 'success', { runtime: 3000 });
const store = new TriggerStore(x.store);
const cas = { backend: new FixtureGitHubState(async (method, route, body) => { const r = await fetch(x.cas + route, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(2000) }); return { status: r.status, data: await r.json() }; }, 2500) };
const client = new GitHubFacts(W.transport(x.github), { repo: C.REPO, timeoutMs: 1500 });
const fixtures = [];
const provision = W.provisioner({ t, cas, store, mode: x.mode || 'success', fixtures });
(async () => {
  let out;
  try {
    const trigger = kind === 'event' ? W.eventTrigger(f0, store, { delivery: x.delivery }) : W.tickTrigger(Date.now());
    const it = x.pipeline.work_items[0];
    out = await Bridge.step({ mode: 'fake', pipeline: x.pipeline, item: it, trigger, readSnapshot: () => client.snapshot(x.pipeline, it, Date.now()), readLedger: () => new Ledger(cas.backend, f0.config).read(Date.now()), provision, report: (i, b) => client.report(i, b), now: Date.now() });
  } catch (e) { out = { state: 'BLOCKED', reason: e && e.code || 'WORKER_ERROR' }; }
  out.fake_launches = fixtures.reduce((n, f) => n + f.cli.launches(), 0); out.pid = process.pid;
  console.log(JSON.stringify(out));
  store.close(); for (const fn of cleanups) { try { fn(); } catch { /* temp cleanup */ } }
})();
