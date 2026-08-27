import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// `lifecycle.ts` only exports the plugin, so the handler is reached by
// registering the plugin against a fake fastify and pulling the route back out.
// The handler runs everything inside `db.transaction`, so the fake tx exposes
// the same select/update chain as the fake db.
const {
  rowQueue,
  updates,
  dbState,
  auth_middleware_if_enabled,
  acting_org_preHandler_optional,
  getNetworkConfigById,
  getOrFetchSchemaByUrl,
  decryptItemPrivate,
  hasAcceptedProfileConsent,
  classify_item,
  buildRetiredItemState,
  cancelItemConnections,
  dispatchRetireCancelNotifications,
  dispatchItemLifecycleNotification,
  publishItemEvent,
  invalidateItemFetchCache,
} = vi.hoisted(() => ({
  rowQueue: [] as unknown[][],
  updates: [] as { table: unknown; values: Record<string, unknown>; where: unknown }[],
  // Resettable failure flag — never monkey-patch the shared row queue, an
  // override there leaks into every later test in the file.
  dbState: { failWith: null as Error | null },
  // Params are declared on every mock because `vi.fn(() => ...)` infers a
  // ZERO-ARG signature, which breaks both the spread-through in the vi.mock
  // factory and `mock.calls[0][0]` under tsc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth_middleware_if_enabled: vi.fn(async (..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  acting_org_preHandler_optional: vi.fn(async (..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNetworkConfigById: vi.fn(async (..._a: any[]) => ({ pause_enabled: true })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOrFetchSchemaByUrl: vi.fn(async (..._a: any[]) => ({
    required: ['name'],
    properties: { name: {} },
  })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decryptItemPrivate: vi.fn((..._a: any[]) => ({ mergedState: { name: 'Ada' } })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hasAcceptedProfileConsent: vi.fn(async (..._a: any[]) => true),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  classify_item: vi.fn((..._a: any[]) => ({ lifecycle_status: 'live' })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildRetiredItemState: vi.fn((..._a: any[]) => ({ scrubbed: true })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cancelItemConnections: vi.fn(async (..._a: any[]) => [] as unknown[]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchRetireCancelNotifications: vi.fn(async (..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchItemLifecycleNotification: vi.fn(async (..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publishItemEvent: vi.fn(async (..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invalidateItemFetchCache: vi.fn(async (..._a: any[]) => {}),
}));

function nextRows() {
  if (dbState.failWith) return Promise.reject(dbState.failWith);
  return Promise.resolve(rowQueue.shift() ?? []);
}

const fakeTx = {
  select: () => ({
    from: () => ({
      where: () => {
        // A thenable so both `await .where(...)` and `.limit()` work. BOTH
        // callbacks must be forwarded — dropping `rej` makes a rejected query
        // hang the await forever.
        const result = {
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            nextRows().then(res, rej),
          limit: () => nextRows(),
        };
        return result;
      },
    }),
  }),
  update: (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (where: unknown) => {
        if (dbState.failWith) return Promise.reject(dbState.failWith);
        updates.push({ table, values, where });
        return Promise.resolve([]);
      },
    }),
  }),
};

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: (fn: (tx: any) => Promise<unknown>) => fn(fakeTx),
  },
}));

vi.mock('@dpg/database', () => ({
  items: {
    item_id: 'items.item_id',
    item_network: 'items.item_network',
    item_domain: 'items.item_domain',
    item_type: 'items.item_type',
    item_schema_url: 'items.item_schema_url',
    item_state: 'items.item_state',
    item_private_state: 'items.item_private_state',
    lifecycle_status: 'items.lifecycle_status',
    created_by: 'items.created_by',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  // `sql` is used as a template tag (`sql\`now()\``).
  sql: (strings: TemplateStringsArray) => ({ sql: strings.join('?') }),
}));

vi.mock('@dpg/schemas', () => ({
  default: { object: (shape: unknown) => ({ shape }) },
  ItemLifecycleBody: { body: true },
  ItemLifecycleResponse: { response: true },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth_middleware_if_enabled: (...a: any[]) => auth_middleware_if_enabled(...a),
}));

vi.mock('@/middleware/acting_org_optional', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  acting_org_preHandler_optional: (...a: any[]) => acting_org_preHandler_optional(...a),
}));

