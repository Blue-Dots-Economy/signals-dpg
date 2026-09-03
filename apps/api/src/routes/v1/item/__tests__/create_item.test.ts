import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// Everything create_item touches is mocked: the handler is pure branching
// around a transaction, so the interesting assertions are the HTTP status +
// machine-readable error code, and the exact payload handed to
// createItemInternal (which is where the "clients cannot set
// item_instance_url / item_schema_url" contract is observable).
const {
  dbState,
  rowQueue,
  txInsertValues,
  txUpdateSet,
  ensureItemPartition,
  resolveConsentVersion,
  isServedDomainBinding,
  replyForUnservedDomain,
  invalidateItemFetchCache,
  publishItemEvent,
  createItemInternal,
  dispatchItemLifecycleNotification,
  resolveGoLiveGates,
  resolveLocationsForCreate,
  getWardAge,
  guardianConsentRequired,
  getNetworkConfigById,
  FakeDrizzleQueryError,
  FakeDatabaseError,
  FakeItemServiceError,
} = vi.hoisted(() => {
  class FakeDrizzleQueryError extends Error {
    override cause: unknown;
    constructor(cause: unknown) {
      super('drizzle query failed');
      this.cause = cause;
    }
  }
  class FakeDatabaseError extends Error {
    code: string;
    constructor(code: string) {
      super(`pg ${code}`);
      this.code = code;
    }
  }
  class FakeItemServiceError extends Error {
    statusCode: number;
    errorCode: string;
    constructor(statusCode: number, errorCode: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }
  return {
    // Resettable failure flags, so an override never leaks into a later test.
    dbState: {
      failWith: null as Error | null,
      txFailWith: null as Error | null,
      consentInsertFailWith: null as Error | null,
    },
    rowQueue: [] as unknown[][],
    txInsertValues: vi.fn((_v: Record<string, unknown>) => undefined),
    txUpdateSet: vi.fn((_v: Record<string, unknown>) => undefined),
    ensureItemPartition: vi.fn(),
    resolveConsentVersion: vi.fn(),
    isServedDomainBinding: vi.fn(),
    replyForUnservedDomain: vi.fn(),
    invalidateItemFetchCache: vi.fn(),
    publishItemEvent: vi.fn(),
    createItemInternal: vi.fn(),
    dispatchItemLifecycleNotification: vi.fn(),
    resolveGoLiveGates: vi.fn(),
    resolveLocationsForCreate: vi.fn(),
    getWardAge: vi.fn(),
    guardianConsentRequired: vi.fn(),
    getNetworkConfigById: vi.fn(),
    FakeDrizzleQueryError,
    FakeDatabaseError,
    FakeItemServiceError,
  };
});

function nextRows() {
  if (dbState.failWith) return Promise.reject(dbState.failWith);
  return Promise.resolve(rowQueue.shift() ?? []);
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          // Thenable AND chainable: both callbacks must be forwarded or a
          // rejected query would hang the await.
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            nextRows().then(res, rej),
          limit: () => nextRows(),
        }),
      }),
    }),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      if (dbState.txFailWith) throw dbState.txFailWith;
      const tx = {
        insert: () => ({
          values: async (v: Record<string, unknown>) => {
            if (dbState.consentInsertFailWith) throw dbState.consentInsertFailWith;
            txInsertValues(v);
          },
        }),
        update: () => ({
          set: (v: Record<string, unknown>) => {
            txUpdateSet(v);
            // The single-role bootstrap now reads `.returning()` so it can tell
            // whether it fired — that is the user-level moment the SS-3 default
            // aggregator tags the owner (#640). Empty array = the user already
            // had a domain, so no tagging.
            return { where: () => ({ returning: async () => [] }) };
          },
        }),
      };
      return cb(tx);
    },
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  consent_record: { userId: 'cr.userId', itemId: 'cr.itemId' },
  user: { id: 'user.id', domains: 'user.domains' },
}));

vi.mock('drizzle-orm', () => ({
  DrizzleQueryError: FakeDrizzleQueryError,
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
  sql: (...a: unknown[]) => a,
}));

