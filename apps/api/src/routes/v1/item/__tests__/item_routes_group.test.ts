import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// Unit tests for the three thin item route handlers (update / fetch / delete).
// Everything they touch is mocked: the real coverage of these files otherwise
// only comes from *.integration.test.ts, which the default run excludes.
//
// `fetch_items_handler` is NOT exported, so that one is reached by registering
// the plugin against a fake fastify and pulling the captured route back out.
const {
  dbState,
  deletes,
  updateItemInternal,
  ItemServiceError,
  DrizzleQueryError,
  DatabaseError,
  publishItemEvent,
  invalidateItemFetchCache,
  decryptItemPrivate,
  isServedDomainBinding,
  replyForUnservedDomain,
  getCachedLocalItemFetch,
  fetchLocalItems,
  auth_middleware_if_enabled,
} = vi.hoisted(() => {
  class ItemServiceError extends Error {
    statusCode: number;
    errorCode: string;
    constructor(statusCode: number, errorCode: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }
  class DatabaseError extends Error {
    code: string;
    constructor(code: string) {
      super(`pg error ${code}`);
      this.code = code;
    }
  }
  class DrizzleQueryError extends Error {
    constructor(message: string, cause?: unknown) {
      super(message);
      (this as { cause?: unknown }).cause = cause;
    }
  }

  return {
    // Resettable state — never monkey-patch a shared queue, an override there
    // leaks into every later test in the file.
    dbState: {
      failWith: null as Error | null,
      deleteRows: [] as Record<string, unknown>[],
    },
    deletes: [] as { table: unknown; where: unknown; cols: unknown }[],
    ItemServiceError,
    DrizzleQueryError,
    DatabaseError,
    // Params are declared on every vi.fn: `vi.fn(() => ...)` infers a zero-arg
    // signature and then `mock.calls[0][0]` fails tsc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateItemInternal: vi.fn(async (..._a: any[]) => ({ row: {} })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publishItemEvent: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invalidateItemFetchCache: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    decryptItemPrivate: vi.fn((..._a: any[]) => ({ mergedState: {} })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    isServedDomainBinding: vi.fn((..._a: any[]) => true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    replyForUnservedDomain: vi.fn(async (..._a: any[]): Promise<unknown> => undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getCachedLocalItemFetch: vi.fn(async (..._a: any[]): Promise<unknown> => undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchLocalItems: vi.fn(async (..._a: any[]): Promise<unknown> => undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auth_middleware_if_enabled: vi.fn(async (..._a: any[]) => {}),
  };
});

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    delete: (table: unknown) => ({
      where: (where: unknown) => ({
        returning: (cols: unknown) => {
          if (dbState.failWith) return Promise.reject(dbState.failWith);
          deletes.push({ table, where, cols });
          return Promise.resolve(dbState.deleteRows);
        },
      }),
    }),
  },
}));

vi.mock('@dpg/database', () => ({
  DatabaseError,
  items: {
    item_id: 'items.item_id',
    created_by: 'items.created_by',
    item_network: 'items.item_network',
    item_domain: 'items.item_domain',
    item_type: 'items.item_type',
  },
}));

vi.mock('drizzle-orm', () => ({
  DrizzleQueryError,
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
}));

vi.mock('@dpg/schemas', () => {
  const leaf = { array: () => leaf };
  return {
    default: {
      object: (shape: unknown) => ({ shape }),
      number: () => leaf,
      null: () => leaf,
    },
    ItemResponseSchema: leaf,
    UpdateItemBodySchema: { kind: 'update-body' },
    UpdateItemParamsSchema: { kind: 'item-params' },
    FetchItemsQuerySchema: { kind: 'fetch-query' },
  };
});

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth_middleware_if_enabled: (...a: any[]) => auth_middleware_if_enabled(...a),
}));

vi.mock('@/services/item_service', () => ({
  ItemServiceError,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateItemInternal: (...a: any[]) => updateItemInternal(...a),
}));

vi.mock('@/utils/publish_item_event', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publishItemEvent: (...a: any[]) => publishItemEvent(...a),
}));

vi.mock('@/utils/item_fetch_cache_invalidate', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invalidateItemFetchCache: (...a: any[]) => invalidateItemFetchCache(...a),
}));

