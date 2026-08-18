import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// The handler is exported directly, so it is called without a fastify instance.
// Everything it touches is mocked: the point of these tests is which side
// effects fire after a promotion, not the DB mechanics.
const {
  isItemOwnedBy, promoteItemOnProfileConsent, hasAcceptedTermsAndPrivacy,
  resolveConsentVersion, publishItemEvent, invalidateItemFetchCache,
  dbState, inserted,
} = vi.hoisted(() => ({
  isItemOwnedBy: vi.fn(),
  promoteItemOnProfileConsent: vi.fn(),
  hasAcceptedTermsAndPrivacy: vi.fn(),
  resolveConsentVersion: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publishItemEvent: vi.fn(async (..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invalidateItemFetchCache: vi.fn(async (..._a: any[]) => {}),
  // Resettable so a forced failure never leaks into a later test.
  dbState: { existingConsent: [] as unknown[], failWith: null as Error | null },
  inserted: [] as unknown[],
}));

vi.mock('@/config', () => ({
  apiConfig: { served_domains: [{ network: 'blue_dot', domain: 'seeker' }] },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@api/db/postgres/schema', () => ({ consent_record: {} }));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    // Idempotency pre-check: select().from().where().limit()
    select: () => ({ from: () => ({ where: () => ({ limit: async () => dbState.existingConsent }) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (dbState.failWith) throw dbState.failWith;
      return fn({ insert: () => ({ values: async (v: unknown) => { inserted.push(v); } }) });
    },
  },
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('@/services/item_service', () => ({
  isItemOwnedBy: (...a: any[]) => isItemOwnedBy(...a),
  promoteItemOnProfileConsent: (...a: any[]) => promoteItemOnProfileConsent(...a),
}));
vi.mock('@/services/consent_acceptance', () => ({
  hasAcceptedTermsAndPrivacy: (...a: any[]) => hasAcceptedTermsAndPrivacy(...a),
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
/* eslint-enable @typescript-eslint/no-explicit-any */

import { accept_profile_consent_handler } from '../accept_profile_consent';

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

const log = { error: vi.fn(), warn: vi.fn() };
const ITEM_ID = '11111111-1111-1111-1111-111111111111';
const BODY = {
  network: 'blue_dot',
  brand: 'bd',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_id: ITEM_ID,
  version: 1,
};

function call(body: Record<string, unknown> = BODY, user: unknown = { id: 'u1' }) {
  const reply = makeReply();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return accept_profile_consent_handler({ log, user, body } as any, reply as any).then(() => reply);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.existingConsent = [];
  dbState.failWith = null;
  inserted.length = 0;
  isItemOwnedBy.mockResolvedValue(true);
  hasAcceptedTermsAndPrivacy.mockResolvedValue(true);
  resolveConsentVersion.mockResolvedValue(3);
  promoteItemOnProfileConsent.mockResolvedValue(true);
});

describe('accept_profile_consent — search indexing after promotion (#557)', () => {
  it('publishes an upsert item event when consent promotes the profile to live', async () => {
    // Without this the signals-search index keeps the profile at `draft`, so it is
    // invisible in every ranked feed and every map viewport while `items` says live.
    const reply = await call();

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ recorded: 1 });
    expect(publishItemEvent).toHaveBeenCalledWith(
      {
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_id: ITEM_ID,
        op: 'upsert',
      },
      log,
    );
  });

  it('does not publish when consent recorded but the item was not promoted', async () => {
    // An incomplete profile, or a minor still awaiting guardian consent: nothing
    // about the indexed row changed, so there is nothing to tell search about.
    promoteItemOnProfileConsent.mockResolvedValue(false);

    await call();

    expect(publishItemEvent).not.toHaveBeenCalled();
    expect(invalidateItemFetchCache).not.toHaveBeenCalled();
  });

  it('still returns 200 when publishing the event fails', async () => {
    // Best-effort: the consent row is already committed, so a Redis outage must
    // not turn a recorded consent into a 500. The sweep is the backstop.
    publishItemEvent.mockRejectedValue(new Error('redis down'));

    const reply = await call();

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ recorded: 1 });
  });
});
