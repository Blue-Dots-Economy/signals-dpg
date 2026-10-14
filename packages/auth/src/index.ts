// better-auth's `createAuth` was exported from here until #517 retired the
// library. What remains is the PII crypto this package has always also owned —
// unrelated to the identity provider, and load-bearing for item encryption and
// the private-location jitter (`SIGNALS_PII_KEY`).
export * from './pii_crypto';
export * from './pii_key';
