import { describe, it, expect, vi, beforeEach } from 'vitest';

const { peekSignupExtras } = vi.hoisted(() => ({ peekSignupExtras: vi.fn() }));
vi.mock('@/services/auth/signup_extras', () => ({ peekSignupExtras }));

const { resolveSignupDomain } = await import('../resolve_signup_domain.js');

beforeEach(() => peekSignupExtras.mockReset());

describe('resolveSignupDomain', () => {
  it('returns the parked signup domain', async () => {
    peekSignupExtras.mockResolvedValue({ domain: 'provider' });
    expect(await resolveSignupDomain({ email: 'a@x.com', phoneNumber: null })).toBe('provider');
  });

  it('returns null when the stash has no domain', async () => {
    peekSignupExtras.mockResolvedValue({ age: 30 });
    expect(await resolveSignupDomain({ email: 'a@x.com', phoneNumber: null })).toBeNull();
  });

  it('returns null when nothing is parked', async () => {
    peekSignupExtras.mockResolvedValue(null);
    expect(await resolveSignupDomain({ email: null, phoneNumber: '+911234567890' })).toBeNull();
  });
});
