import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// Every dependency of the two accept handlers is mocked so these stay pure unit
// tests (the integration siblings need live Postgres + Redis).
const {
  dbState,
  selectQueue,
  insertCalls,
  txInsertCalls,
  resolveConsentVersion,
  hasAcceptedTermsAndPrivacy,
  isItemOwnedBy,
  promoteItemOnProfileConsent,
  invalidateItemFetchCache,
  apiConfig,
} = vi.hoisted(() => ({
  // Resettable failure flags — never monkey-patch the shared queue, an override
  // there leaks into every later test in the file.
  dbState: {
    failSelect: null as Error | null,
    failInsert: null as (Error & { code?: string }) | null,
    failTxInsert: null as (Error & { code?: string }) | null,
    failTransaction: null as Error | null,
  },
  selectQueue: [] as unknown[][],
  insertCalls: [] as unknown[],
  txInsertCalls: [] as unknown[],
  resolveConsentVersion: vi.fn(),
  hasAcceptedTermsAndPrivacy: vi.fn(),
  isItemOwnedBy: vi.fn(),
  promoteItemOnProfileConsent: vi.fn(),
  invalidateItemFetchCache: vi.fn(),
  apiConfig: {
    served_domains: [
      { network: 'blue_dot', domain: 'student' },
      { network: 'yellow_dot', domain: 'seeker' },
    ] as Array<{ network: string; domain: string }>,
  },
}));

function nextRows() {
  if (dbState.failSelect) return Promise.reject(dbState.failSelect);
  return Promise.resolve(selectQueue.shift() ?? []);
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          // Thenable so an awaited `.where(...)` works as well as `.limit()`.
          // BOTH callbacks must be forwarded — dropping `rej` would hang a
          // rejected query until the test timeout.
          const result = {
            then: (
              res: (v: unknown) => unknown,
              rej?: (e: unknown) => unknown,
            ) => nextRows().then(res, rej),
            limit: () => nextRows(),
          };
          return result;
        },
      }),
    }),
    insert: () => ({
      values: (rows: unknown) => {
        insertCalls.push(rows);
        if (dbState.failInsert) return Promise.reject(dbState.failInsert);
        return Promise.resolve([]);
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (dbState.failTransaction) throw dbState.failTransaction;
      const tx = {
        insert: () => ({
          values: (rows: unknown) => {
            txInsertCalls.push(rows);
            if (dbState.failTxInsert) return Promise.reject(dbState.failTxInsert);
            return Promise.resolve([]);
          },
        }),
      };
      return fn(tx);
    },
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  consent_record: {
    id: 'cr.id',
    userId: 'cr.userId',
    level: 'cr.level',
    consentCategory: 'cr.consentCategory',
    itemId: 'cr.itemId',
    network: 'cr.network',
    documentVersion: 'cr.documentVersion',
    source: 'cr.source',
  },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@dpg/schemas', () => ({
  default: { object: () => ({}), number: () => ({ int: () => ({}) }) },
  ConsentAcceptBodySchema: {},
  ConsentAcceptResponseSchema: {},
  ProfileConsentAcceptBodySchema: {},
}));

vi.mock('@/config', () => ({ apiConfig }));

// accept_profile_consent publishes an item event after a promotion (#557), which
// pulls in the Redis client — mocked here so this unit suite never touches Redis
// (and so the `@/config` mock above doesn't need to grow `databasesConfig`).
vi.mock('@/utils/publish_item_event', () => ({
  publishItemEvent: vi.fn(async (..._a: unknown[]) => {}),
  publishItemEvents: vi.fn(async (..._a: unknown[]) => {}),
}));

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: (...a: unknown[]) => resolveConsentVersion(...a),
}));

vi.mock('@/services/consent_acceptance', () => ({
  hasAcceptedTermsAndPrivacy: (...a: unknown[]) =>
    hasAcceptedTermsAndPrivacy(...a),
}));

vi.mock('@/services/item_service', () => ({
  isItemOwnedBy: (...a: unknown[]) => isItemOwnedBy(...a),
  promoteItemOnProfileConsent: (...a: unknown[]) =>
    promoteItemOnProfileConsent(...a),
}));

