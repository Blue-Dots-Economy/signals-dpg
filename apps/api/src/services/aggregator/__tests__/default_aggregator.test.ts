/**
 * Unit tests for default-aggregator resolution + tagging (SS-3, #640).
 *
 * The column these functions read decides who may decrypt an inbound
 * population's PII, so the behaviours pinned here are the safety ones:
 * fail-closed on ambiguity, write-once tagging, and "no default configured" as
 * a normal state rather than an error.
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
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  // The org lookup goes through `db.execute` (one shared SQL definition used by
  // the API and the ops scripts); the user lookup uses the query builder.
  const execute = vi.fn(() => Promise.resolve({ rows: dbState.orgRows }));
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
  resolveDefaultAggregator,
  tagUserWithDefaultAggregator,
  resolveOwnerGateContext,
} = await import('../default_aggregator.js');

const logMock = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
const log = logMock as unknown as NonNullable<Parameters<typeof resolveDefaultAggregator>[3]>;

beforeEach(() => {
  dbState.orgRows = [];
  dbState.userRows = [];
  dbState.updateReturns = [];
  dbState.updates = [];
  vi.clearAllMocks();
});

describe('resolveDefaultAggregator', () => {
  it('reports no default when nothing claims the binding', () => {
    dbState.orgRows = [];
    return expect(resolveDefaultAggregator(db, 'blue_dot', 'seeker', log)).resolves.toEqual({
      org_id: null,
      configured: false,
    });
  });

  it('returns the single claimant', () => {
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(resolveDefaultAggregator(db, 'blue_dot', 'seeker', log)).resolves.toEqual({
      org_id: 'org_agg_1',
      configured: true,
    });
  });

  // Postgres cannot unique-index an array element, so a directly-edited row can
  // produce two claimants. Picking one would hand PII rights to a coin flip.
  it('fails closed and logs when two orgs claim the same binding', async () => {
    dbState.orgRows = [{ id: 'org_agg_1' }, { id: 'org_agg_2' }];
    await expect(resolveDefaultAggregator(db, 'blue_dot', 'seeker', log)).resolves.toEqual({
      org_id: null,
      configured: false,
    });
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });
});

describe('tagUserWithDefaultAggregator', () => {
  it('writes the tag and the server-only default marker', async () => {
    dbState.orgRows = [{ id: 'org_agg_1' }];
    dbState.updateReturns = [{ id: 'user_1' }];

    await expect(
      tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker', log),
    ).resolves.toBe('org_agg_1');

    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      onboardedByOrgId: 'org_agg_1',
      onboardedByDefault: true,
    });
  });

  it('writes nothing when no default is configured', async () => {
    dbState.orgRows = [];
    await expect(
      tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker', log),
    ).resolves.toBeNull();
    expect(dbState.updates).toHaveLength(0);
  });

  // The IS NULL predicate lives in the WHERE clause, so an already-tagged user
  // matches no rows: moving someone between aggregators stays an explicit,
  // audited operation.
  it('reports null when the guarded UPDATE matched no rows', async () => {
    dbState.orgRows = [{ id: 'org_agg_1' }];
    dbState.updateReturns = [];
    await expect(
      tagUserWithDefaultAggregator(db, 'user_1', 'blue_dot', 'seeker', log),
    ).resolves.toBeNull();
  });
});

describe('resolveOwnerGateContext', () => {
  it('reports an owned user with a configured default', () => {
    dbState.userRows = [{ onboardedByOrgId: 'org_agg_1' }];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(
      resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker', log),
    ).resolves.toEqual({ has_owner: true, default_configured: true });
  });

  it('reports an unowned user', () => {
    dbState.userRows = [{ onboardedByOrgId: null }];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(
      resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker', log),
    ).resolves.toEqual({ has_owner: false, default_configured: true });
  });

  it('reports default_configured=false so the gate stays inert pre-launch', () => {
    dbState.userRows = [{ onboardedByOrgId: null }];
    dbState.orgRows = [];
    return expect(
      resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker', log),
    ).resolves.toEqual({ has_owner: false, default_configured: false });
  });

  it('treats a missing user row as unowned (fail closed)', () => {
    dbState.userRows = [];
    dbState.orgRows = [{ id: 'org_agg_1' }];
    return expect(
      resolveOwnerGateContext(db, 'user_1', 'blue_dot', 'seeker', log),
    ).resolves.toEqual({ has_owner: false, default_configured: true });
  });
});
