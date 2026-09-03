/**
 * Route tests for POST /api/v1/admin/aggregator/default (SS-3, #640).
 *
 * The endpoint exists instead of a hand-written UPDATE because the column it
 * writes grants PII-decrypt rights over an entire inbound population. So the
 * behaviours pinned here are the ones raw SQL could not give us: the
 * network-service guard, validation of the org and the bindings, exclusivity
 * (one default per binding), and an audit row per actual change.
 *
 * Mounted in isolation with a stubbed `acting_org`, same approach as
 * `upsert.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

const dbState = {
  /** The org named by `org_id`. */
  target: null as { id: string; type: string | null; metadata: string | null } | null,
  /** Every org currently holding any binding. */
  holders: [] as Array<{ id: string; bindings: string[] | null }>,
  served: ['blue_dot/seeker', 'blue_dot/provider'] as string[],
  declaredDomains: [] as string[],
  updates: [] as Array<{ set: Record<string, unknown> }>,
  audits: [] as Array<Record<string, unknown>>,
  /** When set, db.transaction rejects with it. */
  transactionError: null as unknown,
};

vi.mock('@/utils/org_metadata', () => ({
  readConfiguredDomains: () => Promise.resolve(dbState.declaredDomains),
}));

vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: (network: string, domain: string) =>
    dbState.served.includes(`${network}/${domain}`),
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const makeSelect = () =>
    vi.fn(() => ({
      from: vi.fn(() => ({
        // Holder scan: `.where(...)` with no `.limit()`, awaited directly.
        where: vi.fn(() => {
          const chain = Promise.resolve(dbState.holders) as Promise<unknown> & {
            limit?: unknown;
          };
          chain.limit = vi.fn(() => Promise.resolve(dbState.target ? [dbState.target] : []));
          return chain;
        }),
      })),
    }));

  const makeUpdate = () =>
    vi.fn(() => ({
      set: vi.fn((set: Record<string, unknown>) => ({
        where: vi.fn(() => {
          dbState.updates.push({ set });
          return Promise.resolve();
        }),
      })),
    }));

  const makeInsert = () =>
    vi.fn(() => ({
      values: vi.fn((rows: Record<string, unknown> | Record<string, unknown>[]) => {
        dbState.audits.push(...(Array.isArray(rows) ? rows : [rows]));
        return Promise.resolve();
      }),
    }));

  // `execute` covers the advisory lock the handler takes first.
  const execute = vi.fn(() => Promise.resolve({ rows: [] }));
  const tx = { select: makeSelect(), update: makeUpdate(), insert: makeInsert(), execute };

  return {
    db: {
      select: makeSelect(),
      update: makeUpdate(),
      insert: makeInsert(),
      execute,
      transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => {
        if (dbState.transactionError) throw dbState.transactionError;
        return cb(tx);
      }),
    },
  };
});

const { aggregator_default } = await import('../default.js');

const buildApp = async (
  acting: { org_type?: 'aggregator' | 'voice' | 'network_service' } = {},
) => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { acting_org: unknown }).acting_org = {
      org_id: 'org_network_service',
      org_type: acting.org_type ?? 'network_service',
      service_user_id: 'svc_test',
    };
    (req as unknown as { user: unknown }).user = { id: 'svc_user_1' };
  });
  await app.register(aggregator_default);
  return app;
};

const post = async (
  payload: unknown,
  acting?: { org_type?: 'aggregator' | 'voice' | 'network_service' },
) => {
  const app = await buildApp(acting);
  return app.inject({ method: 'POST', url: '/aggregator/default', payload: payload as object });
};

const AGG = { id: 'org_agg_1', type: 'aggregator', metadata: null };

beforeEach(() => {
  dbState.target = { ...AGG };
  dbState.holders = [];
  dbState.served = ['blue_dot/seeker', 'blue_dot/provider'];
  dbState.declaredDomains = [];
  dbState.updates = [];
  dbState.audits = [];
  dbState.transactionError = null;
});

