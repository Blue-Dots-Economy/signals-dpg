import { test, expect } from '../../src/fixtures.js';
import { checkUser, keycloakSelfSignup, signup, acceptCoreConsent } from '../../src/auth.js';
import { resolveBinding, buildMinimalItemState } from '../../src/schema.js';
import { freshIdentity } from '../../src/flows.js';
import { newName } from '../../src/identities.js';
import { skipIfSignupExhausted } from '../../src/signup_budget.js';
import { SignupRateLimitedError } from '../../src/auth.js';

/**
 * Journey A — Adult self-signup → schema-typed profile → discoverable (P0).
 * Runs only against an `allowed` self-signup target (see Journey B for gated).
 * Guards: consent gates discoverability · backend-generated URLs · classifier is
 * the only go-live path.
 */
test.describe('Journey A — self-signup → profile → discoverable', () => {
  test.skip(({ cfg }) => cfg.selfSignupMode !== 'allowed', 'target is not self-signup allowed (see Journey B)');
  test.skip(({ caps }) => !caps.testOtp, 'requires OTP retrieval (CREATE_TEST_OTP on the target)');

  test('new adult signs up, creates a profile, and it becomes discoverable', async ({ api, cfg, authCtx, provider }) => {
    const identity = freshIdentity(cfg, 'a', { provider });
    const binding0 = await resolveBinding(api, cfg.servedDomains[0]);

    // "is this identifier already taken?" — a different endpoint per provider.
    // better-auth answers it with check-user; under Keycloak that mount does not
    // exist and self-signup reports it instead, via `alreadyRegistered`.
    if (provider === 'betterauth') {
      const check = await checkUser(api, identity);
      expect(check.status).toBe(200);
      expect(check.body.userExists, 'a freshly generated identity must be new').toBeFalsy();
    } else {
      const probe = await keycloakSelfSignup(api, identity, newName('Adult'), {
        domain: binding0.domain,
        age: 35,
      });
      // NOTE: this probe *is* a signup, so this test spends two of the hourly
      // per-IP budget, not one. Treat an exhausted budget the same as the helper
      // does — an environment limit, not a regression.
      if (probe.status === 429) skipIfSignupExhausted(test, new SignupRateLimitedError(identity.value));
      expect(probe.status, JSON.stringify(probe.body)).toBe(200);
      expect(probe.alreadyRegistered, 'a freshly generated identity must be new').toBeFalsy();
    }

    // signup and accept terms + privacy (signup is idempotent on an identity the
    // probe above may already have created)
    const session = await signup(api, identity, newName('Adult'), authCtx, {
      domain: binding0.domain,
      age: 35,
    }).catch((e) => skipIfSignupExhausted(test, e));
    expect(session.token).toBeTruthy();
    await acceptCoreConsent(session, cfg.network, 'signup');
    // Record the USER-LEVEL age snapshot (#331), same as flows.ts's
    // createLiveProfileUser — the `age: 35` passed to signup() above only lands
    // on the Keycloak identity attributes, never on the user row. A guardian-
    // gated domain (blue_dot's seeker) is fail-closed on a null user-level age
    // (guardianGateBlocksGoLive), so without this the profile below correctly
    // stays draft even though every other go-live condition is met.
    await session.client.post('/api/v1/consent/u18/dob', { network: cfg.network, age: 35 });

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

  test('consent gates discoverability: a profile is not live/discoverable without profile consent', async ({ api, cfg, authCtx, provider }) => {
    const identity = freshIdentity(cfg, 'a2', { provider });
    const binding = await resolveBinding(api, cfg.servedDomains[0]);
    const session = await signup(api, identity, newName('Adult'), authCtx, {
      domain: binding.domain,
      age: 35,
    }).catch((e) => skipIfSignupExhausted(test, e));
    await acceptCoreConsent(session, cfg.network, 'signup');

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
