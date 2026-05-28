import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

type PiiCryptoErrorCode = 'KEY_MISSING' | 'BAD_FORMAT' | 'DECRYPT_FAILED';

export class PiiCryptoError extends Error {
  readonly code: PiiCryptoErrorCode;
  constructor(code: PiiCryptoErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'PiiCryptoError';
  }
}

const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 'v1';

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new PiiCryptoError('KEY_MISSING', 'PII key must be a 32-byte Buffer');
  }
}

export function encryptPiiBlob(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, ct, tag]).toString('base64')}`;
}

export function decryptPiiBlob(blob: string, key: Buffer): string {
  assertKey(key);
  if (!blob.startsWith(`${VERSION}:`)) {
    throw new PiiCryptoError('BAD_FORMAT', 'Unknown PII blob version');
  }
  const raw = Buffer.from(blob.slice(VERSION.length + 1), 'base64');
  if (raw.length < IV_LEN + TAG_LEN + 1) {
    throw new PiiCryptoError('BAD_FORMAT', 'PII blob is too short');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ct = raw.subarray(IV_LEN, raw.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new PiiCryptoError('DECRYPT_FAILED', 'PII blob decryption failed');
  }
}