vi.mock('@/network_configs', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNetworkConfigById: (...a: any[]) => getNetworkConfigById(...a),
}));

vi.mock('@/network_schema_cache', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOrFetchSchemaByUrl: (...a: any[]) => getOrFetchSchemaByUrl(...a),
}));

vi.mock('@/utils/item_decrypt', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decryptItemPrivate: (...a: any[]) => decryptItemPrivate(...a),
}));

vi.mock('@/services/consent_acceptance', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hasAcceptedProfileConsent: (...a: any[]) => hasAcceptedProfileConsent(...a),
}));

vi.mock('@/services/items/classifier', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  classify_item: (...a: any[]) => classify_item(...a),
}));

vi.mock('@/services/items/retire_pii', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildRetiredItemState: (...a: any[]) => buildRetiredItemState(...a),
}));

vi.mock('@/services/items/retire_connections', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cancelItemConnections: (...a: any[]) => cancelItemConnections(...a),
}));

vi.mock('@/notifications/notify_retire', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchRetireCancelNotifications: (...a: any[]) =>
    dispatchRetireCancelNotifications(...a),
}));

// The lifecycle seam lazy-imports this; the mock intercepts the dynamic import.
vi.mock('@/notifications/notify_item_lifecycle', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchItemLifecycleNotification: (...a: any[]) => dispatchItemLifecycleNotification(...a),
}));

vi.mock('@/utils/publish_item_event', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publishItemEvent: (...a: any[]) => publishItemEvent(...a),
}));

vi.mock('@/utils/item_fetch_cache_invalidate', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invalidateItemFetchCache: (...a: any[]) => invalidateItemFetchCache(...a),
}));

import { item_lifecycle } from '../lifecycle';

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

interface FakeRoute {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preHandler?: (...a: any[]) => unknown;
  schema?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: any;
}

const routes: FakeRoute[] = [];
const hooks: { name: string; fn: unknown }[] = [];

