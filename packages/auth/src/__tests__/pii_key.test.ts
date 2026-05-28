import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getPiiKey', () => {
  const original = process.env.SIGNALS_PII_KEY;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SIGNALS_PII_KEY;
    else process.env.SIGNALS_PII_KEY = original;
  });

  it('returns a 32-byte Buffer when env is set to base64 of 32 bytes', async () => {
    process.env.SIGNALS_PII_KEY = Buffer.alloc(32, 0xa1).toString('base64');
    const { getPiiKey } = await import('../pii_key');
    const k = getPiiKey();
    expect(Buffer.isBuffer(k)).toBe(true);
    expect(k.length).toBe(32);
  });

  it('throws PiiCryptoError(KEY_MISSING) when env var is absent', async () => {
    delete process.env.SIGNALS_PII_KEY;
    const { getPiiKey } = await import('../pii_key');
    const { PiiCryptoError } = await import('../pii_crypto');
    expect(() => getPiiKey()).toThrow(PiiCryptoError);
    try { getPiiKey(); } catch (err) {
      expect((err as InstanceType<typeof PiiCryptoError>).code).toBe('KEY_MISSING');
    }
  });

  it('throws KEY_MISSING when env var decodes to wrong length', async () => {
    process.env.SIGNALS_PII_KEY = Buffer.alloc(16).toString('base64');
    const { getPiiKey } = await import('../pii_key');
    const { PiiCryptoError } = await import('../pii_crypto');
    expect(() => getPiiKey()).toThrow(PiiCryptoError);
  });
});