vi.mock('@/utils/item_decrypt', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decryptItemPrivate: (...a: any[]) => decryptItemPrivate(...a),
}));

vi.mock('@/utils/served_domain_guard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isServedDomainBinding: (...a: any[]) => isServedDomainBinding(...a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replyForUnservedDomain: (...a: any[]) => replyForUnservedDomain(...a),
}));

vi.mock('@/utils/item_fetch_cache', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCachedLocalItemFetch: (...a: any[]) => getCachedLocalItemFetch(...a),
}));

vi.mock('@/utils/item_fetch_runtime', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchLocalItems: (...a: any[]) => fetchLocalItems(...a),
}));

import { update_item, update_item_handler } from '../update_item';
import { delete_item, delete_item_handler } from '../delete_item';
import { fetch_item, fetch_items } from '../fetch_item';

// --- fakes -----------------------------------------------------------------

interface FakeReply {
  statusCode: number;
  body: unknown;
  code(c: number): FakeReply;
  send(b?: unknown): FakeReply;
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

async function loadRoutes() {
  routes.length = 0;
  const fakeFastify = {
    route: (opts: FakeRoute) => {
      routes.push(opts);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args = [fakeFastify as any, {} as any] as const;
  await update_item(...args);
  await delete_item(...args);
  await fetch_items(...args);
}

function routeFor(method: string): FakeRoute {
  const found = routes.find((r) => r.method === method);
  if (!found) throw new Error(`no ${method} item route registered`);
  return found;
}

const log = { error: vi.fn(), warn: vi.fn() };

function baseUpdatedRow(overrides: Record<string, unknown> = {}) {
  return {
    item_id: 'item-1',
    item_network: 'yellow_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    item_state: { name: 'Ada' },
    item_private_state: 'cipher-blob',
    created_by: 'user-1',
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (req: any, reply: any) => Promise<unknown>;

function callHandler(handler: AnyHandler, req: Record<string, unknown>) {
  const reply = makeReply();
  return handler({ log, ...req }, reply).then(() => reply);
}

beforeEach(async () => {
  dbState.failWith = null;
  dbState.deleteRows = [];
  deletes.length = 0;
  vi.clearAllMocks();
  // Deterministic defaults, re-applied every test (clearAllMocks keeps
  // implementations, but a per-test override must not survive).
  updateItemInternal.mockImplementation(async () => ({ row: baseUpdatedRow() }));
  publishItemEvent.mockImplementation(async () => {});
  invalidateItemFetchCache.mockImplementation(async () => {});
  decryptItemPrivate.mockImplementation((row: Record<string, unknown>) => ({
    mergedState: row.item_state as Record<string, unknown>,
  }));
  isServedDomainBinding.mockImplementation(() => true);
  replyForUnservedDomain.mockImplementation(
    async (reply: FakeReply, network: string, domain: string) =>
      reply.code(403).send({
        error: 'UNSERVED_DOMAIN_BINDING',
        message: `This API instance does not serve "${network}/${domain}".`,
      }),
  );
  getCachedLocalItemFetch.mockImplementation(
    async (_filters: unknown, loader: () => Promise<unknown>) => loader(),
  );
  fetchLocalItems.mockImplementation(async () => ({
    meta: { total: 0, limit: 10, offset: 0 },
    items: [],
  }));
  await loadRoutes();
});

// --- plugin registration ---------------------------------------------------

describe('item route registration', () => {
  it('registers PATCH /:itemId, DELETE /:itemId and GET /fetch, each behind auth', () => {
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual([
      'PATCH /:itemId',
      'DELETE /:itemId',
      'GET /fetch',
    ]);
    for (const route of routes) {
      // item_routes.ts has no group-level auth hook, so a missing per-route
      // preHandler would leave the endpoint unauthenticated.
      expect(typeof route.preHandler).toBe('function');
      expect(route.schema?.tags).toEqual(['item']);
    }
  });

  it('wires the shared auth middleware as the preHandler', async () => {
    await routeFor('PATCH').preHandler?.({}, {});
    await routeFor('DELETE').preHandler?.({}, {});
    await routeFor('GET').preHandler?.({}, {});
    expect(auth_middleware_if_enabled).toHaveBeenCalledTimes(3);
  });

  it('declares a 204-null response for DELETE and a body schema only on PATCH', () => {
    expect(routeFor('DELETE').schema?.response).toBeDefined();
    expect(routeFor('PATCH').schema?.body).toEqual({ kind: 'update-body' });
    expect(routeFor('DELETE').schema?.body).toBeUndefined();
    expect(routeFor('GET').schema?.query).toEqual({ kind: 'fetch-query' });
  });

  it('exports fetch_item as an alias of the fetch_items plugin', () => {
    expect(fetch_item).toBe(fetch_items);
  });
});

// --- update_item -----------------------------------------------------------

describe('update_item_handler', () => {
  const params = { itemId: 'item-1' };
  const body = { item_state: { name: 'Ada' }, item_locations: [{ lat: 1, lon: 2 }] };

  it('returns 401 when there is no authenticated user', async () => {
    const reply = await callHandler(update_item_handler, { params, body });
    expect(reply.statusCode).toBe(401);
    expect((reply.body as { error: string }).error).toBe('UNAUTHORIZED');
    expect(updateItemInternal).not.toHaveBeenCalled();
  });

  it('updates as a non-admin owner, publishes an upsert event and sweeps the cache', async () => {
    const reply = await callHandler(update_item_handler, {
      params,
      body,
      user: { id: 'user-1', role: 'user' },
    });

    expect(reply.statusCode).toBe(200);
    const [, itemId, callerId, isAdmin, patch] = updateItemInternal.mock.calls[0];
    expect(itemId).toBe('item-1');
    expect(callerId).toBe('user-1');
    expect(isAdmin).toBe(false);
    expect(patch).toEqual({
      item_state: body.item_state,
      item_locations: body.item_locations,
    });

    expect(publishItemEvent.mock.calls[0][0]).toEqual({
      item_network: 'yellow_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      item_id: 'item-1',
      op: 'upsert',
    });
    expect(invalidateItemFetchCache).toHaveBeenCalledWith('yellow_dot', 'student');
  });

  it('passes isAdmin=true through for an admin caller', async () => {
    await callHandler(update_item_handler, {
      params,
      body,
      user: { id: 'admin-1', role: 'admin' },
    });
    expect(updateItemInternal.mock.calls[0][3]).toBe(true);
  });

  it('drops item_private_state and returns the decrypted merged state', async () => {
    updateItemInternal.mockImplementation(async () => ({ row: baseUpdatedRow() }));
    decryptItemPrivate.mockImplementation(() => ({
      mergedState: { name: 'Ada', phone: '+15550000' },
    }));

    const reply = await callHandler(update_item_handler, {
      params,
      body,
      user: { id: 'user-1' },
    });

    const item = (reply.body as { item: Record<string, unknown> }).item;
    expect(item.item_private_state).toBeUndefined();
    expect(item.item_state).toEqual({ name: 'Ada', phone: '+15550000' });
    expect(decryptItemPrivate.mock.calls[0][0]).toEqual({
      item_state: { name: 'Ada' },
      item_private_state: 'cipher-blob',
    });
  });

  it('still returns 200 when cache invalidation fails, logging a warning', async () => {
    invalidateItemFetchCache.mockImplementation(async () => {
      throw new Error('redis down');
    });

    const reply = await callHandler(update_item_handler, {
      params,
      body,
      user: { id: 'user-1' },
    });

    expect(reply.statusCode).toBe(200);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('maps an ItemServiceError onto its own status and error code', async () => {
    updateItemInternal.mockImplementation(async () => {
      throw new ItemServiceError(403, 'ITEM_FORBIDDEN', 'not your item');
    });

    const reply = await callHandler(update_item_handler, {
      params,
      body,
      user: { id: 'user-2' },
    });

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({
      error: 'ITEM_FORBIDDEN',
      message: 'not your item',
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('maps a PG 22P02 (invalid text representation) to 400 INVALID_INPUT', async () => {
    updateItemInternal.mockImplementation(async () => {
      throw new DrizzleQueryError('query failed', new DatabaseError('22P02'));
    });

    const reply = await callHandler(update_item_handler, {
      params,
      body,
      user: { id: 'user-1' },
    });

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual({
      error: 'INVALID_INPUT',
      message: 'Invalid value provided',
    });
  });

  it('falls through to 500 for other PG codes (23505 / 23503 are not mapped here)', async () => {
    for (const code of ['23505', '23503']) {
      vi.clearAllMocks();
      updateItemInternal.mockImplementation(async () => {
        throw new DrizzleQueryError('query failed', new DatabaseError(code));
      });

      const reply = await callHandler(update_item_handler, {
        params,
        body,
        user: { id: 'user-1' },
      });

      expect(reply.statusCode).toBe(500);
      expect((reply.body as { error: string }).error).toBe('INTERNAL_SERVER_ERROR');
      expect(log.error).toHaveBeenCalledTimes(1);
    }
  });

  it('falls through to 500 for a DrizzleQueryError with a non-DatabaseError cause', async () => {
    updateItemInternal.mockImplementation(async () => {
      throw new DrizzleQueryError('query failed', new Error('socket closed'));
    });

    const reply = await callHandler(update_item_handler, {
      params,
      body,
      user: { id: 'user-1' },
    });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe('INTERNAL_SERVER_ERROR');
  });

  it('returns 500 when the item-event publish fails (it is inside the try, uncaught)', async () => {
    publishItemEvent.mockImplementation(async () => {
      throw new Error('redis publish failed');
    });

    const reply = await callHandler(update_item_handler, {
      params,
      body,
      user: { id: 'user-1' },
    });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe('INTERNAL_SERVER_ERROR');
    expect(invalidateItemFetchCache).not.toHaveBeenCalled();
  });
});

// --- delete_item -----------------------------------------------------------

describe('delete_item_handler', () => {
  const params = { itemId: 'item-1' };
  const deletedRow = {
    item_id: 'item-1',
    item_network: 'yellow_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
  };

  it('returns 401 when there is no authenticated user', async () => {
    const reply = await callHandler(delete_item_handler, { params });
    expect(reply.statusCode).toBe(401);
    expect((reply.body as { error: string }).error).toBe('UNAUTHORIZED');
    expect(deletes).toHaveLength(0);
  });

  it('returns 204 with no body, publishes a delete event and sweeps the cache', async () => {
    dbState.deleteRows = [deletedRow];

    const reply = await callHandler(delete_item_handler, {
      params,
      user: { id: 'user-1' },
    });

    expect(reply.statusCode).toBe(204);
    expect(reply.body).toBeUndefined();
    expect(publishItemEvent.mock.calls[0][0]).toEqual({ ...deletedRow, op: 'delete' });
    expect(invalidateItemFetchCache).toHaveBeenCalledWith('yellow_dot', 'student');
  });

  it('scopes the delete to the caller-owned row (no admin bypass)', async () => {
    dbState.deleteRows = [deletedRow];

    await callHandler(delete_item_handler, {
      params,
      user: { id: 'admin-1', role: 'admin' },
    });

    expect(deletes[0].where).toEqual({
      op: 'and',
      parts: [
        { op: 'eq', col: 'items.item_id', val: 'item-1' },
        { op: 'eq', col: 'items.created_by', val: 'admin-1' },
      ],
    });
  });

  it('returns 404 with a non-leaking envelope when nothing was deleted', async () => {
    dbState.deleteRows = [];

    const reply = await callHandler(delete_item_handler, {
      params,
      user: { id: 'user-2' },
    });

    expect(reply.statusCode).toBe(404);
    expect(reply.body).toEqual({
      error: 'ITEM_NOT_FOUND_OR_FORBIDDEN',
      message: 'Item not found or does not belong to the authenticated user',
    });
    expect(publishItemEvent).not.toHaveBeenCalled();
    expect(invalidateItemFetchCache).not.toHaveBeenCalled();
  });

  it('still returns 204 when cache invalidation fails, logging a warning', async () => {
    dbState.deleteRows = [deletedRow];
    invalidateItemFetchCache.mockImplementation(async () => {
      throw new Error('redis down');
    });

    const reply = await callHandler(delete_item_handler, {
      params,
      user: { id: 'user-1' },
    });

    expect(reply.statusCode).toBe(204);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('returns 500 and logs when the delete query rejects', async () => {
    dbState.failWith = new Error('connection terminated');

    const reply = await callHandler(delete_item_handler, {
      params,
      user: { id: 'user-1' },
    });

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to delete item',
    });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('does not special-case a PG 23503 FK violation — it becomes a 500', async () => {
    dbState.failWith = new DrizzleQueryError(
      'delete failed',
      new DatabaseError('23503'),
    );

    const reply = await callHandler(delete_item_handler, {
      params,
      user: { id: 'user-1' },
    });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe('INTERNAL_SERVER_ERROR');
  });
});

// --- fetch_items -----------------------------------------------------------

describe('fetch_items_handler', () => {
  const query = {
    item_network: 'yellow_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    limit: 10,
    offset: 0,
  };

  function callFetch(req: Record<string, unknown>) {
    return callHandler(routeFor('GET').handler as AnyHandler, req);
  }

  it('returns 401 when there is no authenticated user', async () => {
    const reply = await callFetch({ query });
    expect(reply.statusCode).toBe(401);
    expect((reply.body as { error: string }).error).toBe('UNAUTHORIZED');
    expect(isServedDomainBinding).not.toHaveBeenCalled();
  });

  it('returns 403 UNSERVED_DOMAIN_BINDING for a binding this instance does not serve', async () => {
    isServedDomainBinding.mockImplementation(() => false);

    const reply = await callFetch({ query, user: { id: 'user-1' } });

    expect(reply.statusCode).toBe(403);
    expect((reply.body as { error: string }).error).toBe('UNSERVED_DOMAIN_BINDING');
    expect(isServedDomainBinding).toHaveBeenCalledWith('yellow_dot', 'student');
    expect(replyForUnservedDomain.mock.calls[0].slice(1)).toEqual([
      'yellow_dot',
      'student',
    ]);
    expect(getCachedLocalItemFetch).not.toHaveBeenCalled();
  });

  it('scopes the read to the caller, requests private state and excludes retired items', async () => {
    const reply = await callFetch({ query, user: { id: 'user-1' } });

    expect(reply.statusCode).toBe(200);
    const filters = getCachedLocalItemFetch.mock.calls[0][0] as Record<string, unknown>;
    expect(filters.created_by).toBe('user-1');
    expect(filters.includePrivateState).toBe(true);
    expect(filters.exclude_retired).toBe(true);
    expect(filters.item_network).toBe('yellow_dot');
    expect(filters.limit).toBe(10);
    // The loader closure is what actually hits the DB path.
    expect(fetchLocalItems).toHaveBeenCalledWith(filters);
  });

  it('keeps retired items when include_retired is set (login-redirect check)', async () => {
    await callFetch({
      query: { ...query, include_retired: true },
      user: { id: 'user-1' },
    });

    const filters = getCachedLocalItemFetch.mock.calls[0][0] as Record<string, unknown>;
    expect(filters.exclude_retired).toBe(false);
  });

  it('coerces cached string timestamps back into Date instances', async () => {
    const liveDate = new Date('2026-01-02T03:04:05.000Z');
    fetchLocalItems.mockImplementation(async () => ({
      meta: { total: 2, limit: 10, offset: 0 },
      items: [
        { item_id: 'a', created_at: '2026-01-01T00:00:00.000Z', updated_at: liveDate },
        { item_id: 'b', created_at: liveDate, updated_at: '2026-01-03T00:00:00.000Z' },
      ],
    }));

    const reply = await callFetch({ query, user: { id: 'user-1' } });

    const body = reply.body as {
      meta: { total: number };
      items: { item_id: string; created_at: unknown; updated_at: unknown }[];
    };
    expect(body.meta.total).toBe(2);
    for (const item of body.items) {
      expect(item.created_at).toBeInstanceOf(Date);
      expect(item.updated_at).toBeInstanceOf(Date);
    }
    expect((body.items[0].created_at as Date).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    // An already-Date value is passed through by reference, not re-wrapped.
    expect(body.items[0].updated_at).toBe(liveDate);
  });

  it('returns 500 and logs when the cached fetch rejects', async () => {
    getCachedLocalItemFetch.mockImplementation(async () => {
      throw new Error('redis unavailable');
    });

    const reply = await callFetch({ query, user: { id: 'user-1' } });

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch items',
    });
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