vi.mock('@dpg/database', () => ({
  DatabaseError: FakeDatabaseError,
  ensureItemPartition: (...a: unknown[]) => ensureItemPartition(...a),
}));

vi.mock('@dpg/schemas', () => ({
  default: { object: () => ({}), string: () => ({}) },
  CreateItemBodySchema: {},
}));

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: (...a: unknown[]) => resolveConsentVersion(...a),
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: (...a: unknown[]) => isServedDomainBinding(...a),
  replyForUnservedDomain: (...a: unknown[]) => replyForUnservedDomain(...a),
}));

vi.mock('@/utils/item_fetch_cache_invalidate', () => ({
  invalidateItemFetchCache: (...a: unknown[]) => invalidateItemFetchCache(...a),
}));

vi.mock('@/utils/publish_item_event', () => ({
  publishItemEvent: (...a: unknown[]) => publishItemEvent(...a),
}));

vi.mock('@/services/item_service', () => ({
  ItemServiceError: FakeItemServiceError,
  createItemInternal: (...a: unknown[]) => createItemInternal(...a),
  resolveGoLiveGates: (...a: unknown[]) => resolveGoLiveGates(...a),
}));

// The create seam lazy-imports this; the mock intercepts the dynamic import.
vi.mock('@/notifications/notify_item_lifecycle', () => ({
  dispatchItemLifecycleNotification: (...a: unknown[]) => dispatchItemLifecycleNotification(...a),
}));

vi.mock('@/services/geocoding/resolve_locations_for_create', () => ({
  resolveLocationsForCreate: (...a: unknown[]) => resolveLocationsForCreate(...a),
}));

vi.mock('@/services/minor_guardian_repo', () => ({
  getWardAge: (...a: unknown[]) => getWardAge(...a),
}));

vi.mock('@/services/minor', () => ({
  isMinor: (age: number) => age < 18,
  guardianConsentRequired: (...a: unknown[]) => guardianConsentRequired(...a),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...a: unknown[]) => getNetworkConfigById(...a),
}));

import { create_item_handler } from '../create_item';

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

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

function baseBody(over: Record<string, unknown> = {}) {
  return {
    item_network: 'blue_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    item_state: { name: 'Ada' },
    ...over,
  };
}

async function call(req: {
  user?: { id: string; role?: string };
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}) {
  const reply = makeReply();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (create_item_handler as any)(
    { log, headers: {}, ...req },
    reply
  );
  return reply;
}

function bodyOf(reply: FakeReply) {
  return reply.body as { error: string; message: string } & Record<string, unknown>;
}

/** First (and only) argument object handed to createItemInternal (arg 2). */
function createPayload() {
  return createItemInternal.mock.calls[0]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  rowQueue.length = 0;
  dbState.failWith = null;
  dbState.txFailWith = null;
  dbState.consentInsertFailWith = null;
  vi.clearAllMocks();

  // Happy-path defaults; individual tests override.
  isServedDomainBinding.mockReturnValue(true);
  ensureItemPartition.mockResolvedValue(undefined);
  resolveLocationsForCreate.mockResolvedValue([]);
  resolveConsentVersion.mockResolvedValue(3);
  // Default: the domain gates go-live on consent_required, so the create-time
  // CONSENT_REQUIRED guard is active (config-driven per #344 go_live_required).
  resolveGoLiveGates.mockResolvedValue(['schema_required', 'consent_required']);
  guardianConsentRequired.mockReturnValue(false);
  getNetworkConfigById.mockResolvedValue({ id: 'blue_dot' });
  getWardAge.mockResolvedValue(30);
  createItemInternal.mockResolvedValue({
    itemId: 'item-1',
    itemType: 'profile_1.0',
    lifecycleStatus: 'live',
  });
  publishItemEvent.mockResolvedValue(undefined);
  invalidateItemFetchCache.mockResolvedValue(undefined);
});

// --- guard rails -----------------------------------------------------------

