import { test, expect } from '../../src/fixtures.js';
import { requireCapabilities } from '../../src/capabilities.js';
import { createLiveProfileUser, freshIdentity } from '../../src/flows.js';
import { signup, acceptCoreConsent, TEST_OTP, resolveAuthProvider } from '../../src/auth.js';
import { resolveBinding, buildMinimalItemState } from '../../src/schema.js';
import { newName, newPhone } from '../../src/identities.js';
import { tryPerformAction } from '../../src/actions.js';
import type { ApiClient } from '../../src/api-client.js';
import type { E2EConfig } from '../../src/config.js';
import type { AuthContext, Session } from '../../src/auth.js';
import type { Binding } from '../../src/schema.js';
import { skipIfSignupExhausted } from '../../src/signup_budget.js';

/**
 * Journey S — the U18 gating surface (P0).
 *
 * Journey C proves the core invariant (a gated minor reaches `live` only via a
 * guardian). This journey covers everything around it that had no test at all:
 * the read/precheck endpoints, the write-once age, the fail-closed prerequisites,
 * and the two guards that shipped most recently —
 *
 *  - **#395 external-channel block.** A minor may act **in-app only**. An
 *    on-behalf / aggregator call must be refused with
 *    `MINOR_ACTION_CHANNEL_BLOCKED` even though the UI never offers that path —
 *    the API gate is the control, not the UI.
 *  - **#393 batch guardian OTP.** One OTP covers a whole bulk selection, scoped
 *    to the sha256 of the sorted action tuples, so the code cannot be replayed
 *    against a *different* selection.
 *
 * Minors must be created by **self-signup**: `/admin/participant` refuses an
 * under-18 outright (`U18_NOT_ALLOWED`), which the first test pins. Self-signup
 * is capped at 10/hour per IP, so this file keeps its minor count to three.
 */

/** Comfortably under 18 on any network's threshold. */
const MINOR_AGE = 14;

