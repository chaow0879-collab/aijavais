'use strict';
// Model unit prices for estimating and capping runs (B7e). Pure lookups, no network.
// Order of precedence: an administrator-entered price on the connection, then the built-in catalog
// (catalog/model-prices.v1.json, sourced and deliberately conservative). Anything else is unknown (null).
const CATALOG = require('../catalog/model-prices.v1.json');
const CURRENCIES = ['CNY', 'USD'];
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
// Validation for an administrator-entered price; returns an error string or null.
function invalid(price) {
  if (price === null || price === undefined) return null;
  if (typeof price !== 'object' || Array.isArray(price)) return '单价格式不正确';
  if (!CURRENCIES.includes(price.currency)) return '币种只能是 CNY 或 USD';
  if (!finite(price.inputPerMillion, 0, 100000) || !finite(price.outputPerMillion, 0, 100000)) return '单价必须是 0–100000 之间的数字（每百万 Token）';
  if (!(price.inputPerMillion > 0 || price.outputPerMillion > 0)) return '单价不能全为 0';
  return null;
}
function normalize(price) {
  if (!price) return null;
  return { currency: price.currency, inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion };
}
function catalogPrice(providerId, modelId) {
  const e = CATALOG.prices.find(p => p.providerId === providerId && p.modelIds.includes(modelId));
  return e ? { currency: e.currency, inputPerMillion: e.inputPerMillion, outputPerMillion: e.outputPerMillion, source: 'catalog', checkedAt: CATALOG.checkedAt } : null;
}
// B5-2: a model of a platform that HAS official catalog prices, but is not itself listed, gets an
// estimated price: the platform's most expensive listed model x2 (input and output separately).
// AUD-F100-01: this is an estimate, NOT a guaranteed upper bound on the vendor's real price; the user is
// told so. The server budget gates (approval, reservation, overspend stop) are unchanged but compute with
// this estimate, so if the vendor's real price is higher the real bill can exceed the confirmed cap. A platform with no catalog entry at all stays unknown and is never called.
const CEILING_FACTOR = 2;
function estimatedCeiling(providerId) {
  const list = CATALOG.prices.filter(p => p.providerId === providerId);
  if (!list.length) return null;
  const currency = list[0].currency;
  if (list.some(p => p.currency !== currency)) return null; // mixed currencies: no honest single ceiling
  return { currency, inputPerMillion: Math.max(...list.map(p => p.inputPerMillion)) * CEILING_FACTOR,
    outputPerMillion: Math.max(...list.map(p => p.outputPerMillion)) * CEILING_FACTOR,
    source: 'catalog', basis: 'estimated_ceiling', checkedAt: CATALOG.checkedAt };
}
function resolve(connection) {
  if (!connection) return null;
  if (connection.price) return { ...normalize(connection.price), source: 'admin' };
  return catalogPrice(connection.providerId, connection.modelId) || estimatedCeiling(connection.providerId);
}
module.exports = { CATALOG, CURRENCIES, CEILING_FACTOR, invalid, normalize, catalogPrice, estimatedCeiling, resolve };