describe('create_item_handler guards', () => {
  it('401 UNAUTHORIZED when there is no authenticated user', async () => {
    const reply = await call({ user: undefined, body: baseBody() });

    expect(reply.statusCode).toBe(401);
    expect(bodyOf(reply).error).toBe('UNAUTHORIZED');
    expect(createItemInternal).not.toHaveBeenCalled();
  });

  it('403 FORBIDDEN_CREATED_BY when a session user supplies created_by', async () => {
    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ created_by: 'someone-else' }),
    });

    expect(reply.statusCode).toBe(403);
    expect(bodyOf(reply).error).toBe('FORBIDDEN_CREATED_BY');
  });

  it('403 FORBIDDEN_CREATED_BY even for an admin ROLE without an api-key header', async () => {
    // The api-key header, not the admin role, unlocks the on-behalf flow.
    const reply = await call({
      user: { id: 'admin1', role: 'admin' },
      body: baseBody({ created_by: 'u2' }),
    });

    expect(reply.statusCode).toBe(403);
    expect(bodyOf(reply).error).toBe('FORBIDDEN_CREATED_BY');
  });

  it('403 FORBIDDEN_CREATED_BY for a non-admin api-key caller supplying created_by', async () => {
    const reply = await call({
      user: { id: 'svc', role: 'user' },
      headers: { 'x-api-key': 'k' },
      body: baseBody({ created_by: 'u2' }),
    });

    expect(reply.statusCode).toBe(403);
    expect(bodyOf(reply).error).toBe('FORBIDDEN_CREATED_BY');
  });

  it('400 CREATED_BY_REQUIRED when an admin api-key caller omits created_by', async () => {
    const reply = await call({
      user: { id: 'admin1', role: 'admin' },
      headers: { 'x-api-key': 'k' },
      body: baseBody(),
    });

    expect(reply.statusCode).toBe(400);
    expect(bodyOf(reply).error).toBe('CREATED_BY_REQUIRED');
  });

  it('400 CONSENT_REQUIRED for a self create with no consent when a version is configured', async () => {
    resolveConsentVersion.mockResolvedValue(2);

    const reply = await call({ user: { id: 'u1' }, body: baseBody() });

    expect(reply.statusCode).toBe(400);
    expect(bodyOf(reply).error).toBe('CONSENT_REQUIRED');
    expect(resolveConsentVersion).toHaveBeenCalledWith({
      network: 'blue_dot',
      category: 'profile_creation',
    });
  });

  it('allows a consent-less self create when no profile_creation consent is configured', async () => {
    resolveConsentVersion.mockResolvedValue(null);

    const reply = await call({ user: { id: 'u1' }, body: baseBody() });

    expect(reply.statusCode).toBe(201);
    expect(createPayload().consent_accepted).toBe(false);
  });

  it('skips the CONSENT_REQUIRED guard when the domain does not gate on consent_required (#344)', async () => {
    // Domain goes live on completeness alone (`go_live_required: ["schema_required"]`),
    // so a self create with no consent is allowed even though a profile_creation
    // version IS configured — the create-time guard is config-driven and must not
    // demand consent, nor even resolve the version, on a consent-free domain.
    resolveGoLiveGates.mockResolvedValue(['schema_required']);
    resolveConsentVersion.mockResolvedValue(2);

    const reply = await call({ user: { id: 'u1' }, body: baseBody() });

    expect(reply.statusCode).toBe(201);
    expect(bodyOf(reply).error).toBeUndefined();
    // The consent-free gate set short-circuits before resolveConsentVersion.
    expect(resolveConsentVersion).not.toHaveBeenCalled();
    expect(resolveGoLiveGates).toHaveBeenCalledWith('blue_dot', 'student');
  });

  it('delegates to replyForUnservedDomain for an unserved network/domain binding', async () => {
    isServedDomainBinding.mockReturnValue(false);
    replyForUnservedDomain.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (reply: any) =>
        reply.code(404).send({ error: 'DOMAIN_NOT_SERVED', message: 'nope' })
    );

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(reply.statusCode).toBe(404);
    expect(bodyOf(reply).error).toBe('DOMAIN_NOT_SERVED');
    expect(replyForUnservedDomain).toHaveBeenCalledWith(
      expect.anything(),
      'blue_dot',
      'student'
    );
    expect(createItemInternal).not.toHaveBeenCalled();
  });

  it('403 DOMAIN_LOCKED when user.domains holds a different domain', async () => {
    rowQueue.push([{ domains: ['student'] }]);

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({
        item_domain: 'employer',
        consent: { category: 'profile_creation', version: 1 },
      }),
    });

    expect(reply.statusCode).toBe(403);
    expect(bodyOf(reply).error).toBe('DOMAIN_LOCKED');
    expect(bodyOf(reply).locked_domain).toBe('student');
    expect(bodyOf(reply).requested_domain).toBe('employer');
  });

  it('allows any served domain when user.domains is empty (first create)', async () => {
    rowQueue.push([{ domains: [] }]);

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({
        item_domain: 'employer',
        consent: { category: 'profile_creation', version: 1 },
      }),
    });

    expect(reply.statusCode).toBe(201);
    // ...and the first create bootstraps the single role on the user row.
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ domains: ['employer'] })
    );
  });

  it('an admin api-key caller bypasses the domain lock entirely', async () => {
    // No row pushed: if the lock query ran, `domains` would be undefined and
    // the create would proceed anyway, so instead assert the *effect* — the
    // item is created for created_by, not for the admin caller.
    const reply = await call({
      user: { id: 'admin1', role: 'admin' },
      headers: { 'x-api-key': 'k' },
      body: baseBody({ created_by: 'u2', item_domain: 'employer' }),
    });

    expect(reply.statusCode).toBe(201);
    expect(createPayload().created_by).toBe('u2');
    // The on-behalf path never resolves a create-time consent requirement.
    expect(resolveConsentVersion).not.toHaveBeenCalled();
  });

  it('500 PARTITION_SETUP_FAILED when ensureItemPartition throws', async () => {
    ensureItemPartition.mockRejectedValue(new Error('no ddl'));

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('PARTITION_SETUP_FAILED');
    expect(log.error).toHaveBeenCalled();
    expect(createItemInternal).not.toHaveBeenCalled();
  });
});