vi.mock('@/utils/item_fetch_cache_invalidate', () => ({
  invalidateItemFetchCache: (...a: unknown[]) => invalidateItemFetchCache(...a),
}));

import {
  accept_profile_consent,
  accept_profile_consent_handler,
} from '../accept_profile_consent';
import { accept_consent, accept_consent_handler } from '../accept_consent';

// --- harness ---------------------------------------------------------------

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
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
}

const log = { error: vi.fn(), warn: vi.fn() };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(handler: any, req: Record<string, unknown>) {
  const reply = makeReply();
  return handler({ log, ...req }, reply).then(() => reply);
}

const errorOf = (reply: FakeReply) => (reply.body as { error?: string }).error;

const profileBody = (over: Record<string, unknown> = {}) => ({
  network: 'blue_dot',
  brand: null,
  item_domain: 'student',
  item_type: 'profile_1.0',
  item_id: 'item-1',
  version: 1,
  ...over,
});

const lastTxRow = () =>
  (txInsertCalls[txInsertCalls.length - 1] as Record<string, unknown>) ?? {};

beforeEach(() => {
  selectQueue.length = 0;
  insertCalls.length = 0;
  txInsertCalls.length = 0;
  dbState.failSelect = null;
  dbState.failInsert = null;
  dbState.failTxInsert = null;
  dbState.failTransaction = null;
  vi.clearAllMocks();

  // Happy-path defaults; individual tests override.
  isItemOwnedBy.mockResolvedValue(true);
  hasAcceptedTermsAndPrivacy.mockResolvedValue(true);
  resolveConsentVersion.mockResolvedValue(2);
  promoteItemOnProfileConsent.mockResolvedValue(false);
  invalidateItemFetchCache.mockResolvedValue(undefined);
});

// --- route registration ----------------------------------------------------

describe('consent accept route registration', () => {
  it('registers POST /profile-accept and POST /accept behind auth', async () => {
    const routes: Array<Record<string, unknown>> = [];
    const fastify = {
      route: (opts: Record<string, unknown>) => {
        routes.push(opts);
      },
    };

    await accept_profile_consent(fastify as never, {} as never);
    await accept_consent(fastify as never, {} as never);

    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ url: '/profile-accept', method: 'POST' });
    expect(routes[1]).toMatchObject({ url: '/accept', method: 'POST' });
    // consent_routes.ts has no group-level auth hook, so each route must carry
    // its own preHandler or it would be unauthenticated.
    for (const r of routes) expect(r.preHandler).toBeDefined();
  });
});

// --- accept_profile_consent ------------------------------------------------

