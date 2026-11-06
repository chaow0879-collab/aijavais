'use strict';
// M3: control-plane seam. A FAKE control plane (stand-in for Codex R46, not its code) turns
// a GitHub event and the 10-minute fallback tick for the same work into signed envelopes;
// this runner starts the (fake) CLI once and returns one settlement. Evidence: E3_FAKE.
// No real GitHub event, cron or dispatch is involved (those are NOT_ENABLED here).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { acceptDispatch, toControlPlaneResult } = require('../../tools/agent-pilot-r45/handoff');
const C = require('../../tools/agent-pilot-r45/contract');
const H = require('./helpers.cjs');

// Minimal fake control plane with a fake clock: event now, fallback tick every 10 minutes.
function fakeControlPlane(start) {
  let now = start;
  const pending = [{ work: 'pilot-1', source_sha: H.HEAD }];
  return {
    advance: ms => { now += ms; },
    envelopesFor: (kind, eventId) => pending.map(p => ({ envelope: H.envelope({
      dispatch_id: 'dsp-' + kind + '-' + eventId, trigger: { kind, event_id: eventId },
      issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 1800000).toISOString() }) })),
    now: () => now
  };
}

test('GitHub event + 10-minute fallback ticks for the same work start the CLI once; settlements agree', async t => {
  const dir = H.tmp(t), cli = H.fakeCli(dir, 'success'), stateDir = path.join(dir, 'state');
  const cp = fakeControlPlane(Date.now());
  const opts = () => ({ policy: H.policy(), stateDir, sourceRepo: H.ROOT, mode: 'fake', fakeExecutable: cli.file, now: cp.now() });
  const [evt] = cp.envelopesFor('github_event', 'issue_comment-1');
  const first = await acceptDispatch(evt, opts());
  assert.equal(first.settlement.state, 'SUCCESS'); assert.equal(first.settlement.redispatch, 'never');
  // The same GitHub event delivered again within its validity window (webhook redelivery).
  const results = [first.settlement, (await acceptDispatch(evt, opts())).settlement];
  for (let i = 1; i <= 3; i++) {
    cp.advance(10 * 60 * 1000);
    const [tick] = cp.envelopesFor('fallback_tick', 'tick-' + i);
    results.push((await acceptDispatch(tick, opts())).settlement);
  }
  // A stale redelivery after the envelope expired is refused outright (still nothing started).
  const stale = (await acceptDispatch(evt, opts())).settlement;
  assert.deepEqual([stale.state, stale.reason], ['REJECTED', 'ENVELOPE_EXPIRED']);
  assert.equal(cli.launches(), 1, 'exactly one CLI start for one piece of work');
  assert.deepEqual(results.slice(1).map(r => r.state), ['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE']);
  assert.ok(results.every(r => r.dedupe_key === first.settlement.dedupe_key && r.terminal === true && r.redispatch === 'never'));
  assert.ok(results.slice(1).every(r => r.previous_run_id === first.settlement.run_id));
  assert.equal(first.settlement.real_agent_launch, false); assert.equal(first.settlement.actual_agent_launches, 0);
  assert.equal(first.settlement.source_sha, H.HEAD); assert.equal(first.settlement.cost_known, true);
});

test('tick arrives first, event later, then the runner restarts: still one start', async t => {
  const dir = H.tmp(t), cli = H.fakeCli(dir, 'success'), stateDir = path.join(dir, 'state');
  const cp = fakeControlPlane(Date.now());
  const opts = () => ({ policy: H.policy(), stateDir, sourceRepo: H.ROOT, mode: 'fake', fakeExecutable: cli.file, now: cp.now() });
  const [tick] = cp.envelopesFor('fallback_tick', 'tick-a');
  assert.equal((await acceptDispatch(tick, opts())).settlement.state, 'SUCCESS');
  cp.advance(30000);
  const [evt] = cp.envelopesFor('github_event', 'late-event');
  assert.equal((await acceptDispatch(evt, opts())).settlement.state, 'DUPLICATE');
  // "Restart": a brand-new process would build a new Journal on the same private state dir.
  delete require.cache[require.resolve('../../tools/agent-pilot-r45/journal')];
  assert.equal((await acceptDispatch(evt, opts())).settlement.state, 'DUPLICATE');
  assert.equal(cli.launches(), 1);
});

test('failures settle once and are never redispatched; refused dispatches never start anything', async t => {
  const dir = H.tmp(t), cli = H.fakeCli(dir, 'unauth'), stateDir = path.join(dir, 'state');
  const opts = { policy: H.policy(), stateDir, sourceRepo: H.ROOT, mode: 'fake', fakeExecutable: cli.file };
  const e = { envelope: H.envelope() };
  const a = (await acceptDispatch(e, opts)).settlement;
  assert.deepEqual([a.state, a.reason, a.retry, a.redispatch], ['FAILED', 'AUTH_FAILED', 'never', 'never']);
  assert.equal((await acceptDispatch({ envelope: H.envelope({ trigger: { kind: 'fallback_tick', event_id: 't' } }) }, opts)).settlement.state, 'DUPLICATE');
  const refused = (await acceptDispatch({ envelope: H.envelope({ gate: { qa: { verdict: 'FAIL' } } }) }, opts)).settlement;
  assert.deepEqual([refused.state, refused.reason, refused.retry], ['REJECTED', 'MISSING_OR_FAILED_QA', 'never']);
  assert.equal(cli.launches(), 1);
  await assert.rejects(acceptDispatch(null, opts), /INVALID_DECISION/);
});

test('settlement refuses malformed outcomes (the control plane only ever sees validated results)', () => {
  const o = C.makeOutcome({ state: 'SUCCESS', retry: 'none' });
  assert.equal(toControlPlaneResult(o).state, 'SUCCESS');
  assert.throws(() => toControlPlaneResult({ ...o, cost: { known: true, usd: null } }), /INVALID_OUTCOME/);
  assert.throws(() => toControlPlaneResult({ ...o, agent_launch: { real_agent_launch: true, actual_agent_launches: 0 } }), /INVALID_OUTCOME/);
});
