/**
 * Unit tests for default-aggregator resolution + tagging (SS-3, #640).
 *
 * The column these functions read decides who may decrypt an inbound
 * population's PII, so the behaviours pinned here are the safety ones: the
 * write-once tagging, and "no default nominated" as a normal state. Defaults
 * are per binding, so a seeker aggregator and a provider aggregator coexist;
 * the exclusivity trigger stops two orgs claiming the same binding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbState = {
  /** Rows the org lookup returns — length drives the 0 / 1 / 2+ branches. */
  orgRows: [] as Array<{ id: string }>,
  /** Rows the user lookup returns. */
  userRows: [] as Array<{ onboardedByOrgId: string | null }>,
  /** Rows the tagging UPDATE ... RETURNING reports as written. */
  updateReturns: [] as Array<{ id: string }>,
  updates: [] as Array<Record<string, unknown>>,
  /** Every SQL object handed to `execute`, so we can assert on the query. */
  executed: [] as unknown[],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  const execute = vi.fn((query: unknown) => {
    dbState.executed.push(query);
    return Promise.resolve({ rows: dbState.orgRows });
  });
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(dbState.userRows)),
      })),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => {
          dbState.updates.push(values);
          return Promise.resolve(dbState.updateReturns);
        }),
      })),
    })),
  }));
  return { db: { select, update, execute } };
});

const { db } = await import('@api/db/postgres/drizzle_config');
const {
  bindingKey,
  defaultAggregatorQuery,
  resolveDefaultAggregator,
  tagUserWithDefaultAggregator,
  resolveOwnerGateContext,
} = await import('../default_aggregator.js');

beforeEach(() => {
  dbState.orgRows = [];
  dbState.userRows = [];
  dbState.updateReturns = [];
  dbState.updates = [];
  dbState.executed = [];
  vi.clearAllMocks();
});

describe('bindingKey', () => {
  it('is network-qualified, matching served_domain_guard', () => {
    expect(bindingKey('blue_dot', 'seeker')).toBe('blue_dot/seeker');
  });
});

describe('defaultAggregatorQuery', () => {
  // Both halves matter: without the `&&` overlap the query would return any
  // default (handing a provider signup to the seeker aggregator), and without
  // `type = 'aggregator'` a network_service org could own an inbound population.
  it('filters to the aggregator holding THIS binding', () => {
    const rendered = JSON.stringify(defaultAggregatorQuery('blue_dot/seeker'));
    expect(rendered).toContain('default_for_bindings &&');
    expect(rendered).toContain('blue_dot/seeker');
    expect(rendered).toContain("type = 'aggregator'");
    expect(rendered).toContain('LIMIT 1');
  });
});

describe('resolveDefaultAggregator', () => {
  it('runs the shared query and applies the rule', async () => {
    dbState.orgRows = [{ id: 'org_agg_1' }];
    await expect(resolveDefaultAggregator(db, 'blue_dot', 'seeker')).resolves.toEqual({ org_id: 'org_agg_1' });
    expect(dbState.executed).toHaveLength(1);
  });

});

describe('tagUserWithDefaultAggregator', () => {
  it('writes the tag and the server-only default marker', async () => {
    dbState.orgRows = [{ id: 'org_agg_1' }];
    dbState.updateReturns = [{ id: 'user_1' }];

    const result = await tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker');
    expect(result.tagged).toBe(true);
    expect(result.resolution).toEqual({ org_id: 'org_agg_1' });

    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      onboardedByOrgId: 'org_agg_1',
      onboardedByDefault: true,
    });
  });

  // A participant onboarded months ago already carries a real onboarded_at.
  // Overwriting it would make a dormant user resurface as brand new in
  // item_metrics.age_days / profile_status.
  // The tagging basis (#640's last AC). Portal self-signup has no other
  // writer for this column, so without it the basis is only half recorded.
  it("records the basis as 'self', without clobbering an existing via", async () => {
    dbState.orgRows = [{ id: 'org_agg_1' }];
    dbState.updateReturns = [{ id: 'user_1' }];
    await tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker');
    // A coalesce expression, not the literal 'self' — a cold-voice user tagged
    // later must keep via='voice'.
    expect(dbState.updates[0].onboardedVia).not.toBe('self');
    expect(dbState.updates[0].onboardedVia).toHaveProperty('queryChunks');
  });

  it('preserves an existing onboarded_at instead of stamping now()', async () => {
    dbState.orgRows = [{ id: 'org_agg_1' }];
    dbState.updateReturns = [{ id: 'user_1' }];
    await tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker');
    // A plain Date here would overwrite the genuine join date; it must be a SQL
    // expression (coalesce) so an earlier value survives.
    expect(dbState.updates[0].onboardedAt).not.toBeInstanceOf(Date);
    expect(dbState.updates[0].onboardedAt).toHaveProperty('queryChunks');
  });

  it('writes nothing when no default is nominated', async () => {
    dbState.orgRows = [];
    const result = await tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker');
    expect(result).toEqual({ resolution: { org_id: null }, tagged: false });
    expect(dbState.updates).toHaveLength(0);
  });


  // The IS NULL predicate lives in the WHERE, so an already-tagged user matches
  // no rows: moving someone between aggregators stays explicit and audited.
  it('reports tagged=false when the guarded UPDATE matched no rows', async () => {
    dbState.orgRows = [{ id: 'org_agg_1' }];
    dbState.updateReturns = [];
    const result = await tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker');
    expect(result.tagged).toBe(false);
    expect(result.resolution.org_id).toBe('org_agg_1');
  });
});

describe('resolveOwnerGateContext', () => {
  it('reports an owned user with a resolved default', () => {
    dbState.userRows = [{ onboardedByOrgId: 'org_agg_1' }];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker')).resolves.toEqual({
      has_owner: true,
      default_configured: true,
    });
  });

  it('reports an unowned user', () => {
    dbState.userRows = [{ onboardedByOrgId: null }];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker')).resolves.toEqual({
      has_owner: false,
      default_configured: true,
    });
  });

  it('reports none so the gate stays inert pre-launch', () => {
    dbState.userRows = [{ onboardedByOrgId: null }];
    dbState.orgRows = [];
    return expect(resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker')).resolves.toEqual({
      has_owner: false,
      default_configured: false,
    });
  });


  it('treats a missing user row as unowned (fail closed)', () => {
    dbState.userRows = [];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker')).resolves.toEqual({
      has_owner: false,
      default_configured: true,
    });
  });

  // The tag write already resolved the default; reusing it keeps a gated
  // profile write at one `organization` read instead of two.
  it('reuses a known resolution instead of re-querying', async () => {
    dbState.userRows = [{ onboardedByOrgId: 'org_agg_1' }];
    const ctx = await resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker', { org_id: 'org_agg_1' });
    expect(ctx).toEqual({ has_owner: true, default_configured: true });
    expect(dbState.executed).toHaveLength(0);
  });
});