// --- server-owned fields ---------------------------------------------------

describe('server-owned fields', () => {
  it('never forwards client-supplied item_instance_url / item_schema_url', async () => {
    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({
        consent: { category: 'profile_creation', version: 1 },
        item_instance_url: 'https://evil.example/item',
        item_schema_url: 'https://evil.example/schema',
        item_id: 'client-chosen-id',
        lifecycle_status: 'live',
      }),
    });

    expect(reply.statusCode).toBe(201);
    const payload = createPayload();
    expect(payload).not.toHaveProperty('item_instance_url');
    expect(payload).not.toHaveProperty('item_schema_url');
    expect(payload).not.toHaveProperty('item_id');
    expect(payload).not.toHaveProperty('lifecycle_status');
    // Only the explicit allow-list reaches the service.
    expect(Object.keys(payload).sort()).toEqual([
      'consent_accepted',
      'created_by',
      'item_domain',
      'item_locations',
      'item_network',
      'item_state',
      'item_type',
    ]);
  });

  it('defaults item_state to {} and uses server-resolved locations', async () => {
    resolveLocationsForCreate.mockResolvedValue([{ lat: 1, lng: 2 }]);

    await call({
      user: { id: 'u1' },
      body: {
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        consent: { category: 'profile_creation', version: 1 },
      },
    });

    expect(createPayload().item_state).toEqual({});
    expect(createPayload().item_locations).toEqual([{ lat: 1, lng: 2 }]);
  });

  it('201 returns the service-assigned item id and type', async () => {
    createItemInternal.mockResolvedValue({
      itemId: 'server-id',
      itemType: 'profile_1.0',
    });

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(reply.statusCode).toBe(201);
    expect(reply.body).toEqual({ item_type: 'profile_1.0', item_id: 'server-id' });
    expect(publishItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'server-id', op: 'upsert' }),
      log
    );
    expect(invalidateItemFetchCache).toHaveBeenCalledWith('blue_dot', 'student');
  });

  it('still returns 201 when cache invalidation fails (warn only)', async () => {
    invalidateItemFetchCache.mockRejectedValue(new Error('redis down'));

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(reply.statusCode).toBe(201);
    expect(log.warn).toHaveBeenCalled();
  });
});

