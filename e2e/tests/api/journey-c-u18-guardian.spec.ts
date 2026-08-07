import { test, expect } from '../../src/fixtures.js';
import { freshIdentity } from '../../src/flows.js';
import { signup, acceptCoreConsent, TEST_OTP, type AuthContext, type Session } from '../../src/auth.js';
import { resolveBinding, buildMinimalItemState, type Binding } from '../../src/schema.js';
import { newName, newPhone } from '../../src/identities.js';
import type { ApiClient } from '../../src/api-client.js';
import type { E2EConfig } from '../../src/config.js';

/**
 * Journey C (API) — U18 minor + guardian consent (P0).
 * Guards the #311 invariant: on a guardian-gated domain a minor's profile reaches
 * `live` ONLY via a guardian `source='guardian'` consent — never the ward's own
 * self-consent (fail-closed). Then verifies the guardian flow does promote it.
 *
 * Uses OTP self-signup; guardian OTP is also the fixed 000000 under CREATE_TEST_OTP.
 * The gated domain is the first served domain (blue_dot/seeker is guardian-gated).
 * Skips-and-reports when the target predates the U18 endpoints or the domain
 * isn't guardian-gated there.
 */
/** Comfortably under 18 on any network's threshold. */
const MINOR_AGE = 14;

async function fetchItem(session: Session, binding: Binding, itemId: string) {
  const res = await session.client.get<{ items: Array<{ item_id: string; lifecycle_status?: string }> }>(
    `/api/v1/item/fetch?item_network=${binding.network}&item_domain=${binding.domain}&item_type=${binding.item_type}&limit=100`,
  );
  return res.body?.items?.find((i) => i.item_id === itemId);
}

/**
 * Read the item until it reaches `want`, or give up.
 *
 * `/item/fetch` has a ~1s Redis cache, so a just-promoted item can still be
 * served from its pre-promotion (draft) snapshot. A single read here produced a
 * false failure even though the promote itself returned `promoted: true`.
 * Mirrors the poll `flows.ts` already does for the adult path.
 */
async function waitForStatus(session: Session, binding: Binding, itemId: string, want: string) {
  let item = await fetchItem(session, binding, itemId);
  for (let i = 0; i < 5 && item?.lifecycle_status !== want; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    item = await fetchItem(session, binding, itemId);
  }
  return item;
}

/** Sign up a minor and create a profile in the gated domain; returns the draft item. */
async function setupMinorDraft(
  api: ApiClient,
  cfg: E2EConfig,
  domainKey: string,
  authCtx: AuthContext,
  provider: 'betterauth' | 'keycloak',
) {
  // A minor still self-signs-up here on purpose — Journey C is about the U18
  // path a real minor takes, and service provisioning would skip the gate under
  // test. Provider-aware so the identity lands on a channel whose OTP is
  // readable (Keycloak: Mailpit for email, the container log for phone).
  const identity = freshIdentity(cfg, 'minor', { provider });
  const session = await signup(api, identity, newName('Minor'), authCtx, { age: 14 });
  await acceptCoreConsent(session, cfg.network, 'signup');

  // #331: the route stores an AGE snapshot, not a date of birth. It previously
  // took `dateOfBirth`; sending that now fails Zod validation with
  // "body/age expected number, received NaN".
  const dob = await session.client.post<{ isMinor?: boolean }>('/api/v1/consent/u18/dob', {
    network: cfg.network,
    age: MINOR_AGE,
  });
  test.skip(dob.status === 404, 'target predates the U18 DOB endpoint');
  expect(dob.status, `u18/dob: ${JSON.stringify(dob.body)}`).toBe(200);
  expect(dob.body.isMinor, 'a 14-year-old must be classified a minor').toBe(true);

  const binding = await resolveBinding(api, domainKey);
  const create = await session.client.post<{ item_id: string }>('/api/v1/item/create', {
    item_network: binding.network,
    item_domain: binding.domain,
    item_type: binding.item_type,
    item_state: buildMinimalItemState(binding.schema),
    consent: { category: 'profile_creation', version: 1 },
  });
  expect(create.status, `item/create: ${JSON.stringify(create.body)}`).toBe(201);
  const itemId = create.body.item_id;

  const item = await fetchItem(session, binding, itemId);
  test.skip(item?.lifecycle_status === 'live', 'domain is not guardian-gated on this target (minor went live)');
  return { session, binding, itemId, item };
}

