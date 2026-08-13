import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// `fetch_events_handler` is not exported, so the plugin is registered against a
// fake fastify and the captured route handler is invoked directly.
//
// The handler runs TWO queries off the same where-clause: a `count(*)` select
// (awaited straight off `.where()`) and the page select (which chains
// `.orderBy().limit().offset()`). `dbState.calls` records both so filter and
// pagination branches can be asserted on the real arguments.
const { dbState } = vi.hoisted(() => ({
  dbState: {
    countRows: [] as unknown[],
    rows: [] as unknown[],
    // Resettable failure flag — never monkey-patch a shared queue, the
    // override would leak into every later test in the file.
    failWith: null as Error | null,
    calls: [] as {
      count: boolean;
      where: unknown;
      orderBy?: unknown;
      limit?: number;
      offset?: number;
    }[],
  },
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: (fields?: unknown) => ({
      from: () => ({
        where: (clause: unknown) => {
          const call = { count: fields !== undefined, where: clause } as {
            count: boolean;
            where: unknown;
            orderBy?: unknown;
            limit?: number;
            offset?: number;
          };
          dbState.calls.push(call);

          const settle = () =>
            dbState.failWith
              ? Promise.reject(dbState.failWith)
              : Promise.resolve(call.count ? dbState.countRows : dbState.rows);

          // A thenable: the count query awaits `.where(...)` directly while the
          // page query chains first. BOTH callbacks must be forwarded —
          // dropping `rej` makes a rejected query hang until the test timeout.
          const chain = {
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              settle().then(res, rej),
            orderBy: (o: unknown) => {
              call.orderBy = o;
              return chain;
            },
            limit: (n: number) => {
              call.limit = n;
              return chain;
            },
            offset: (n: number) => {
              call.offset = n;
              return chain;
            },
          };

          return chain;
        },
      }),
    }),
  },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: (strings: TemplateStringsArray) => ({ op: 'sql', text: strings.join('') }),
}));

vi.mock('@dpg/database', () => ({
  action_events: {
    action_id: 'ae.action_id',
    action_type: 'ae.action_type',
    action_status: 'ae.action_status',
    update_count: 'ae.update_count',
    source_item_id: 'ae.source_item_id',
    target_item_id: 'ae.target_item_id',
    source_item_owner: 'ae.source_item_owner',
    target_item_owner: 'ae.target_item_owner',
    created_at: 'ae.created_at',
  },
}));

vi.mock('@dpg/schemas', () => ({
  default: { object: () => ({}), number: () => ({}) },
  FetchOwnedEventsQuerySchema: { __schema: 'FetchOwnedEventsQuerySchema' },
  OwnedActionEventSchema: { array: () => ({ __schema: 'OwnedActionEvent[]' }) },
}));

import { fetch_events } from '../fetch_events';

// --- fakes -----------------------------------------------------------------
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

interface CapturedRoute {
  url: string;
  method: string;
  preHandler: unknown;
  schema: { query: unknown; response: Record<string, unknown>; tags: string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (req: any, reply: FakeReply) => Promise<unknown>;
}

let route: CapturedRoute;

const log = { error: vi.fn() };

type Query = {
  ownership_role: 'all' | 'initiated' | 'received';
  limit: number;
  offset: number;
  action_id?: string;
  action_type?: string;
  action_status?: string;
  item_id?: string;
  update_count?: number;
};

function q(partial: Partial<Query> = {}): Query {
  return { ownership_role: 'all', limit: 20, offset: 0, ...partial };
}

function call(user: { id: string } | undefined, query: Query) {
  const reply = makeReply();
  return route.handler({ log, user, query }, reply).then(() => reply);
}

// where-clause introspection ------------------------------------------------
type Cond =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'or'; args: Cond[] }
  | { op: 'and'; args: Cond[] };

function describeCond(c: Cond): string {
  if (c.op === 'eq') return `eq(${c.col},${String(c.val)})`;
  return `${c.op}(${c.args.map(describeCond).join('|')})`;
}

/** The top-level conditions the handler pushed, in order. */
function conditionsOf(where: unknown): string[] {
  const c = where as Cond;
  return c.op === 'and' ? c.args.map(describeCond) : [describeCond(c)];
}

