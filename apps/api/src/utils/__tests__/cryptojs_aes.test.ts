import { describe, it, expect } from 'vitest';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { decryptCryptoJsAes } from '../cryptojs_aes.js';

/**
 * Encrypt exactly the way CryptoJS.AES.encrypt(text, passphrase).toString()
 * does, so the decrypt is tested against the real wire format rather than a
 * round-trip through our own code.
 */
function cryptoJsEncrypt(text: string, passphrase: string, salt = randomBytes(8)): string {
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < 48) {
    block = createHash('md5')
      .update(Buffer.concat([block, Buffer.from(passphrase, 'utf8'), salt]))
      .digest();
    derived = Buffer.concat([derived, block]);
  }
  const cipher = createCipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'latin1'), salt, ct]).toString('base64');
}

describe('decryptCryptoJsAes', () => {
  it('decrypts the CryptoJS passphrase format', () => {
    const blob = cryptoJsEncrypt('dge-mole_a@b.com|1790230628', 'the-secret');
    expect(blob.startsWith('U2FsdGVkX1')).toBe(true);
    expect(decryptCryptoJsAes(blob, 'the-secret')).toBe('dge-mole_a@b.com|1790230628');
  });

  it('returns null for the wrong passphrase', () => {
    const blob = cryptoJsEncrypt('hello world, long enough to pad', 'right');
    expect(decryptCryptoJsAes(blob, 'wrong')).toBeNull();
  });

  it('returns null without the Salted__ header', () => {
    expect(decryptCryptoJsAes(Buffer.from('x'.repeat(48)).toString('base64'), 'k')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(decryptCryptoJsAes('%%%not-base64%%%', 'k')).toBeNull();
    expect(decryptCryptoJsAes('', 'k')).toBeNull();
  });

  it('tolerates + turned into spaces by an unencoded query string', () => {
    let blob = '';
    // Find a blob that actually contains '+', so the case is exercised.
    for (let i = 0; i < 200 && !blob.includes('+'); i += 1) {
      blob = cryptoJsEncrypt(`payload-${i}`, 'k');
    }
    expect(blob).toContain('+');
    expect(decryptCryptoJsAes(blob.replace(/\+/g, ' '), 'k')).toMatch(/^payload-/);
  });
});
