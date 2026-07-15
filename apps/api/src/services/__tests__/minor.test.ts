import { describe, it, expect } from 'vitest';
import { isMinor } from '@/services/minor';

// Fixed reference "today" so the assertions are deterministic.
const NOW = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15

describe('isMinor', () => {
  it('is true for a clear minor (age ~16)', () => {
    expect(isMinor(2010, 1, NOW)).toBe(true);
  });

  it('stays minor through the entire birth-month of the 18th year', () => {
    // Turns 18 in July 2026 → still minor until Aug 1 2026.
    expect(isMinor(2008, 7, NOW)).toBe(true);
  });

  it('is adult once past the 1st of the month after the 18th-year birth-month', () => {
    // 18th-year birth-month June 2026 → adult from Jul 1 2026.
    expect(isMinor(2008, 6, NOW)).toBe(false);
  });

  it('handles December births (month wraps to January next year)', () => {
    // 18th-year birth-month Dec 2026 → adult from Jan 1 2027 → still minor now.
    expect(isMinor(2008, 12, NOW)).toBe(true);
  });

  it('is adult for someone well over 18', () => {
    expect(isMinor(2000, 5, NOW)).toBe(false);
  });
});
