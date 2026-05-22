import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the db before importing the SUT. The recompute path does:
//
//   1. db.execute(sql) → returns { rows: [...] }
//   2. db.insert(table).values(rows).onConflictDoUpdate({...}) → upserts
//
// dbState.users seeds the execute() result; dbState.upserts captures every
// batch handed to flush() so the test can assert batching + payload shape.
// ---------------------------------------------------------------------------

interface UserRow {
  user_id: string;
  created_at: Date;
  updated_at: Date;
  onboarded_by_org_id: string | null;
  onboarded_via: string | null;
  profile_state: Record<string, unknown> | null;
  profile_created_at: Date | null;
  profile_last_updated_at: Date | null;
  applications_total: number;
  applications_pending: number;
  applications_accepted: number;
  applications_rejected: number;
}

const dbState: {
  users: UserRow[];
  upserts: Array<Array<Record<string, unknown>>>;
} = {
  users: [],
  upserts: [],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  const db = {
    execute: vi.fn(async () => ({ rows: dbState.users })),
    insert: vi.fn(() => ({
      values: vi.fn((rows: Array<Record<string, unknown>>) => ({
        onConflictDoUpdate: vi.fn(async () => {
          dbState.upserts.push(rows);
        }),
      })),
    })),
  };
  return { db };
});

const fixed_schema = {
  type: 'object' as const,
  required: ['Full Name', 'Phone Number'],
  properties: {
    'Full Name': { type: 'string' as const },
    'Phone Number': { type: 'string' as const },
    'Email Address': { type: 'string' as const }, // optional
    'Grade': { type: 'string' as const },         // optional
  },
};

vi.mock('../schema_lookup.js', () => ({
  get_schema_for_aggregator: vi.fn(async () => ({
    schema: fixed_schema,
    network: 'yellow_dot',
    domain: 'student',
    item_type: 'profile_1.0',
  })),
}));

// Import AFTER mocks are registered.
const { recompute_aggregator_metrics } = await import('../recompute.js');

const NOW = new Date('2026-05-22T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

beforeEach(() => {
  dbState.users = [];
  dbState.upserts = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe('recompute_aggregator_metrics', () => {
  it('returns processed=0 and writes no upsert when the aggregator has no users', async () => {
    const result = await recompute_aggregator_metrics('agg-empty');
    expect(result.processed).toBe(0);
    expect(dbState.upserts).toEqual([]);
  });

  it('writes per-user metrics for a mixed-state fixture', async () => {
    dbState.users = [
      // U1 — new: profile 3 days old, no apps
      {
        user_id: 'u1',
        created_at: daysAgo(3),
        updated_at: daysAgo(3),
        onboarded_by_org_id: 'agg-1',
        onboarded_via: 'voice',
        profile_state: { 'Full Name': 'Alice' },
        profile_created_at: daysAgo(3),
        profile_last_updated_at: daysAgo(3),
        applications_total: 0,
        applications_pending: 0,
        applications_accepted: 0,
        applications_rejected: 0,
      },
      // U2 — satisfied: has an accepted application
      {
        user_id: 'u2',
        created_at: daysAgo(60),
        updated_at: daysAgo(5),
        onboarded_by_org_id: 'agg-1',
        onboarded_via: 'web',
        profile_state: {
          'Full Name': 'Bob',
          'Phone Number': '9876543210',
          'Email Address': 'bob@example.com',
          'Grade': 'XI',
        },
        profile_created_at: daysAgo(60),
        profile_last_updated_at: daysAgo(5),
        applications_total: 3,
        applications_pending: 1,
        applications_accepted: 1,
        applications_rejected: 1,
      },
      // U3 — at_risk: 45 days idle, 2 apps all rejected
      {
        user_id: 'u3',
        created_at: daysAgo(120),
        updated_at: daysAgo(45),
        onboarded_by_org_id: 'agg-1',
        onboarded_via: null,
        profile_state: { 'Full Name': 'Carol' },
        profile_created_at: daysAgo(120),
        profile_last_updated_at: daysAgo(45),
        applications_total: 2,
        applications_pending: 0,
        applications_accepted: 0,
        applications_rejected: 2,
      },
    ];

    const result = await recompute_aggregator_metrics('agg-1');

    expect(result.processed).toBe(3);
    expect(dbState.upserts).toHaveLength(1);
    const written = dbState.upserts[0];
    expect(written).toHaveLength(3);

    const byUser = Object.fromEntries(written.map((r) => [r.userId as string, r]));

    // U1: new status, only "Full Name" populated (1.0 / 3.0 → 33), missing required
    expect(byUser.u1.profileStatus).toBe('new');
    expect(byUser.u1.profileCompletionPct).toBe(33);
    expect(byUser.u1.actionableTags).toEqual(['missing_phone_number']);
    expect(byUser.u1.onboardedVia).toBe('voice');
    expect(byUser.u1.applicationsTotal).toBe(0);

    // U2: satisfied (accepted > 0), 100% complete, no missing tags
    expect(byUser.u2.profileStatus).toBe('satisfied');
    expect(byUser.u2.profileCompletionPct).toBe(100);
    expect(byUser.u2.actionableTags).toEqual([]);
    expect(byUser.u2.applicationsAccepted).toBe(1);
    expect(byUser.u2.applicationsTotal).toBe(3);

    // U3: at_risk (45d idle, no accepts), missing phone, all rejected, idle
    expect(byUser.u3.profileStatus).toBe('at_risk');
    expect(byUser.u3.profileCompletionPct).toBe(33);
    expect(byUser.u3.actionableTags).toEqual([
      'missing_phone_number',
      'all_applications_rejected',
      'no_recent_activity',
    ]);
    expect(byUser.u3.ageDays).toBe(120);
  });

  it('falls back to user timestamps when the profile is missing', async () => {
    dbState.users = [
      {
        user_id: 'u-no-profile',
        created_at: daysAgo(2),
        updated_at: daysAgo(2),
        onboarded_by_org_id: 'agg-1',
        onboarded_via: 'voice',
        profile_state: null,
        profile_created_at: null,
        profile_last_updated_at: null,
        applications_total: 0,
        applications_pending: 0,
        applications_accepted: 0,
        applications_rejected: 0,
      },
    ];

    await recompute_aggregator_metrics('agg-1');
    const row = dbState.upserts[0][0];
    expect(row.profileCompletionPct).toBe(0);
    expect(row.profileStatus).toBe('new'); // < 7 days, no apps
    // Both schema-required keys missing → two missing_* tags.
    expect(row.actionableTags).toEqual([
      'missing_full_name',
      'missing_phone_number',
    ]);
  });

  it('flushes in batches of 1000', async () => {
    const make = (i: number): UserRow => ({
      user_id: `u${i}`,
      created_at: daysAgo(10),
      updated_at: daysAgo(10),
      onboarded_by_org_id: 'agg-bulk',
      onboarded_via: 'web',
      profile_state: {
        'Full Name': 'X',
        'Phone Number': '9999999999',
      },
      profile_created_at: daysAgo(10),
      profile_last_updated_at: daysAgo(10),
      applications_total: 0,
      applications_pending: 0,
      applications_accepted: 0,
      applications_rejected: 0,
    });
    dbState.users = Array.from({ length: 1500 }, (_, i) => make(i));

    const result = await recompute_aggregator_metrics('agg-bulk');
    expect(result.processed).toBe(1500);
    expect(dbState.upserts).toHaveLength(2);
    expect(dbState.upserts[0]).toHaveLength(1000);
    expect(dbState.upserts[1]).toHaveLength(500);
  });
});
