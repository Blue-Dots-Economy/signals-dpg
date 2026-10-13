import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAccountLink } from '../link_resolver.js';
import type { SsoIdentity } from '../types.js';

const IDENTITY: SsoIdentity = {
  provider: 'ncs',
  providerUserId: 'u-1',
  subject: 'ncs:u-1',
  fullName: 'Ameya',
  phone: '+919730862967',
  phoneVerified: true,
  email: null,
  emailVerified: false,
  role: 'JOBSEEKER',
  attributes: {},
};

const admin = {
  findByIdpLink: vi.fn(),
  findByPhone: vi.fn(),
  federatedIdentities: vi.fn(),
};

const resolve = (identity: SsoIdentity = IDENTITY) =>
  resolveAccountLink(identity, { admin, idpAlias: 'signals-sso' });

beforeEach(() => {
  vi.clearAllMocks();
  admin.findByIdpLink.mockResolvedValue([]);
  admin.findByPhone.mockResolvedValue([]);
  admin.federatedIdentities.mockResolvedValue([]);
});

describe('resolveAccountLink', () => {
  it('a new number becomes the username of a new account', async () => {
    expect(await resolve()).toEqual({ ok: true, value: { preferredUsername: '+919730862967' } });
  });

  it('links an existing account found by phone when NCS verified the number', async () => {
    admin.findByPhone.mockResolvedValue([{ id: 'kc-1', username: 'ameya@x.org' }]);
    expect(await resolve()).toEqual({ ok: true, value: { preferredUsername: 'ameya@x.org' } });
  });


  it('refuses to link an existing account on an unverified number', async () => {
    admin.findByPhone.mockResolvedValue([{ id: 'kc-1', username: 'ameya@x.org' }]);
    expect(await resolve({ ...IDENTITY, phoneVerified: false })).toMatchObject({
      ok: false,
      reason: 'phone-unverified',
    });
  });

  it('lets a returning user in even if the number is now unverified', async () => {
    admin.findByIdpLink.mockResolvedValue([{ id: 'kc-1', username: 'ameya@x.org' }]);
    expect(await resolve({ ...IDENTITY, phoneVerified: false })).toEqual({
      ok: true,
      value: { preferredUsername: 'ameya@x.org' },
    });
    expect(admin.findByIdpLink).toHaveBeenCalledWith('signals-sso', 'ncs:u-1');
    expect(admin.findByPhone).not.toHaveBeenCalled();
  });

  it('keeps a returning user on their linked account after their partner number changed', async () => {
    // Linked account still carries the old number; the new number is free.
    admin.findByIdpLink.mockResolvedValue([{ id: 'kc-1', username: '+919000000001' }]);
    expect(await resolve({ ...IDENTITY, phone: '+919000000002' })).toEqual({
      ok: true,
      value: { preferredUsername: '+919000000001' },
    });
  });

  it('keeps a returning user on their linked account even if the new number belongs to another account', async () => {
    admin.findByIdpLink.mockResolvedValue([{ id: 'kc-1', username: '+919000000001' }]);
    admin.findByPhone.mockResolvedValue([{ id: 'kc-9', username: 'someone@x.org' }]);
    expect(await resolve({ ...IDENTITY, phone: '+919000000002' })).toEqual({
      ok: true,
      value: { preferredUsername: '+919000000001' },
    });
  });

  it('refuses when the partner user is linked to more than one account', async () => {
    admin.findByIdpLink.mockResolvedValue([
      { id: 'kc-1', username: 'a' },
      { id: 'kc-2', username: 'b' },
    ]);
    expect(await resolve()).toMatchObject({ ok: false, reason: 'link-conflict' });
  });

  it('never creates an account on an unverified number', async () => {
    expect(await resolve({ ...IDENTITY, phoneVerified: false })).toMatchObject({
      ok: false,
      reason: 'phone-unverified',
    });
  });

  it('refuses when the account is linked to a different partner user', async () => {
    admin.findByPhone.mockResolvedValue([{ id: 'kc-1', username: 'ameya@x.org' }]);
    admin.federatedIdentities.mockResolvedValue([
      { identityProvider: 'signals-sso', userId: 'ncs:someone-else' },
    ]);
    expect(await resolve()).toMatchObject({ ok: false, reason: 'link-conflict' });
  });

  it('ignores links to other identity providers', async () => {
    admin.findByPhone.mockResolvedValue([{ id: 'kc-1', username: 'ameya@x.org' }]);
    admin.federatedIdentities.mockResolvedValue([{ identityProvider: 'google', userId: 'g-1' }]);
    expect(await resolve()).toMatchObject({ ok: true });
  });

  it('refuses when the number matches more than one account', async () => {
    admin.findByPhone.mockResolvedValue([
      { id: 'kc-1', username: 'a' },
      { id: 'kc-2', username: '+919730862967' },
    ]);
    expect(await resolve()).toMatchObject({ ok: false, reason: 'link-conflict' });
  });


  it('fails closed when Keycloak cannot be asked', async () => {
    admin.findByIdpLink.mockRejectedValue(new Error('down'));
    expect(await resolve()).toMatchObject({ ok: false, reason: 'provider-unavailable' });
    admin.findByIdpLink.mockResolvedValue([]);
    admin.findByPhone.mockRejectedValue(new Error('down'));
    expect(await resolve()).toMatchObject({ ok: false, reason: 'provider-unavailable' });
    expect(
      await resolveAccountLink(IDENTITY, { admin: null, idpAlias: 'signals-sso' })
    ).toMatchObject({ ok: false, reason: 'provider-unavailable' });
  });
});
