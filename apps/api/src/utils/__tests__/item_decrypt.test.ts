import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptPiiBlob, PiiCryptoError, _resetPiiKeyCacheForTests } from '@dpg/auth';
import { decryptItemPrivate } from '../item_decrypt';

const KEY_B64 = Buffer.alloc(32, 0xa1).toString('base64');

describe('decryptItemPrivate', () => {
  const originalKey = process.env.SIGNALS_PII_KEY;
  beforeEach(() => {
    process.env.SIGNALS_PII_KEY = KEY_B64;
    _resetPiiKeyCacheForTests();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.SIGNALS_PII_KEY;
    else process.env.SIGNALS_PII_KEY = originalKey;
  });

  it('returns item_state unchanged when item_private_state is empty', () => {
    const out = decryptItemPrivate({
      item_state: { name: 'A***', city: 'Bangalore' },
      item_private_state: '',
    });
    expect(out.mergedState).toEqual({ name: 'A***', city: 'Bangalore' });
  });

  it('merges decrypted private values over masked ones in item_state', () => {
    const key = Buffer.from(KEY_B64, 'base64');
    const enc = encryptPiiBlob(JSON.stringify({ name: 'Aniket', email: 'a@b.com' }), key);
    const out = decryptItemPrivate({
      item_state: { name: 'A***', email: 'a***@b.com', city: 'Bangalore' },
      item_private_state: enc,
    });
    expect(out.mergedState).toEqual({
      name: 'Aniket', email: 'a@b.com', city: 'Bangalore',
    });
  });

  it('throws PiiCryptoError on a corrupt blob', () => {
    expect(() =>
      decryptItemPrivate({ item_state: {}, item_private_state: 'v1:not-base64-aaaa' })
    ).toThrow(PiiCryptoError);
  });
});
