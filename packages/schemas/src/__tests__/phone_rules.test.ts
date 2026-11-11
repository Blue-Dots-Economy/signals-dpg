import { describe, it, expect } from 'vitest';
import { PHONE_E164_PATTERN, PHONE_INPUT_PATTERN, isContactPhone } from '../phone_rules';

describe('phone rules', () => {
  it('needs exactly 10 digits starting 6-9 after +91', () => {
    expect(PHONE_E164_PATTERN.test('+919876543210')).toBe(true);
    for (const bad of ['+91935350600', '+9193535060012', '+911234567890']) {
      expect(PHONE_E164_PATTERN.test(bad)).toBe(false);
    }
  });

  it('keeps other country codes and accepts a bare Indian mobile from a form', () => {
    expect(PHONE_E164_PATTERN.test('+447911123456')).toBe(true);
    expect(PHONE_INPUT_PATTERN.test('9876543210')).toBe(true);
    expect(PHONE_INPUT_PATTERN.test('935350600')).toBe(false);
  });

  it('accepts landlines as contacts but not a short +91 number', () => {
    expect(isContactPhone('+918023456789')).toBe(true);
    expect(isContactPhone('080 2345 6789')).toBe(true);
    expect(isContactPhone('+91935350600')).toBe(false);
    expect(isContactPhone('12345')).toBe(false);
  });
});