test.describe('Journey C — U18 guardian consent', () => {
  // Gate on self-signup being AVAILABLE, not on it being the preferred
  // provisioning method. `provisioningMethod` returns 'service' whenever service
  // credentials exist (to dodge the self-signup IP rate limit), so the old
  // `!== 'signup'` check silently skipped this whole P0 journey on any target
  // with service creds configured — i.e. the recommended setup. C deliberately
  // self-signs-up because service provisioning would bypass the gate under test.
  test.skip(({ cfg }) => cfg.selfSignupMode !== 'allowed', 'C uses OTP self-signup (target must allow it)');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('a minor stays draft and self-consent does NOT promote (fail-closed)', async ({ api, cfg, authCtx, provider }) => {
    const { session, binding, itemId, item } = await setupMinorDraft(api, cfg, cfg.servedDomains[0], authCtx, provider);

    expect(item?.lifecycle_status, 'a gated minor must not be live on create').not.toBe('live');

    // the ward's OWN profile consent must not promote a gated minor
    await session.client.post('/api/v1/consent/profile-accept', {
      network: binding.network,
      item_domain: binding.domain,
      item_type: binding.item_type,
      item_id: itemId,
      version: 1,
    });
    const after = await fetchItem(session, binding, itemId);
    expect(after?.lifecycle_status, 'minor self-consent must NOT promote to live').not.toBe('live');
  });

  test('a verified guardian promotes the minor profile to live', async ({ api, cfg, authCtx, provider }) => {
    const { session, binding, itemId } = await setupMinorDraft(api, cfg, cfg.servedDomains[0], authCtx, provider);

    // 1) register + verify the guardian (account-level guardian consent)
    const guardian = await session.client.post<{ otpSent?: boolean }>('/api/v1/consent/u18/guardian', {
      network: binding.network,
      guardianName: 'E2E Guardian',
      guardianPhone: newPhone(), // distinct from the ward
      guardianDeclarationAccepted: true,
    });
    test.skip(guardian.status === 404, 'target predates the guardian endpoints');
    expect(guardian.status, `u18/guardian: ${JSON.stringify(guardian.body)}`).toBe(200);

    const gVerify = await session.client.post<{ verified?: boolean }>('/api/v1/consent/u18/guardian/verify', {
      network: binding.network,
      otp: TEST_OTP,
    });
    expect(gVerify.status, `guardian/verify: ${JSON.stringify(gVerify.body)}`).toBe(200);
    expect(gVerify.body.verified).toBe(true);

    // 2) guardian profile-creation consent for the item (issue → verify) promotes it
    const issue = await session.client.post<{ otpSent?: boolean }>('/api/v1/consent/u18/profile-consent/issue', {
      network: binding.network,
      item_domain: binding.domain,
      item_type: binding.item_type,
      item_id: itemId,
    });
    expect(issue.status, `profile-consent/issue: ${JSON.stringify(issue.body)}`).toBe(200);

    const verify = await session.client.post<{ verified?: boolean; promoted?: boolean }>('/api/v1/consent/u18/profile-consent/verify', {
      network: binding.network,
      item_domain: binding.domain,
      item_type: binding.item_type,
      item_id: itemId,
      otp: TEST_OTP,
    });
    expect(verify.status, `profile-consent/verify: ${JSON.stringify(verify.body)}`).toBe(200);
    expect(verify.body.promoted, 'guardian consent should promote the item').toBe(true);

    const live = await waitForStatus(session, binding, itemId, 'live');
    expect(live?.lifecycle_status, 'guardian-sourced consent promotes minor to live').toBe('live');
  });
});
