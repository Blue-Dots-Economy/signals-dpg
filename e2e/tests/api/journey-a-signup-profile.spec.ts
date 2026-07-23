import { test, expect } from '../../src/fixtures.js';
import { checkUser, signup, acceptCoreConsent } from '../../src/auth.js';
import { resolveBinding, buildMinimalItemState } from '../../src/schema.js';
import { newName, newPhone, newEmail } from '../../src/identities.js';

/**
 * Journey A — Adult self-signup → schema-typed profile → discoverable (P0).
 * Runs only against an `allowed` self-signup target (see Journey B for gated).
 * Guards: consent gates discoverability · backend-generated URLs · classifier is
 * the only go-live path.
 */
test.describe('Journey A — self-signup → profile → discoverable', () => {
  test.skip(({ cfg }) => cfg.selfSignupMode !== 'allowed', 'target is not self-signup allowed (see Journey B)');
  test.skip(({ caps }) => !caps.testOtp, 'requires OTP retrieval (CREATE_TEST_OTP on the target)');

  test('new adult signs up, creates a profile, and it becomes discoverable', async ({ api, cfg }) => {
    const channel = cfg.loginChannels.includes('phone') ? 'phone' : 'email';
    const identity = channel === 'phone' ? { channel, value: newPhone() } as const : { channel, value: newEmail('a') } as const;

    // check-user reports new
    const check = await checkUser(api, identity);
    expect(check.status).toBe(200);
    expect(check.body.userExists, 'a freshly generated identity must be new').toBeFalsy();

    // signup (request+verify with fixed test OTP) and accept terms + privacy
    const session = await signup(api, identity, newName('Adult'));
    expect(session.token).toBeTruthy();
    await acceptCoreConsent(session, cfg.network, 'signup');

    // build a schema-valid minimal profile in the first served domain
    const binding = await resolveBinding(api, cfg.servedDomains[0]);
    const itemState = buildMinimalItemState(binding.schema);

    // create WITH profile-creation consent → expect live
    const create = await session.client.post<{ item_id: string; item_type: string }>('/api/v1/item/create', {
      item_network: binding.network,
      item_domain: binding.domain,
      item_type: binding.item_type,
      item_state: itemState,
      // deliberately try to set server-owned fields — they must be ignored
      item_instance_url: 'https://client-supplied.example/should-be-ignored',
      item_schema_url: 'https://client-supplied.example/schema',
      lifecycle_status: 'live',
      consent: { category: 'profile_creation', version: 1 },
    });
    expect(create.status, `item/create: ${JSON.stringify(create.body)}`).toBe(201);
    const itemId = create.body.item_id;

    // fetch own items — assert server-generated URLs (not the client-supplied ones) and live
    const mine = await session.client.get<{ items: Array<{ item_id: string; lifecycle_status?: string; item_instance_url: string; item_schema_url: string }> }>(
      `/api/v1/item/fetch?item_network=${binding.network}&item_domain=${binding.domain}&item_type=${binding.item_type}&limit=100`,
    );
    const item = mine.body.items.find((i) => i.item_id === itemId);
    expect(item, 'created item should appear on own fetch').toBeTruthy();
    expect(item!.item_instance_url).not.toContain('client-supplied.example');
    expect(item!.item_schema_url).not.toContain('client-supplied.example');
    expect(item!.lifecycle_status, 'consent + complete required fields ⇒ live').toBe('live');

    // discoverable via the network fetch (live-only)
    const disc = await api.get<{ items: Array<{ item_id: string }> }>(
      `/api/v1/network/item/fetch?item_network=${binding.network}&item_domain=${binding.domain}&item_type=${binding.item_type}&limit=200`,
    );
    expect(disc.status).toBe(200);
    expect(disc.body.items.some((i) => i.item_id === itemId), 'live profile must be discoverable').toBeTruthy();
  });

  test('consent gates discoverability: a profile is not live/discoverable without profile consent', async ({ api, cfg }) => {
    const channel = cfg.loginChannels.includes('phone') ? 'phone' : 'email';
    const identity = channel === 'phone' ? { channel, value: newPhone() } as const : { channel, value: newEmail('a2') } as const;
    const session = await signup(api, identity, newName('Adult'));
    await acceptCoreConsent(session, cfg.network, 'signup');

    const binding = await resolveBinding(api, cfg.servedDomains[0]);
    const itemState = buildMinimalItemState(binding.schema);

    // create WITHOUT the consent block
    const create = await session.client.post<{ item_id?: string; error?: string }>('/api/v1/item/create', {
      item_network: binding.network,
      item_domain: binding.domain,
      item_type: binding.item_type,
      item_state: itemState,
    });

    if (create.status === 400) {
      // network requires profile_creation consent at create time — the gate itself
      expect(create.body.error).toBe('CONSENT_REQUIRED');
      return;
    }

    // otherwise the item was created as a draft and must NOT be discoverable
    expect(create.status).toBe(201);
    const itemId = create.body.item_id!;
    const mine = await session.client.get<{ items: Array<{ item_id: string; lifecycle_status?: string }> }>(
      `/api/v1/item/fetch?item_network=${binding.network}&item_domain=${binding.domain}&item_type=${binding.item_type}&limit=100`,
    );
    const item = mine.body.items.find((i) => i.item_id === itemId);
    expect(item!.lifecycle_status, 'no profile consent ⇒ draft').not.toBe('live');

    const disc = await api.get<{ items: Array<{ item_id: string }> }>(
      `/api/v1/network/item/fetch?item_network=${binding.network}&item_domain=${binding.domain}&item_type=${binding.item_type}&limit=200`,
    );
    expect(disc.body.items.some((i) => i.item_id === itemId), 'draft must not be discoverable').toBeFalsy();
  });
});