// --- lifecycle-email seam (#531/#534) --------------------------------------

describe('create_item_handler — lifecycle notification seam', () => {
  it('dispatches a create notification for the owner with the committed lifecycle status', async () => {
    createItemInternal.mockResolvedValue({
      itemId: 'item-1',
      itemType: 'profile_1.0',
      lifecycleStatus: 'draft', // e.g. incomplete profile — drives *.create_incomplete copy
    });

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });
    expect(reply.statusCode).toBe(201);

    // Fire-and-forget after commit — flush the void-import microtask.
    await vi.waitFor(() => expect(dispatchItemLifecycleNotification).toHaveBeenCalledTimes(1));
    expect(dispatchItemLifecycleNotification.mock.calls[0]![0]).toMatchObject({
      op: 'create',
      ownerId: 'u1', // the resolved owner (session caller here)
      network: 'blue_dot',
      domain: 'student',
      lifecycleStatus: 'draft',
    });
  });

  it('still returns 201 when the create notification rejects (best-effort)', async () => {
    dispatchItemLifecycleNotification.mockRejectedValueOnce(new Error('NS down'));

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(reply.statusCode).toBe(201); // route unaffected by the notify rejection
    await vi.waitFor(() => expect(dispatchItemLifecycleNotification).toHaveBeenCalled());
  });
});

// --- consent + U18 promotion ----------------------------------------------

describe('consent capture and U18 gating', () => {
  it('a consenting self create promotes to live and records the server-resolved version', async () => {
    resolveConsentVersion.mockResolvedValue(7);

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({
        consent: { category: 'profile_creation', version: 1, brand: 'acme' },
      }),
    });

    expect(reply.statusCode).toBe(201);
    expect(createPayload().consent_accepted).toBe(true);
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'item',
        consentCategory: 'profile_creation',
        userId: 'u1',
        itemId: 'item-1',
        network: 'blue_dot',
        brand: 'acme',
        // Version 7 comes from the config, NOT the client-supplied 1.
        documentVersion: 7,
        source: 'profile',
      })
    );
  });

  it('records brand null when the consent block omits it', async () => {
    await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ brand: null })
    );
  });

  it('keys the consent row on the CALLER while the item is owned by created_by', async () => {
    const reply = await call({
      user: { id: 'admin1', role: 'admin' },
      headers: { 'x-api-key': 'k' },
      body: baseBody({
        created_by: 'u2',
        consent: { category: 'profile_creation', version: 1 },
      }),
    });

    expect(reply.statusCode).toBe(201);
    expect(createPayload().created_by).toBe('u2');
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin1' })
    );
  });

  it('a gated MINOR self-consent stays draft (fail-closed)', async () => {
    guardianConsentRequired.mockReturnValue(true);
    getWardAge.mockResolvedValue(15);

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(reply.statusCode).toBe(201);
    expect(createPayload().consent_accepted).toBe(false);
    expect(getWardAge).toHaveBeenCalledWith('u1');
  });

  it('a gated user with an unknown age stays draft (null cannot prove adulthood)', async () => {
    guardianConsentRequired.mockReturnValue(true);
    getWardAge.mockResolvedValue(null);

    await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(createPayload().consent_accepted).toBe(false);
  });

  it('a gated PROVEN adult still self-promotes to live', async () => {
    guardianConsentRequired.mockReturnValue(true);
    getWardAge.mockResolvedValue(19);

    await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(createPayload().consent_accepted).toBe(true);
  });

  it('does not consult the guardian gate at all without a consent block', async () => {
    resolveConsentVersion.mockResolvedValue(null);

    await call({ user: { id: 'u1' }, body: baseBody() });

    expect(getNetworkConfigById).not.toHaveBeenCalled();
    expect(getWardAge).not.toHaveBeenCalled();
    expect(txInsertValues).not.toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED when no profile_creation version is configured', async () => {
    resolveConsentVersion.mockResolvedValue(null);

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('CONSENT_WRITE_FAILED');
    expect(log.error).toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED (item rolled back) when the consent insert throws', async () => {
    dbState.consentInsertFailWith = new Error('consent insert exploded');

    const reply = await call({
      user: { id: 'u1' },
      body: baseBody({ consent: { category: 'profile_creation', version: 1 } }),
    });

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('CONSENT_WRITE_FAILED');
    // Nothing is published/invalidated when the transaction rolls back.
    expect(publishItemEvent).not.toHaveBeenCalled();
    expect(invalidateItemFetchCache).not.toHaveBeenCalled();
  });
});

