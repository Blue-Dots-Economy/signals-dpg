import { describe, it, expect } from 'vitest';
import { hmacSha256Hex, safeEqual, sha256Hex } from '../secure_crypto.js';

describe('safeEqual', () => {
  it('is true only for identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false (does not throw) on a length mismatch', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('hmacSha256Hex', () => {
  it('matches the RFC 4231 test case 2 vector', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    );
  });
});

describe('sha256Hex', () => {
  it('hashes the empty string to the known digest', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });
});
