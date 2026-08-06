import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// --- mocks (hoisted) -------------------------------------------------------
// The handler runs THREE queries per successful request, in this order:
//   1. count(*)  — awaited directly off `.where(...)`
//   2. page rows — `.where(...).orderBy(...).limit(...).offset(...)`
//   3. items     — awaited directly off `.where(...)` (resolveItemNames)
// so a single FIFO result queue is enough, and `dbState.calls` records the
// where/orderBy/limit/offset of each so the filter permutations can be asserted.
const { dbState, getNetworkConfigById, decryptItemPrivate } = vi.hoisted(() => ({
  dbState: {
    queue: [] as unknown[][],
    calls: [] as Array<{
      where: unknown;
      orderBy?: unknown[];
      limit?: number;
      offset?: number;
    }>,
    // Resettable failure flag — never monkey-patch the queue, an override
    // there would leak into every later test in the file.
    failWith: null as Error | null,
    // 1-based query index to fail at; null = fail every query.
    failAtCall: null as number | null,
  },
  getNetworkConfigById: vi.fn(),
  decryptItemPrivate: vi.fn(),
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const next = (n: number) => {
    if (
      dbState.failWith &&
      (dbState.failAtCall === null || dbState.failAtCall === n)
    ) {
      return Promise.reject(dbState.failWith);
    }
    return Promise.resolve(dbState.queue.shift() ?? []);
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: (where: unknown) => {
            const call: {
              where: unknown;
              orderBy?: unknown[];
              limit?: number;
              offset?: number;
            } = { where };
            dbState.calls.push(call);
            const n = dbState.calls.length;
            // Thenable: some queries are awaited straight off `.where(...)`,
            // the page query chains orderBy/limit/offset. BOTH callbacks must
            // be forwarded — dropping `rej` hangs a rejected await.
            return {
              then: (
                res: (v: unknown) => unknown,
                rej?: (e: unknown) => unknown,
              ) => next(n).then(res, rej),
              orderBy: (...ob: unknown[]) => {
                call.orderBy = ob;
                return {
                  limit: (l: number) => {
                    call.limit = l;
                    return {
                      offset: (o: number) => {
                        call.offset = o;
                        return next(n);
                      },
                    };
                  },
                };
              },
            };
          },
        }),
      }),
    },
  };
});

vi.mock('@/network_configs', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNetworkConfigById: (...a: any[]) => getNetworkConfigById(...a),
}));

vi.mock('@/utils/item_decrypt', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decryptItemPrivate: (...a: any[]) => decryptItemPrivate(...a),
}));

import { fetch_actions } from '../fetch_actions';

// --- fixtures --------------------------------------------------------------

const USER = 'user-me';
const OTHER = 'user-them';

/**
 * `seeker` profiles carry a private `beneficiary_name` (pre-masked in
 * item_state); `provider` profiles declare a public `display_name_field`.
 * `connect` reveals PII only on `accepted`.
 */
const NETWORK_CONFIG = {
  id: 'test_net',
  domains: [
    {
      id: 'provider',
      item_schemas: {
        'profile_1.0': { display_name_field: 'organisation_name' },
      },
    },
    {
      id: 'seeker',
      item_schemas: {
        'profile_1.0': {
          properties: { beneficiary_name: { type: 'string', private: true } },
        },
      },
    },
  ],
  actions: {
    connect: {
      interactions: [
        {
          from_network: 'test_net',
          from_domain: 'seeker',
          from_items: [],
          to_network: 'test_net',
          to_domain: 'provider',
          to_items: [],
          reveals_pii_on_status: ['accepted'],
        },
      ],
    },
  },
};