async function loadRoutes() {
  routes.length = 0;
  hooks.length = 0;
  const fakeFastify = {
    addHook: (name: string, fn: unknown) => {
      hooks.push({ name, fn });
    },
    route: (opts: FakeRoute) => {
      routes.push(opts);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await item_lifecycle(fakeFastify as any, {} as any);
}

const log = { error: vi.fn(), warn: vi.fn() };

const OWNER = 'user-1';
const ITEM_ID = '11111111-1111-1111-1111-111111111111';

function existingItem(overrides: Record<string, unknown> = {}) {
  return {
    item_id: ITEM_ID,
    item_network: 'blue_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    item_schema_url: 'https://schemas.example/profile_1.0.json',
    item_state: { name: 'Ada', email: 'ada@example.com' },
    item_private_state: 'enc:blob',
    lifecycle_status: 'live',
    created_by: OWNER,
    ...overrides,
  };
}

async function call(req: Record<string, unknown>) {
  await loadRoutes();
  const reply = makeReply();
  const route = routes[0];
  if (!route) throw new Error('no /lifecycle route registered');
  await route.handler({ log, ...req }, reply);
  return reply;
}

function ownerRequest(action: string, overrides: Record<string, unknown> = {}) {
  return {
    user: { id: OWNER },
    body: { item_id: ITEM_ID, action },
    ...overrides,
  };
}

beforeEach(() => {
  rowQueue.length = 0;
  updates.length = 0;
  dbState.failWith = null;
  vi.clearAllMocks();
  getNetworkConfigById.mockResolvedValue({ pause_enabled: true });
  getOrFetchSchemaByUrl.mockResolvedValue({
    required: ['name'],
    properties: { name: {} },
  });
  decryptItemPrivate.mockReturnValue({ mergedState: { name: 'Ada' } });
  hasAcceptedProfileConsent.mockResolvedValue(true);
  classify_item.mockReturnValue({ lifecycle_status: 'live' });
  buildRetiredItemState.mockReturnValue({ scrubbed: true });
  cancelItemConnections.mockResolvedValue([]);
  invalidateItemFetchCache.mockResolvedValue(undefined);
  publishItemEvent.mockResolvedValue(undefined);
});

describe('item_lifecycle route registration', () => {
  it('registers POST /lifecycle with auth then acting-org as plugin hooks', async () => {
    await loadRoutes();

    expect(hooks.map((h) => h.name)).toEqual(['preHandler', 'preHandler']);

    // Order matters: auth populates request.user, which the acting-org hook
    // reads — so hook 0 must be auth and hook 1 the acting-org check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (hooks[0]?.fn as any)();
    expect(auth_middleware_if_enabled).toHaveBeenCalledTimes(1);
    expect(acting_org_preHandler_optional).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (hooks[1]?.fn as any)();
    expect(acting_org_preHandler_optional).toHaveBeenCalledTimes(1);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.url).toBe('/lifecycle');
    expect(routes[0]?.method).toBe('POST');
    // The route-level preHandler is the (idempotent) second auth pass.
    expect(routes[0]?.preHandler).toBeDefined();
  });
});

describe('item_lifecycle_handler — auth & ownership', () => {
  it('401 UNAUTHORIZED when there is no authenticated caller', async () => {
    const reply = await call({ user: undefined, body: { item_id: ITEM_ID, action: 'pause' } });

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { error: string }).error).toBe('UNAUTHORIZED');
    expect(updates).toHaveLength(0);
  });

  it('404 ITEM_NOT_FOUND when the item row does not exist', async () => {
    rowQueue.push([]);

    const reply = await call(ownerRequest('pause'));

    expect(reply.statusCode).toBe(404);
    expect((reply.body as { error: string }).error).toBe('ITEM_NOT_FOUND');
    expect(updates).toHaveLength(0);
  });

  it('403 ITEM_NOT_OWNED_BY_USER for a non-owner without a network_service org', async () => {
    rowQueue.push([existingItem({ created_by: 'someone-else' })]);

    const reply = await call(ownerRequest('pause'));

    expect(reply.statusCode).toBe(403);
    expect((reply.body as { error: string }).error).toBe('ITEM_NOT_OWNED_BY_USER');
    expect(updates).toHaveLength(0);
  });

  it('allows a network_service acting-org to act on an item it does not own', async () => {
    rowQueue.push([existingItem({ created_by: 'someone-else' })]);

    const reply = await call(
      ownerRequest('pause', { acting_org: { org_type: 'network_service' } }),
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ item_id: ITEM_ID, lifecycle_status: 'paused' });
  });

  it('notifies the item OWNER, not the network_service caller who paused it (#531/#534)', async () => {
    // Regression guard: a network_service org pauses a profile it does not own.
    // The lifecycle email must reach the OWNER (created_by), not the actor —
    // else the person whose profile was paused is never told.
    rowQueue.push([existingItem({ created_by: 'someone-else' })]);

    const reply = await call(
      ownerRequest('pause', { acting_org: { org_type: 'network_service' } }),
    );
    expect(reply.statusCode).toBe(200);

    // Fire-and-forget after commit — flush the void-import microtask.
    await vi.waitFor(() => expect(dispatchItemLifecycleNotification).toHaveBeenCalledTimes(1));
    const event = dispatchItemLifecycleNotification.mock.calls[0]![0] as {
      op: string;
      ownerId: string;
    };
    expect(event).toMatchObject({ op: 'pause', ownerId: 'someone-else' });
    expect(event.ownerId).not.toBe(OWNER); // never the acting caller
  });

  it('does not send a lifecycle email on unpause (only pause/retire)', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'paused' })]);

    await call(ownerRequest('unpause'));
    await Promise.resolve(); // let any stray microtask run

    expect(dispatchItemLifecycleNotification).not.toHaveBeenCalled();
  });

  it('a failing lifecycle notification never fails the route (best-effort)', async () => {
    dispatchItemLifecycleNotification.mockRejectedValueOnce(new Error('NS down'));
    rowQueue.push([existingItem()]);

    const reply = await call(ownerRequest('pause'));

    expect(reply.statusCode).toBe(200); // route unaffected by the notify rejection
    await vi.waitFor(() => expect(dispatchItemLifecycleNotification).toHaveBeenCalled());
  });

  it('a non-network_service acting-org does not bypass ownership', async () => {
    rowQueue.push([existingItem({ created_by: 'someone-else' })]);

    const reply = await call(
      ownerRequest('pause', { acting_org: { org_type: 'aggregator' } }),
    );

    expect(reply.statusCode).toBe(403);
  });
});

