'use strict';
// R56 owns trigger -> work-ticket decisions; R57 owns final receipt validation.
// This adapter is the only glue. Neither owner's original module is replaced.
const Control = require('./control');
const { publicClone, boundedBackend } = require('../first-pilot-r51/entry');
const C = require('../auto-handoff-r46/contract');
const blocked = reason => ({ state: 'BLOCKED', reason, next_allowed: false, actual_agent_launches: 0, evidence: 'E3_FAKE_ONLY' });
const call = fn => boundedBackend({ read: fn }, 1500).read();
async function currentGate(input, envelope, now) {
  const f = require('../event-handoff-r56/facts').read(await call(input.readSnapshot), input.pipeline, input.item, now);
  return f.candidate === envelope.source_sha && f.branch_sha === envelope.source_sha && !f.withdrawn && !f.revoked &&
    !f.reviews.audit.negative.length && !f.reviews.qa.negative.length && !f.independence && !!f.ci.green &&
    f.reviews.audit.accepted?.ref === envelope.audit_refs.audit && f.reviews.qa.accepted?.ref === envelope.audit_refs.qa;
}
async function step(input = {}) {
  if (Object.getOwnPropertyDescriptor(input, 'mode')?.value !== 'fake') return Control.runOnce(input);
  try {
    const Bridge = require('../event-handoff-r56/bridge');
    const pipelineHash = C.digest({ pipeline: publicClone(input.pipeline), item: publicClone(input.item) });
    const result = await Bridge.step({ ...input,
      readSnapshot: () => call(input.readSnapshot), readLedger: () => call(input.readLedger),
      provision: async (ticket, trigger) => {
        const prepared = await call(() => input.provision(publicClone(ticket), trigger));
        const envelope = prepared.packet?.base?.envelope;
        if (prepared.collectionPolicy?.r56_pipeline_digest !== pipelineHash) throw Object.assign(Error('R56_POLICY_NOT_AUTHORIZED'), { code: 'R56_POLICY_NOT_AUTHORIZED' });
        return { envelope, launch: async () => {
          const parent = ticket.after ? await call(() => input.lookupCompleted(ticket.after)) : null;
          const packet = trigger.kind === 'github_webhook'
            ? { ...prepared.packet, kind: 'verified-event', record: trigger } : prepared.packet;
          const authorityCheck = async now => pipelineHash === C.digest({ pipeline: publicClone(input.pipeline), item: publicClone(input.item) }) &&
            await currentGate(input, envelope, now) && (typeof prepared.authorityCheck !== 'function' || await prepared.authorityCheck(now) === true);
          const r = await Control.runOnce({ ...prepared, packet, mode: 'fake', parentEnvelope: parent?.packet?.base?.envelope, signal: input.signal, authorityCheck });
          // Only a fully collected/gated R57 result is reported as STAGE_SUCCEEDED.
          return r.state === 'DONE' ? { ...r.execution, r57: { state: r.state, receipt: r.collected.receipt } }
            : { state: r.state, reason: r.reason, r50: r.execution?.r50, outcome: r.execution?.outcome, r57: { state: r.state } };
        } };
      }
    });
    if (result.state !== 'HANDOFF_COMPLETE') return result;
    // R56's durable SUCCEEDED means execution settled, not final acceptance.
    // Re-read every completion so a last-stage missing review cannot turn into
    // HANDOFF_COMPLETE merely because all R46 jobs are SUCCEEDED.
    const completions = [];
    for (const stage of result.decision.stages) {
      const item = await call(() => input.lookupCompleted(stage.key));
      if (item?.packet?.base?.envelope?.idempotency_key !== stage.key || C.identity(item.packet.base.envelope) !== stage.key) return blocked('COMPLETION_LOOKUP_BINDING');
      const check = await Control.collectCompleted({ ...item, mode: 'fake' });
      if (check.state !== 'DONE') return { ...check, next_allowed: false, r56_execution_state: 'HANDOFF_COMPLETE', reason: check.reason || 'WAIT_FINAL_RECEIPTS' };
      completions.push(check.collected.receipt);
    }
    const last = await call(() => input.lookupCompleted(result.decision.stages.at(-1).key));
    if (!await currentGate(input, last.packet.base.envelope, Date.now())) return blocked('R56_FINAL_GATE_CHANGED');
    return { ...result, r57_completed_receipts: completions, manual_prompt_transfers: 0, real_agent_wake: 'NOT_VERIFIED' };
  } catch (error) { return blocked(/^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'R56_R57_ADAPTER_UNVERIFIED'); }
}
module.exports = { step };
