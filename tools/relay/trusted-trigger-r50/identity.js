'use strict';
// Caller identities can only be minted by the verifiers in this package (webhook HMAC
// intake, GitHub Actions OIDC). A plain object that merely looks like one is never trusted.
const minted = new WeakSet();
function mint(identity) { Object.freeze(identity); minted.add(identity); return identity; }
const isMinted = x => !!x && typeof x === 'object' && minted.has(x);
function reject(code) { throw Object.assign(Error(code), { code }); }
module.exports = { mint, isMinted, reject };