beforeAll(async () => {
  const register = fetch_events as unknown as (fastify: {
    route: (c: CapturedRoute) => void;
  }) => Promise<void>;

  await register({
    route: (c) => {
      route = c;
    },
  });
});

beforeEach(() => {
  dbState.countRows = [{ count: 0 }];
  dbState.rows = [];
  dbState.failWith = null;
  dbState.calls.length = 0;
  vi.clearAllMocks();
});

describe('fetch_events route registration', () => {
  it('registers GET /fetch behind auth with the query schema (validation is delegated to fastify)', () => {
    expect(route.url).toBe('/fetch');
    expect(route.method).toBe('GET');
    // A missing preHandler here would make the route unauthenticated: the
    // event group has no group-level auth hook.
    expect(route.preHandler).toBeTypeOf('function');
    // The 400s for a bad `limit`/`item_id` come from this schema, not the
    // handler — so the handler never re-validates.
    expect(route.schema.query).toEqual({
      __schema: 'FetchOwnedEventsQuerySchema',
    });
    expect(route.schema.tags).toEqual(['event']);
    // The 200 body is schema-constrained, so a missing ownership tag would be
    // a serialization error rather than a silently thinner payload.
    expect(route.schema.response[200]).toBeDefined();
  });
});

describe('fetch_events handler — auth', () => {
  it('401 UNAUTHORIZED when there is no authenticated user, without querying', async () => {
    const reply = await call(undefined, q());

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to fetch events',
    });
    expect(dbState.calls).toHaveLength(0);
  });
});

describe('fetch_events handler — happy path', () => {
  it('returns meta plus events and tags ownership_roles from both owner columns', async () => {
    const created = new Date('2026-01-02T03:04:05.000Z');
    dbState.countRows = [{ count: 3 }];
    dbState.rows = [
      {
        action_id: 'a1',
        source_item_owner: 'u1',
        target_item_owner: 'u1',
        created_at: created,
      },
      {
        action_id: 'a2',
        source_item_owner: 'u1',
        target_item_owner: 'other',
        created_at: created,
      },
      {
        action_id: 'a3',
        source_item_owner: 'other',
        target_item_owner: 'u1',
        created_at: created,
      },
    ];

    const reply = await call({ id: 'u1' }, q({ limit: 20, offset: 0 }));

    expect(reply.statusCode).toBe(200);
    const body = reply.body as {
      meta: { total: number; limit: number; offset: number };
      events: { action_id: string; ownership_roles: string[] }[];
    };
    expect(body.meta).toEqual({ total: 3, limit: 20, offset: 0 });
    expect(body.events.map((e) => e.ownership_roles)).toEqual([
      ['initiated', 'received'],
      ['initiated'],
      ['received'],
    ]);
    // Row fields are passed through untouched.
    expect(body.events[0]).toMatchObject({ action_id: 'a1', created_at: created });
  });

  it('coerces a string created_at into a Date and a string count into a number', async () => {
    dbState.countRows = [{ count: '7' }];
    dbState.rows = [
      {
        action_id: 'a1',
        source_item_owner: 'u1',
        target_item_owner: null,
        created_at: '2026-01-02T03:04:05.000Z',
      },
    ];

    const reply = await call({ id: 'u1' }, q());

    const body = reply.body as {
      meta: { total: number };
      events: { created_at: Date }[];
    };
    expect(body.meta.total).toBe(7);
    expect(typeof body.meta.total).toBe('number');
    expect(body.events[0].created_at).toBeInstanceOf(Date);
    expect(body.events[0].created_at.toISOString()).toBe(
      '2026-01-02T03:04:05.000Z'
    );
  });

  it('returns an empty event list with the real total when the page is past the end', async () => {
    dbState.countRows = [{ count: 12 }];
    dbState.rows = [];

    const reply = await call({ id: 'u1' }, q({ limit: 5, offset: 50 }));

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({
      meta: { total: 12, limit: 5, offset: 50 },
      events: [],
    });
  });
});

