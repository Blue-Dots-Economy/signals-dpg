import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { signup, login, acceptCoreConsent, identityQuery, type Identity, type Session } from '../../src/auth.js';
import { newName, newPhone, newEmail } from '../../src/identities.js';

/**
 * Journey K — Consent ledger invariants (P0).
 * Guard asserted here: the consent version is DERIVED SERVER-SIDE — a client-
 * supplied version is never trusted.
 */
test.describe('Journey K — consent ledger', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users (gated target without service creds)');
  test.skip(({ caps }) => !caps.testOtp, 'requires OTP retrieval (CREATE_TEST_OTP on the target)');

  test('a client-supplied consent version is ignored; the server records its own', async ({ api, service, cfg, caps }) => {
    const channel = cfg.loginChannels.includes('phone') ? 'phone' : 'email';
    const identity: Identity = channel === 'phone' ? { channel, value: newPhone() } : { channel, value: newEmail('k') };

    // create an authenticated user (signup on allowed targets; provision+login on gated)
    let session: Session;
    if (provisioningMethod(cfg, caps) === 'signup') {
      session = await signup(api, identity, newName('Ledger'));
    } else {
      const idField = channel === 'phone' ? { phone_number: identity.value } : { email: identity.value };
      const prov = await service.post('/api/v1/admin/participant', {
        ...idField,
        name: newName('Ledger'),
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'link',
        network: cfg.network,
      });
      expect(prov.status).toBe(200);
      session = await login(api, identity);
    }

    const FORGED = 999_999;
    const accept = await session.client.post<{ recorded: number }>('/api/v1/consent/accept', {
      network: cfg.network,
      source: 'signup',
      items: [
        { category: 'terms', version: FORGED },
        { category: 'privacy', version: 1 },
      ],
    });
    expect(accept.status, `consent/accept: ${JSON.stringify(accept.body)}`).toBe(200);

    // read back the accepted versions by identifier (unauthenticated pre-login endpoint)
    const status = await api.get<{ statuses: { terms: number[]; privacy: number[] } }>(
      `/api/v1/consent/status-by-identifier?network=${encodeURIComponent(cfg.network)}&${identityQuery(identity)}`,
    );
    expect(status.status).toBe(200);
    expect(status.body.statuses.terms.length, 'terms consent should be recorded').toBeGreaterThan(0);
    expect(
      status.body.statuses.terms.includes(FORGED),
      'the forged client version must NOT appear — the server derives the version',
    ).toBeFalsy();
  });

  test('re-accepting terms is append-only and does not multiply the current version', async ({ api, service, cfg, caps }) => {
    const channel = cfg.loginChannels.includes('phone') ? 'phone' : 'email';
    const identity: Identity = channel === 'phone' ? { channel, value: newPhone() } : { channel, value: newEmail('k2') };

    let session: Session;
    if (provisioningMethod(cfg, caps) === 'signup') {
      session = await signup(api, identity, newName('Ledger2'));
    } else {
      const idField = channel === 'phone' ? { phone_number: identity.value } : { email: identity.value };
      await service.post('/api/v1/admin/participant', { ...idField, name: newName('Ledger2'), terms_accepted: true, privacy_accepted: true, channel: 'link', network: cfg.network });
      session = await login(api, identity);
    }

    // accept terms + privacy twice
    await acceptCoreConsent(session, cfg.network, 'signup');
    await acceptCoreConsent(session, cfg.network, 'login');

    const status = await api.get<{ statuses: { terms: number[]; privacy: number[] } }>(
      `/api/v1/consent/status-by-identifier?network=${encodeURIComponent(cfg.network)}&${identityQuery(identity)}`,
    );
    expect(status.status).toBe(200);
    // the current version should be present exactly once (latest-wins by seq), not duplicated
    const current = Math.max(...status.body.statuses.terms);
    expect(status.body.statuses.terms.filter((v) => v === current).length, 'current terms version appears once').toBe(1);
  });

  test('profile_creation consent is idempotent (re-accept records nothing new)', async ({ api, service, cfg, caps }) => {
    test.skip(provisioningMethod(cfg, caps) === null, 'no way to create users');
    const u = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'kidem' });

    // the profile is already live (consent recorded at create / promotion); a
    // repeat profile-accept for the same item must be a no-op (recorded 0).
    const again = await u.session.client.post<{ recorded: number }>('/api/v1/consent/profile-accept', {
      network: u.binding.network,
      item_domain: u.binding.domain,
      item_type: u.binding.item_type,
      item_id: u.itemId,
      version: 1,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.recorded, 'idempotent profile consent records nothing new').toBe(0);
  });
});