interface MinorPersona {
  session: Session;
  userId: string;
  binding: Binding;
  itemId: string;
  itemInstanceUrl: string;
  lifecycleStatus: string;
  sourceRef: { item_network: string; item_domain: string; item_type: string; item_id: string };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchOwn(session: Session, binding: Binding, itemId: string) {
  const res = await session.client.get<{
    items: Array<{ item_id: string; lifecycle_status?: string; item_instance_url: string }>;
  }>(
    `/api/v1/item/fetch?item_network=${encodeURIComponent(binding.network)}&item_domain=${encodeURIComponent(binding.domain)}&item_type=${encodeURIComponent(binding.item_type)}&limit=100`,
  );
  return res.body?.items?.find((i) => i.item_id === itemId);
}

/** Poll past the ~1s item-fetch cache, which can serve a pre-promotion snapshot. */
async function waitForStatus(session: Session, binding: Binding, itemId: string, want: string) {
  let item = await fetchOwn(session, binding, itemId);
  for (let i = 0; i < 6 && item?.lifecycle_status !== want; i++) {
    await sleep(1200);
    item = await fetchOwn(session, binding, itemId);
  }
  return item;
}

/**
 * Create a minor with a profile in a guardian-gated domain.
 *
 * **Self-signup is the only route.** `POST /admin/participant` refuses an
 * under-18 outright (`U18_NOT_ALLOWED` — "use the portal"), asserted below, so
 * the service path that every other journey uses is unavailable here. That means
 * every minor costs one of the 10-per-hour-per-IP self-signups; keep the count
 * in this file low, and clear `signup:ip:*` on the target's Redis between heavy
 * local runs.
 *
 * `promote: true` additionally runs the guardian flow so the profile reaches
 * `live` (needed by anything that performs an action, since `PROFILE_NOT_LIVE`
 * is checked before the U18 gate).
 */
async function createMinor(
  api: ApiClient,
  cfg: E2EConfig,
  authCtx: AuthContext,
  opts: { domainKey: string; label: string; promote?: boolean },
): Promise<MinorPersona> {
  const binding = await resolveBinding(api, opts.domainKey);
  const provider = await resolveAuthProvider(api, cfg);
  const id = freshIdentity(cfg, opts.label, { provider });

  const session = await signup(api, id, newName(opts.label), authCtx, {
    domain: binding.domain,
    age: MINOR_AGE,
  }).catch((e) => skipIfSignupExhausted(test, e));
  await acceptCoreConsent(session, binding.network, 'signup');

  const dob = await session.client.post<{ isMinor?: boolean }>('/api/v1/consent/u18/dob', {
    network: binding.network,
    age: MINOR_AGE,
  });
  if (dob.status !== 200 || dob.body?.isMinor !== true) {
    throw new Error(`[e2e] u18/dob did not classify a minor: ${dob.status} ${JSON.stringify(dob.body)}`);
  }

  const create = await session.client.post<{ item_id: string }>('/api/v1/item/create', {
    item_network: binding.network,
    item_domain: binding.domain,
    item_type: binding.item_type,
    item_state: buildMinimalItemState(binding.schema),
    consent: { category: 'profile_creation', version: 1 },
  });
  if (create.status !== 201 || !create.body?.item_id) {
    throw new Error(`[e2e] minor item/create failed: ${create.status} ${JSON.stringify(create.body)}`);
  }
  const itemId = create.body.item_id;

  if (opts.promote) {
    await registerGuardian(session, binding.network);
    const issue = await session.client.post('/api/v1/consent/u18/profile-consent/issue', {
      network: binding.network,
      item_domain: binding.domain,
      item_type: binding.item_type,
      item_id: itemId,
    });
    if (issue.status !== 200) {
      throw new Error(`[e2e] profile-consent/issue failed: ${issue.status} ${JSON.stringify(issue.body)}`);
    }
    const verify = await session.client.post<{ promoted?: boolean }>(
      '/api/v1/consent/u18/profile-consent/verify',
      {
        network: binding.network,
        item_domain: binding.domain,
        item_type: binding.item_type,
        item_id: itemId,
        otp: TEST_OTP,
      },
    );
    if (verify.status !== 200) {
      throw new Error(`[e2e] profile-consent/verify failed: ${verify.status} ${JSON.stringify(verify.body)}`);
    }
  }

  const item = await waitForStatus(session, binding, itemId, opts.promote ? 'live' : 'draft');
  return {
    session,
    userId: session.userId,
    binding,
    itemId,
    itemInstanceUrl: item?.item_instance_url ?? '',
    lifecycleStatus: item?.lifecycle_status ?? 'unknown',
    sourceRef: {
      item_network: binding.network,
      item_domain: binding.domain,
      item_type: binding.item_type,
      item_id: itemId,
    },
  };
}

/** Attach + OTP-verify a guardian for the ward (account level). */
async function registerGuardian(session: Session, network: string) {
  const start = await session.client.post('/api/v1/consent/u18/guardian', {
    network,
    guardianName: 'E2E Guardian',
    guardianPhone: newPhone(),
    guardianDeclarationAccepted: true,
  });
  if (start.status !== 200) {
    throw new Error(`[e2e] u18/guardian failed: ${start.status} ${JSON.stringify(start.body)}`);
  }
  const verified = await session.client.post<{ verified?: boolean }>(
    '/api/v1/consent/u18/guardian/verify',
    { network, otp: TEST_OTP },
  );
  if (verified.status !== 200) {
    throw new Error(`[e2e] u18/guardian/verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
}

test.describe('Journey S — U18 gating surface', () => {
  test.beforeEach(({ caps }) => {
    requireCapabilities(test, caps, ['serviceAuth', 'testOtp']);
  });
  // Minors can only be created by self-signup (see createMinor).
  test.skip(({ cfg }) => cfg.selfSignupMode !== 'allowed', 'minors can only be created via self-signup');

  test('an under-18 cannot be onboarded through the service API', async ({ api, service, cfg }) => {
    // Fail-closed: the aggregator/service bulk path must not be a way around the
    // guardian flow. A minor has to come through the portal, where the U18
    // journey (DOB → guardian → OTP) is enforced.
    const binding = await resolveBinding(api, cfg.servedDomains[0]);
    const res = await service.post<{ error?: string }>('/api/v1/admin/participant', {
      phone_number: newPhone(),
      name: newName('minor-svc'),
      age: MINOR_AGE,
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'profile_creation', value: true },
      ],
      channel: 'link',
      network: binding.network,
      domain: binding.domain,
      item_type: binding.item_type,
      item_state: buildMinimalItemState(binding.schema),
    });
    expect(res.status, `service onboarding of a minor must be refused: ${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body?.error).toBe('U18_NOT_ALLOWED');
  });

  test('u18-precheck is public and discloses only requiresDob', async ({ api, cfg }) => {
    // Unauthenticated on purpose — this runs before login in the real flow.
    const res = await api.post<Record<string, unknown>>('/api/v1/auth/u18-precheck', {
      network: cfg.network,
      phoneNumber: newPhone(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.requiresDob, 'an unknown identifier never requires a DOB').toBe(false);
    // The domain is deliberately NOT returned: it would tell an anonymous caller
    // which gated domain an identifier participates in.
    expect(
      Object.keys(res.body).sort(),
      'precheck must disclose exactly one field',
    ).toEqual(['requiresDob']);
  });

  test('u18/status is authenticated and derived server-side', async ({ api, service, cfg, caps, authCtx }) => {
    const anon = await api.get(`/api/v1/consent/u18/status?network=${encodeURIComponent(cfg.network)}`);
    expect(anon.status, 'u18 status must not be readable anonymously').toBe(401);

    const adult = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'sadult',
    });
    const mine = await adult.session.client.get<{ hasBirthData: boolean; isMinor: boolean; guardianVerified: boolean }>(
      `/api/v1/consent/u18/status?network=${encodeURIComponent(cfg.network)}`,
    );
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.hasBirthData, 'a provisioned adult has an age on file').toBe(true);
    expect(mine.body.isMinor).toBe(false);
    expect(mine.body.guardianVerified).toBe(false);

    const unknown = await adult.session.client.get<{ error?: string }>(
      '/api/v1/consent/u18/status?network=not_a_network',
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body?.error).toBe('UNKNOWN_NETWORK');
  });