describe('item_lifecycle_handler — invalid transitions', () => {
  it('409 ALREADY_RETIRED — retire is terminal, no transition out of retired', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'retired' })]);

    const reply = await call(ownerRequest('unpause'));

    expect(reply.statusCode).toBe(409);
    expect(reply.body).toEqual({
      error: 'INVALID_LIFECYCLE_ACTION',
      message: 'this profile is retired and cannot change state',
    });
    expect(updates).toHaveLength(0);
  });

  it('409 ALREADY_RETIRED even for a second retire on a retired item', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'retired' })]);

    const reply = await call(ownerRequest('retire'));

    expect(reply.statusCode).toBe(409);
    expect((reply.body as { error: string }).error).toBe('INVALID_LIFECYCLE_ACTION');
    // No PII scrub / connection cancel on an already-retired item.
    expect(buildRetiredItemState).not.toHaveBeenCalled();
    expect(cancelItemConnections).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('409 PAUSE_NOT_ENABLED (distinct error code) when the network gate is off', async () => {
    getNetworkConfigById.mockResolvedValue({ pause_enabled: false });
    rowQueue.push([existingItem({ lifecycle_status: 'live' })]);

    const reply = await call(ownerRequest('pause'));

    expect(reply.statusCode).toBe(409);
    expect(reply.body).toEqual({
      error: 'PAUSE_NOT_ENABLED',
      message: 'Pause is not enabled for this network',
    });
    expect(getNetworkConfigById).toHaveBeenCalledWith('blue_dot');
    expect(updates).toHaveLength(0);
  });

  it('409 PAUSE_REQUIRES_LIVE when pausing a draft item', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'draft' })]);

    const reply = await call(ownerRequest('pause'));

    expect(reply.statusCode).toBe(409);
    expect(reply.body).toEqual({
      error: 'INVALID_LIFECYCLE_ACTION',
      message: 'pause is only valid on a live item',
    });
  });

  it('409 PAUSE_REQUIRES_LIVE when pausing an already-paused item', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'paused' })]);

    const reply = await call(ownerRequest('pause'));

    expect(reply.statusCode).toBe(409);
    expect((reply.body as { message: string }).message).toBe(
      'pause is only valid on a live item',
    );
  });

  it('409 UNPAUSE_REQUIRES_PAUSED when unpausing a live item', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'live' })]);

    const reply = await call(ownerRequest('unpause'));

    expect(reply.statusCode).toBe(409);
    expect(reply.body).toEqual({
      error: 'INVALID_LIFECYCLE_ACTION',
      message: 'unpause is only valid on a paused item',
    });
    expect(updates).toHaveLength(0);
  });

  it('resume is allowed even when the pause feature gate is off', async () => {
    // Only `pause` consults the network gate, so a profile paused earlier can
    // still be recovered after the feature is switched off.
    getNetworkConfigById.mockResolvedValue({ pause_enabled: false });
    rowQueue.push([existingItem({ lifecycle_status: 'paused' })]);

    const reply = await call(ownerRequest('unpause'));

    expect(reply.statusCode).toBe(200);
    expect(getNetworkConfigById).not.toHaveBeenCalled();
  });
});