describe('fetch_events handler — pagination', () => {
  it('forwards limit/offset to the page query only, ordered by created_at desc, and echoes them', async () => {
    const reply = await call({ id: 'u1' }, q({ limit: 5, offset: 10 }));

    const [countCall, pageCall] = dbState.calls;
    expect(dbState.calls).toHaveLength(2);
    expect(countCall.count).toBe(true);
    expect(countCall.limit).toBeUndefined();
    expect(countCall.offset).toBeUndefined();
    expect(pageCall.limit).toBe(5);
    expect(pageCall.offset).toBe(10);
    expect(pageCall.orderBy).toEqual({ op: 'desc', col: 'ae.created_at' });
    // Total is the unpaginated count, so both queries share one where-clause.
    expect(pageCall.where).toEqual(countCall.where);
    expect((reply.body as { meta: unknown }).meta).toEqual({
      total: 0,
      limit: 5,
      offset: 10,
    });
  });
});

describe('fetch_events handler — ownership scoping', () => {
  it("ownership_role 'all' scopes to either owner column via OR", async () => {
    await call({ id: 'u1' }, q());

    expect(conditionsOf(dbState.calls[0].where)).toEqual([
      'or(eq(ae.source_item_owner,u1)|eq(ae.target_item_owner,u1))',
    ]);
  });

  it("ownership_role 'initiated' narrows both the owner and the item column to the source side", async () => {
    await call(
      { id: 'u1' },
      q({ ownership_role: 'initiated', item_id: 'item-1' })
    );

    expect(conditionsOf(dbState.calls[0].where)).toEqual([
      'eq(ae.source_item_id,item-1)',
      'eq(ae.source_item_owner,u1)',
    ]);
  });

  it("ownership_role 'received' narrows both to the target side", async () => {
    await call(
      { id: 'u1' },
      q({ ownership_role: 'received', item_id: 'item-1' })
    );

    expect(conditionsOf(dbState.calls[0].where)).toEqual([
      'eq(ae.target_item_id,item-1)',
      'eq(ae.target_item_owner,u1)',
    ]);
  });

  it("an item_id with ownership_role 'all' matches the item on either side", async () => {
    await call({ id: 'u1' }, q({ item_id: 'item-1' }));

    expect(conditionsOf(dbState.calls[0].where)).toEqual([
      'or(eq(ae.source_item_id,item-1)|eq(ae.target_item_id,item-1))',
      'or(eq(ae.source_item_owner,u1)|eq(ae.target_item_owner,u1))',
    ]);
  });
});

describe('fetch_events handler — filters', () => {
  it('applies every optional filter when supplied', async () => {
    await call(
      { id: 'u1' },
      q({
        action_id: 'act-1',
        action_type: 'application',
        action_status: 'accepted',
        update_count: 4,
      })
    );

    expect(conditionsOf(dbState.calls[0].where)).toEqual([
      'eq(ae.action_id,act-1)',
      'eq(ae.action_type,application)',
      'eq(ae.action_status,accepted)',
      'eq(ae.update_count,4)',
      'or(eq(ae.source_item_owner,u1)|eq(ae.target_item_owner,u1))',
    ]);
  });

  it('filters on update_count 0 (checked against undefined, not falsiness)', async () => {
    await call({ id: 'u1' }, q({ update_count: 0 }));

    expect(conditionsOf(dbState.calls[0].where)).toEqual([
      'eq(ae.update_count,0)',
      'or(eq(ae.source_item_owner,u1)|eq(ae.target_item_owner,u1))',
    ]);
  });

  it('drops empty-string filters rather than matching on them', async () => {
    await call(
      { id: 'u1' },
      q({ action_id: '', action_type: '', action_status: '', item_id: '' })
    );

    expect(conditionsOf(dbState.calls[0].where)).toEqual([
      'or(eq(ae.source_item_owner,u1)|eq(ae.target_item_owner,u1))',
    ]);
  });
});

describe('fetch_events handler — failures', () => {
  it('500 INTERNAL_SERVER_ERROR and logs when a query throws', async () => {
    dbState.failWith = new Error('db down');

    const reply = await call({ id: 'u1' }, q({ action_type: 'application' }));

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch events',
    });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        query: expect.objectContaining({ action_type: 'application' }),
      }),
      'Failed to fetch events'
    );
  });

  it('500 when the count query returns no row (destructuring an empty result)', async () => {
    dbState.countRows = [];

    const reply = await call({ id: 'u1' }, q());

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe(
      'INTERNAL_SERVER_ERROR'
    );
    // The page query is never reached.
    expect(dbState.calls).toHaveLength(1);
  });
});
