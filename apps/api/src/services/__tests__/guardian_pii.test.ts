import { describe, it, expect, beforeAll } from 'vitest';
import { encryptGuardianField, decryptGuardianField, guardianRef } from '@/services/guardian_pii';

// getPiiKey() reads SIGNALS_PII_KEY; the integration env sets it. For this
// unit test, set a valid 32-byte base64 key before importing key usage.
beforeAll(() => {
  process.env.SIGNALS_PII_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

describe('guardian PII crypto', () => {
  it('round-trips a value (encrypt → decrypt)', () => {
    const blob = encryptGuardianField('+91999888777');
    expect(blob).not.toBe('+91999888777'); // actually encrypted
    expect(decryptGuardianField(blob)).toBe('+91999888777');
  });

  it('produces different ciphertext for the same input (IV/nonce)', () => {
    expect(encryptGuardianField('a@b.co')).not.toBe(encryptGuardianField('a@b.co'));
  });

  describe('guardianRef (deterministic, for ward-count cap)', () => {
    it('is deterministic for the same normalized contact', () => {
      expect(guardianRef('+919000000001')).toBe(guardianRef('+919000000001'));
      // normalization: trim + lowercase
      expect(guardianRef('  Parent@Example.com ')).toBe(guardianRef('parent@example.com'));
    });
    it('differs for different contacts and is not the plaintext', () => {
      expect(guardianRef('+919000000001')).not.toBe(guardianRef('+919000000002'));
      expect(guardianRef('+919000000001')).not.toContain('9000000001');
    });
  });
});
