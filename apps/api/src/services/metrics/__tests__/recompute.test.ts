import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbState: {
  sampleRows: Array<{ item_network: string }>;
  itemRows: Array<Record<string, unknown>>;
  upserts: Array<Record<string, unknown>>;
  executeCallCount: number;
} = { sampleRows: [], itemRows: [], upserts: [], executeCallCount: 0 };

vi.mock('@api/db/postgres/drizzle_config', () => {
  const execute = vi.fn(async () => {
    dbState.executeCallCount++;
    // First call is the "sample" query (LIMIT 1, learns the network).
    // Second + later are the main CTE call.
    if (dbState.executeCallCount === 1) {
      return { rows: dbState.sampleRows };
    }
    return { rows: dbState.itemRows };
  });
  const insert = vi.fn(() => ({
    values: vi.fn((rows: Array<Record<string, unknown>>) => ({
      onConflictDoUpdate: vi.fn(() => {
        dbState.upserts.push(...rows);
        return Promise.resolve();
      }),
    })),
  }));
  return { db: { execute, insert } };
});

vi.mock('../schema_lookup.js', () => ({
  get_item_schema: vi.fn(async () => ({
    type: 'object',
    required: ['name', 'phone'],
    properties: { name: {}, phone: {}, bio: {} },
  })),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: 'blue_dot',
    actions: {
      apply: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: {
              shortlisted: ['shortlisted'],
              rejected: ['rejected'],
              pending: ['created', 'submitted'],
            },
          },
        ],
      },
    },
  })),
}));

const { recompute_aggregator_domain_metrics } = await import('../recompute.js');

const sample_seeker_row = {
  item_id: 'item_seeker_1',
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  owner_user_id: 'usr_1',
  onboarded_by_org_id: 'org_a',
  onboarded_via: 'bulk',
  item_state: { name: 'A', phone: '+91' },
  profile_created_at: new Date('2026-05-15'),
  profile_last_updated_at: new Date('2026-05-15'),
  applications_total: 3,
  applications_pending: 1,
  applications_shortlisted: 1,
  applications_rejected: 1,
  last_applied_at: new Date('2026-05-20'),
  last_shortlisted_at: null,
  last_rejected_at: null,
  openings: null,
};

describe('recompute_aggregator_domain_metrics', () => {
  beforeEach(() => {
    dbState.sampleRows = [];
    dbState.itemRows = [];
    dbState.upserts = [];
    dbState.executeCallCount = 0;
  });

  it('handles an empty aggregator gracefully (no items)', async () => {
    dbState.sampleRows = [];  // sample query returns []
    dbState.itemRows = [];
    const result = await recompute_aggregator_domain_metrics('org_a', 'seeker');
    expect(result.processed).toBe(0);
    expect(dbState.upserts).toEqual([]);
  });

  it('upserts one row per seeker item with computed status + tags', async () => {
    dbState.sampleRows = [{ item_network: 'blue_dot' }];
    dbState.itemRows = [sample_seeker_row];
    const result = await recompute_aggregator_domain_metrics('org_a', 'seeker');
    expect(result.processed).toBe(1);
    expect(dbState.upserts).toHaveLength(1);
    const r = dbState.upserts[0];
    expect(r.itemId).toBe('item_seeker_1');
    expect(r.itemDomain).toBe('seeker');
    expect(r.applicationsTotal).toBe(3);
    expect(r.applicationsShortlisted).toBe(1);
    expect(r.applicationsRejected).toBe(1);
    expect(r.profileStatus).toBeTruthy();
  });

  it('flushes in batches above 1000 rows', async () => {
    dbState.sampleRows = [{ item_network: 'blue_dot' }];
    dbState.itemRows = Array.from({ length: 2500 }, (_, i) => ({
      ...sample_seeker_row,
      item_id: `item_${i}`,
    }));
    const result = await recompute_aggregator_domain_metrics('org_a', 'seeker');
    expect(result.processed).toBe(2500);
    expect(dbState.upserts).toHaveLength(2500);
  });
});
