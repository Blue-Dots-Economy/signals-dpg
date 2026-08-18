import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const {
  isItemOwnedBy, requireMinorWard, getGuardianContactPlaintext, getGuardianNamePlaintext,
  getNetworkConfigById, guardianConsentRequired, resolveConsentVersion,
  issueGuardianOtp, verifyGuardianOtp, assertVerifyAttemptAllowed, guardianOtpErrorReply,
  upsertGuardianProfileConsentAndPromote, publishItemEvent, invalidateItemFetchCache,
  redisMock, dbState,
} = vi.hoisted(() => ({
  isItemOwnedBy: vi.fn(),
  requireMinorWard: vi.fn(),
  getGuardianContactPlaintext: vi.fn(),
  getGuardianNamePlaintext: vi.fn(),
  getNetworkConfigById: vi.fn(),
  guardianConsentRequired: vi.fn(),
  resolveConsentVersion: vi.fn(),
  issueGuardianOtp: vi.fn(),
  verifyGuardianOtp: vi.fn(),
  assertVerifyAttemptAllowed: vi.fn(),
  guardianOtpErrorReply: vi.fn(),
  upsertGuardianProfileConsentAndPromote: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publishItemEvent: vi.fn(async (..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invalidateItemFetchCache: vi.fn(async (..._a: any[]) => {}),
  redisMock: { get: vi.fn(), set: vi.fn(), getdel: vi.fn() },
  // Resettable flag so a forced transaction failure never leaks into a later
  // test (monkey-patching the shared mock would).
  dbState: { failWith: null as Error | null },
}));

vi.mock('@/config', () => ({
  apiConfig: { served_domains: [{ network: 'blue_dot', domain: 'seeker' }] },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (dbState.failWith) throw dbState.failWith;
      return fn({ tx: true });
    },
  },
}));

vi.mock('@api/db/secondary/redis', () => ({ redis: redisMock }));

/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('@/services/item_service', () => ({
  isItemOwnedBy: (...a: any[]) => isItemOwnedBy(...a),
  upsertGuardianProfileConsentAndPromote: (...a: any[]) => upsertGuardianProfileConsentAndPromote(...a),
}));

vi.mock('@/services/minor_guardian_repo', () => ({
  requireMinorWard: (...a: any[]) => requireMinorWard(...a),
  getGuardianContactPlaintext: (...a: any[]) => getGuardianContactPlaintext(...a),
  getGuardianNamePlaintext: (...a: any[]) => getGuardianNamePlaintext(...a),
}));

vi.mock('@/services/minor', () => ({
  guardianConsentRequired: (...a: any[]) => guardianConsentRequired(...a),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...a: any[]) => getNetworkConfigById(...a),
}));

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: (...a: any[]) => resolveConsentVersion(...a),
}));

vi.mock('@/utils/publish_item_event', () => ({
  publishItemEvent: (...a: any[]) => publishItemEvent(...a),
}));

vi.mock('@/utils/item_fetch_cache_invalidate', () => ({
  invalidateItemFetchCache: (...a: any[]) => invalidateItemFetchCache(...a),
}));