describe('accept_profile_consent_handler', () => {
  it('401 when unauthenticated', async () => {
    const reply = await call(accept_profile_consent_handler, {
      user: undefined,
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(401);
    expect(errorOf(reply)).toBe('UNAUTHORIZED');
    expect(isItemOwnedBy).not.toHaveBeenCalled();
  });

  it('400 UNKNOWN_NETWORK for a network this instance does not serve', async () => {
    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody({ network: 'green_dot' }),
    });

    expect(reply.statusCode).toBe(400);
    expect(errorOf(reply)).toBe('UNKNOWN_NETWORK');
    expect(isItemOwnedBy).not.toHaveBeenCalled();
  });

  it('403 NOT_ITEM_OWNER when the caller does not own the item', async () => {
    isItemOwnedBy.mockResolvedValue(false);

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(403);
    expect(errorOf(reply)).toBe('NOT_ITEM_OWNER');
    expect(isItemOwnedBy).toHaveBeenCalledWith('u1', profileBody());
    expect(hasAcceptedTermsAndPrivacy).not.toHaveBeenCalled();
  });

  it('500 CONSENT_READ_FAILED when the ownership check throws', async () => {
    isItemOwnedBy.mockRejectedValue(new Error('db down'));

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(500);
    expect(errorOf(reply)).toBe('CONSENT_READ_FAILED');
    expect(log.error).toHaveBeenCalled();
    expect(txInsertCalls).toHaveLength(0);
  });

  it('409 CONSENT_PREREQUISITE_MISSING when terms+privacy are not accepted', async () => {
    hasAcceptedTermsAndPrivacy.mockResolvedValue(false);

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(409);
    expect(errorOf(reply)).toBe('CONSENT_PREREQUISITE_MISSING');
    expect(txInsertCalls).toHaveLength(0);
  });

  it('500 CONSENT_READ_FAILED when the prerequisite check throws', async () => {
    hasAcceptedTermsAndPrivacy.mockRejectedValue(new Error('db down'));

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(500);
    expect(errorOf(reply)).toBe('CONSENT_READ_FAILED');
  });

  it('is idempotent: recorded:0 and no insert when a row already exists', async () => {
    selectQueue.push([{ id: 'existing-row' }]);

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ recorded: 0 });
    expect(txInsertCalls).toHaveLength(0);
    expect(resolveConsentVersion).not.toHaveBeenCalled();
  });

  it('500 CONSENT_READ_FAILED when the idempotency read throws', async () => {
    dbState.failSelect = new Error('db down');

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(500);
    expect(errorOf(reply)).toBe('CONSENT_READ_FAILED');
  });

  it('400 CONSENT_VERSION_UNCONFIGURED when no version is configured', async () => {
    resolveConsentVersion.mockResolvedValue(null);

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(400);
    expect(errorOf(reply)).toBe('CONSENT_VERSION_UNCONFIGURED');
    expect(txInsertCalls).toHaveLength(0);
  });

  it('records the server-derived version, ignoring the client-supplied one', async () => {
    resolveConsentVersion.mockResolvedValue(7);

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody({ version: 99, brand: 'acme' }),
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ recorded: 1 });
    expect(resolveConsentVersion).toHaveBeenCalledWith({
      network: 'blue_dot',
      brand: 'acme',
      category: 'profile_creation',
    });
    expect(lastTxRow()).toMatchObject({
      level: 'item',
      consentCategory: 'profile_creation',
      userId: 'u1',
      itemId: 'item-1',
      network: 'blue_dot',
      brand: 'acme',
      documentVersion: 7,
      source: 'profile',
    });
    expect(lastTxRow().acceptedAt).toBeInstanceOf(Date);
  });

  it('normalises an absent brand to null in the ledger row', async () => {
    const body = profileBody();
    delete (body as Record<string, unknown>).brand;

    await call(accept_profile_consent_handler, { user: { id: 'u1' }, body });

    expect(lastTxRow().brand).toBeNull();
  });

  it('does NOT sweep the item-fetch caches when nothing was promoted', async () => {
    promoteItemOnProfileConsent.mockResolvedValue(false);

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.body).toEqual({ recorded: 1 });
    expect(promoteItemOnProfileConsent).toHaveBeenCalled();
    expect(invalidateItemFetchCache).not.toHaveBeenCalled();
  });

  it('sweeps the item-fetch caches after a draft->live promotion (#464)', async () => {
    promoteItemOnProfileConsent.mockResolvedValue(true);

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody({ item_domain: 'seeker' }),
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ recorded: 1 });
    expect(invalidateItemFetchCache).toHaveBeenCalledWith('blue_dot', 'seeker');
  });

  it('still returns recorded:1 when the cache sweep fails (best-effort)', async () => {
    promoteItemOnProfileConsent.mockResolvedValue(true);
    invalidateItemFetchCache.mockRejectedValue(new Error('redis down'));

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ recorded: 1 });
    expect(log.warn).toHaveBeenCalled();
  });

  it('treats a 23505 unique violation on insert as already recorded', async () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    dbState.failTxInsert = err;

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ recorded: 0 });
    expect(log.warn).toHaveBeenCalled();
    expect(invalidateItemFetchCache).not.toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED for any other insert failure (never masked)', async () => {
    dbState.failTxInsert = Object.assign(new Error('not null violation'), {
      code: '23502',
    });

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(500);
    expect(errorOf(reply)).toBe('CONSENT_WRITE_FAILED');
    expect(log.error).toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED when the promotion inside the tx throws', async () => {
    promoteItemOnProfileConsent.mockRejectedValue(new Error('classify failed'));

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(500);
    expect(errorOf(reply)).toBe('CONSENT_WRITE_FAILED');
    expect(invalidateItemFetchCache).not.toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED when the transaction itself fails', async () => {
    dbState.failTransaction = new Error('could not begin');

    const reply = await call(accept_profile_consent_handler, {
      user: { id: 'u1' },
      body: profileBody(),
    });

    expect(reply.statusCode).toBe(500);
    expect(errorOf(reply)).toBe('CONSENT_WRITE_FAILED');
  });
});

