'use strict';
// GitHub Actions OIDC caller identity for the scheduled 10-minute fallback (and any
// default-branch workflow). Real RS256 verification against a JWKS the caller provides;
// fetching GitHub's JWKS and requesting tokens needs a real default-branch workflow with
// `id-token: write`, which is NOT available here -> BLOCKED_IDENTITY_PROVIDER.
const crypto = require('node:crypto');
const { mint, reject } = require('./identity');
const ISSUER = 'https://token.actions.githubusercontent.com';
const b64 = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function verifyOidc(token, { jwks, policy, now }) {
  if (!jwks || !Array.isArray(jwks.keys) || !jwks.keys.length) reject('BLOCKED_IDENTITY_PROVIDER');
  if (typeof token !== 'string' || token.length > 8192) reject('OIDC_MALFORMED');
  const parts = token.split('.');
  if (parts.length !== 3) reject('OIDC_MALFORMED');
  let header, claims;
  try { header = JSON.parse(b64(parts[0]).toString('utf8')); claims = JSON.parse(b64(parts[1]).toString('utf8')); } catch { reject('OIDC_MALFORMED'); }
  if (header.alg !== 'RS256') reject('OIDC_ALG'); // no "none", no HS256 key confusion
  const jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (k.use === undefined || k.use === 'sig'));
  if (!jwk) reject('OIDC_UNKNOWN_KEY');
  let ok = false;
  try { ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64(parts[2])); } catch { ok = false; }
  if (!ok) reject('OIDC_SIGNATURE');
  const sec = Math.floor(now / 1000), skew = Math.ceil(policy.clock_skew_ms / 1000);
  if (claims.iss !== ISSUER) reject('OIDC_ISSUER');
  if ((Array.isArray(claims.aud) ? !claims.aud.includes(policy.oidc_audience) : claims.aud !== policy.oidc_audience)) reject('OIDC_AUDIENCE');
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= sec || !Number.isSafeInteger(claims.iat) || claims.iat > sec + skew || (claims.nbf !== undefined && claims.nbf > sec + skew)) reject('OIDC_TIME');
  if (claims.repository !== policy.repo || String(claims.repository_id) !== String(policy.repository_id)) reject('OIDC_REPOSITORY');
  if (claims.ref !== 'refs/heads/' + policy.default_branch || claims.ref_type !== 'branch') reject('OIDC_REF');
  if (!['schedule', 'workflow_dispatch', 'workflow_run', 'issue_comment'].includes(claims.event_name)) reject('OIDC_EVENT'); // never pull_request*
  if (claims.workflow_ref !== policy.trusted_workflow_ref || claims.runner_environment !== 'github-hosted') reject('OIDC_WORKFLOW');
  if (!/^[a-f0-9]{40}$/.test(claims.sha || '')) reject('OIDC_SHA');
  return mint({ kind: 'github_actions_oidc', repository: claims.repository, repository_id: String(claims.repository_id), ref: claims.ref, sha: claims.sha, event_name: claims.event_name, workflow_ref: claims.workflow_ref, run_id: String(claims.run_id || ''), synthetic: jwks.synthetic === true });
}
module.exports = { verifyOidc, ISSUER };
