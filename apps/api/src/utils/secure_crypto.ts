import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Small crypto primitives shared by the auth paths (browser session CSRF,
 * inter-instance tokens, partner SSO). One implementation each, so a fix to
 * one — e.g. the length pre-check below — cannot miss the others.
 */

/**
 * Constant-time string compare.
 *
 * `!==` on secrets leaks position through timing. Lengths are compared first
 * because `timingSafeEqual` throws on a mismatch — length is not the secret.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Lowercase-hex HMAC-SHA256 of a UTF-8 string. */
export function hmacSha256Hex(secret: string | Buffer, data: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

/** Lowercase-hex SHA-256 of a UTF-8 string. */
export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
