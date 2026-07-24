import { describe, it, expect } from 'vitest';
import { isMinor, guardianConsentRequired } from '@/services/minor';
import type { NetworkConfigDocument } from '@dpg/schemas';

describe('isMinor (age snapshot, #331)', () => {
  it('is true for a clear minor (age 16)', () => {
    expect(isMinor(16)).toBe(true);
  });

  it('is a minor across the whole boundary year (age 18 → u18, no month)', () => {
    expect(isMinor(18)).toBe(true);
  });

  it('is adult once age exceeds 18', () => {
    expect(isMinor(19)).toBe(false);
  });

  it('is adult for someone well over 18', () => {
    expect(isMinor(26)).toBe(false);
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