// --- accept_consent --------------------------------------------------------

const acceptBody = (over: Record<string, unknown> = {}) => ({
  network: 'blue_dot',
  brand: null,
  source: 'signup',
  items: [
    { category: 'terms', version: 1 },
    { category: 'privacy', version: 1 },
  ],
  ...over,
});

const insertedRows = () =>
  (insertCalls[insertCalls.length - 1] ?? []) as Array<Record<string, unknown>>;

describe('accept_consent_handler', () => {
  it('401 when unauthenticated', async () => {
    const reply = await call(accept_consent_handler, {
      user: undefined,
      body: acceptBody(),
    });

    expect(reply.statusCode).toBe(401);
    expect(errorOf(reply)).toBe('UNAUTHORIZED');
    expect(insertCalls).toHaveLength(0);
  });

  it('400 UNKNOWN_NETWORK for an unserved network', async () => {
    const reply = await call(accept_consent_handler, {
      user: { id: 'u1' },
      body: acceptBody({ network: 'green_dot' }),
    });

    expect(reply.statusCode).toBe(400);
    expect(errorOf(reply)).toBe('UNKNOWN_NETWORK');
    expect(resolveConsentVersion).not.toHaveBeenCalled();
  });

  it('writes one user-level row per item with server-derived versions', async () => {
    resolveConsentVersion.mockResolvedValueOnce(3).mockResolvedValueOnce(4);

    const reply = await call(accept_consent_handler, {
      user: { id: 'u1' },
      body: acceptBody({ source: 'login', brand: 'acme' }),
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ recorded: 2 });

    const rows = insertedRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      level: 'user',
      consentCategory: 'terms',
      userId: 'u1',
      network: 'blue_dot',
      brand: 'acme',
      documentVersion: 3,
      source: 'login',
    });
    expect(rows[1]).toMatchObject({
      consentCategory: 'privacy',
      documentVersion: 4,
    });
    // Client-supplied versions (1) are ignored in favour of the config values.
    expect(resolveConsentVersion).toHaveBeenNthCalledWith(1, {
      network: 'blue_dot',
      brand: 'acme',
      category: 'terms',
    });
  });

  it('stamps every row with the same acceptedAt and nulls an absent brand', async () => {
    const body = acceptBody();
    delete (body as Record<string, unknown>).brand;

    await call(accept_consent_handler, { user: { id: 'u1' }, body });

    const rows = insertedRows();
    expect(rows[0].brand).toBeNull();
    expect(rows[0].acceptedAt).toBeInstanceOf(Date);
    expect(rows[0].acceptedAt).toBe(rows[1].acceptedAt);
  });

  it('400 CONSENT_VERSION_UNCONFIGURED and no write when a version is missing', async () => {
    resolveConsentVersion.mockResolvedValueOnce(1).mockResolvedValueOnce(null);

    const reply = await call(accept_consent_handler, {
      user: { id: 'u1' },
      body: acceptBody(),
    });

    expect(reply.statusCode).toBe(400);
    expect(errorOf(reply)).toBe('CONSENT_VERSION_UNCONFIGURED');
    expect((reply.body as { message: string }).message).toContain('privacy');
    expect(insertCalls).toHaveLength(0);
  });

  it('500 CONSENT_WRITE_FAILED when the ledger insert throws', async () => {
    dbState.failInsert = new Error('db down');

    const reply = await call(accept_consent_handler, {
      user: { id: 'u1' },
      body: acceptBody(),
    });

    expect(reply.statusCode).toBe(500);
    expect(errorOf(reply)).toBe('CONSENT_WRITE_FAILED');
    expect(log.error).toHaveBeenCalled();
  });

  it('reports recorded as the number of submitted items', async () => {
    const reply = await call(accept_consent_handler, {
      user: { id: 'u1' },
      body: acceptBody({ items: [{ category: 'terms', version: 1 }] }),
    });

    expect(reply.body).toEqual({ recorded: 1 });
    expect(insertedRows()).toHaveLength(1);
  });
});
