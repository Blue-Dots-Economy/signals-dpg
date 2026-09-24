import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const takeEntry = vi.fn();
vi.mock('@/services/auth/sso/sso_store', () => ({
  takeEntry: (...a: unknown[]) => takeEntry(...a),
}));
const verifyKeycloakToken = vi.fn();
vi.mock('@/utils/keycloak_token', () => ({
  verifyKeycloakToken: (...a: unknown[]) => verifyKeycloakToken(...a),
}));
const provisionUserFromClaims = vi.fn();
vi.mock('@/services/auth/provisioning', () => ({
  provisionUserFromClaims: (...a: unknown[]) => provisionUserFromClaims(...a),
}));
const bootstrapSsoProfile = vi.fn();
vi.mock('@/services/auth/sso/sso_profile_bootstrap', () => ({
  bootstrapSsoProfile: (...a: unknown[]) => bootstrapSsoProfile(...a),
}));
const MAPPING = { item_type: 'profile_1.0', role_to_domain: {}, fields: {} };
const getSsoProfileMapping = vi.fn((_id: string) => MAPPING as unknown);
vi.mock('@/services/auth/sso/registry', () => ({
  getSsoProfileMapping: (id: string) => getSsoProfileMapping(id),
}));

const { completeSsoLogin } = await import('../complete_sso_login.js');

const IDENTITY = { provider: 'ncs', subject: 'ncs:u-1', phone: '+919730862967' };
const ENTRY = { identity: IDENTITY, preferredUsername: '+919730862967' };
const CLAIMS = { sub: 'kc-1', preferred_username: '+919730862967' };
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;
const SSO = { provider: 'ncs', handle: 'h-1' };

beforeEach(() => {
  vi.clearAllMocks();
  takeEntry.mockResolvedValue(ENTRY);
  verifyKeycloakToken.mockResolvedValue({ ok: true, claims: CLAIMS });
  provisionUserFromClaims.mockResolvedValue({ ok: true, user: { id: 'kc-1' }, created: true });
  bootstrapSsoProfile.mockResolvedValue({ created: true, itemId: 'i-1' });
});

describe('completeSsoLogin', () => {
  it('provisions with the signup bypass and bootstraps the profile', async () => {
    await completeSsoLogin(SSO, 'access-token', log);
    expect(takeEntry).toHaveBeenCalledWith('h-1');
    expect(verifyKeycloakToken).toHaveBeenCalledWith('access-token');
    expect(provisionUserFromClaims).toHaveBeenCalledWith(CLAIMS, log, { allowSignup: true });
    expect(bootstrapSsoProfile).toHaveBeenCalledWith('kc-1', IDENTITY, MAPPING, log);
  });

  it('does nothing without a live entry', async () => {
    takeEntry.mockResolvedValue(null);
    await completeSsoLogin(SSO, 'access-token', log);
    expect(provisionUserFromClaims).not.toHaveBeenCalled();
  });

  it('refuses the bypass when Keycloak logged in a different account than the SSO API vouched for', async () => {
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { ...CLAIMS, preferred_username: 'someone@else.org' },
    });
    await completeSsoLogin(SSO, 'access-token', log);
    expect(provisionUserFromClaims).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('matches usernames case-insensitively', async () => {
    takeEntry.mockResolvedValue({ ...ENTRY, preferredUsername: 'Ameya@X.org' });
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { ...CLAIMS, preferred_username: 'ameya@x.org' },
    });
    await completeSsoLogin(SSO, 'access-token', log);
    expect(provisionUserFromClaims).toHaveBeenCalled();
  });

  it('skips the bootstrap when provisioning refuses', async () => {
    provisionUserFromClaims.mockResolvedValue({ ok: false, code: 'USER_BANNED', message: 'x' });
    await completeSsoLogin(SSO, 'access-token', log);
    expect(bootstrapSsoProfile).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    verifyKeycloakToken.mockRejectedValue(new Error('jwks down'));
    await expect(completeSsoLogin(SSO, 'access-token', log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
