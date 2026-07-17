import { describe, it, expect } from 'vitest';
import { isMinor, guardianConsentRequired } from '@/services/minor';
import type { NetworkConfigDocument } from '@dpg/schemas';

// Fixed reference "today" so the assertions are deterministic.
const NOW = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15
const dob = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('isMinor (full date of birth)', () => {
  it('is true for a clear minor (age ~16)', () => {
    expect(isMinor(dob(2010, 1, 10), NOW)).toBe(true);
  });

  it('is still a minor the day before the 18th birthday', () => {
    // Turns 18 on 2026-07-20 → minor now (2026-07-15).
    expect(isMinor(dob(2008, 7, 20), NOW)).toBe(true);
  });

  it('is adult exactly on the 18th birthday', () => {
    // 18th birthday is today → adult.
    expect(isMinor(dob(2008, 7, 15), NOW)).toBe(false);
  });

  it('is adult once past the 18th birthday', () => {
    expect(isMinor(dob(2008, 6, 1), NOW)).toBe(false);
  });

  it('is adult for someone well over 18', () => {
    expect(isMinor(dob(2000, 5, 3), NOW)).toBe(false);
  });
});

const cfg = {
  id: 'blue_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'provider', guardian_consent_required: false },
    { id: 'legacy' }, // flag absent → default false
  ],
} as unknown as NetworkConfigDocument;

describe('guardianConsentRequired', () => {
  it('is true when the domain opts in', () => {
    expect(guardianConsentRequired(cfg, 'seeker')).toBe(true);
  });

  it('is false when the domain opts out', () => {
    expect(guardianConsentRequired(cfg, 'provider')).toBe(false);
  });

  it('is false when the flag is absent', () => {
    expect(guardianConsentRequired(cfg, 'legacy')).toBe(false);
  });

  it('is false for an unknown domain', () => {
    expect(guardianConsentRequired(cfg, 'nope')).toBe(false);
  });
});
