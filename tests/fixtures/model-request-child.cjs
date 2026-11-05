'use strict';
// Test-only process/crash fixture. No model network request or real charge.
const fs = require('node:fs');
const path = require('node:path');
const { ProjectStore } = require('../../lib/project-store');
const { DatabaseSync } = require('node:sqlite');
const [mode, dir, requestId = 'crash-request', hash = 'a'.repeat(64)] = process.argv.slice(2);
const usage = { kind: 'intake_draft', requestId, connectionId: 'mock-model', modelId: 'MOCK-crash',
  tokens: null, cost: null, currency: 'USD', reservedTokens: 1800, reservedCost: 0.25,
  tokenUpperBound: 1800, costUpperBound: 0.25, approvePaid: true };
function send(value) { if (process.send) process.send(value); else process.stdout.write(JSON.stringify(value)); }
if (mode === 'try-open') {
  try { const store = new ProjectStore({ dir }); store.close(); send({ opened: true }); }
  catch (error) { send({ opened: false, code: error.code }); }
} else if (mode === 'sql-duplicate') {
  // Deliberately bypass the application lock in this test-only SQL client: the
  // PRIMARY KEY must independently stop another SQLite writer from inserting.
  const db = new DatabaseSync(path.join(dir, 'projects.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
  try {
    const row = db.prepare('SELECT * FROM model_requests WHERE request_id=?').get(requestId);
    const ledgerId = 'sql-child-' + process.pid;
    db.prepare('INSERT INTO system_usage VALUES(?,?,?)').run(ledgerId, Date.now(), JSON.stringify({ ...usage, ledgerId }));
    db.prepare('INSERT INTO model_requests(owner_id,kind,request_id,params_hash,state,ledger_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(row.owner_id, row.kind, row.request_id, row.params_hash, 'claimed', ledgerId, Date.now(), Date.now());
    db.exec('COMMIT'); send({ inserted: true });
  } catch (error) { db.exec('ROLLBACK'); send({ inserted: false, code: error.code, message: error.message }); }
  finally { db.close(); }
} else {
  const store = new ProjectStore({ dir });
  const reserved = store.claimModelRequest({ ownerId: 'crash-owner', kind: 'intake_draft', requestId, paramsHash: hash, usage });
  if (mode !== 'claimed') store.markModelRequestDispatching(reserved.ledgerId);
  if (mode === 'called') {
    const callModel = () => fs.appendFileSync(path.join(dir, 'mock-dispatch-count.txt'), 'dispatch\n', { mode: 0o600 });
    callModel();
  }
  send({ ready: true, ledgerId: reserved.ledgerId, mode });
  setInterval(() => {}, 1000); // Parent SIGKILLs; no graceful settlement/lock release.
}
