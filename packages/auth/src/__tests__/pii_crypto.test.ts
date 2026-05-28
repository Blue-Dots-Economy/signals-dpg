import { describe, expect, it } from 'vitest';
import { encryptPiiBlob, decryptPiiBlob, PiiCryptoError } from '../pii_crypto';

const KEY = Buffer.alloc(32, 0xa1); // deterministic 32-byte key

describe('pii_crypto', () => {
  it('round-trips a string', () => {
    const ct = encryptPiiBlob('{"email":"a@b.com"}', KEY);
    expect(decryptPiiBlob(ct, KEY)).toBe('{"email":"a@b.com"}');
  });

  it('emits the v1: version prefix', () => {
    const ct = encryptPiiBlob('hello', KEY);
    expect(ct.startsWith('v1:')).toBe(true);
  });

  it('produces a different ciphertext each call (fresh IV)', () => {
    const a = encryptPiiBlob('same', KEY);
    const b = encryptPiiBlob('same', KEY);
    expect(a).not.toBe(b);
  });

  it('rejects an unknown version prefix', () => {
    expect(() => decryptPiiBlob('v9:zzz', KEY)).toThrow(PiiCryptoError);
    try {
      decryptPiiBlob('v9:zzz', KEY);
    } catch (err) {
      expect((err as PiiCryptoError).code).toBe('BAD_FORMAT');
    }
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const ct = encryptPiiBlob('hello', KEY);
    // Flip the last char before the base64 padding.
    const tampered = ct.slice(0, -2) + (ct.endsWith('A=') ? 'B=' : 'A=');
    expect(() => decryptPiiBlob(tampered, KEY)).toThrow(PiiCryptoError);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => encryptPiiBlob('x', Buffer.alloc(16))).toThrow(PiiCryptoError);
  });
});
