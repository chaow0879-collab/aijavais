'use strict';
// TEST-ONLY bridge between frozen R46 (control plane) and frozen R45 (one-shot runner).
// It proves which minimal deltas a future integrator must implement; it is NOT a broker,
// scheduler, runner or authorization system and must never be wired into a live path.
const crypto = require('node:crypto');

const TEST_KEY_PREFIX = 'r48-test-broker-'; // no production policy may ever trust this prefix
const privateKeys = new WeakMap();           // keys live only inside this process, never exported

class TestBroker {
  constructor({ testOnly } = {}) {
    if (testOnly !== true) throw Error('R48_TEST_BROKER_REQUIRES_EXPLICIT_TEST_ONLY');
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKeys.set(this, pair.privateKey);
    this.keyId = TEST_KEY_PREFIX + crypto.randomBytes(6).toString('hex');
    this.publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
    Object.freeze(this);
  }
  // R45 trust entry for an in-memory test policy (never written to a file).
  trustEntry() { return { [this.keyId]: { pem: this.publicPem, roles: ['dispatcher'] } }; }
  sign(frame, canonical) {
    const body = { ...frame }; delete body.signature;
    return { ...body, signature: { key_id: this.keyId, alg: 'ed25519', value: crypto.sign(null, Buffer.from(canonical(body)), privateKeys.get(this)).toString('base64') } };
  }
}
// R46 prepare() output -> R45 envelope. Without a trusted broker the honest answer is BLOCKED.
function toR45(prepared, { broker, canonical } = {}) {
  if (!prepared || prepared.evidence !== 'E2_E3_FAKE' || prepared.signature_status !== 'NOT_SIGNED' || !prepared.unsigned_envelope) throw Error('R48_NOT_AN_R46_FAKE_FRAME');
  if (!broker) return { status: 'BLOCKED_TRUSTED_SIGNATURE_BROKER', envelope: null };
  if (!(broker instanceof TestBroker)) throw Error('R48_ONLY_TEST_BROKER_SUPPORTED');
  return { status: 'SIGNED_BY_TEST_BROKER', envelope: broker.sign(prepared.unsigned_envelope, canonical) };
}
// R45 outcome -> shape R46 normalize() accepts. Proposed minimal delta, exactly two fields:
// evidence.level 'E3_FAKE_CLI' -> 'E3_FAKE' (same fake tier) and process.exit_code -> process.exit.
// Never relabels a real/live launch as fake, never invents states R46 does not have.
const FAKE_LEVELS = { E2: 'E2', E3_FAKE_CLI: 'E3_FAKE' };
function toR46(outcome) {
  if (!outcome || typeof outcome !== 'object') throw Error('R48_NOT_AN_OUTCOME');
  if (outcome.agent_launch?.real_agent_launch !== false || outcome.agent_launch?.actual_agent_launches !== 0) throw Error('R48_REAL_OUTCOME_NOT_MAPPABLE');
  if (!Object.hasOwn(FAKE_LEVELS, outcome.evidence?.level)) throw Error('R48_REAL_OUTCOME_NOT_MAPPABLE');
  if (['DUPLICATE', 'DRY_RUN'].includes(outcome.state)) return { status: 'BLOCKED_R46_STATE_UNMAPPED', state: outcome.state, previous_run_id: outcome.evidence?.previous_run_id || null };
  const mapped = structuredClone(outcome);
  mapped.evidence.level = FAKE_LEVELS[outcome.evidence.level];
  if (mapped.process) mapped.process.exit = outcome.process.exit_code;
  return { status: 'MAPPED', outcome: mapped };
}
module.exports = { TestBroker, toR45, toR46, TEST_KEY_PREFIX };