function actionRow(overrides: Record<string, unknown> = {}) {
  return {
    action_id: 'act-1',
    action_type: 'connect',
    action_status: 'created',
    source_item_id: 'src-1',
    source_item_network: 'test_net',
    source_item_domain: 'seeker',
    source_item_type: 'profile_1.0',
    source_item_owner: USER,
    target_item_id: 'tgt-1',
    target_item_network: 'test_net',
    target_item_domain: 'provider',
    target_item_type: 'profile_1.0',
    target_item_owner: OTHER,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

/** Private-name (seeker) item: item_state carries the mask already. */
function seekerItem(overrides: Record<string, unknown> = {}) {
  return {
    item_id: 'src-1',
    item_network: 'test_net',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { beneficiary_name: 'M***' },
    item_private_state: 'cipher-src-1',
    lifecycle_status: 'live',
    ...overrides,
  };
}

/** Public-name (provider) item. */
function providerItem(overrides: Record<string, unknown> = {}) {
  return {
    item_id: 'tgt-1',
    item_network: 'test_net',
    item_domain: 'provider',
    item_type: 'profile_1.0',
    item_state: { organisation_name: 'Mobility World India' },
    item_private_state: null,
    lifecycle_status: 'live',
    ...overrides,
  };
}

/** ciphertext → the private fields it decrypts to. Unknown blob = throw. */
const ciphers: Record<string, Record<string, unknown>> = {};

function primeDb(
  count: unknown,
  rows: unknown[],
  itemRows: unknown[] = [],
): void {
  dbState.queue.push([{ count }], rows, itemRows);
}

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
type AnyFn = (...a: any[]) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routes: any[] = [];
let handler: AnyFn;

beforeAll(async () => {
  const fakeFastify = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    route: (opts: any) => {
      routes.push(opts);
      handler = opts.handler as AnyFn;
    },
  };
  await fetch_actions(
    fakeFastify as unknown as Parameters<typeof fetch_actions>[0],
    {} as unknown as Parameters<typeof fetch_actions>[1],
  );
});

async function call(
  query: Record<string, unknown>,
  user: { id: string } | null = { id: USER },
): Promise<FakeReply> {
  const reply = makeReply();
  await handler(
    { log, user: user ?? undefined, query: { limit: 20, offset: 0, ...query } },
    reply,
  );
  return reply;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (r: FakeReply) => r.body as any;

const dialect = new PgDialect();
function renderWhere(i: number) {
  return dialect.sqlToQuery(dbState.calls[i].where as SQL);
}

beforeEach(() => {
  dbState.queue.length = 0;
  dbState.calls.length = 0;
  dbState.failWith = null;
  dbState.failAtCall = null;
  for (const k of Object.keys(ciphers)) delete ciphers[k];
  vi.clearAllMocks();
  getNetworkConfigById.mockResolvedValue(NETWORK_CONFIG);
  decryptItemPrivate.mockImplementation(
    (row: { item_state: Record<string, unknown>; item_private_state: string }) => {
      // Mirrors the real util: no ciphertext → the public state is the merged
      // state; a bad blob throws.
      if (!row.item_private_state) return { mergedState: row.item_state };
      const extra = ciphers[row.item_private_state];
      if (!extra) throw new Error('decrypt failed');
      return { mergedState: { ...row.item_state, ...extra } };
    },
  );
});

// --- tests -----------------------------------------------------------------

describe('fetch_actions route registration', () => {
  it('registers GET /fetch behind auth with the action tag', () => {
    expect(routes).toHaveLength(1);
    expect(routes[0].url).toBe('/fetch');
    expect(routes[0].method).toBe('GET');
    expect(routes[0].preHandler).toBeTypeOf('function');
    expect(routes[0].schema.tags).toEqual(['action']);
    expect(routes[0].schema.response[200]).toBeDefined();
  });
});

describe('fetch_actions_handler — auth', () => {
  it('401 UNAUTHORIZED with no authenticated user (no query issued)', async () => {
    const reply = await call({}, null);

    expect(reply.statusCode).toBe(401);
    expect(bodyOf(reply).error).toBe('UNAUTHORIZED');
    expect(dbState.calls).toHaveLength(0);
  });
});

describe('fetch_actions_handler — ownership scoping', () => {
  it('defaults to actions on EITHER side of the caller', async () => {
    primeDb('3', []);

    const reply = await call({});

    expect(reply.statusCode).toBe(200);
    const q = renderWhere(0);
    expect(q.sql).toContain('"source_item_owner"');
    expect(q.sql).toContain('"target_item_owner"');
    expect(q.sql).toContain(' or ');
    expect(q.params).toEqual([USER, USER]);
  });

  it('ownership_role=initiated scopes to source_item_owner only', async () => {
    primeDb(1, []);

    await call({ ownership_role: 'initiated' });

    const q = renderWhere(0);
    expect(q.sql).toContain('"source_item_owner"');
    expect(q.sql).not.toContain('"target_item_owner"');
    expect(q.params).toEqual([USER]);
  });

  it('ownership_role=received scopes to target_item_owner only', async () => {
    primeDb(1, []);

    await call({ ownership_role: 'received' });

    const q = renderWhere(0);
    expect(q.sql).toContain('"target_item_owner"');
    expect(q.sql).not.toContain('"source_item_owner"');
    expect(q.params).toEqual([USER]);
  });

  it('tags ownership_roles with both sides when the caller owns both items', async () => {
    primeDb(1, [actionRow({ target_item_owner: USER })], [
      seekerItem(),
      providerItem(),
    ]);

    const reply = await call({});

    expect(bodyOf(reply).actions[0].ownership_roles).toEqual([
      'initiated',
      'received',
    ]);
  });

  it('tags only received when the caller owns just the target item', async () => {
    primeDb(1, [actionRow({ source_item_owner: OTHER, target_item_owner: USER })]);

    const reply = await call({});

    expect(bodyOf(reply).actions[0].ownership_roles).toEqual(['received']);
  });
});

describe('fetch_actions_handler — filters', () => {
  it('applies action_id / action_type / action_status filters', async () => {
    primeDb(1, []);

    await call({
      action_id: 'act-1',
      action_type: 'connect',
      action_status: 'accepted',
    });

    const q = renderWhere(0);
    expect(q.sql).toContain('"action_id"');
    expect(q.sql).toContain('"action_type"');
    expect(q.sql).toContain('"action_status"');
    expect(q.params).toEqual(['act-1', 'connect', 'accepted', USER, USER]);
  });

  it('item_id alone matches the item on EITHER side of the action', async () => {
    primeDb(1, []);

    await call({ item_id: 'src-1' });

    const q = renderWhere(0);
    expect(q.sql).toContain('"source_item_id"');
    expect(q.sql).toContain('"target_item_id"');
    // item_id OR-pair, then the owner OR-pair.
    expect(q.params).toEqual(['src-1', 'src-1', USER, USER]);
  });

  it('item_id + initiated narrows to source_item_id', async () => {
    primeDb(1, []);

    await call({ item_id: 'src-1', ownership_role: 'initiated' });

    const q = renderWhere(0);
    expect(q.sql).toContain('"source_item_id"');
    expect(q.sql).not.toContain('"target_item_id"');
    expect(q.params).toEqual(['src-1', USER]);
  });

  it('item_id + received narrows to target_item_id', async () => {
    primeDb(1, []);

    await call({ item_id: 'tgt-1', ownership_role: 'received' });

    const q = renderWhere(0);
    expect(q.sql).toContain('"target_item_id"');
    expect(q.sql).not.toContain('"source_item_id"');
    expect(q.params).toEqual(['tgt-1', USER]);
  });

  it('count and page queries share the same where clause', async () => {
    primeDb(1, [actionRow()], [seekerItem(), providerItem()]);

    await call({ action_status: 'created' });

    expect(dbState.calls[0].where).toBe(dbState.calls[1].where);
  });
});

describe('fetch_actions_handler — pagination & meta', () => {
  it('forwards limit/offset to the page query and echoes them in meta', async () => {
    primeDb('42', []);

    const reply = await call({ limit: 5, offset: 10 });

    expect(dbState.calls[1].limit).toBe(5);
    expect(dbState.calls[1].offset).toBe(10);
    expect(bodyOf(reply).meta).toEqual({ total: 42, limit: 5, offset: 10 });
  });

  it('orders by updated_at desc then created_at desc', async () => {
    primeDb(0, []);

    await call({});

    const orderBy = dbState.calls[1].orderBy ?? [];
    expect(orderBy).toHaveLength(2);
    const first = dialect.sqlToQuery(orderBy[0] as SQL).sql;
    const second = dialect.sqlToQuery(orderBy[1] as SQL).sql;
    expect(first).toContain('"updated_at"');
    expect(first).toContain('desc');
    expect(second).toContain('"created_at"');
    expect(second).toContain('desc');
  });

  it('skips the items query entirely on an empty page', async () => {
    primeDb(0, []);

    const reply = await call({});

    expect(bodyOf(reply)).toEqual({
      meta: { total: 0, limit: 20, offset: 0 },
      actions: [],
    });
    // count + page rows only — resolveItemNames short-circuits.
    expect(dbState.calls).toHaveLength(2);
    expect(getNetworkConfigById).not.toHaveBeenCalled();
  });

  it('coerces string timestamps into Date instances', async () => {
    primeDb(1, [
      actionRow({
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      }),
    ]);

    const reply = await call({});

    const action = bodyOf(reply).actions[0];
    expect(action.created_at).toBeInstanceOf(Date);
    expect(action.updated_at).toBeInstanceOf(Date);
    expect(action.created_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('passes Date timestamps through untouched', async () => {
    const created = new Date('2026-03-03T03:03:03.000Z');
    primeDb(1, [actionRow({ created_at: created })]);

    const reply = await call({});

    expect(bodyOf(reply).actions[0].created_at).toBe(created);
  });
});

describe('fetch_actions_handler — display names & PII gating', () => {
  it('returns a public display_name_field value as-is and never decrypts it', async () => {
    primeDb(1, [actionRow()], [providerItem()]);

    const reply = await call({});

    const action = bodyOf(reply).actions[0];
    expect(action.target_item_name).toBe('Mobility World India');
    // Source item was not in the items result → no name resolvable.
    expect(action.source_item_name).toBeNull();
    expect(decryptItemPrivate).not.toHaveBeenCalled();
  });

  it('keeps a private name masked when the status does not reveal PII', async () => {
    ciphers['cipher-src-1'] = { beneficiary_name: 'Meera Kumari' };
    primeDb(1, [actionRow({ action_status: 'created' })], [
      seekerItem(),
      providerItem(),
    ]);

    const reply = await call({});

    expect(bodyOf(reply).actions[0].source_item_name).toBe('M***');
    expect(decryptItemPrivate).not.toHaveBeenCalled();
  });

  it('reveals the real private name on a reveal status when the profile is live', async () => {
    ciphers['cipher-src-1'] = { beneficiary_name: '  Meera Kumari  ' };
    primeDb(1, [actionRow({ action_status: 'accepted' })], [
      seekerItem(),
      providerItem(),
    ]);

    const reply = await call({});

    expect(bodyOf(reply).actions[0].source_item_name).toBe('Meera Kumari');
    expect(decryptItemPrivate).toHaveBeenCalledTimes(1);
  });

  it('keeps the mask on a reveal status when the named profile is not live (#273)', async () => {
    ciphers['cipher-src-1'] = { beneficiary_name: 'Meera Kumari' };
    primeDb(1, [actionRow({ action_status: 'accepted' })], [
      seekerItem({ lifecycle_status: 'paused' }),
      providerItem(),
    ]);

    const reply = await call({});

    expect(bodyOf(reply).actions[0].source_item_name).toBe('M***');
    expect(decryptItemPrivate).not.toHaveBeenCalled();
  });

  it('falls back to the mask and warns when decrypt throws', async () => {
    // No entry in `ciphers` → the decrypt mock throws.
    primeDb(1, [actionRow({ action_status: 'accepted' })], [
      seekerItem(),
      providerItem(),
    ]);

    const reply = await call({});

    expect(reply.statusCode).toBe(200);
    expect(bodyOf(reply).actions[0].source_item_name).toBe('M***');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'src-1', field: 'beneficiary_name' }),
      expect.stringContaining('pii decrypt failed'),
    );
  });

  it('falls back to the mask when the row carries no ciphertext', async () => {
    primeDb(1, [actionRow({ action_status: 'accepted' })], [
      seekerItem({ item_private_state: null }),
      providerItem(),
    ]);

    const reply = await call({});

    // encrypted:'' → decrypt returns the public state, whose value is the mask.
    expect(bodyOf(reply).actions[0].source_item_name).toBe('M***');
  });

  it('picks the first populated conventional private-name field', async () => {
    ciphers['cipher-src-1'] = { full_name: 'Real Person' };
    primeDb(1, [actionRow({ action_status: 'accepted' })], [
      seekerItem({ item_state: { beneficiary_name: '   ', full_name: 'R***' } }),
    ]);

    const reply = await call({});

    expect(bodyOf(reply).actions[0].source_item_name).toBe('Real Person');
    expect(decryptItemPrivate).toHaveBeenCalledWith(
      expect.objectContaining({ item_private_state: 'cipher-src-1' }),
    );
  });

  it('returns null (not the item_id) when no name field resolves at all', async () => {
    primeDb(1, [actionRow()], [
      seekerItem({ item_state: { unrelated: 'x' } }),
      providerItem({ item_state: {} }),
    ]);

    const reply = await call({});

    const action = bodyOf(reply).actions[0];
    expect(action.source_item_name).toBeNull();
    expect(action.target_item_name).toBeNull();
  });

  it('masks and warns when the reveal-status lookup throws (unknown action type)', async () => {
    ciphers['cipher-src-1'] = { beneficiary_name: 'Meera Kumari' };
    primeDb(
      1,
      [actionRow({ action_type: 'not_in_config', action_status: 'accepted' })],
      [seekerItem(), providerItem()],
    );

    const reply = await call({});

    expect(reply.statusCode).toBe(200);
    expect(bodyOf(reply).actions[0].source_item_name).toBe('M***');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action_id: 'act-1', action_type: 'not_in_config' }),
      expect.stringContaining('pii reveal-status resolution failed'),
    );
  });

  it('masks (fail-closed) when the network config cannot be loaded', async () => {
    getNetworkConfigById.mockRejectedValue(new Error('config down'));
    ciphers['cipher-src-1'] = { beneficiary_name: 'Meera Kumari' };
    primeDb(1, [actionRow({ action_status: 'accepted' })], [
      seekerItem(),
      providerItem(),
    ]);

    const reply = await call({});

    expect(reply.statusCode).toBe(200);
    // No schema → no public display name; the pre-masked state value is used.
    expect(bodyOf(reply).actions[0].source_item_name).toBe('M***');
    expect(bodyOf(reply).actions[0].target_item_name).toBeNull();
  });

  it('memoises the network config per pass and the decrypt per item', async () => {
    ciphers['cipher-src-1'] = { beneficiary_name: 'Meera Kumari' };
    // Same seeker item is the source of one action and the target of another.
    primeDb(
      2,
      [
        actionRow({ action_id: 'act-1', action_status: 'accepted' }),
        actionRow({
          action_id: 'act-2',
          action_status: 'accepted',
          source_item_id: 'tgt-1',
          source_item_domain: 'provider',
          target_item_id: 'src-1',
          target_item_domain: 'seeker',
          target_item_network: 'test_net',
        }),
      ],
      [seekerItem(), providerItem()],
    );

    const reply = await call({});

    // One decrypt for src-1 despite it appearing on both rows.
    expect(decryptItemPrivate).toHaveBeenCalledTimes(1);
    // Two independent caches (resolveItemNames + the reveal-status pass), each
    // hitting the single network exactly once.
    expect(getNetworkConfigById).toHaveBeenCalledTimes(2);
    expect(bodyOf(reply).actions[0].source_item_name).toBe('Meera Kumari');
    // act-2's interaction (provider → seeker) is not declared, so it masks.
    expect(bodyOf(reply).actions[1].target_item_name).toBe('M***');
  });
});

describe('fetch_actions_handler — failures', () => {
  it('500 INTERNAL_SERVER_ERROR when the count query fails', async () => {
    dbState.failWith = new Error('db down');

    const reply = await call({});

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('INTERNAL_SERVER_ERROR');
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to fetch actions',
    );
  });

  it('500 when the item-name lookup fails', async () => {
    primeDb(1, [actionRow()]);
    dbState.failWith = new Error('items query down');
    dbState.failAtCall = 3;

    const reply = await call({});

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('INTERNAL_SERVER_ERROR');
  });

  it('500 when the count row is missing', async () => {
    dbState.queue.push([], []);

    const reply = await call({});

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('INTERNAL_SERVER_ERROR');
  });
});