vi.mock('@/services/guardian_otp', () => ({
  issueGuardianOtp: (...a: any[]) => issueGuardianOtp(...a),
  verifyGuardianOtp: (...a: any[]) => verifyGuardianOtp(...a),
  assertVerifyAttemptAllowed: (...a: any[]) => assertVerifyAttemptAllowed(...a),
  guardianOtpErrorReply: (...a: any[]) => guardianOtpErrorReply(...a),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

import { u18_profile_consent } from '../u18_profile_consent';

interface FakeReply {
  statusCode: number;
  body: unknown;
  code(c: number): FakeReply;
  send(b: unknown): FakeReply;
}

function makeReply(): FakeReply {
  return {
    statusCode: 0,
    body: undefined,
    code(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, reply: any) => Promise<unknown>;

const routes = new Map<string, Handler>();
const log = { error: vi.fn(), warn: vi.fn() };

beforeAll(async () => {
  // The handlers aren't exported; register the plugin against a fake fastify
  // and capture the route handlers by url.
  const fakeFastify = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    route: (opts: any) => { routes.set(String(opts.url), opts.handler as Handler); },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await u18_profile_consent(fakeFastify as any, {} as any);
});

const AUTHED = { id: 'u1' };
/** `user: null` models an unauthenticated request (`request.user` unset). */
function call(url: string, body: Record<string, unknown>, user: unknown = AUTHED) {
  const handler = routes.get(url);
  if (!handler) throw new Error(`route not registered: ${url}`);
  const reply = makeReply();
  return handler({ log, user: user ?? undefined, body }, reply).then(() => reply);
}

const err = (reply: FakeReply) => (reply.body as { error: string }).error;

const ITEM = {
  network: 'blue_dot',
  brand: 'bd',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_id: '11111111-1111-1111-1111-111111111111',
};
const PRECREATE = { network: 'blue_dot', brand: 'bd', item_domain: 'seeker' };
const TOKEN_KEY = 'u18:precreate:u1:blue_dot:seeker';

/** Happy-path defaults: minor ward, gated domain, guardian contact on file. */
function primeMinor() {
  isItemOwnedBy.mockResolvedValue(true);
  requireMinorWard.mockResolvedValue({ ok: true, age: 15 });
  getNetworkConfigById.mockResolvedValue({ id: 'blue_dot' });
  guardianConsentRequired.mockReturnValue(true);
  getGuardianContactPlaintext.mockResolvedValue({ contact: 'g@example.com', contactType: 'email' });
  getGuardianNamePlaintext.mockResolvedValue('Parent P');
  resolveConsentVersion.mockResolvedValue(3);
  verifyGuardianOtp.mockResolvedValue(true);
  assertVerifyAttemptAllowed.mockResolvedValue(undefined);
  issueGuardianOtp.mockResolvedValue(undefined);
  upsertGuardianProfileConsentAndPromote.mockResolvedValue(true);
  guardianOtpErrorReply.mockReturnValue(null);
  redisMock.getdel.mockResolvedValue('1');
  redisMock.set.mockResolvedValue('OK');
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.failWith = null;
  primeMinor();
});

describe('u18_profile_consent plugin registration', () => {
  it('registers all five POST routes', () => {
    expect([...routes.keys()].sort()).toEqual([
      '/u18/profile-consent/finalize',
      '/u18/profile-consent/issue',
      '/u18/profile-consent/precreate/issue',
      '/u18/profile-consent/precreate/verify',
      '/u18/profile-consent/verify',
    ]);
  });
});

// --- shared guards across all five handlers ---------------------------------
describe('shared guards', () => {
  const itemRoutes = [
    '/u18/profile-consent/issue',
    '/u18/profile-consent/verify',
    '/u18/profile-consent/finalize',
  ];
  const precreateRoutes = [
    '/u18/profile-consent/precreate/issue',
    '/u18/profile-consent/precreate/verify',
  ];

  it.each([...itemRoutes, ...precreateRoutes])('%s → 401 when unauthenticated', async (url) => {
    const reply = await call(url, { ...ITEM, otp: '000000' }, null);
    expect(reply.statusCode).toBe(401);
    expect(err(reply)).toBe('UNAUTHORIZED');
  });

  it.each([...itemRoutes, ...precreateRoutes])('%s → 400 UNKNOWN_NETWORK for an unserved network', async (url) => {
    const reply = await call(url, { ...ITEM, network: 'green_dot', otp: '000000' });
    expect(reply.statusCode).toBe(400);
    expect(err(reply)).toBe('UNKNOWN_NETWORK');
  });

  it.each(itemRoutes)('%s → 403 NOT_ITEM_OWNER when the caller does not own the item', async (url) => {
    isItemOwnedBy.mockResolvedValue(false);
    const reply = await call(url, { ...ITEM, otp: '000000' });
    expect(reply.statusCode).toBe(403);
    expect(err(reply)).toBe('NOT_ITEM_OWNER');
    // The ward check is short-circuited by the ownership failure.
    expect(requireMinorWard).not.toHaveBeenCalled();
  });

  it.each(itemRoutes)('%s → 409 DOB_REQUIRED when no age is on file', async (url) => {
    requireMinorWard.mockResolvedValue({ ok: false, code: 'DOB_REQUIRED' });
    const reply = await call(url, { ...ITEM, otp: '000000' });
    expect(reply.statusCode).toBe(409);
    expect(err(reply)).toBe('DOB_REQUIRED');
  });

  it.each(itemRoutes)('%s → 409 NOT_A_MINOR for an adult owner', async (url) => {
    requireMinorWard.mockResolvedValue({ ok: false, code: 'NOT_A_MINOR' });
    const reply = await call(url, { ...ITEM, otp: '000000' });
    expect(reply.statusCode).toBe(409);
    expect(err(reply)).toBe('NOT_A_MINOR');
  });

  it.each(precreateRoutes)('%s → 409 NOT_A_MINOR for an adult', async (url) => {
    requireMinorWard.mockResolvedValue({ ok: false, code: 'NOT_A_MINOR' });
    const reply = await call(url, { ...PRECREATE, otp: '000000' });
    expect(reply.statusCode).toBe(409);
    expect(err(reply)).toBe('NOT_A_MINOR');
  });

  it.each(precreateRoutes)('%s → 409 NOT_GATED when the domain needs no guardian consent', async (url) => {
    guardianConsentRequired.mockReturnValue(false);
    const reply = await call(url, { ...PRECREATE, otp: '000000' });
    expect(reply.statusCode).toBe(409);
    expect(err(reply)).toBe('NOT_GATED');
    expect(getNetworkConfigById).toHaveBeenCalledWith('blue_dot');
    expect(guardianConsentRequired).toHaveBeenCalledWith({ id: 'blue_dot' }, 'seeker');
  });

  it('the item-scoped routes do NOT check guardianConsentRequired (ownership + minor only)', async () => {
    // assertOwnedMinorItem intentionally omits the gated-domain check that the
    // pre-create path performs.
    await call('/u18/profile-consent/issue', ITEM);
    expect(guardianConsentRequired).not.toHaveBeenCalled();
  });
});

// --- precreate/issue -------------------------------------------------------
describe('precreate/issue', () => {
  const url = '/u18/profile-consent/precreate/issue';

  it('issues an OTP scoped to ward+network+domain and returns otpSent', async () => {
    const reply = await call(url, PRECREATE);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ otpSent: true });
    expect(issueGuardianOtp).toHaveBeenCalledWith({
      scope: 'u1:profile_create:blue_dot:seeker',
      contact: 'g@example.com',
      contactType: 'email',
      scenario: { kind: 'profile' },
      variables: { parentName: 'Parent P', domain: 'seeker' },
    });
  });

  it('omits parentName from the template variables when no guardian name is stored', async () => {
    getGuardianNamePlaintext.mockResolvedValue(null);
    await call(url, PRECREATE);
    expect(issueGuardianOtp.mock.calls[0][0]).toMatchObject({ variables: { domain: 'seeker' } });
    expect(issueGuardianOtp.mock.calls[0][0].variables).not.toHaveProperty('parentName');
  });

  it('409 GUARDIAN_REQUIRED when no guardian contact is on file', async () => {
    getGuardianContactPlaintext.mockResolvedValue(null);
    const reply = await call(url, PRECREATE);
    expect(reply.statusCode).toBe(409);
    expect(err(reply)).toBe('GUARDIAN_REQUIRED');
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('maps a GuardianOtpError to its status ladder (429 OTP_RATE_LIMITED)', async () => {
    issueGuardianOtp.mockRejectedValue(new Error('rate limited'));
    guardianOtpErrorReply.mockReturnValue({ status: 429, error: 'OTP_RATE_LIMITED', message: 'too many' });
    const reply = await call(url, PRECREATE);
    expect(reply.statusCode).toBe(429);
    expect(err(reply)).toBe('OTP_RATE_LIMITED');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('500 OTP_SEND_FAILED and logs for a non-OTP send failure', async () => {
    issueGuardianOtp.mockRejectedValue(new Error('smtp down'));
    guardianOtpErrorReply.mockReturnValue(null);
    const reply = await call(url, PRECREATE);
    expect(reply.statusCode).toBe(500);
    expect(err(reply)).toBe('OTP_SEND_FAILED');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- precreate/verify ------------------------------------------------------
describe('precreate/verify', () => {
  const url = '/u18/profile-consent/precreate/verify';

  it('stores a short-lived pre-create token on success', async () => {
    const reply = await call(url, { ...PRECREATE, otp: '123456' });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ verified: true });
    expect(verifyGuardianOtp).toHaveBeenCalledWith({ scope: 'u1:profile_create:blue_dot:seeker', otp: '123456' });
    expect(redisMock.set).toHaveBeenCalledWith(TOKEN_KEY, '1', 'EX', 900);
  });

  it('400 INVALID_OTP and writes no token when the OTP does not match', async () => {
    verifyGuardianOtp.mockResolvedValue(false);
    const reply = await call(url, { ...PRECREATE, otp: '999999' });
    expect(reply.statusCode).toBe(400);
    expect(err(reply)).toBe('INVALID_OTP');
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('429 OTP_VERIFY_THROTTLED when the attempt limiter rejects', async () => {
    assertVerifyAttemptAllowed.mockRejectedValue(new Error('throttled'));
    guardianOtpErrorReply.mockReturnValue({ status: 429, error: 'OTP_VERIFY_THROTTLED', message: 'slow down' });
    const reply = await call(url, { ...PRECREATE, otp: '123456' });
    expect(reply.statusCode).toBe(429);
    expect(err(reply)).toBe('OTP_VERIFY_THROTTLED');
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });

  it('500 OTP_VERIFY_FAILED when the attempt check fails for a non-OTP reason', async () => {
    assertVerifyAttemptAllowed.mockRejectedValue(new Error('redis down'));
    guardianOtpErrorReply.mockReturnValue(null);
    const reply = await call(url, { ...PRECREATE, otp: '123456' });
    expect(reply.statusCode).toBe(500);
    expect(err(reply)).toBe('OTP_VERIFY_FAILED');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- finalize --------------------------------------------------------------
describe('finalize', () => {
  const url = '/u18/profile-consent/finalize';

  it('consumes the token atomically via getdel and writes the guardian consent row', async () => {
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ promoted: true });
    expect(redisMock.getdel).toHaveBeenCalledWith(TOKEN_KEY);
    expect(resolveConsentVersion).toHaveBeenCalledWith({
      network: 'blue_dot', brand: 'bd', category: 'profile_creation', variant: 'u18',
    });
    expect(upsertGuardianProfileConsentAndPromote).toHaveBeenCalledWith(
      { tx: true },
      {
        userId: 'u1',
        itemId: ITEM.item_id,
        network: 'blue_dot',
        brand: 'bd',
        documentVersion: 3,
      },
    );
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('reports promoted:false when the item was not flipped to live', async () => {
    upsertGuardianProfileConsentAndPromote.mockResolvedValue(false);
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ promoted: false });
  });

  it('409 GUARDIAN_PRECREATE_REQUIRED when no guardian OTP was verified (D13)', async () => {
    // The self consent row written at create time does not satisfy the gate —
    // only a verified guardian OTP token does.
    redisMock.getdel.mockResolvedValue(null);
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(409);
    expect(err(reply)).toBe('GUARDIAN_PRECREATE_REQUIRED');
    expect(upsertGuardianProfileConsentAndPromote).not.toHaveBeenCalled();
  });

  it('400 CONSENT_VERSION_UNCONFIGURED and restores the token so a retry can finalize', async () => {
    resolveConsentVersion.mockResolvedValue(null);
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(400);
    expect(err(reply)).toBe('CONSENT_VERSION_UNCONFIGURED');
    expect(redisMock.set).toHaveBeenCalledWith(TOKEN_KEY, '1', 'EX', 900);
    expect(upsertGuardianProfileConsentAndPromote).not.toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED and restores the token when the transaction throws', async () => {
    dbState.failWith = new Error('deadlock');
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(500);
    expect(err(reply)).toBe('CONSENT_WRITE_FAILED');
    expect(redisMock.set).toHaveBeenCalledWith(TOKEN_KEY, '1', 'EX', 900);
    expect(log.error).toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED when the consent upsert itself throws', async () => {
    upsertGuardianProfileConsentAndPromote.mockRejectedValue(new Error('constraint'));
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(500);
    expect(err(reply)).toBe('CONSENT_WRITE_FAILED');
    expect(redisMock.set).toHaveBeenCalledWith(TOKEN_KEY, '1', 'EX', 900);
  });
});

// --- item-scoped issue -----------------------------------------------------
describe('profile-consent/issue', () => {
  const url = '/u18/profile-consent/issue';

  it('issues an OTP scoped to ward+item id', async () => {
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ otpSent: true });
    expect(issueGuardianOtp).toHaveBeenCalledWith({
      scope: `u1:profile:${ITEM.item_id}`,
      contact: 'g@example.com',
      contactType: 'email',
      scenario: { kind: 'profile' },
      variables: { parentName: 'Parent P', domain: 'seeker' },
    });
    expect(isItemOwnedBy).toHaveBeenCalledWith('u1', ITEM);
  });

  it('409 GUARDIAN_REQUIRED when no guardian contact is stored', async () => {
    getGuardianContactPlaintext.mockResolvedValue(null);
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(409);
    expect(err(reply)).toBe('GUARDIAN_REQUIRED');
  });

  it('503 OTP_PROVIDER_UNAVAILABLE when no OTP channel is configured', async () => {
    issueGuardianOtp.mockRejectedValue(new Error('no provider'));
    guardianOtpErrorReply.mockReturnValue({
      status: 503, error: 'OTP_PROVIDER_UNAVAILABLE', message: 'no channel',
    });
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(503);
    expect(err(reply)).toBe('OTP_PROVIDER_UNAVAILABLE');
  });

  it('500 OTP_SEND_FAILED for an unexpected send error', async () => {
    issueGuardianOtp.mockRejectedValue(new Error('boom'));
    guardianOtpErrorReply.mockReturnValue(null);
    const reply = await call(url, ITEM);
    expect(reply.statusCode).toBe(500);
    expect(err(reply)).toBe('OTP_SEND_FAILED');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- item-scoped verify ----------------------------------------------------
describe('profile-consent/verify', () => {
  const url = '/u18/profile-consent/verify';

  it('verifies, writes the guardian row and reports promotion', async () => {
    const reply = await call(url, { ...ITEM, otp: '123456' });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ verified: true, promoted: true });
    expect(verifyGuardianOtp).toHaveBeenCalledWith({ scope: `u1:profile:${ITEM.item_id}`, otp: '123456' });
    expect(upsertGuardianProfileConsentAndPromote).toHaveBeenCalledWith(
      { tx: true },
      {
        userId: 'u1',
        itemId: ITEM.item_id,
        network: 'blue_dot',
        brand: 'bd',
        documentVersion: 3,
      },
    );
  });

  it('resolves the consent version BEFORE consuming the single-use OTP', async () => {
    resolveConsentVersion.mockResolvedValue(null);
    const reply = await call(url, { ...ITEM, otp: '123456' });
    expect(reply.statusCode).toBe(400);
    expect(err(reply)).toBe('CONSENT_VERSION_UNCONFIGURED');
    // The OTP must survive a config misconfiguration so a retry can use it.
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });

  it('400 INVALID_OTP without writing consent when the code is wrong', async () => {
    verifyGuardianOtp.mockResolvedValue(false);
    const reply = await call(url, { ...ITEM, otp: '000000' });
    expect(reply.statusCode).toBe(400);
    expect(err(reply)).toBe('INVALID_OTP');
    expect(upsertGuardianProfileConsentAndPromote).not.toHaveBeenCalled();
  });

  it('429 OTP_VERIFY_THROTTLED when the attempt limiter rejects', async () => {
    assertVerifyAttemptAllowed.mockRejectedValue(new Error('throttled'));
    guardianOtpErrorReply.mockReturnValue({ status: 429, error: 'OTP_VERIFY_THROTTLED', message: 'slow down' });
    const reply = await call(url, { ...ITEM, otp: '123456' });
    expect(reply.statusCode).toBe(429);
    expect(err(reply)).toBe('OTP_VERIFY_THROTTLED');
    expect(resolveConsentVersion).not.toHaveBeenCalled();
  });

  it('500 OTP_VERIFY_FAILED when the attempt check fails for a non-OTP reason', async () => {
    assertVerifyAttemptAllowed.mockRejectedValue(new Error('redis down'));
    guardianOtpErrorReply.mockReturnValue(null);
    const reply = await call(url, { ...ITEM, otp: '123456' });
    expect(reply.statusCode).toBe(500);
    expect(err(reply)).toBe('OTP_VERIFY_FAILED');
    expect(log.error).toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED when the transaction throws (OTP already spent)', async () => {
    dbState.failWith = new Error('deadlock');
    const reply = await call(url, { ...ITEM, otp: '123456' });
    expect(reply.statusCode).toBe(500);
    expect(err(reply)).toBe('CONSENT_WRITE_FAILED');
    expect(log.error).toHaveBeenCalled();
    // Unlike finalize, there is no token to restore here.
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('passes a null brand straight through to version resolution', async () => {
    await call(url, { ...ITEM, brand: null, otp: '123456' });
    expect(resolveConsentVersion).toHaveBeenCalledWith({
      network: 'blue_dot', brand: null, category: 'profile_creation', variant: 'u18',
    });
  });
});

// --- search index + read caches after a guardian promotion (#557) -----------
// This is the flow the bug was reported on: a U18 profile is created `draft`,
// guardian consent promotes it to `live`, and nothing told signals-search — so
// the profile stayed `draft` in item_search and was invisible to the network
// while its owner's UI showed it as Active.
describe.each([
  ['/u18/profile-consent/verify', { ...ITEM, otp: '123456' }],
  ['/u18/profile-consent/finalize', ITEM],
])('%s — after a promotion', (url, body) => {
  it('publishes an upsert item event so search re-indexes the now-live profile', async () => {
    upsertGuardianProfileConsentAndPromote.mockResolvedValue(true);

    const reply = await call(url, body);

    expect(reply.statusCode).toBe(200);
    expect(publishItemEvent).toHaveBeenCalledWith(
      {
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_id: ITEM.item_id,
        op: 'upsert',
      },
      log,
    );
  });

  it('sweeps the item-fetch caches, as the self-consent route already does', async () => {
    upsertGuardianProfileConsentAndPromote.mockResolvedValue(true);

    await call(url, body);

    expect(invalidateItemFetchCache).toHaveBeenCalledWith('blue_dot', 'seeker');
  });

  it('does nothing when the guardian consent did not promote the item', async () => {
    upsertGuardianProfileConsentAndPromote.mockResolvedValue(false);

    await call(url, body);

    expect(publishItemEvent).not.toHaveBeenCalled();
    expect(invalidateItemFetchCache).not.toHaveBeenCalled();
  });

  it('still returns 200 when the publish fails — consent is already committed', async () => {
    upsertGuardianProfileConsentAndPromote.mockResolvedValue(true);
    publishItemEvent.mockRejectedValue(new Error('redis down'));

    const reply = await call(url, body);

    expect(reply.statusCode).toBe(200);
  });

  it('still publishes and returns 200 when the cache sweep fails', async () => {
    // The consent row and the lifecycle flip are already committed, so a cache
    // miss must neither fail the request nor skip the search re-index behind it.
    upsertGuardianProfileConsentAndPromote.mockResolvedValue(true);
    invalidateItemFetchCache.mockRejectedValue(new Error('redis down'));

    const reply = await call(url, body);

    expect(reply.statusCode).toBe(200);
    expect(log.warn).toHaveBeenCalled();
    expect(publishItemEvent).toHaveBeenCalledTimes(1);
  });
});
