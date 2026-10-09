import { describe, it, expect } from 'vitest';
import { normalizeIndianMobile } from '../phone.js';

describe('normalizeIndianMobile', () => {
  it.each([
    ['9730862967', '+919730862967'],
    ['97308 62967', '+919730862967'],
    ['973-086-2967', '+919730862967'],
    ['+919730862967', '+919730862967'],
    ['919730862967', '+919730862967'],
    ['09730862967', '+919730862967'],
  ])('normalises %s', (raw, expected) => {
    expect(normalizeIndianMobile(raw)).toBe(expected);
  });

  it.each(['', '12345', '1234567890', '97308629671', 'abcdefghij', '+449730862967'])(
    'rejects %s',
    (raw) => {
      expect(normalizeIndianMobile(raw)).toBeNull();
    }
  );

  it('rejects non-strings', () => {
    expect(normalizeIndianMobile(undefined)).toBeNull();
    expect(normalizeIndianMobile(9730862967 as unknown as string)).toBeNull();
  });
});
