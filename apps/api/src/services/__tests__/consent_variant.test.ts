import { describe, it, expect, vi, beforeEach } from 'vitest';

// #626: which consent document set applies to a user. The age source is
// mocked; `isMinor` is the real rule, so a change to either side — the age
// lookup or the minor boundary — shows up here instead of silently sending
// every minor back to the adult copy.
const { getWardAge } = vi.hoisted(() => ({ getWardAge: vi.fn() }));
vi.mock('@/services/minor_guardian_repo', () => ({
  getWardAge: (...a: unknown[]) => getWardAge(...a),
}));

const { resolveUserConsentVariant } = await import('../consent_variant');

beforeEach(() => getWardAge.mockReset());

describe('resolveUserConsentVariant', () => {
  it('a known minor (age 15) gets the U18 set', async () => {
    getWardAge.mockResolvedValue(15);
    expect(await resolveUserConsentVariant('u1')).toBe('u18');
  });

  it('age 18 is still a minor (birth year only, so the whole boundary year)', async () => {
    getWardAge.mockResolvedValue(18);
    expect(await resolveUserConsentVariant('u1')).toBe('u18');
  });

  it('an adult (age 30) gets the adult set', async () => {
    getWardAge.mockResolvedValue(30);
    expect(await resolveUserConsentVariant('u1')).toBe('adult');
  });

  it('an unknown age is adult — the documented safe default, never a lock-out', async () => {
    getWardAge.mockResolvedValue(null);
    expect(await resolveUserConsentVariant('u1')).toBe('adult');
  });

  it('reads the age for that user, on the given transaction when there is one', async () => {
    getWardAge.mockResolvedValue(15);
    const tx = { tag: 'tx' };
    await resolveUserConsentVariant('u42', tx as never);
    expect(getWardAge).toHaveBeenCalledWith('u42', tx);
    await resolveUserConsentVariant('u43');
    expect(getWardAge).toHaveBeenLastCalledWith('u43');
  });
});