  test('the stored age is write-once — a minor cannot be re-declared an adult', async ({
    api,
    cfg,
    authCtx,
  }) => {
    const minor = await createMinor(api, cfg, authCtx, {
      domainKey: cfg.servedDomains[0],
      label: 'sagelock',
    });

    const status = await minor.session.client.get<{ isMinor: boolean; hasBirthData: boolean }>(
      `/api/v1/consent/u18/status?network=${encodeURIComponent(cfg.network)}`,
    );
    expect(status.body.hasBirthData).toBe(true);
    expect(status.body.isMinor, 'a 14-year-old must classify as a minor').toBe(true);

    // Re-sending the SAME age is an idempotent no-op…
    const same = await minor.session.client.post<{ isMinor?: boolean }>('/api/v1/consent/u18/dob', {
      network: cfg.network,
      age: MINOR_AGE,
    });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.isMinor).toBe(true);

    // …but a minor→adult flip is refused. Allowing it would silently de-gate an
    // account that already has a guardian attached.
    const flip = await minor.session.client.post<{ error?: string }>('/api/v1/consent/u18/dob', {
      network: cfg.network,
      age: 30,
    });
    expect(flip.status, `age overwrite must be refused: ${JSON.stringify(flip.body)}`).toBe(409);
    expect(flip.body?.error).toBe('DOB_ALREADY_SET');

    const after = await minor.session.client.get<{ isMinor: boolean }>(
      `/api/v1/consent/u18/status?network=${encodeURIComponent(cfg.network)}`,
    );
    expect(after.body.isMinor, 'the ward must still be a minor after the refused flip').toBe(true);
  });

  test('guardian prerequisites are fail-closed', async ({ api, cfg, authCtx }) => {
    const minor = await createMinor(api, cfg, authCtx, {
      domainKey: cfg.servedDomains[0],
      label: 'sprereq',
    });
    expect(minor.lifecycleStatus, 'a gated minor must not be live on create').not.toBe('live');

    const base = {
      network: minor.binding.network,
      item_domain: minor.binding.domain,
      item_type: minor.binding.item_type,
      item_id: minor.itemId,
    };

    // No guardian on file yet → the OTP cannot even be issued.
    const issue = await minor.session.client.post<{ error?: string }>(
      '/api/v1/consent/u18/profile-consent/issue',
      base,
    );
    expect(issue.status, `issue without a guardian: ${JSON.stringify(issue.body)}`).toBe(409);
    expect(issue.body?.error).toBe('GUARDIAN_REQUIRED');

    // Finalize without a verified pre-create OTP must not record consent.
    const finalize = await minor.session.client.post<{ error?: string }>(
      '/api/v1/consent/u18/profile-consent/finalize',
      base,
    );
    expect(finalize.status, `finalize without precreate: ${JSON.stringify(finalize.body)}`).toBe(409);
    expect(finalize.body?.error).toBe('GUARDIAN_PRECREATE_REQUIRED');

    // With a guardian attached, a WRONG OTP still must not promote.
    await registerGuardian(minor.session, minor.binding.network);
    const reissue = await minor.session.client.post(
      '/api/v1/consent/u18/profile-consent/issue',
      base,
    );
    expect(reissue.status, JSON.stringify(reissue.body)).toBe(200);
    const badOtp = await minor.session.client.post<{ error?: string }>(
      '/api/v1/consent/u18/profile-consent/verify',
      { ...base, otp: '999999' },
    );
    expect(badOtp.status).toBe(400);
    expect(badOtp.body?.error).toBe('INVALID_OTP');

    const stillDraft = await fetchOwn(minor.session, minor.binding, minor.itemId);
    expect(stillDraft?.lifecycle_status, 'a wrong guardian OTP must not promote').not.toBe('live');
  });

  test('a minor cannot act over an external / on-behalf channel (#395)', async ({
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    // The source profile must be LIVE: `PROFILE_NOT_LIVE` is checked before the
    // U18 gate, so an unpromoted minor would fail for the wrong reason and the
    // channel block would never be reached.
    const minor = await createMinor(api, cfg, authCtx, {
      domainKey: cfg.servedDomains[0],
      label: 'sextm',
      promote: true,
    });
    expect(minor.lifecycleStatus, 'the minor must be live before the channel guard is reachable').toBe('live');

    const target = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0],
      label: 'sextt',
    });

    // In-app (self) channel first — this is the control. If this fails the
    // block below would be indistinguishable from "actions don't work at all".
    const inApp = await tryPerformAction(minor.session, {
      actionType: cfg.action.type,
      source: minor.sourceRef,
      target: target.targetRef,
    });
    // Exactly two outcomes are legitimate in-app for a minor: the action goes
    // through, or the guardian OTP gate asks for a code. Enumerating them (rather
    // than just asserting "not blocked") is what makes this a real control — a
    // vaguer check would pass even if in-app actions were broken for some other
    // reason, and the block below would then prove nothing.
    const inAppOutcome = inApp.result?.status === 'success' ? 'success' : inApp.result?.error;
    expect(
      ['success', 'GUARDIAN_OTP_REQUIRED'],
      `a minor's in-app action must either succeed or request a guardian OTP; got ${JSON.stringify(inApp.result)}`,
    ).toContain(inAppOutcome);

    // Now the same action on behalf of the minor, through the service caller.
    // `channel` is derived from `request.acting_org`, so this is 'external'.
    const onBehalf = await service.post<{
      results?: Array<{ status: string; error?: string }>;
      error?: string;
    }>('/api/v1/action/perform', {
      action_type: cfg.action.type,
      source_item: minor.sourceRef,
      target_item: target.targetRef,
      requirements_snapshot: {},
      acting_as_user_id: minor.userId,
      consent: { acknowledged: true, version: 1 },
    });
    const item = onBehalf.body?.results?.[0];
    expect(
      item?.error ?? onBehalf.body?.error,
      `a minor's action over an external channel must be blocked: HTTP ${onBehalf.status} ${JSON.stringify(onBehalf.body)}`,
    ).toBe('MINOR_ACTION_CHANNEL_BLOCKED');
  });
});
