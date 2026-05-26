import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock, insertMock } = vi.hoisted(() => {
  const executeMock = vi.fn();
  const insertMock = vi.fn(() => ({
    values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(async () => undefined) })),
  }));
  return { executeMock, insertMock };
});

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: { execute: executeMock, insert: insertMock },
}));
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: 'purple_dot',
    domains: [
      {
        id: 'seeker',
        item_schemas: {
          'profile_1.0': {
            type: 'object',
            required: ['beneficiary_name'],
            properties: { beneficiary_name: { type: 'string', private: true } },
          },
        },
        status_rules: [
          { status: 'new', when: { item_age_days: { lte: 7 } } },
          { status: 'inactive', when: 'default' },
        ],
      },
    ],
    actions: {
      connect: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: {
              create: ['created'],
              accept: ['accepted'],
              reject: ['rejected'],
              cancel: ['cancelled'],
            },
          },
        ],
      },
    },
  })),
}));
vi.mock('../schema_lookup.js', () => ({
  get_item_schema: vi.fn(async () => ({
    type: 'object',
    required: ['beneficiary_name'],
    properties: { beneficiary_name: { type: 'string', private: true } },
  })),
}));

import { recompute_aggregator_domain_metrics } from '../recompute.js';

describe('recompute_aggregator_domain_metrics', () => {
  beforeEach(() => {
    executeMock.mockReset();
    insertMock.mockClear();
  });

  it('returns processed: 0 when no items exist for the (aggregator, domain)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    const result = await recompute_aggregator_domain_metrics('org_1', 'seeker');
    expect(result.processed).toBe(0);
  });

  it('computes and upserts one item with empty action counts → status new (age <= 7)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ item_network: 'purple_dot' }] });
    const now = new Date();
    const created = new Date(now.getTime() - 3 * 86_400_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          item_id: 'itm_1',
          item_network: 'purple_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          owner_user_id: 'u_1',
          onboarded_by_org_id: 'org_1',
          onboarded_via: 'bulk',
          item_state: { beneficiary_name: 'Asha' },
          profile_created_at: created,
          profile_last_updated_at: created,
          count_create: 0,
          count_accept: 0,
          count_reject: 0,
          count_cancel: 0,
          last_create_at: null,
          last_accept_at: null,
          last_reject_at: null,
          last_cancel_at: null,
        },
      ],
    });

    const result = await recompute_aggregator_domain_metrics('org_1', 'seeker');
    expect(result.processed).toBe(1);
    expect(insertMock).toHaveBeenCalledOnce();
  });
});