// --- failure mapping ------------------------------------------------------

describe('error mapping', () => {
  const consentBody = () =>
    baseBody({ consent: { category: 'profile_creation', version: 1 } });

  it('propagates an ItemServiceError status and error code verbatim', async () => {
    createItemInternal.mockRejectedValue(
      new FakeItemServiceError(422, 'ITEM_VALIDATION_FAILED', 'bad state')
    );

    const reply = await call({ user: { id: 'u1' }, body: consentBody() });

    expect(reply.statusCode).toBe(422);
    expect(bodyOf(reply).error).toBe('ITEM_VALIDATION_FAILED');
    expect(bodyOf(reply).message).toBe('bad state');
  });

  it('409 ITEM_ALREADY_EXISTS for PG 23505 (unique violation)', async () => {
    createItemInternal.mockRejectedValue(
      new FakeDrizzleQueryError(new FakeDatabaseError('23505'))
    );

    const reply = await call({ user: { id: 'u1' }, body: consentBody() });

    expect(reply.statusCode).toBe(409);
    expect(bodyOf(reply).error).toBe('ITEM_ALREADY_EXISTS');
  });

  it('400 INVALID_REFERENCE for PG 23503 (foreign key violation)', async () => {
    createItemInternal.mockRejectedValue(
      new FakeDrizzleQueryError(new FakeDatabaseError('23503'))
    );

    const reply = await call({ user: { id: 'u1' }, body: consentBody() });

    expect(reply.statusCode).toBe(400);
    expect(bodyOf(reply).error).toBe('INVALID_REFERENCE');
  });

  it('500 INTERNAL_SERVER_ERROR for an unmapped PG code', async () => {
    createItemInternal.mockRejectedValue(
      new FakeDrizzleQueryError(new FakeDatabaseError('23514'))
    );

    const reply = await call({ user: { id: 'u1' }, body: consentBody() });

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('INTERNAL_SERVER_ERROR');
    expect(log.error).toHaveBeenCalled();
  });

  it('500 INTERNAL_SERVER_ERROR for a DrizzleQueryError whose cause is not a DatabaseError', async () => {
    createItemInternal.mockRejectedValue(
      new FakeDrizzleQueryError(new Error('socket closed'))
    );

    const reply = await call({ user: { id: 'u1' }, body: consentBody() });

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('INTERNAL_SERVER_ERROR');
  });

  it('500 INTERNAL_SERVER_ERROR when the transaction itself fails (catch-all)', async () => {
    dbState.txFailWith = new Error('deadlock detected');

    const reply = await call({ user: { id: 'u1' }, body: consentBody() });

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('INTERNAL_SERVER_ERROR');
    expect(bodyOf(reply).message).toBe('Failed to create item');
  });

  it('500 INTERNAL_SERVER_ERROR when publishing the item event throws after commit', async () => {
    publishItemEvent.mockRejectedValue(new Error('kafka down'));

    const reply = await call({ user: { id: 'u1' }, body: consentBody() });

    expect(reply.statusCode).toBe(500);
    expect(bodyOf(reply).error).toBe('INTERNAL_SERVER_ERROR');
  });

  it('lets a domain-lock lookup rejection escape unmapped (pre-try/catch)', async () => {
    dbState.failWith = new Error('db down');

    // The lookup happens BEFORE the try/catch, so this rejection escapes the
    // handler rather than being mapped to a response body.
    await expect(
      call({ user: { id: 'u1' }, body: consentBody() })
    ).rejects.toThrow('db down');
  });
});
