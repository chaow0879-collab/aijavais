'use strict';
// GitHub webhook intake. Reuses R46's verifier (HMAC-SHA256 over the raw body, repository
// full name + id, no forks, allow-listed sender, workflow_run source checks) and adds what
// R46 does not do: GitHub header shape, a narrower event/action allow-list, App installation
// binding, freshness, and durable replay refusal by delivery id. Issue text is never parsed
// as an instruction or approval; it only wakes the same reconcile path as the 10-min tick.
const crypto = require('node:crypto');
const T = require('../auto-handoff-r46/triggers');
const { mint, reject } = require('./identity');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = { issue_comment: ['created'], workflow_run: ['completed'] };
const lower = h => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [String(k).toLowerCase(), Array.isArray(v) ? v[0] : v]));

function verifyDelivery({ headers, body }, { secret, r46config, policy, store, now }) {
  const h = lower(headers);
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : '', 'utf8');
  if (!raw.length || raw.length > policy.max_body_bytes) reject('BODY_SIZE');
  if (!/^GitHub-Hookshot\//.test(h['user-agent'] || '') || !/^application\/json\b/.test(h['content-type'] || '')) reject('NOT_A_GITHUB_DELIVERY');
  const event = h['x-github-event'], delivery = h['x-github-delivery'], signature = h['x-hub-signature-256'];
  if (!UUID.test(delivery || '') || !Object.hasOwn(ACTIONS, event || '')) reject('EVENT_NOT_ALLOWED');
  // R46: constant-time HMAC, repo name/id, fork, sender, PR-sourced workflow_run, issue scope.
  let trigger;
  try { trigger = T.webhook({ body: raw.toString('utf8'), signature, delivery, event, secret }, r46config, now); }
  catch (e) { reject(e.code === 'UNTRUSTED_EVENT' ? 'BAD_SIGNATURE' : e.code || 'UNTRUSTED_EVENT'); }
  const p = JSON.parse(raw.toString('utf8'));
  if (!ACTIONS[event].includes(p.action)) reject('ACTION_NOT_ALLOWED');
  if (policy.installation_id !== null && p.installation?.id !== policy.installation_id) reject('INSTALLATION_MISMATCH');
  const stamp = Date.parse(event === 'issue_comment' ? p.comment?.created_at : p.workflow_run?.updated_at);
  if (!Number.isFinite(stamp) || stamp > now + policy.clock_skew_ms || now - stamp > policy.max_event_age_ms) reject('STALE_OR_FUTURE_EVENT');
  // Replay refusal happens last, so a forged or out-of-scope delivery cannot burn a real id.
  const id = crypto.createHash('sha256').update(delivery).digest('hex');
  if (!store.claimDelivery(id, event, now)) reject('REPLAYED_DELIVERY');
  store.audit('event_accepted', { event, action: p.action, delivery_hash: id.slice(0, 16), sender: p.sender?.login }, now);
  return mint({ kind: 'github_webhook', trigger, event, action: p.action, delivery_hash: id, sender: p.sender.login, repository_id: p.repository.id, installation_id: p.installation?.id ?? null, received_at: now });
}
module.exports = { verifyDelivery, ACTIONS };
