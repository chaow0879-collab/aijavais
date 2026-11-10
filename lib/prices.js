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
function resolve(connection) {
  if (!connection) return null;
  if (connection.price) return { ...normalize(connection.price), source: 'admin' };
  return catalogPrice(connection.providerId, connection.modelId);
}
module.exports = { CATALOG, CURRENCIES, invalid, normalize, catalogPrice, resolve };
