import { PiiCryptoError } from './pii_crypto';

let cached: Buffer | null = null;

export function getPiiKey(): Buffer {
  if (cached) return cached;
  const raw = process.env.SIGNALS_PII_KEY;
  if (!raw) {
    throw new PiiCryptoError('KEY_MISSING', 'SIGNALS_PII_KEY is not set');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new PiiCryptoError(
      'KEY_MISSING',
      'SIGNALS_PII_KEY must decode to 32 bytes'
    );
  }
  cached = buf;
  return cached;
}

// Test-only helper. Resetting the cached key lets vitest swap env between tests.
export function _resetPiiKeyCacheForTests(): void {
  cached = null;
}
