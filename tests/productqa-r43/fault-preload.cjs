'use strict';
// Test-only runtime fault fixture. No source file is modified. All targets are
// disposable loopback servers; these hooks never enable a production endpoint.
const fs = require('node:fs');
const path = require('node:path');
if (process.env.QA_GAPS_TEST_PROCESS !== '1') throw Error('ProductQA fixture requires an explicit isolated test process');
const { ProjectStore } = require('../../lib/project-store');
const { IntakeDraftService } = require('../../lib/intake-draft');
const mode = process.env.QA_GAPS_FAULT || '';
function checkpoint(phase, ledgerId) {
  fs.writeFileSync(path.join(process.env.AIJ_DATA_DIR, 'qa-checkpoint.json'), JSON.stringify({ phase, ledgerId, pid: process.pid, at: Date.now() }));
  // Hold exactly this synchronous, committed crash window. The test controller
  // sends SIGKILL; a 30-second guard prevents an orphaned fixture running forever.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  throw Error('QA crash-window controller did not send SIGKILL');
}
if (mode === 'settlement-failure') {
  const original = ProjectStore.prototype.settleSystemUsage;
  ProjectStore.prototype.settleSystemUsage = function (ledgerId, usage) {
    if (usage.kind === 'intake_draft') throw Error('QA synthetic settlement disk-full');
    return original.call(this, ledgerId, usage);
  };
}
if (mode === 'claimed' || mode === 'dispatch-marker') {
  const original = ProjectStore.prototype.markModelRequestDispatching;
  ProjectStore.prototype.markModelRequestDispatching = function (ledgerId) {
    if (mode === 'claimed') checkpoint('claimed-before-dispatch-marker', ledgerId);
    const result = original.call(this, ledgerId);
    checkpoint('dispatch-marker-before-network', ledgerId);
    return result;
  };
}
if (mode === 'ignore-abort') {
  const original = IntakeDraftService.prototype._generate;
  IntakeDraftService.prototype._generate = function (prepared, operation) {
    if (!this.qaAdversarialAdapterInstalled) {
      this.qaAdversarialAdapterInstalled = true;
      const actualHttpAdapter = this.callModel;
      // Keep real production HTTP/SSE parsing, but deliberately remove the
      // caller's signal to model a non-cooperative provider adapter. This does
      // NOT claim that the normal production adapter ignores cancellation.
      this.callModel = (runtime, options) => actualHttpAdapter(runtime, { ...options, signal: undefined });
    }
    return original.call(this, prepared, operation);
  };
}
