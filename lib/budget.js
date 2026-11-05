'use strict';
// Shared model-call policy. Pure calculations: callers persist reservations
// before dispatch and commit usage/ledger together after dispatch. No network,
// tools, credentials or project lifecycle live in this module.
const SEC = require('./security');
class BudgetError extends Error {
  constructor(message, code = 'invalid', status = 400) { super(message); this.name = 'BudgetError'; this.code = code; this.status = status; }
}
function number(v, fallback, min, max, label) {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new BudgetError(`${label} must be between ${min} and ${max}`);
  return n;
}
function isLocalFree(connection, policy) {
  if (connection.pricingMode !== 'local') return false;
  try {
    const u = new URL(connection.baseUrl), host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const target = (host.includes(':') ? `[${host}]` : host) + ':' + port;
    return (host === 'localhost' || SEC.classifyIp(host) === 'loopback') && policy?.localTargets?.has(target) === true;
  } catch { return false; }
}
function authorizeModels({ connections, policy, input = {} }) {
  const allowedTools = input.allowedTools === undefined ? [] : input.allowedTools;
  if (!Array.isArray(allowedTools) || allowedTools.length > 100) throw new BudgetError('list must contain at most 100 items');
  const approval = { approvePaid: input.approvePaid === true,
    maxCost: number(input.maxCost, 0, 0, 10000, 'maxCost'),
    maxTokens: Math.floor(number(input.maxTokens, 32000, 1, 1000000, 'maxTokens')),
    maxOutputTokens: Math.floor(number(input.maxOutputTokens, 2048, 1, 8192, 'maxOutputTokens')),
    allowedTools: allowedTools.map(v => {
      if (v === null || v === undefined) return '';
      if (typeof v !== 'string' || v.length > 200) throw new BudgetError('list item must be text of at most 200 characters');
      return v.trim();
    }).filter(Boolean), prices: {}, targets: {}, approvedAt: Date.now() };
  if (input.prices !== undefined && (!input.prices || typeof input.prices !== 'object' || Array.isArray(input.prices))) throw new BudgetError('prices must be a model ID to rate map');
  for (const c of connections) {
    if (!c) continue;
    approval.targets[c.connectionId] = { baseUrl: c.baseUrl, modelId: c.modelId, protocol: c.protocol, pricingMode: c.pricingMode, updatedAt: c.updatedAt };
    if (isLocalFree(c, policy)) continue;
    if (!approval.approvePaid) throw new BudgetError('Explicit per-run approval is required for paid, free-tier-unverified or unknown remote APIs', 'paid_approval_required', 402);
    if (!(approval.maxCost > 0)) throw new BudgetError('A positive maxCost is required', 'budget_required', 402);
    const price = input.prices?.[c.connectionId];
    if (!price || (price.currency && price.currency !== 'USD')) throw new BudgetError(`USD input/output rates are required for ${c.connectionId}`, 'price_required', 402);
    const inputPerMillion = number(price.inputPerMillion, undefined, 0, 1000000, 'inputPerMillion');
    const outputPerMillion = number(price.outputPerMillion, undefined, 0, 1000000, 'outputPerMillion');
    if (!(inputPerMillion > 0 || outputPerMillion > 0)) throw new BudgetError('Zero or unknown remote rates cannot bypass cost approval', 'price_required', 402);
    approval.prices[c.connectionId] = { inputPerMillion, outputPerMillion, currency: 'USD' };
  }
  return approval;
}
function initialUsage() { return { providerTokens: 0, estimatedTokens: 0, cost: 0, reservedCost: 0, reservedTokens: 0, usedTokens: 0, currency: 'USD' }; }
function reserveCall({ approval, usage, connection, policy, system, prompt }) {
  const target = approval.targets[connection.connectionId];
  if (!target || Object.entries(target).some(([key, value]) => connection[key] !== value)) throw new BudgetError('Model configuration changed after authorization; start a newly approved run', 'model_changed', 409);
  if (!isLocalFree(connection, policy) && (!approval.approvePaid || !approval.prices[connection.connectionId])) throw new BudgetError('Remote call is not authorized by this run', 'paid_approval_required', 402);
  const inputTokensBound = Buffer.byteLength(system + prompt, 'utf8') + 256;
  const outputTokensBound = approval.maxOutputTokens, tokenBound = inputTokensBound + outputTokensBound;
  const price = approval.prices[connection.connectionId];
  const costBound = price ? (inputTokensBound * price.inputPerMillion + outputTokensBound * price.outputPerMillion) / 1e6 : 0;
  const roundTokens = usage.usedTokens - (usage.roundStartTokens || 0), roundCost = usage.cost - (usage.roundStartCost || 0);
  if (roundTokens + usage.reservedTokens + tokenBound > approval.maxTokens) throw new BudgetError('Token budget cannot cover this call; no request sent', 'token_budget_exceeded', 402);
  if (roundCost + usage.reservedCost + costBound > approval.maxCost) throw new BudgetError('Cost budget cannot cover this call; no request sent', 'cost_budget_exceeded', 402);
  return { reservation: { tokenBound, costBound, inputTokensBound, outputTokensBound, price },
    usage: { ...usage, reservedTokens: usage.reservedTokens + tokenBound, reservedCost: usage.reservedCost + costBound } };
}
function settleCall({ usage, connectionId, roleId, reservation, result, failed = false, error }) {
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const known = result && validCount(result.tokens) && (result.inTokens === undefined || validCount(result.inTokens)) && (result.outTokens === undefined || validCount(result.outTokens));
  const estimated = !known || result.estimated === true, tokens = known ? result.tokens : reservation.tokenBound;
  const inputTokens = known && Number.isFinite(result.inTokens) ? result.inTokens : undefined;
  const outputTokens = known && Number.isFinite(result.outTokens) ? result.outTokens : undefined;
  const complete = !estimated && result.usageComplete !== false && inputTokens !== undefined && outputTokens !== undefined && inputTokens + outputTokens === tokens;
  const cost = reservation.price ? (complete ? (inputTokens * reservation.price.inputPerMillion + outputTokens * reservation.price.outputPerMillion) / 1e6 : reservation.costBound) : 0;
  const budgetTokens = complete ? tokens : Math.max(tokens, reservation.tokenBound);
  return {
    usage: { ...usage, usedTokens: usage.usedTokens + budgetTokens, cost: usage.cost + cost,
      providerTokens: usage.providerTokens + (estimated ? 0 : tokens), estimatedTokens: usage.estimatedTokens + (estimated ? budgetTokens : budgetTokens - tokens),
      reservedTokens: Math.max(0, usage.reservedTokens - reservation.tokenBound), reservedCost: Math.max(0, usage.reservedCost - reservation.costBound) },
    entry: { roleId, connectionId, tokens, budgetTokens, inputTokens, outputTokens,
      tokenSource: estimated ? (known ? 'estimated' : 'reserved_unknown') : (complete ? 'provider' : 'provider_partial'), cost,
      costSource: complete ? 'provider_usage_x_user_rates' : 'conservative_reservation', currency: 'USD', prices: reservation.price || null, failed, ...(error ? { error } : {}) },
    complete, overrun: tokens > reservation.tokenBound || cost > reservation.costBound + 1e-9 ||
      (inputTokens !== undefined && inputTokens > reservation.inputTokensBound) || (outputTokens !== undefined && outputTokens > reservation.outputTokensBound),
  };
}
module.exports = { BudgetError, isLocalFree, authorizeModels, initialUsage, reserveCall, settleCall };
