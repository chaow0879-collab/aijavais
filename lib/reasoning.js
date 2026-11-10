'use strict';
// Reasoning ("thinking") model handling for OpenAI-compatible chat streams. Pure: no network, no state.
//
// Budget invariant this module protects: the provider's total completion tokens (reasoning + answer)
// must not exceed the approved per-call output cap, because lib/budget.js reserves cost for exactly
// that many output tokens before dispatch. Providers differ:
//   - DeepSeek: max_tokens already includes reasoning (bounded), but reasoning can use all of it and
//     leave an empty answer (finish_reason "length"). Nothing to shape; callers detect the empty answer.
//   - DashScope (Qwen thinking models): max_tokens limits only the answer; thinking is limited separately
//     by thinking_budget. Measured 2026-11-10: max_tokens=100 returned 3326 completion tokens (3255
//     reasoning). So the approved cap is split between thinking_budget and max_tokens.
// New providers are added as PROFILES entries (the extension hook); unknown hosts are left unchanged.
const THINK_SHARE = 0.5;
const PROFILES = Object.freeze([
  Object.freeze({
    id: 'dashscope-thinking-budget',
    match: host => /(^|\.)dashscope(-intl|-us)?\.aliyuncs\.com$/.test(host),
    shape(body, cap) {
      const think = Math.floor(cap * THINK_SHARE);
      if (think < 1 || cap - think < 1) { body.enable_thinking = false; body.max_tokens = cap; return; }
      body.thinking_budget = think;
      body.max_tokens = cap - think;
    },
  }),
]);
function hostOf(baseUrl) {
  try { return new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; }
}
function profileFor(baseUrl) {
  const host = hostOf(baseUrl);
  return host ? PROFILES.find(p => p.match(host)) || null : null;
}
// Mutates an OpenAI-compatible request body so total completion stays within `cap`. Returns the profile id or null.
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
module.exports = { PROFILES, THINK_SHARE, profileFor, shapeOpenAIBody, reasoningTokens };
