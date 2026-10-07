import { describe, it, expect } from 'vitest';
import { E164_PATTERN, normalizeE164Phone } from '../phone';

describe('normalizeE164Phone', () => {
  it.each(['9876543210', '919876543210', '+91 98765 43210', '+919876543210', ' (98765) 43-210 ', '+91-98765-43210'])(
    '%j → +919876543210',
    (raw) => {
      expect(normalizeE164Phone(raw)).toBe('+919876543210');
    },
  );

  it('keeps a non-Indian E.164 number', () => {
    expect(normalizeE164Phone('+1 (415) 555-0100')).toBe('+14155550100');
  });

  it.each(['12345', 'abc', '', '   ', '+0123456789', '98765abc10', '+91 98765 43210 ext 5'])('rejects %j', (raw) => {
    expect(normalizeE164Phone(raw)).toBeNull();
  });

  it('every accepted result matches the E.164 pattern NS enforces', () => {
    expect(E164_PATTERN.test(normalizeE164Phone('9876543210')!)).toBe(true);
  });
});
