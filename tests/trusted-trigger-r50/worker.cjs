'use strict';
// Separate OS process for the E3 drill: either a loopback webhook receiver ("event") or a
// scheduled fallback run ("tick"). Both share only: the authoritative HTTP/SQLite CAS
// service, the R50 SQLite store, the R45 state dir and a synthetic signer seed file in the
// test's private temp dir. Nothing here can reach GitHub, a model or a real credential.
const fs = require('node:fs');
const { serve } = require('../../tools/trusted-trigger-r50/server');
const { TriggerStore } = require('../../tools/trusted-trigger-r50/store');
const { Broker, TestSigner } = require('../../tools/trusted-trigger-r50/broker');
const { verifyOidc } = require('../../tools/trusted-trigger-r50/oidc');
const { handle, tickRecord } = require('../../tools/trusted-trigger-r50/pipeline');

const [mode, file] = process.argv.slice(2);
const x = JSON.parse(fs.readFileSync(file, 'utf8'));
const backend = {
  async read() { const r = await fetch(x.cas + '/state', { signal: AbortSignal.timeout(3000) }); if (!r.ok) throw Object.assign(Error('read'), { status: r.status }); return r.json(); },
  async compareAndSwap(version, document) { const r = await fetch(x.cas + '/cas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version, document }), signal: AbortSignal.timeout(3000) }); if (!r.ok) throw Object.assign(Error('cas'), { status: r.status }); return r.json(); }
};
const store = new TriggerStore(x.store);
const broker = new Broker({ signer: new TestSigner({ testOnly: true, seed: Buffer.from(fs.readFileSync(x.seed, 'utf8'), 'hex') }), policy: x.r50, store });
const base = { ...x.base, backend };
(async () => {
  if (mode === 'tick') {
    let record;
    try { record = tickRecord(verifyOidc(x.oidc, { jwks: x.jwks, policy: x.r50, now: x.now }), x.now, x.base.config); } catch (e) { record = null; }
    const r = await handle({ record, base, broker, approval: x.approval, now: x.now });
    console.log(JSON.stringify({ mode, pid: process.pid, ...r }));
  } else {
    const s = await serve({ secret: x.secret, r46config: x.r46config, policy: x.r50, store, clock: () => x.now,
      onTrigger: async record => { const r = await handle({ record, base, broker, approval: x.approval, now: x.now }); setImmediate(() => s.server.close()); return r; } });
    console.log(JSON.stringify({ url: s.url, pid: process.pid }));
  }
})().catch(() => { process.exitCode = 1; });
