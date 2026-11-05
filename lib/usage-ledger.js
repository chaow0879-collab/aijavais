'use strict';
/* Records model calls made outside project runs (connection tests) in the system ledger.
 * A failed write is never silent: it is written to the audit log (without any credential
 * or prompt content) and reported to the caller as recorded:false so the call is not
 * treated as fully accounted. Unknown cost stays null. */
function recordSystemCall({ store, audit = () => {} }, entry) {
  try {
    if (!store || typeof store.recordSystemUsage !== 'function') throw new Error('ledger unavailable');
    const doc = store.recordSystemUsage(entry);
    return { recorded: true, ledgerId: doc.ledgerId };
  } catch (e) {
    const safe = { kind: entry.kind, connectionId: entry.connectionId ?? null, modelId: entry.modelId ?? null, ok: entry.ok, tokens: entry.tokens ?? null, cost: entry.cost ?? null, reason: String(e?.code || e?.name || 'write_failed').slice(0, 40) };
    try { audit('usage_ledger_write_failed', safe); } catch { /* audit itself failing must not hide the flag below */ }
    return { recorded: false, warning: '本次模型调用的用量未能写入账本（已记录审计事件）；请视为未完整记账，不要当作零费用。' };
  }
}
module.exports = { recordSystemCall };