describe('item_lifecycle_handler — pause / unpause', () => {
  it('pause on a live item sets paused and sweeps the item-fetch cache', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'live' })]);

    const reply = await call(ownerRequest('pause'));

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ item_id: ITEM_ID, lifecycle_status: 'paused' });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values.lifecycle_status).toBe('paused');
    // Pause is not destructive: state / private blob / locations untouched.
    expect(updates[0]?.values).not.toHaveProperty('item_state');
    expect(updates[0]?.values).not.toHaveProperty('item_private_state');
    expect(updates[0]?.values).not.toHaveProperty('item_locations');
    expect(invalidateItemFetchCache).toHaveBeenCalledWith('blue_dot', 'student');
    // A paused item must drop out of search, so the transition is published as an
    // `upsert` (the row stays, its lifecycle_status changes) — #557. Only retire
    // de-indexes, and only retire notifies counterparties.
    expect(publishItemEvent).toHaveBeenCalledWith(
      {
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        item_id: ITEM_ID,
        op: 'upsert',
      },
      log,
    );
    expect(dispatchRetireCancelNotifications).not.toHaveBeenCalled();
  });

  it('publishes an upsert event when unpause puts the item back live', async () => {
    // Without this the search index keeps the pre-unpause lifecycle until the
    // next reconciliation sweep tick — and if the sweep is blinded, forever (#557).
    rowQueue.push([existingItem({ lifecycle_status: 'paused' })]);
    classify_item.mockReturnValue({ lifecycle_status: 'live' });

    await call(ownerRequest('unpause'));

    expect(publishItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: ITEM_ID, op: 'upsert' }),
      log,
    );
  });

  it('unpause recomputes draft/live from the decrypted merged state', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'paused' })]);
    classify_item.mockReturnValue({ lifecycle_status: 'live' });

    const reply = await call(ownerRequest('unpause'));

    expect(reply.body).toEqual({ item_id: ITEM_ID, lifecycle_status: 'live' });
    expect(decryptItemPrivate).toHaveBeenCalledWith({
      item_state: { name: 'Ada', email: 'ada@example.com' },
      item_private_state: 'enc:blob',
    });
    // Reclassified from `draft`, so the classifier's paused/retired short
    // circuits can't pin the item back to paused.
    expect(classify_item).toHaveBeenCalledWith({
      schema: { required: ['name'], properties: { name: {} } },
      merged_state: { name: 'Ada' },
      current_status: 'draft',
      consent_accepted: true,
    });
    expect(updates[0]?.values.lifecycle_status).toBe('live');
  });

  it('unpause of an incomplete/unconsented profile lands back in draft', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'paused' })]);
    hasAcceptedProfileConsent.mockResolvedValue(false);
    classify_item.mockReturnValue({ lifecycle_status: 'draft' });

    const reply = await call(ownerRequest('unpause'));

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ item_id: ITEM_ID, lifecycle_status: 'draft' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((classify_item.mock.calls[0] as any[])[0].consent_accepted).toBe(false);
    expect(updates[0]?.values.lifecycle_status).toBe('draft');
  });

  it('unpause tolerates a null private blob (empty-string default)', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'paused', item_private_state: null })]);

    const reply = await call(ownerRequest('unpause'));

    expect(reply.statusCode).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((decryptItemPrivate.mock.calls[0] as any[])[0].item_private_state).toBe('');
  });
});

