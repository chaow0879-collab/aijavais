'use strict';
// Reasoning ("thinking") model handling for OpenAI-compatible chat streams. Pure: no network, no state.
//
// Budget invariant this module protects: the provider's total completion tokens (reasoning + answer)
// must not exceed outputBound(baseUrl, cap), because lib/budget.js reserves cost for exactly that many
// output tokens before dispatch (and stops the workflow if a provider still overruns it). Providers differ:
//   - DeepSeek: max_tokens already includes reasoning (bounded), but reasoning can use all of it and
//     leave an empty answer (finish_reason "length"). Nothing to shape; callers detect the empty answer.
//   - DashScope (Qwen thinking models): max_tokens limits only the answer; thinking is limited separately
//     by thinking_budget. Measured 2026-11-10: max_tokens=100 returned 3326 completion tokens (3255
//     reasoning). The answer keeps the full approved cap (non-thinking models are unaffected, AUD-FE6C-02)
//     and thinking gets half of it; the budget reserves cap + thinking (outputBound) for this profile.
// New providers are added as PROFILES entries (the extension hook); unknown hosts are left unchanged.
const THINK_SHARE = 0.5;
const PROFILES = Object.freeze([
  Object.freeze({
    id: 'dashscope-thinking-budget',
    match: host => /(^|\.)dashscope(-intl|-us)?\.aliyuncs\.com$/.test(host),
    think: cap => Math.floor(cap * THINK_SHARE),
    shape(body, cap) {
      const think = this.think(cap);
      body.max_tokens = cap;
      if (think < 1) { body.enable_thinking = false; return; }
      body.thinking_budget = think;
    },
  }),
]);
function hostOf(baseUrl) {
  try { return new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; }
}
// Test-only hosts (non-production): lets MOCK providers on loopback exercise the DashScope profile end to end.
let testHosts = new Set();
function configure({ testHosts: hosts } = {}) { testHosts = new Set((hosts || []).map(h => String(h).toLowerCase())); }
function profileFor(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return null;
  return PROFILES.find(p => p.match(host)) || (testHosts.has(host) ? PROFILES[0] : null);
}
// Worst-case completion tokens (answer + thinking) for an approved per-call cap: what the budget must reserve.
function outputBound(baseUrl, cap) {
  const profile = profileFor(baseUrl);
  return profile && profile.think ? cap + profile.think(cap) : cap;
}
// Mutates an OpenAI-compatible request body so total completion stays within outputBound(baseUrl, cap)
// (assuming the provider honours max_tokens and thinking_budget). Returns the profile id or null.
function shapeOpenAIBody(baseUrl, body, cap) {
  const profile = profileFor(baseUrl);
  if (!profile || !Number.isSafeInteger(cap) || cap < 1) return null;
  profile.shape(body, cap);
  return profile.id;
}
// Reasoning tokens reported inside usage (a subset of completion_tokens), or undefined when not reported.
function reasoningTokens(usage) {
  const n = usage?.completion_tokens_details?.reasoning_tokens;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
module.exports = { PROFILES, THINK_SHARE, configure, profileFor, outputBound, shapeOpenAIBody, reasoningTokens };
