import { createDecipheriv, createHash } from 'node:crypto';

/**
 * Decrypt a value produced by `CryptoJS.AES.encrypt(text, passphrase)`.
 *
 * That call uses OpenSSL's legacy passphrase format: base64 of
 * `"Salted__" | 8-byte salt | AES-256-CBC ciphertext`, with the key and IV
 * derived from the passphrase by EVP_BytesToKey (one MD5 round). Partners that
 * sign their links with CryptoJS (NCS does) produce exactly this, so it is
 * decoded here with `node:crypto` rather than pulling in the library.
 *
 * Returns null — never throws — for anything that is not a well-formed blob
 * under this passphrase (bad base64, missing header, bad padding, non-UTF-8).
 */
export function decryptCryptoJsAes(blob: string, passphrase: string): string | null {
  if (typeof blob !== 'string' || blob.length === 0) return null;

  // A '+' in an unencoded query string arrives as a space.
  const raw = Buffer.from(blob.replace(/ /g, '+'), 'base64');
  if (raw.length < 32 || raw.subarray(0, 8).toString('latin1') !== 'Salted__') {
    return null;
  }

  const salt = raw.subarray(8, 16);
  const ciphertext = raw.subarray(16);
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, 'utf8'), salt);

  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
    return text;
  } catch {
    return null;
  }
}

/** OpenSSL EVP_BytesToKey with MD5 and one iteration: 32-byte key + 16-byte IV. */
function evpBytesToKey(passphrase: Buffer, salt: Buffer): { key: Buffer; iv: Buffer } {
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < 48) {
    block = createHash('md5').update(Buffer.concat([block, passphrase, salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  return { key: derived.subarray(0, 32), iv: derived.subarray(32, 48) };
}