describe('item_lifecycle_handler — retire (terminal & destructive)', () => {
  it('scrubs PII, clears the private blob and wipes locations', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'live' })]);

    const reply = await call(ownerRequest('retire'));

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ item_id: ITEM_ID, lifecycle_status: 'retired' });

    // The scrub is driven by the schema + the STORED (masked) item_state —
    // retire deliberately never decrypts the private blob, so a corrupt blob
    // cannot block the action meant to wipe it.
    expect(buildRetiredItemState).toHaveBeenCalledWith(
      { required: ['name'], properties: { name: {} } },
      { name: 'Ada', email: 'ada@example.com' },
    );
    expect(decryptItemPrivate).not.toHaveBeenCalled();

    expect(updates).toHaveLength(1);
    expect(updates[0]?.values.lifecycle_status).toBe('retired');
    expect(updates[0]?.values.item_state).toEqual({ scrubbed: true });
    expect(updates[0]?.values.item_private_state).toBe('');
    expect(updates[0]?.values.item_locations).toEqual([]);
    expect(updates[0]?.values.updated_at).toBeDefined();
  });

  it('cancels every still-open connection inside the transaction', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'paused' })]);

    await call(ownerRequest('retire'));

    expect(cancelItemConnections).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = cancelItemConnections.mock.calls[0] as any[];
    expect(args[0]).toBe(fakeTx);
    expect(args[1]).toEqual({
      item_id: ITEM_ID,
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
    });
    expect(args[2]).toBe(log);
  });

  it('de-indexes from search and notifies the cancelled counterparties', async () => {
    const counterparties = [
      {
        actionId: 'a1',
        actionType: 'application',
        ownerUserId: 'user-2',
        itemId: 'item-2',
        domain: 'employer',
        network: 'blue_dot',
      },
    ];
    cancelItemConnections.mockResolvedValue(counterparties);
    rowQueue.push([existingItem({ lifecycle_status: 'live' })]);

    const reply = await call(ownerRequest('retire'));

    expect(reply.statusCode).toBe(200);
    expect(publishItemEvent).toHaveBeenCalledWith(
      {
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        item_id: ITEM_ID,
        op: 'delete',
      },
      log,
    );
    expect(dispatchRetireCancelNotifications).toHaveBeenCalledWith(
      counterparties,
      'blue_dot',
      log,
    );
    // Counterparties are internal plumbing, never part of the response body.
    expect(reply.body).not.toHaveProperty('counterparties');
  });

  it('retiring a draft item is allowed (retire is not gated on live)', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'draft' })]);

    const reply = await call(ownerRequest('retire'));

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ item_id: ITEM_ID, lifecycle_status: 'retired' });
    // Retire never consults the pause feature gate.
    expect(getNetworkConfigById).not.toHaveBeenCalled();
  });

  it('a cache-invalidation failure is logged but never fails the retire', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'live' })]);
    invalidateItemFetchCache.mockRejectedValue(new Error('redis down'));

    const reply = await call(ownerRequest('retire'));

    expect(reply.statusCode).toBe(200);
    expect(log.warn).toHaveBeenCalled();
    expect(publishItemEvent).toHaveBeenCalled();
  });
});

describe('item_lifecycle_handler — failures', () => {
  it('500 INTERNAL_SERVER_ERROR when the transaction throws', async () => {
    dbState.failWith = new Error('db down');

    const reply = await call(ownerRequest('pause'));

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update item lifecycle',
    });
    expect(log.error).toHaveBeenCalled();
  });

  it('500 when the retire PII scrub blows up — nothing is committed', async () => {
    rowQueue.push([existingItem({ lifecycle_status: 'live' })]);
    buildRetiredItemState.mockImplementation(() => {
      throw new Error('bad schema');
    });

    const reply = await call(ownerRequest('retire'));

    expect(reply.statusCode).toBe(500);
    expect(updates).toHaveLength(0);
    expect(publishItemEvent).not.toHaveBeenCalled();
    expect(dispatchRetireCancelNotifications).not.toHaveBeenCalled();
  });
});