describe('POST /aggregator/default — guards', () => {
  it('rejects a caller that is not the network service', async () => {
    const res = await post(
      { org_id: 'org_agg_1', bindings: ['blue_dot/seeker'] },
      { org_type: 'aggregator' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_NETWORK_SERVICE');
  });

  it('rejects a binding this instance does not serve', async () => {
    const res = await post({ org_id: 'org_agg_1', bindings: ['purple_dot/seeker'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('UNSERVED_DOMAIN_BINDING');
    expect(dbState.updates).toHaveLength(0);
  });

  it('rejects a malformed binding at the schema boundary', async () => {
    const res = await post({ org_id: 'org_agg_1', bindings: ['seeker'] });
    expect(res.statusCode).toBe(400);
  });

  it('404s for an unknown org', async () => {
    dbState.target = null;
    const res = await post({ org_id: 'org_missing', bindings: ['blue_dot/seeker'] });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('ORG_NOT_FOUND');
  });

  // The CHECK constraint enforces this in the database too; rejecting here
  // gives a usable error instead of a 23514.
  it('rejects a non-aggregator org', async () => {
    dbState.target = { id: 'org_ns', type: 'network_service', metadata: null };
    const res = await post({ org_id: 'org_ns', bindings: ['blue_dot/seeker'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_AN_AGGREGATOR');
  });

  it("rejects a domain the org itself does not declare", async () => {
    dbState.declaredDomains = ['seeker'];
    const res = await post({ org_id: 'org_agg_1', bindings: ['blue_dot/provider'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('DOMAIN_NOT_DECLARED');
  });

  it('skips the declared-domain check when the org declares none (legacy mirror)', async () => {
    dbState.declaredDomains = [];
    const res = await post({ org_id: 'org_agg_1', bindings: ['blue_dot/provider'] });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /aggregator/default — writes', () => {
  it('sets the bindings and writes one audit row per binding', async () => {
    const res = await post({
      org_id: 'org_agg_1',
      bindings: ['blue_dot/seeker', 'blue_dot/provider'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      org_id: 'org_agg_1',
      bindings: ['blue_dot/seeker', 'blue_dot/provider'],
      cleared_from: [],
      revoked: [],
    });
    expect(dbState.audits).toHaveLength(2);
    expect(dbState.audits[0]).toMatchObject({
      binding: 'blue_dot/seeker',
      fromOrgId: null,
      toOrgId: 'org_agg_1',
      changedBy: 'svc_user_1',
    });
  });

  // Exclusivity is what makes "one default per binding" true — Postgres cannot
  // unique-index an array element, so the endpoint has to do it.
  it('takes the binding off the previous holder and records it as from_org_id', async () => {
    dbState.holders = [
      { id: 'org_agg_old', bindings: ['blue_dot/seeker', 'blue_dot/provider'] },
    ];

    const res = await post({ org_id: 'org_agg_1', bindings: ['blue_dot/seeker'] });

    expect(res.statusCode).toBe(200);
    expect(res.json().cleared_from).toEqual([
      { org_id: 'org_agg_old', binding: 'blue_dot/seeker' },
    ]);
    // The old holder keeps the binding it was not asked to give up.
    expect(dbState.updates[0].set).toEqual({ defaultForBindings: ['blue_dot/provider'] });
    expect(dbState.audits).toHaveLength(1);
    expect(dbState.audits[0]).toMatchObject({
      binding: 'blue_dot/seeker',
      fromOrgId: 'org_agg_old',
      toOrgId: 'org_agg_1',
    });
  });

  it('nulls the column rather than leaving an empty array', async () => {
    dbState.holders = [{ id: 'org_agg_old', bindings: ['blue_dot/seeker'] }];
    await post({ org_id: 'org_agg_1', bindings: ['blue_dot/seeker'] });
    expect(dbState.updates[0].set).toEqual({ defaultForBindings: null });
  });

  // Standing an aggregator down is the most consequential thing this endpoint
  // does; auditing only additions left it with no trace at all.
  it('clears every binding when sent an empty list, and audits the revocation', async () => {
    dbState.holders = [{ id: 'org_agg_1', bindings: ['blue_dot/seeker'] }];
    const res = await post({ org_id: 'org_agg_1', bindings: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json().bindings).toEqual([]);
    expect(res.json().revoked).toEqual(['blue_dot/seeker']);
    expect(dbState.updates.at(-1)?.set).toEqual({ defaultForBindings: null });
    expect(dbState.audits).toHaveLength(1);
    expect(dbState.audits[0]).toMatchObject({
      binding: 'blue_dot/seeker',
      fromOrgId: 'org_agg_1',
      toOrgId: null,
    });
  });

  it('reports and audits a binding silently dropped by a partial replace', async () => {
    dbState.holders = [
      { id: 'org_agg_1', bindings: ['blue_dot/seeker', 'blue_dot/provider'] },
    ];
    const res = await post({ org_id: 'org_agg_1', bindings: ['blue_dot/provider'] });
    expect(res.statusCode).toBe(200);
    // seeker is left with NO default — the caller must be able to see that.
    expect(res.json().revoked).toEqual(['blue_dot/seeker']);
    expect(dbState.audits).toHaveLength(1);
    expect(dbState.audits[0]).toMatchObject({ binding: 'blue_dot/seeker', toOrgId: null });
  });

  it('is a no-op audit-wise when the org already holds the binding', async () => {
    dbState.holders = [{ id: 'org_agg_1', bindings: ['blue_dot/seeker'] }];
    const res = await post({ org_id: 'org_agg_1', bindings: ['blue_dot/seeker'] });
    expect(res.statusCode).toBe(200);
    expect(dbState.audits).toHaveLength(0);
  });

  it('de-duplicates repeated bindings in the request', async () => {
    const res = await post({
      org_id: 'org_agg_1',
      bindings: ['blue_dot/seeker', 'blue_dot/seeker'],
    });
    expect(res.json().bindings).toEqual(['blue_dot/seeker']);
    expect(dbState.audits).toHaveLength(1);
  });
});

describe('POST /aggregator/default — failure paths', () => {
  // An audit row attributed to nobody defeats the point of having one.
  it('refuses to write when the caller has no resolvable user id', async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addHook('preHandler', async (req) => {
      (req as unknown as { acting_org: unknown }).acting_org = {
        org_id: 'org_network_service',
        org_type: 'network_service',
        service_user_id: 'svc_test',
      };
    });
    await app.register(aggregator_default);

    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/default',
      payload: { org_id: 'org_agg_1', bindings: ['blue_dot/seeker'] },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('ACTOR_UNRESOLVED');
    expect(dbState.audits).toHaveLength(0);
  });

  // The database now guarantees at most one default; the endpoint turns that
  // guarantee into a usable conflict rather than a 500.
  it('maps the single-default unique violation to 409', async () => {
    dbState.transactionError = Object.assign(new Error('dup'), {
      cause: { code: '23505', constraint: 'organization_single_default_idx' },
    });
    const res = await post({ org_id: 'org_agg_1', bindings: ['blue_dot/seeker'] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DEFAULT_ALREADY_SET');
  });

  it('maps the CHECK violation to 400, unwrapping drizzle\'s cause', async () => {
    dbState.transactionError = Object.assign(new Error('check'), {
      cause: { code: '23514' },
    });
    const res = await post({ org_id: 'org_agg_1', bindings: ['blue_dot/seeker'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_AN_AGGREGATOR');
  });

  // A raw pg error's text can carry the failed SQL and its bound params.
  it('never surfaces a raw database error', async () => {
    dbState.transactionError = new Error(
      'duplicate key value violates unique constraint "x" DETAIL: Key (id)=(org_secret)',
    );
    const res = await post({ org_id: 'org_agg_1', bindings: ['blue_dot/seeker'] });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('DEFAULT_AGGREGATOR_WRITE_FAILED');
    expect(res.json().message).not.toContain('org_secret');
  });
});
